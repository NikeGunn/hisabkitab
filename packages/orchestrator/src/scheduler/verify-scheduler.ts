/**
 * Runtime verification (CLAUDE.md §8) of the REAL reminder scheduler —
 * `pnpm --filter @hisab/orchestrator verify:scheduler`.
 *
 * Boots the REAL BullMQ scheduler against LIVE Redis, seeds a tenant + a
 * confirmed sale in the dev DB, and drives the monthly pass two ways:
 *   1. runOnce()           — the worker's exact code path, synchronous
 *   2. trigger() → worker  — through the real Redis queue (proves the round-trip)
 * The summary comes from the REAL ledger generate_return_summary; the template
 * "send" is captured. NO Anthropic API, NO WhatsApp — only Postgres + Redis.
 *
 * Verdicts: PASS | FAIL | BLOCKED. Exit non-zero on any non-PASS.
 * Probes: exactly-once (second pass sends nothing); self-verify HOLDS a lie
 * (a wrong prepared figure → figure-free vat_due_soon, no number stated).
 */
import postgres from 'postgres';
import { QueueEvents } from 'bullmq';
import { createDb } from '@hisab/db';
import { createToolHandlers, type ToolContext } from '@hisab/mcp-ledger';
import { adToBs, bsMonthRange, defaultTaxConfig } from '@hisab/shared';
import { startScheduler } from './queue.js';
import { previousBsMonth, type ReturnSummaryProvider, type TemplateSender } from './reminder-job.js';

const ADMIN_URL = process.env['ADMIN_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/hisabkitab';
const ORCH_URL = process.env['CALLBACK_DATABASE_URL'] ?? 'postgres://hisab_orch:hisab_orch_dev@localhost:5432/hisabkitab';
const APP_URL = process.env['DATABASE_URL'] ?? 'postgres://hisab_app:hisab_app_dev@localhost:5432/hisabkitab';

type Verdict = 'PASS' | 'FAIL' | 'BLOCKED';
const results: Array<{ name: string; verdict: Verdict; detail: string }> = [];
const record = (name: string, verdict: Verdict, detail: string) => {
  results.push({ name, verdict, detail });
  console.log(`[${verdict}] ${name}\n       ${detail}\n`);
};

const localIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// BullMQ accepts an ioredis options object carrying a `url` (verified at runtime
// against live Redis). One shared connection spec for queue, worker, events.
const redisConn = { url: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379' };

async function main(): Promise<void> {
  const NOW = new Date();
  const { bsYear, bsMonth } = previousBsMonth(adToBs(NOW));
  const monthFrom = localIso(bsMonthRange(bsYear, bsMonth).from);

  const adminSql = postgres(ADMIN_URL, { max: 1 });
  const orch = createDb(ORCH_URL, 4);
  const app = createDb(APP_URL, 4);

  // fresh tenant for this run (unique number so reruns don't collide)
  const e164 = `97798${Date.now().toString().slice(-7)}`;
  const [t] = await adminSql`
    INSERT INTO tenants (business_name, pan_or_vat_no, whatsapp_e164, status)
    VALUES ('Verify Scheduler Pasal', '300000009', ${e164}, 'active') RETURNING id`;
  const tenantId = t!['id'] as string;
  await adminSql`
    INSERT INTO sales (tenant_id, occurred_on, amount_excl_vat_paisa, vat_paisa, status)
    VALUES (${tenantId}, ${monthFrom}, 800000, 104000, 'confirmed')`;

  const sent: Array<{ to: string; template: string; params: string[] }> = [];
  const sendTemplate: TemplateSender = async (to, template, params) => void sent.push({ to, template, params });

  const truthfulProvider: ReturnSummaryProvider = async (id, y, m) => {
    // trusted system actor (autonomous scheduler) runs with owner authority
    const ctx: ToolContext = { db: app.db, tenantId: id, role: 'owner', cfg: defaultTaxConfig };
    const r = (await createToolHandlers(ctx).generate_return_summary({ bs_year: y, bs_month: m })) as {
      net_payable_paisa: number;
      is_nil: boolean;
      filing_deadline_ad: string;
    };
    return { netPayablePaisa: BigInt(r.net_payable_paisa), isNil: r.is_nil, filingDeadlineAd: r.filing_deadline_ad };
  };

  let scheduler: Awaited<ReturnType<typeof startScheduler>> | undefined;
  try {
    scheduler = await startScheduler({
      connection: redisConn,
      db: orch.db,
      getReturnSummary: truthfulProvider,
      sendTemplate,
      now: () => NOW,
      log: (m) => console.log(`[sched] ${m}`),
    });

    // 1. runOnce — the worker's exact logic, synchronous
    try {
      const outcomes = await scheduler.runOnce(NOW);
      const mine = outcomes.find((o) => o.tenantId === tenantId);
      const mySends = sent.filter((s) => s.to === e164);
      const ok = mine?.status === 'sent' && mine.kind === 'return_prepared' && mine.verdict === 'PASS' && mySends.length === 1;
      record(
        'runOnce: prepare + self-verify(PASS) + send return_prepared',
        ok ? 'PASS' : 'FAIL',
        `outcome=${JSON.stringify(mine)} sends=${mySends.length}`,
      );
    } catch (err) {
      record('runOnce pass', 'BLOCKED', String(err));
    }

    // 2. PROBE: exactly-once — a second runOnce sends NOTHING more for our tenant
    try {
      const before = sent.filter((s) => s.to === e164).length;
      const outcomes = await scheduler.runOnce(NOW);
      const mine = outcomes.find((o) => o.tenantId === tenantId);
      const after = sent.filter((s) => s.to === e164).length;
      record(
        'PROBE: second pass re-sends NOTHING (exactly-once latch)',
        mine?.status === 'already_sent' && after === before ? 'PASS' : 'FAIL',
        `status=${mine?.status} sends ${before}→${after}`,
      );
    } catch (err) {
      record('PROBE: exactly-once', 'BLOCKED', String(err));
    }

    // 3. the REAL Redis round-trip: enqueue a job, the worker drains it
    const queueEvents = new QueueEvents('hisab-vat-reminders', { connection: redisConn });
    await queueEvents.waitUntilReady();
    try {
      const before = sent.filter((s) => s.to === e164).length;
      const job = await scheduler.trigger();
      const finished = await job
        .waitUntilFinished(queueEvents, 15_000)
        .then(() => true)
        .catch(() => false);
      const after = sent.filter((s) => s.to === e164).length;
      // exactly-once means the queued run sends nothing new (already sent above),
      // but it must COMPLETE cleanly through Redis — that's what we're proving.
      record(
        'BullMQ round-trip: trigger() → worker drains via live Redis',
        finished && after === before ? 'PASS' : finished ? 'FAIL' : 'BLOCKED',
        `job=${job.id} finished=${finished} sends unchanged=${after === before}`,
      );
    } catch (err) {
      record('BullMQ round-trip', 'BLOCKED', String(err));
    } finally {
      await queueEvents.close();
    }

    // 4. PROBE: self-verify HOLDS a lie — a wrong prepared figure → figure-free nudge
    try {
      const e164b = `97798${(Date.now() + 1).toString().slice(-7)}`;
      const [t2] = await adminSql`
        INSERT INTO tenants (business_name, pan_or_vat_no, whatsapp_e164, status)
        VALUES ('Verify Liar Pasal', '300000010', ${e164b}, 'active') RETURNING id`;
      const liarId = t2!['id'] as string;
      await adminSql`
        INSERT INTO sales (tenant_id, occurred_on, amount_excl_vat_paisa, vat_paisa, status)
        VALUES (${liarId}, ${monthFrom}, 800000, 104000, 'confirmed')`;

      const lyingProvider: ReturnSummaryProvider = async () => ({
        netPayablePaisa: 777777n, // lie — real is 104000
        isNil: false,
        filingDeadlineAd: '2026-07-10',
      });
      const liarSched = await startScheduler({
        connection: redisConn,
        db: orch.db,
        getReturnSummary: lyingProvider,
        sendTemplate,
        now: () => NOW,
      });
      try {
        const outcomes = await liarSched.runOnce(NOW);
        const mine = outcomes.find((o) => o.tenantId === liarId);
        const mySend = sent.find((s) => s.to === e164b);
        const heldNoNumber = mySend?.template === 'vat_due_soon' && !mySend.params.join(' ').includes('7777');
        record(
          'PROBE: self-verify HOLDS a lying figure → figure-free vat_due_soon',
          mine?.verdict === 'FAIL' && heldNoNumber ? 'PASS' : 'FAIL',
          `verdict=${mine?.verdict} sent=${JSON.stringify(mySend)}`,
        );
      } finally {
        await liarSched.close();
      }
    } catch (err) {
      record('PROBE: self-verify holds a lie', 'BLOCKED', String(err));
    }
  } finally {
    await scheduler?.close();
    await orch.close();
    await app.close();
    await adminSql.end({ timeout: 5 });
  }

  const bad = results.filter((r) => r.verdict !== 'PASS').length;
  console.log(`${results.length} checks: ${results.length - bad} PASS, ${bad} not-PASS`);
  process.exitCode = bad > 0 ? 1 : 0;
}

void main();
