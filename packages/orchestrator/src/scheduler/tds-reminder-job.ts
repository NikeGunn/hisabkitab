/**
 * Monthly TDS-deposit reminder (PRD v2.0 §12 "Accounting completeness" → "TDS deposit
 * reminder: TDS is also due by the 25th — add it alongside the VAT reminder"; PRD v1.1
 * §5.2/§5.3).
 *
 * For the BS month that just ENDED, for each active tenant with a WhatsApp number:
 *   1. generate_tds_summary (deterministic ledger tool — no agent, no API spend) totals the
 *      TDS WITHHELD on confirmed expenses + returns the deposit deadline (25th of next month),
 *   2. INDEPENDENTLY re-total the same column here (self-verify, PRD §11) — must agree,
 *   3. choose the proactive Utility template:
 *        - nothing withheld (nil)        → SKIP (no obligation, no message),
 *        - PASS (recompute agrees, >0)   → tds_due_soon WITH the figure stated,
 *        - not-PASS                       → tds_due_soon, FIGURE-FREE (numbers held for review),
 *   4. send via the Utility template sender, and
 *   5. latch reminder_log (tenant, year, month, 'tds_due_soon') so a retried/daily tick
 *      re-sends nothing.
 *
 * Same exactly-once + at-least-once design as the VAT reminder, and the same discipline:
 * we PREPARE + nudge only; the owner deposits via eTDS. We never state an unverified figure.
 */
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { schema, type Db } from '@hisab/db';
import { adToBs, bsMonthRange, formatNpr } from '@hisab/shared';
import { bsMonthLabel, previousBsMonth } from './reminder-job.js';

const { tenants, reminderLog, expenses } = schema;

/** Deterministic TDS summary from the Ledger MCP (or in-memory server in tests). */
export type TdsSummaryProvider = (
  tenantId: string,
  bsYear: number,
  bsMonth: number,
) => Promise<{ tdsWithheldPaisa: bigint; isNil: boolean; depositDeadlineAd: string }>;

/** Send a pre-approved Utility template. tds_due_soon is the only TDS template. */
export type TdsTemplateSender = (
  toE164: string,
  templateName: 'tds_due_soon',
  bodyParams: string[],
) => Promise<void>;

export interface TdsReminderJobDeps {
  /** hisab_orch handle (cross-tenant; queries carry explicit tenant filters). */
  db: Db;
  getTdsSummary: TdsSummaryProvider;
  sendTemplate: TdsTemplateSender;
  log?: (msg: string) => void;
}

export interface TdsReminderOutcome {
  tenantId: string;
  status: 'sent' | 'already_sent' | 'skipped' | 'error';
  verdict?: 'PASS' | 'FAIL' | 'BLOCKED';
  detail: string;
}

const ddMon = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** LOCAL-parts ISO — must match the ledger's occurred_on calendar (see self-verify.ts). */
const toIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Independently re-total TDS withheld on confirmed expenses for the BS month — the cross-check
 * against the prepared figure. Returns BLOCKED on a query error (hold, never a false PASS).
 */
async function selfVerifyTds(
  db: Db,
  tenantId: string,
  bsYear: number,
  bsMonth: number,
  preparedPaisa: bigint,
): Promise<{ verdict: 'PASS' | 'FAIL' | 'BLOCKED'; recomputedPaisa: bigint; detail: string }> {
  try {
    const { from, to } = bsMonthRange(bsYear, bsMonth);
    const [row] = await db
      .select({ tds: sql<string>`coalesce(sum(${expenses.tdsPaisa}), 0)` })
      .from(expenses)
      .where(
        and(
          eq(expenses.tenantId, tenantId),
          eq(expenses.status, 'confirmed'),
          gte(expenses.occurredOn, toIso(from)),
          lte(expenses.occurredOn, toIso(to)),
        ),
      );
    const recomputedPaisa = BigInt(row?.tds ?? '0');
    if (recomputedPaisa !== preparedPaisa) {
      return {
        verdict: 'FAIL',
        recomputedPaisa,
        detail: `TDS mismatch: prepared ${preparedPaisa} paisa vs recomputed ${recomputedPaisa} paisa`,
      };
    }
    return {
      verdict: 'PASS',
      recomputedPaisa,
      detail: `independent recompute agrees: ${recomputedPaisa} paisa withheld`,
    };
  } catch (err) {
    return {
      verdict: 'BLOCKED',
      recomputedPaisa: 0n,
      detail: `could not recompute TDS independently: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Process ONE tenant for one BS month. Exactly-once via the reminder_log latch. A NIL month
 * (nothing withheld) is SKIPPED — there is no TDS obligation, so no message is sent.
 */
export async function remindTenantTds(
  deps: TdsReminderJobDeps,
  tenant: { id: string; whatsappE164: string },
  bsYear: number,
  bsMonth: number,
): Promise<TdsReminderOutcome> {
  const label = bsMonthLabel(bsYear, bsMonth);
  try {
    const summary = await deps.getTdsSummary(tenant.id, bsYear, bsMonth);
    if (summary.isNil || summary.tdsWithheldPaisa === 0n) {
      return {
        tenantId: tenant.id,
        status: 'skipped',
        detail: `${label}: no TDS withheld (nil) — no reminder`,
      };
    }
    const verify = await selfVerifyTds(
      deps.db,
      tenant.id,
      bsYear,
      bsMonth,
      summary.tdsWithheldPaisa,
    );
    // SKIP shouldn't occur here; "when in doubt, do not pass" → store as BLOCKED.
    const verdict: 'PASS' | 'FAIL' | 'BLOCKED' = verify.verdict;

    // Latch FIRST: claim the (tenant, year, month, 'tds_due_soon') slot.
    const claimed = await deps.db
      .insert(reminderLog)
      .values({
        tenantId: tenant.id,
        bsYear,
        bsMonth,
        kind: 'tds_due_soon',
        verdict,
        netPayablePaisa: verdict === 'PASS' ? summary.tdsWithheldPaisa : null,
        isNil: false,
        detail: verify.detail,
      })
      .onConflictDoNothing()
      .returning({ id: reminderLog.id });

    if (claimed.length === 0) {
      return {
        tenantId: tenant.id,
        status: 'already_sent',
        verdict,
        detail: `${label}: already sent`,
      };
    }

    const deadline = ddMon(summary.depositDeadlineAd);
    try {
      // PASS → state the withheld figure; not-PASS → figure-free deadline nudge.
      const amount =
        verdict === 'PASS' ? formatNpr(summary.tdsWithheldPaisa).replace('Rs ', '') : '—';
      await deps.sendTemplate(tenant.whatsappE164, 'tds_due_soon', [label, amount, deadline]);
    } catch (sendErr) {
      await deps.db.delete(reminderLog).where(eq(reminderLog.id, claimed[0]!.id));
      throw sendErr;
    }

    deps.log?.(`tds reminder → ${tenant.id} (${label}, ${verdict}): ${verify.detail}`);
    return {
      tenantId: tenant.id,
      status: 'sent',
      verdict,
      detail: `${label}: ${verdict} → tds_due_soon`,
    };
  } catch (err) {
    deps.log?.(`tds reminder FAILED for ${tenant.id} (${label}): ${String(err)}`);
    return {
      tenantId: tenant.id,
      status: 'error',
      detail: `${label}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Run the TDS reminder pass for every active tenant for the BS month that just ended. */
export async function runTdsReminderPass(
  deps: TdsReminderJobDeps,
  now: Date = new Date(),
): Promise<TdsReminderOutcome[]> {
  const { bsYear, bsMonth } = previousBsMonth(adToBs(now));

  const activeTenants = await deps.db
    .select({ id: tenants.id, whatsappE164: tenants.whatsappE164 })
    .from(tenants)
    .where(eq(tenants.status, 'active'));

  const outcomes: TdsReminderOutcome[] = [];
  for (const t of activeTenants) {
    if (!t.whatsappE164) {
      outcomes.push({ tenantId: t.id, status: 'skipped', detail: 'no WhatsApp number bound' });
      continue;
    }
    outcomes.push(
      await remindTenantTds(deps, { id: t.id, whatsappE164: t.whatsappE164 }, bsYear, bsMonth),
    );
  }
  return outcomes;
}
