/**
 * BullMQ wiring for the monthly reminder (PRD v1.0 §8.5 "Queue/scheduler: BullMQ
 * + Redis"). A single repeatable job fans out to runReminderPass.
 *
 * Why this is safe at any tick cadence
 * ------------------------------------
 * Exactly-once is owned by the DB (reminder_log unique key), NOT by the queue.
 * That decoupling is deliberate and is what makes the queue logic robust:
 *   - The job runs DAILY, not once-a-month. A node that was down on "the" day
 *     recovers the next day instead of skipping the whole month.
 *   - Re-runs are free: every tenant already nudged this BS month hits the
 *     reminder_log latch and sends nothing. So we can retry on failure, run
 *     multiple replicas, or trigger a manual pass without fear of double-sends.
 *   - Therefore the worker only needs at-LEAST-once delivery from BullMQ, which
 *     is exactly what BullMQ guarantees — we lean into it rather than fighting it.
 *
 * Hardening applied:
 *   - deterministic scheduler id (upsert replaces, never accumulates schedules)
 *   - retry with exponential backoff, capped attempts (transient Redis/PG blips)
 *   - bounded retention (removeOnComplete / removeOnFail) so Redis can't grow
 *     without limit from a daily job
 *   - per-pass result is returned & logged for observability
 *   - graceful close (drain worker, then queue)
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import {
  runReminderPass,
  type ReminderJobDeps,
  type TenantReminderOutcome,
} from './reminder-job.js';
import { runDunningPass, type DunningJobDeps } from './dunning-job.js';
import { runTdsReminderPass, type TdsReminderJobDeps } from './tds-reminder-job.js';

export const REMINDER_QUEUE = 'hisab-vat-reminders';
export const REMINDER_JOB = 'monthly-vat-return';
/** Stable scheduler id → upsert REPLACES the schedule instead of stacking duplicates. */
export const REMINDER_SCHEDULER_ID = 'monthly-vat-return-scheduler';

/** Daily at 09:15 Asia/Kathmandu (well before the 25th-of-month statutory cutoff). */
export const DEFAULT_REMINDER_CRON = '15 9 * * *';
export const REMINDER_TZ = 'Asia/Kathmandu';

export interface SchedulerOptions extends ReminderJobDeps {
  connection: ConnectionOptions;
  cron?: string;
  timezone?: string;
  /** Max attempts per daily pass on transient failure (default 3). */
  attempts?: number;
  /** Override "now" in tests; production uses the real clock. */
  now?: () => Date;
  /**
   * Optional P10 subscription dunning, run in the SAME daily tick (after reminders).
   * Omitted = no dunning (e.g. before billing is enabled). Same at-least-once + DB
   * latch guarantees as reminders.
   */
  dunning?: DunningJobDeps;
  /**
   * Optional P13 TDS-deposit reminder, run in the SAME daily tick (after the VAT
   * reminder). Omitted = no TDS reminder. Same exactly-once reminder_log latch.
   */
  tds?: TdsReminderJobDeps;
}

export interface SchedulerHandle {
  queue: Queue;
  worker: Worker;
  /**
   * Run one pass immediately and synchronously (tests / `verify` / manual ops).
   * Bypasses Redis entirely — same code path the worker runs, so it proves the
   * real job logic without waiting on the cron.
   */
  runOnce(now?: Date): Promise<TenantReminderOutcome[]>;
  /** Enqueue an out-of-band pass onto the real queue (ops "run it now please"). */
  trigger(): Promise<Job>;
  close(): Promise<void>;
}

export async function startScheduler(opts: SchedulerOptions): Promise<SchedulerHandle> {
  const { connection, cron, timezone, attempts, now, dunning, tds, ...jobDeps } = opts;
  const runNow = now ?? (() => new Date());

  const queue = new Queue(REMINDER_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: attempts ?? 3,
      backoff: { type: 'exponential', delay: 30_000 }, // 30s, 60s, 120s …
      // A daily job would otherwise pile up forever in Redis — keep a small window.
      removeOnComplete: { age: 7 * 24 * 3600, count: 50 },
      removeOnFail: { age: 30 * 24 * 3600, count: 100 }, // keep failures longer to inspect
    },
  });

  // Deterministic id: re-running setup/boot REPLACES the schedule, never duplicates it.
  await queue.upsertJobScheduler(
    REMINDER_SCHEDULER_ID,
    { pattern: cron ?? DEFAULT_REMINDER_CRON, tz: timezone ?? REMINDER_TZ },
    { name: REMINDER_JOB, data: {} },
  );

  const worker = new Worker(
    REMINDER_QUEUE,
    async (job: Job) => {
      const outcomes = await runReminderPass(jobDeps, runNow());
      const tally = outcomes.reduce<Record<string, number>>((acc, o) => {
        acc[o.status] = (acc[o.status] ?? 0) + 1;
        return acc;
      }, {});
      jobDeps.log?.(
        `reminder pass ${job.id}: ${JSON.stringify(tally)} (${outcomes.length} tenants)`,
      );
      // P13 TDS reminder runs in the same tick (after the VAT reminder). Caught + logged
      // separately so a TDS failure never masks a successful VAT reminder pass.
      if (tds) {
        try {
          const t = await runTdsReminderPass(tds, runNow());
          jobDeps.log?.(`tds reminder pass ${job.id}: ${t.length} tenants`);
        } catch (err) {
          jobDeps.log?.(
            `tds reminder pass ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // P10 dunning runs in the same tick (after reminders). A dunning failure must
      // NOT mask a successful reminder pass, so it's caught and logged separately.
      if (dunning) {
        try {
          const d = await runDunningPass(dunning, runNow());
          jobDeps.log?.(`dunning pass ${job.id}: ${d.length} subscriptions`);
        } catch (err) {
          jobDeps.log?.(
            `dunning pass ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // Surfacing an error here lets BullMQ retry with backoff; the reminder_log
      // latch makes the retry re-send only what genuinely failed.
      const errored = outcomes.filter((o) => o.status === 'error');
      if (errored.length > 0) {
        throw new Error(
          `${errored.length}/${outcomes.length} tenants errored: ${errored.map((e) => `${e.tenantId}:${e.detail}`).join(' | ')}`,
        );
      }
      return { tally, count: outcomes.length };
    },
    { connection, concurrency: 1 },
  );

  // Don't let an unhandled 'error' from the worker's Redis stream crash the process.
  worker.on('error', (err) => jobDeps.log?.(`reminder worker error: ${err.message}`));

  return {
    queue,
    worker,
    runOnce: (nowArg?: Date) => runReminderPass(jobDeps, nowArg ?? runNow()),
    trigger: () => queue.add(REMINDER_JOB, {}),
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
