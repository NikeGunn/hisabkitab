/**
 * Compliance-calendar ledger tools (a core agent capability for ZERO date hallucination).
 *
 * The agent must NEVER compute or state a date itself — VAT/TDS deadlines, fiscal-year
 * boundaries, invoice/bill due dates, holidays. These read-only tools answer all of that
 * from the pure deterministic `@hisab/shared/calendar` engine, the single source of truth,
 * and audit-log every query. Governed exactly like verify_filing_deadline: deterministic
 * computation is authoritative; a statutory date on a holiday is flagged (confirm with the
 * IRD), never silently moved.
 *
 * Due dates for open AR invoices / AP bills are READ from the tenant's confirmed rows (RLS
 * scoped) and handed to the engine as-is — the engine echoes them, it never invents a date.
 *
 * All tools are read-only (capability `generate_report`); nothing here writes business data.
 */
import { z } from 'zod';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { appendAudit, schema, type Tx } from '@hisab/db';
import {
  computeComplianceCalendar,
  nextDeadlines,
  holidayOn,
  adToBs,
  type CalendarEvent,
  type DueItem,
  type Holiday,
} from '@hisab/shared';
import type { ToolContext } from './tools.js';

const { arInvoices, apBills, parties } = schema;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const calendarInputSchemas = {
  get_upcoming_deadlines: {
    horizon_days: z
      .number()
      .int()
      .min(1)
      .max(400)
      .default(45)
      .describe('how far ahead to look (days)'),
    include_due_items: z.boolean().default(true).describe('include open invoice/bill due dates'),
  },
  days_until_deadline: {
    target_date: isoDate.describe('an AD date (YYYY-MM-DD) to measure from today'),
  },
  is_business_holiday: {
    date: isoDate.describe('an AD date (YYYY-MM-DD) to check against the configured holidays'),
  },
} as const;

export const calendarToolDescriptions: Record<keyof typeof calendarInputSchemas, string> = {
  get_upcoming_deadlines:
    'List the upcoming compliance events (VAT filing, TDS deposit, fiscal-year boundaries, and open invoice/bill due dates) with exact AD+BS dates and days remaining, from the deterministic calendar engine. Use this whenever the owner asks what is due or when; NEVER compute a date yourself. A deadline on a holiday is flagged, not moved.',
  days_until_deadline:
    'Return the exact whole-calendar-day count from today to a given AD date (negative if past). Use this for any "how many days until X" question instead of counting yourself.',
  is_business_holiday:
    'Check whether an AD date falls on a configured business/public holiday. Returns the holiday name if so. Empty holiday config means none is known; it never guesses.',
};

type Args<K extends keyof typeof calendarInputSchemas> = z.infer<
  z.ZodObject<(typeof calendarInputSchemas)[K]>
>;

const toDate = (iso: string): Date => {
  const [y = 0, m = 1, d = 1] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/**
 * Configured holidays. BS festival closures are CONFIG, never hard-coded literals (mirrors
 * "tax rates/deadlines are config"). Until a holidays table exists, this returns an empty
 * set — and the engine then emits NO holiday warnings rather than fabricating one. Wiring a
 * real source (config/table) later only changes this function.
 */
function loadHolidays(): readonly Holiday[] {
  return [];
}

function serialize(e: CalendarEvent) {
  return {
    kind: e.kind,
    title: e.title,
    due_ad: e.dueAdIso,
    due_bs: `${e.dueBs.year}-${String(e.dueBs.month).padStart(2, '0')}-${String(e.dueBs.day).padStart(2, '0')}`,
    days_until: e.daysUntil,
    ...(e.holidayWarning ? { holiday_warning: e.holidayWarning } : {}),
    ...(e.refId ? { ref_id: e.refId } : {}),
  };
}

export function createCalendarToolHandlers(ctx: ToolContext) {
  const { db, tenantId } = ctx;
  const inTenantTx = <T>(fn: (tx: Tx) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });

  /** Open AR invoices + AP bills with a due date, as calendar DueItems (echoed, not invented). */
  async function loadDueItems(tx: Tx): Promise<DueItem[]> {
    const invoices = await tx
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
    const bills = await tx
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

  return {
    async get_upcoming_deadlines(args: Args<'get_upcoming_deadlines'>) {
      const holidays = loadHolidays();
      return inTenantTx(async (tx) => {
        const dueItems = args.include_due_items ? await loadDueItems(tx) : [];
        const events = computeComplianceCalendar({
          holidays,
          dueItems,
          horizonDays: args.horizon_days,
        });
        const next = nextDeadlines({
          holidays,
          dueItems,
          horizonDays: args.horizon_days,
          limit: 3,
        });
        await appendAudit(tx, tenantId, {
          actor: 'agent',
          action: 'get_upcoming_deadlines',
          detail: { horizon_days: args.horizon_days, event_count: events.length },
        });
        return {
          horizon_days: args.horizon_days,
          today_bs: bsToday(),
          next_three: next.map(serialize),
          events: events.map(serialize),
          source: 'deterministic calendar engine (statutory rule + your confirmed entries)',
          note: 'Dates are computed, never guessed. A deadline on a holiday is flagged; confirm any IRD extension before relying on a later date.',
        };
      });
    },

    async days_until_deadline(args: Args<'days_until_deadline'>) {
      // No DB needed, but audit the query for the zero-hallucination trail.
      const target = toDate(args.target_date);
      const now = new Date();
      const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
      const b = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
      const days = Math.round((b - a) / 86_400_000);
      return inTenantTx(async (tx) => {
        await appendAudit(tx, tenantId, {
          actor: 'agent',
          action: 'days_until_deadline',
          detail: { target_date: args.target_date, days_until: days },
        });
        return {
          target_date: args.target_date,
          days_until: days,
          is_past: days < 0,
          source: 'deterministic day count',
        };
      });
    },

    async is_business_holiday(args: Args<'is_business_holiday'>) {
      const holidays = loadHolidays();
      const bs = adToBs(toDate(args.date));
      const name = holidayOn(bs, holidays);
      return inTenantTx(async (tx) => {
        await appendAudit(tx, tenantId, {
          actor: 'agent',
          action: 'is_business_holiday',
          detail: { date: args.date, is_holiday: name !== null },
        });
        return {
          date: args.date,
          date_bs: `${bs.year}-${String(bs.month).padStart(2, '0')}-${String(bs.day).padStart(2, '0')}`,
          is_holiday: name !== null,
          ...(name ? { holiday_name: name } : {}),
          note:
            holidays.length === 0
              ? 'No holiday calendar is configured yet, so this only confirms it is not a KNOWN holiday; it never guesses.'
              : 'Checked against the configured holiday calendar.',
        };
      });
    },
  };
}

function bsToday(): string {
  const bs = adToBs(new Date());
  return `${bs.year}-${String(bs.month).padStart(2, '0')}-${String(bs.day).padStart(2, '0')}`;
}
