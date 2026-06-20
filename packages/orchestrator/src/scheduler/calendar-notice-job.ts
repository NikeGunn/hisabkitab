/**
 * Proactive COMPLIANCE-CALENDAR notice (the "agent gets notified, under the hood" part).
 *
 * Once per BS month, each active tenant with a bound WhatsApp number gets a single
 * consolidated "what's due this month" digest, computed by the deterministic calendar
 * engine (statutory deadlines + the tenant's own open invoice/bill due dates). This is
 * ADDITIVE to the figure-specific VAT/TDS reminders (those state amounts; this is the
 * calendar-at-a-glance), and it never states a money figure, so it needs no self-verify.
 *
 * Runs in the SAME daily BullMQ tick as the other reminders, and is exactly-once on the
 * SAME reminder_log latch with kind 'deadline_digest' keyed by (tenant, bs_year, bs_month)
 * — a daily/retried tick re-sends nothing; a down-day recovers the next day. Same proven
 * design as the VAT/TDS reminders; zero new infra.
 *
 * Zero-hallucination: every date in the digest comes from the calendar engine via the
 * ledger tool path; the scheduler never formats a date it computed itself.
 */
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import { schema, type Db } from '@hisab/db';
import {
  adToBs,
  computeComplianceCalendar,
  type CalendarEvent,
  type DueItem,
  type Holiday,
} from '@hisab/shared';
import { bsMonthLabel } from './reminder-job.js';

const { tenants, reminderLog, arInvoices, apBills, parties } = schema;

/** Send a pre-approved Utility template. deadline_digest is the only calendar template. */
export type DigestTemplateSender = (
  toE164: string,
  templateName: 'deadline_digest',
  bodyParams: string[],
) => Promise<void>;

export interface CalendarNoticeJobDeps {
  /** hisab_orch handle (cross-tenant; queries carry explicit tenant filters). */
  db: Db;
  sendTemplate: DigestTemplateSender;
  /** Configured holidays (empty = none known; the engine never fabricates one). */
  holidays?: readonly Holiday[];
  /** How far ahead the digest looks. Default 35 days (covers the month + the 25th). */
  horizonDays?: number;
  log?: (msg: string) => void;
}

export interface CalendarNoticeOutcome {
  tenantId: string;
  status: 'sent' | 'already_sent' | 'skipped' | 'error';
  detail: string;
}

/** Open AR invoices + AP bills with a due date for a tenant, as engine DueItems (echoed). */
async function loadDueItems(db: Db, tenantId: string): Promise<DueItem[]> {
  const invoices = await db
    .select({ id: arInvoices.id, dueOn: arInvoices.dueOn, name: parties.name })
    .from(arInvoices)
    .innerJoin(parties, eq(parties.id, arInvoices.partyId))
    .where(
      and(
        eq(arInvoices.tenantId, tenantId),
        eq(arInvoices.status, 'confirmed'),
        gt(arInvoices.balancePaisa, 0n),
        isNotNull(arInvoices.dueOn),
      ),
    );
  const bills = await db
    .select({ id: apBills.id, dueOn: apBills.dueOn, name: parties.name })
    .from(apBills)
    .innerJoin(parties, eq(parties.id, apBills.partyId))
    .where(
      and(
        eq(apBills.tenantId, tenantId),
        eq(apBills.status, 'confirmed'),
        gt(apBills.balancePaisa, 0n),
        isNotNull(apBills.dueOn),
      ),
    );
  return [
    ...invoices.map(
      (r): DueItem => ({ refId: r.id, kind: 'invoice_due', dueAdIso: r.dueOn!, label: r.name }),
    ),
    ...bills.map(
      (r): DueItem => ({ refId: r.id, kind: 'bill_due', dueAdIso: r.dueOn!, label: r.name }),
    ),
  ];
}

/** A short, figure-free one-line summary of the most imminent upcoming events. */
function summarize(events: CalendarEvent[]): string {
  const upcoming = events
    .filter((e) => e.daysUntil >= 0)
    .sort((a, b) => a.daysUntil - b.daysUntil)
    .slice(0, 3);
  if (upcoming.length === 0) return 'No compliance deadlines in the coming weeks.';
  return upcoming
    .map((e) => `${e.title} in ${e.daysUntil}d (${e.dueBs.month}/${e.dueBs.day})`)
    .join('; ');
}

/** Process ONE tenant for the current BS month. Exactly-once via the reminder_log latch. */
export async function noticeTenant(
  deps: CalendarNoticeJobDeps,
  tenant: { id: string; whatsappE164: string },
  bsYear: number,
  bsMonth: number,
): Promise<CalendarNoticeOutcome> {
  const label = bsMonthLabel(bsYear, bsMonth);
  try {
    const dueItems = await loadDueItems(deps.db, tenant.id);
    const events = computeComplianceCalendar({
      holidays: deps.holidays ?? [],
      dueItems,
      horizonDays: deps.horizonDays ?? 35,
    });
    const upcoming = events.filter((e) => e.daysUntil >= 0);
    if (upcoming.length === 0) {
      return { tenantId: tenant.id, status: 'skipped', detail: `${label}: nothing upcoming` };
    }
    const summary = summarize(events);

    // Latch FIRST: claim the (tenant, year, month, 'deadline_digest') slot.
    const claimed = await deps.db
      .insert(reminderLog)
      .values({
        tenantId: tenant.id,
        bsYear,
        bsMonth,
        kind: 'deadline_digest',
        verdict: 'PASS', // a digest states no money figure; PASS = sent as computed
        isNil: false,
        detail: summary.slice(0, 480),
      })
      .onConflictDoNothing()
      .returning({ id: reminderLog.id });

    if (claimed.length === 0) {
      return { tenantId: tenant.id, status: 'already_sent', detail: `${label}: already sent` };
    }

    try {
      // Template params: [month label, count of upcoming items, short summary].
      await deps.sendTemplate(tenant.whatsappE164, 'deadline_digest', [
        label,
        String(upcoming.length),
        summary,
      ]);
    } catch (sendErr) {
      await deps.db.delete(reminderLog).where(eq(reminderLog.id, claimed[0]!.id));
      throw sendErr;
    }

    deps.log?.(`calendar digest → ${tenant.id} (${label}): ${summary}`);
    return { tenantId: tenant.id, status: 'sent', detail: `${label}: ${upcoming.length} upcoming` };
  } catch (err) {
    deps.log?.(`calendar digest FAILED for ${tenant.id} (${label}): ${String(err)}`);
    return {
      tenantId: tenant.id,
      status: 'error',
      detail: `${label}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Run the calendar-notice pass for every active tenant with a bound number, for THIS BS month. */
export async function runCalendarNoticePass(
  deps: CalendarNoticeJobDeps,
  now: Date = new Date(),
): Promise<CalendarNoticeOutcome[]> {
  const bs = adToBs(now);
  const activeTenants = await deps.db
    .select({ id: tenants.id, whatsappE164: tenants.whatsappE164 })
    .from(tenants)
    .where(eq(tenants.status, 'active'));

  const outcomes: CalendarNoticeOutcome[] = [];
  for (const t of activeTenants) {
    if (!t.whatsappE164) {
      outcomes.push({ tenantId: t.id, status: 'skipped', detail: 'no WhatsApp number bound' });
      continue;
    }
    outcomes.push(
      await noticeTenant(deps, { id: t.id, whatsappE164: t.whatsappE164 }, bs.year, bs.month),
    );
  }
  return outcomes;
}
