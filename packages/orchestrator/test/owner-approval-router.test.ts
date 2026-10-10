/**
 * Server-side confirm-before-save, orchestrator half, over REAL Postgres as hisab_orch.
 *   - an owner's verified "yes" is recorded in owner_approvals BEFORE the turn
 *     (anthropic is {} so the turn itself throws — the record must already exist);
 *   - PROBE: a "yes but change…" / a figure / a non-approval is NOT recorded;
 *   - PROBE: a redelivered message id records nothing twice;
 *   - PROBE: a "yes" never gets the canned trivial reply (it must reach the agent).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, schema, type DbHandle } from '@hisab/db';
import { TRIVIAL_REPLY } from '@hisab/shared';
import type Anthropic from '@anthropic-ai/sdk';
import { issuePairingCode, handleUnknownSender } from '../src/onboarding/pairing.js';
import { processInbound, SerialQueues, type RouterDeps } from '../src/whatsapp/router.js';
import { MemoryGateLogger } from '../src/audit/audit-logger.js';
import type { WaClient } from '../src/whatsapp/wa-client.js';
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

async function paired(name: string, e164: string): Promise<string> {
  const [t] = await admin.db
    .insert(schema.tenants)
    .values({ businessName: name, panOrVatNo: '600000098' })
    .returning({ id: schema.tenants.id });
  const id = (t as { id: string }).id;
  await handleUnknownSender(orch.db, e164, `START ${await issuePairingCode(orch.db, id)}`);
  return id;
}

function deps(sent: string[]): RouterDeps {
  return {
    anthropic: {} as Anthropic,
    db: orch.db,
    wa: {
      sendText: vi.fn(async (_to: string, body: string) => void sent.push(body)),
    } as unknown as WaClient,
    gateLogger: new MemoryGateLogger(),
    queues: new SerialQueues(),
    agentId: 'agent_test',
    environmentId: 'env_test',
    ledgerMcpUrl: 'https://ledger.example/mcp',
    signingSecret: 'test-secret',
  };
}

const say = (sent: string[], id: string, from: string, text: string) =>
  processInbound(deps(sent), {
    waMessageId: id,
    fromE164: from,
    timestamp: '0',
    kind: 'text',
    text,
  }).catch(() => undefined);

const approvals = async (tenantId: string, id?: string) =>
  admin.db
    .select()
    .from(schema.ownerApprovals)
    .where(
      id
        ? and(
            eq(schema.ownerApprovals.tenantId, tenantId),
            eq(schema.ownerApprovals.waMessageId, id),
          )
        : eq(schema.ownerApprovals.tenantId, tenantId),
    );

describe('owner approval recording', () => {
  it('records a verified "yes" before the turn and does NOT answer it with the trivial reply', async () => {
    const t = await paired('Approve Pasal', '+9779700001001');
    const sent: string[] = [];
    await say(sent, 'wamid.ap1', '+9779700001001', 'yes');
    expect(await approvals(t, 'wamid.ap1')).toHaveLength(1);
    expect(sent).not.toContain(TRIVIAL_REPLY);
  });

  it.each([
    ['yes but change it to the other vendor', '+9779700001101'],
    ['ok 5000', '+9779700001102'],
    ['hello', '+9779700001103'],
    ['hoina', '+9779700001104'],
  ])('PROBE: %j is not an approval', async (text, phone) => {
    const t = await paired(`No Approve ${text}`, phone);
    await say([], `wamid.np.${text}`, phone, text);
    expect(await approvals(t)).toHaveLength(0);
  });

  it('PROBE: a redelivered message id records nothing twice', async () => {
    const t = await paired('Redeliver Pasal', '+9779700001201');
    await say([], 'wamid.dup', '+9779700001201', 'ho');
    await say([], 'wamid.dup', '+9779700001201', 'ho');
    expect(await approvals(t)).toHaveLength(1);
  });
});

describe('role gate', () => {
  it('PROBE: a staff member saying "yes" records NO approval (staff cannot confirm)', async () => {
    const t = await paired('Staff Pasal', '+9779700001301');
    const [u] = await admin.db
      .insert(schema.users)
      .values({ whatsappE164: '+9779700001302' })
      .returning({ id: schema.users.id });
    await admin.db
      .insert(schema.memberships)
      .values({ userId: (u as { id: string }).id, tenantId: t, role: 'staff', status: 'active' });
    await say([], 'wamid.staff.yes', '+9779700001302', 'yes');
    expect(await approvals(t)).toHaveLength(0);
  });
});
