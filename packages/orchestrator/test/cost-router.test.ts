/**
 * P11 cost-control wiring in the inbound router (PRD v2.0 §7), against REAL
 * Postgres as hisab_orch. Proves:
 *   - a trivial turn ("thanks") is answered LOCALLY (canned reply, agent NEVER
 *     reached — anthropic is {} so a real turn would throw), and still counted;
 *   - a tenant over its monthly budget is THROTTLED before any agent turn;
 *   - an OK tenant is NOT throttled (the substantive path is attempted).
 * PROBES marked per CLAUDE.md §8.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, getUsage, recordUsage, schema, type DbHandle } from '@hisab/db';
import { BUDGET_THROTTLED_REPLY, PLAN_BUDGET_PAISA, TRIVIAL_REPLY } from '@hisab/shared';
import type Anthropic from '@anthropic-ai/sdk';
import { issuePairingCode, handleUnknownSender } from '../src/onboarding/pairing.js';
import { processInbound, SerialQueues, type RouterDeps } from '../src/whatsapp/router.js';
import { MemoryGateLogger } from '../src/audit/audit-logger.js';
import type { WaClient } from '../src/whatsapp/wa-client.js';
import type { InboundMessage } from '../src/whatsapp/inbound.js';
import { ADMIN_URL, ORCH_URL } from './urls.js';

let admin: DbHandle;
let orch: DbHandle;

beforeAll(() => {
  admin = createDb(ADMIN_URL, 3);
  orch = createDb(ORCH_URL, 3);
});
afterAll(async () => {
  await orch.close();
  await admin.close();
});
// Each test uses unique wa message ids + phone numbers, so no global cleanup is
// needed (a global delete would race other suites running concurrently).

/** Provision an active, paired tenant on a fresh number; return {id, e164}. */
async function paired(name: string, e164: string, plan?: string): Promise<string> {
  const [t] = await admin.db
    .insert(schema.tenants)
    .values({ businessName: name, panOrVatNo: '600000099' })
    .returning({ id: schema.tenants.id });
  const id = (t as { id: string }).id;
  const code = await issuePairingCode(orch.db, id);
  await handleUnknownSender(orch.db, e164, `START ${code}`);
  if (plan) {
    await admin.db.insert(schema.subscriptions).values({
      tenantId: id,
      planCode: plan,
      status: 'active',
      currentPeriodEnd: '2099-12-31',
    });
  }
  return id;
}

const textMsg = (id: string, from: string, body: string): InboundMessage => ({
  waMessageId: id,
  fromE164: from,
  timestamp: '0',
  kind: 'text',
  text: body,
});

function makeDeps(sent: { to: string; body: string }[], costGuard?: RouterDeps['costGuard']): RouterDeps {
  return {
    anthropic: {} as Anthropic, // a real agent turn would throw — proves we never start one
    db: orch.db,
    wa: {
      sendText: vi.fn(async (to: string, body: string) => {
        sent.push({ to, body });
      }),
    } as unknown as WaClient,
    gateLogger: new MemoryGateLogger(),
    queues: new SerialQueues(),
    agentId: 'agent_test',
    environmentId: 'env_test',
    ledgerMcpUrl: 'https://ledger.example/mcp',
    signingSecret: 'test-secret',
    ...(costGuard ? { costGuard } : {}),
  };
}

describe('trivial-turn short-circuit (model routing)', () => {
  it('answers "thanks" locally and never starts an agent turn', async () => {
    const id = await paired('Trivial Pasal', '+9779700000001');
    const sent: { to: string; body: string }[] = [];
    const ok = await processInbound(makeDeps(sent, { db: orch.db, model: 'claude-opus-4-8' }), textMsg('wamid.t1', '+9779700000001', 'thanks 🙏'));
    expect(ok).toBe(true);
    expect(sent[0]?.body).toBe(TRIVIAL_REPLY);
    // counted as a turn, ~0 cost
    const usage = await getUsage(orch.db, id);
    expect(usage?.turns).toBe(1);
    expect(usage?.costPaisa).toBe(0);
  });

  it('PROBE: a money message is NOT short-circuited (reaches the agent → throws on stub)', async () => {
    await paired('Real Pasal', '+9779700000002', 'starter');
    const sent: { to: string; body: string }[] = [];
    // anthropic is {} so the substantive path throws; the queue swallows it. The
    // point: it did NOT get the canned trivial reply.
    await processInbound(makeDeps(sent, { db: orch.db, model: 'claude-opus-4-8' }), textMsg('wamid.t2', '+9779700000002', 'paid 5000 to ram')).catch(() => undefined);
    expect(sent.some((s) => s.body === TRIVIAL_REPLY)).toBe(false);
  });
});

describe('budget throttle', () => {
  it('PROBE: a tenant at its monthly cap is throttled BEFORE any agent turn', async () => {
    const id = await paired('Maxed Pasal', '+9779700000003', 'starter');
    // burn the whole starter budget
    await recordUsage(orch.db, id, { inputTokens: 0, outputTokens: 0, costPaisa: PLAN_BUDGET_PAISA.starter });

    const sent: { to: string; body: string }[] = [];
    const ok = await processInbound(
      makeDeps(sent, { db: orch.db, model: 'claude-opus-4-8' }),
      textMsg('wamid.b1', '+9779700000003', 'record a sale of 1200'),
    );
    expect(ok).toBe(true);
    expect(sent[0]?.body).toBe(BUDGET_THROTTLED_REPLY);
    // throttled turn must NOT have started an agent turn / added cost
    const usage = await getUsage(orch.db, id);
    expect(usage?.costPaisa).toBe(PLAN_BUDGET_PAISA.starter); // unchanged
  });

  it('an under-budget tenant is not throttled (substantive path attempted)', async () => {
    await paired('Healthy Pasal', '+9779700000004', 'business');
    const sent: { to: string; body: string }[] = [];
    await processInbound(
      makeDeps(sent, { db: orch.db, model: 'claude-opus-4-8' }),
      textMsg('wamid.b2', '+9779700000004', 'record a sale of 1200'),
    ).catch(() => undefined);
    expect(sent.some((s) => s.body === BUDGET_THROTTLED_REPLY)).toBe(false);
  });
});
