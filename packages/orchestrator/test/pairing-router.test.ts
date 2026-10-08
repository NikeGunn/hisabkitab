/**
 * Pairing + dedupe against REAL Postgres as hisab_orch (RLS-bypassing webhook
 * role from migration 0002). PROBES: wrong/expired/reused codes, webhook retry.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { createDb, schema, type DbHandle } from '@hisab/db';
import type Anthropic from '@anthropic-ai/sdk';
import {
  findTenantBySender,
  handleUnknownSender,
  issuePairingCode,
  ONBOARDING_PROMPT,
  SUSPENDED_ACCOUNT_REPLY,
  underReviewReply,
} from '../src/onboarding/pairing.js';
import {
  processInbound,
  SerialQueues,
  UNSUPPORTED_REPLY,
  PROCESSING_FAILURE_REPLY,
  type RouterDeps,
} from '../src/whatsapp/router.js';
import { MemoryGateLogger } from '../src/audit/audit-logger.js';
import { TenantRateLimiter } from '../src/resilience/rate-limit.js';
import type { WaClient } from '../src/whatsapp/wa-client.js';
import type { InboundMessage } from '../src/whatsapp/inbound.js';
import { ADMIN_URL, ORCH_URL } from './urls.js';

let admin: DbHandle;
let orch: DbHandle;
let tenantId: string;

beforeAll(async () => {
  admin = createDb(ADMIN_URL, 2);
  orch = createDb(ORCH_URL, 2);
  const [t] = await admin.db
    .insert(schema.tenants)
    .values({ businessName: 'Karki Cafe', panOrVatNo: '600000001' })
    .returning({ id: schema.tenants.id });
  tenantId = (t as { id: string }).id;
});

afterAll(async () => {
  await orch.close();
  await admin.close();
});

const textMsg = (id: string, from: string, body: string): InboundMessage => ({
  waMessageId: id,
  fromE164: from,
  timestamp: '0',
  kind: 'text',
  text: body,
});

function makeDeps(sent: { to: string; body: string }[]): RouterDeps {
  return {
    anthropic: {} as Anthropic, // never reached in these paths
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
  };
}

describe('pairing flow (PRD v1.0 §13)', () => {
  it('binds the number, activates the tenant, consumes the code, audit-logs', async () => {
    const code = await issuePairingCode(orch.db, tenantId);
    const outcome = await handleUnknownSender(orch.db, '+9779801111111', `start ${code}`);
    expect(outcome).toEqual({ kind: 'paired', tenantId, businessName: 'Karki Cafe' });

    const [t] = await orch.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    expect(t).toMatchObject({ status: 'active', whatsappE164: '+9779801111111' });

    expect(await findTenantBySender(orch.db, '+9779801111111')).toEqual({
      tenantId,
      businessName: 'Karki Cafe',
    });

    const audits = await admin.db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, tenantId));
    expect(audits.some((a) => a.action === 'whatsapp_paired')).toBe(true);
  });

  it('PROBE: a consumed code cannot pair a second number', async () => {
    const code = await issuePairingCode(orch.db, tenantId);
    await handleUnknownSender(orch.db, '+100', `START ${code}`);
    expect(await handleUnknownSender(orch.db, '+200', `START ${code}`)).toEqual({ kind: 'invalid_code' });
  });

  it('PROBE: wrong and expired codes are rejected; random text is no_code', async () => {
    expect(await handleUnknownSender(orch.db, '+300', 'START 0000')).toEqual({ kind: 'invalid_code' });
    expect(await handleUnknownSender(orch.db, '+300', 'hello?')).toEqual({ kind: 'no_code' });

    const code = await issuePairingCode(orch.db, tenantId);
    await orch.db
      .update(schema.pairingCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.pairingCodes.code, code));
    expect(await handleUnknownSender(orch.db, '+300', `START ${code}`)).toEqual({ kind: 'invalid_code' });
  });
});

describe('processInbound routing', () => {
  it('PROBE: a webhook retry (same wa message id) is processed exactly once', async () => {
    const sent: { to: string; body: string }[] = [];
    const deps = makeDeps(sent);
    const msg = textMsg('wamid.dup1', '+9779809999999', 'hello');
    expect(await processInbound(deps, msg)).toBe(true);
    expect(await processInbound(deps, msg)).toBe(false); // dedupe
    expect(sent).toHaveLength(1); // one onboarding prompt, not two
  });

  it('unknown sender without a code gets the onboarding prompt', async () => {
    const sent: { to: string; body: string }[] = [];
    await processInbound(makeDeps(sent), textMsg('wamid.ob1', '+9779808888888', 'namaste'));
    expect(sent[0]?.body).toBe(ONBOARDING_PROMPT);
  });

  it('voice notes get the coming-soon reply (never silently dropped)', async () => {
    const [t2] = await admin.db
      .insert(schema.tenants)
      .values({ businessName: 'Thapa Suppliers', panOrVatNo: '600000002' })
      .returning({ id: schema.tenants.id });
    const code = await issuePairingCode(orch.db, (t2 as { id: string }).id);
    await handleUnknownSender(orch.db, '+9779807777777', `START ${code}`);

    const sent: { to: string; body: string }[] = [];
    await processInbound(makeDeps(sent), {
      waMessageId: 'wamid.audio1',
      fromE164: '+9779807777777',
      timestamp: '0',
      kind: 'audio',
      media: { mediaId: 'm', mimeType: 'audio/ogg' },
    });
    expect(sent[0]?.body).toBe(UNSUPPORTED_REPLY);
  });

  it('PROBE: a credential (OTP) is refused BEFORE reaching the agent, and audit-logged', async () => {
    const [t3] = await admin.db
      .insert(schema.tenants)
      .values({ businessName: 'Secret Pasal', panOrVatNo: '600000003' })
      .returning({ id: schema.tenants.id });
    const id3 = (t3 as { id: string }).id;
    const code = await issuePairingCode(orch.db, id3);
    await handleUnknownSender(orch.db, '+9779806666666', `START ${code}`);

    const sent: { to: string; body: string }[] = [];
    // anthropic is {} in makeDeps — if the guard FAILED to short-circuit, the
    // session call would throw. A clean refusal proves the agent was never reached.
    const ok = await processInbound(makeDeps(sent), textMsg('wamid.cred1', '+9779806666666', 'my OTP is 482913'));
    expect(ok).toBe(true);
    expect(sent[0]?.body).toMatch(/never send passwords/i);
    expect(sent[0]?.body).not.toContain('482913'); // secret never echoed

    const audits = await admin.db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, id3));
    const blocked = audits.find((a) => a.action === 'credential_blocked');
    expect(blocked).toBeTruthy();
    expect(JSON.stringify(blocked!.detail)).not.toContain('482913'); // not persisted raw
  });

  it('PROBE: a per-tenant rate limit throttles a burst (cost guard), then the nudge is sent', async () => {
    const [t4] = await admin.db
      .insert(schema.tenants)
      .values({ businessName: 'Flood Pasal', panOrVatNo: '600000004' })
      .returning({ id: schema.tenants.id });
    const code = await issuePairingCode(orch.db, (t4 as { id: string }).id);
    await handleUnknownSender(orch.db, '+9779805555555', `START ${code}`);

    const sent: { to: string; body: string }[] = [];
    const deps: RouterDeps = { ...makeDeps(sent), rateLimiter: new TenantRateLimiter({ capacity: 2, refillPerSec: 0 }) };
    // capacity 2 → first two pass to the (stubbed) agent path; the 3rd is throttled.
    // anthropic is {} so a non-throttled message would throw — but a plain "hello"
    // with no media reaches getOrCreateTenantSession; to keep this unit on the
    // rate path we send greetings that the agent path would handle, and assert the
    // 3rd gets the rate-limited reply.
    await processInbound(deps, textMsg('wamid.f1', '+9779805555555', 'hi')).catch(() => undefined);
    await processInbound(deps, textMsg('wamid.f2', '+9779805555555', 'hi')).catch(() => undefined);
    await processInbound(deps, textMsg('wamid.f3', '+9779805555555', 'hi')).catch(() => undefined);
    expect(sent.some((s) => /sending messages very quickly/i.test(s.body))).toBe(true);
  });
});

describe('crash containment (a message is NEVER silently lost)', () => {
  it('PROBE: a crash before any reply releases the dedupe claim and asks the owner to resend', async () => {
    // Pair a fresh tenant, then send a substantive message. anthropic is {} in
    // makeDeps, so the agent path throws at getOrCreateTenantSession — a stand-in
    // for any mid-pipeline outage (Anthropic down, session-create failure).
    const [t5] = await admin.db
      .insert(schema.tenants)
      .values({ businessName: 'Crash Pasal', panOrVatNo: '600000005' })
      .returning({ id: schema.tenants.id });
    const code = await issuePairingCode(orch.db, (t5 as { id: string }).id);
    await handleUnknownSender(orch.db, '+9779804444444', `START ${code}`);

    const sent: { to: string; body: string }[] = [];
    const deps = makeDeps(sent);
    const msg = textMsg('wamid.crash1', '+9779804444444', 'sold catering 9000');
    await expect(processInbound(deps, msg)).rejects.toThrow();

    // the owner was told to resend (never a silent drop)
    expect(sent.some((s) => s.body === PROCESSING_FAILURE_REPLY)).toBe(true);
    // the dedupe claim was released, so a redelivery of the SAME id is processed
    // again (it re-crashes here, but it is not swallowed as a dupe)
    const rows = await orch.db
      .select()
      .from(schema.waEvents)
      .where(eq(schema.waEvents.waMessageId, 'wamid.crash1'));
    expect(rows).toHaveLength(0);
    await expect(processInbound(deps, msg)).rejects.toThrow(); // NOT false-dedupe
  });

  it('a crash on a pre-agent path (unknown sender) also releases and apologizes', async () => {
    const sent: { to: string; body: string }[] = [];
    const deps = makeDeps(sent);
    // resolveMembership dies → claim must be released
    const broken = { ...deps, db: new Proxy(deps.db, {
      get(target, prop) {
        if (prop === 'select') throw new Error('db down');
        return Reflect.get(target, prop);
      },
    }) as typeof deps.db };
    await expect(
      processInbound(broken, textMsg('wamid.crash2', '+9779803333333', 'hello')),
    ).rejects.toThrow('db down');
    expect(sent.some((s) => s.body === PROCESSING_FAILURE_REPLY)).toBe(true);
    const rows = await orch.db
      .select()
      .from(schema.waEvents)
      .where(eq(schema.waEvents.waMessageId, 'wamid.crash2'));
    expect(rows).toHaveLength(0);
  });
});

describe('SerialQueues', () => {
  it('evicts a settled tail (the per-sender map drains to zero — leak probe)', async () => {
    const q = new SerialQueues();
    await q.run('sender-a', async () => 'done');
    await q.run('sender-b', async () => {
      throw new Error('boom');
    }).catch(() => undefined);
    // eviction runs on the settle microtask — yield once
    await new Promise((r) => setTimeout(r, 0));
    expect(q.size).toBe(0);
  });

  it('serializes per key, runs keys concurrently, survives failures', async () => {
    const q = new SerialQueues();
    const order: string[] = [];
    const slow = (label: string, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(label);
      return label;
    };
    const failing = async () => {
      throw new Error('boom');
    };

    const results = await Promise.allSettled([
      q.run('a', slow('a1', 30)),
      q.run('a', failing),
      q.run('a', slow('a2', 1)),
      q.run('b', slow('b1', 5)),
    ]);
    expect(order).toEqual(['b1', 'a1', 'a2']); // b ran while a1 was in flight; a2 after a1
    expect(results[1]?.status).toBe('rejected'); // failure surfaced, queue kept going
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'a2' });
  });
});

describe('operator-suspended business (admin panel → Suspend)', () => {
  it('PROBE: the owner is told the account is paused: no agent turn, no signup-loop prompt; reactivation restores routing', async () => {
    const [t] = await admin.db
      .insert(schema.tenants)
      .values({ businessName: 'Paused Pasal', panOrVatNo: '600000077' })
      .returning({ id: schema.tenants.id });
    const owner = '+9779807777001';
    const code = await issuePairingCode(orch.db, t!.id);
    expect((await handleUnknownSender(orch.db, owner, `START ${code}`)).kind).toBe('paired');
    await admin.db.update(schema.tenants).set({ status: 'suspended' }).where(eq(schema.tenants.id, t!.id));

    const sent: { to: string; body: string }[] = [];
    // anthropic is {} in makeDeps: reaching the agent would crash → PROCESSING_FAILURE_REPLY
    await processInbound(makeDeps(sent), textMsg('wamid.susp1', owner, 'sales today 5000'));
    expect(sent).toEqual([{ to: owner, body: SUSPENDED_ACCOUNT_REPLY }]);
    // a START from the paused owner must not re-pair or reveal anything else
    await processInbound(makeDeps(sent), textMsg('wamid.susp2', owner, 'START 1234'));
    expect(sent.at(-1)?.body).toBe(SUSPENDED_ACCOUNT_REPLY);
    const [after] = await admin.db.select().from(schema.tenants).where(eq(schema.tenants.id, t!.id));
    expect(after?.status).toBe('suspended');
  });

  it('PROBE: a stranger still gets the onboarding prompt (the paused reply leaks no business to others)', async () => {
    const sent: { to: string; body: string }[] = [];
    await processInbound(makeDeps(sent), textMsg('wamid.susp3', '+9779807777999', 'hello'));
    expect(sent[0]?.body).toBe(ONBOARDING_PROMPT);
  });
});

describe('issuePairingCode revoke', () => {
  it('PROBE: a resend revokes only LIVE codes; an already-dead code keeps the moment it died', async () => {
    const [t] = await admin.db
      .insert(schema.tenants)
      .values({ businessName: 'Revoke Probe', panOrVatNo: '600000078' })
      .returning({ id: schema.tenants.id });
    const dead = await issuePairingCode(orch.db, t!.id, { phoneE164: '+9779807777002', digits: 6 });
    await admin.db
      .update(schema.pairingCodes)
      .set({ expiresAt: sql`now() - interval '1 hour'` })
      .where(eq(schema.pairingCodes.code, dead));
    const [before] = await admin.db.select().from(schema.pairingCodes).where(eq(schema.pairingCodes.code, dead));
    const live = await issuePairingCode(orch.db, t!.id, { phoneE164: '+9779807777002', digits: 6 });
    await issuePairingCode(orch.db, t!.id, { phoneE164: '+9779807777002', digits: 6 });
    const [deadAfter] = await admin.db.select().from(schema.pairingCodes).where(eq(schema.pairingCodes.code, dead));
    expect(deadAfter!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    const [liveAfter] = await admin.db.select().from(schema.pairingCodes).where(eq(schema.pairingCodes.code, live));
    expect(liveAfter!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000); // revoked
    const stillLive = await admin.db
      .select()
      .from(schema.pairingCodes)
      .where(and(eq(schema.pairingCodes.tenantId, t!.id), isNull(schema.pairingCodes.consumedAt), gt(schema.pairingCodes.expiresAt, sql`now()`)));
    expect(stillLive).toHaveLength(1);
  });
});

describe('pilot applications over WhatsApp (review first)', () => {
  async function applicationFor(phone: string, review: 'awaiting' | 'approved' | 'declined'): Promise<string> {
    const [t] = await admin.db
      .insert(schema.tenants)
      .values({ businessName: 'Review Traders', panOrVatNo: '604444444', signupSource: 'web', reviewStatus: review, applicantE164: phone })
      .returning({ id: schema.tenants.id });
    return t!.id;
  }

  it('PROBE: an awaiting applicant gets the under-review reply, never the agent, never paired', async () => {
    const phone = '+9779807770001';
    const id = await applicationFor(phone, 'awaiting');
    const sent: { to: string; body: string }[] = [];
    await processInbound(makeDeps(sent), textMsg('wamid.review-1', phone, 'hello, can I start?'));
    expect(sent).toEqual([{ to: phone, body: underReviewReply('Review Traders') }]);
    const [t] = await orch.db.select().from(schema.tenants).where(eq(schema.tenants.id, id));
    expect(t).toMatchObject({ status: 'pending', whatsappE164: null });
  });

  it('approved applicant: a bare "ok" or an image (no text) pairs it and welcomes the owner', async () => {
    for (const [i, msg] of [
      textMsg('wamid.review-2', '+9779807770002', 'ok'),
      { waMessageId: 'wamid.review-3', fromE164: '+9779807770003', timestamp: '0', kind: 'image' } as InboundMessage,
    ].entries()) {
      const id = await applicationFor(msg.fromE164, 'approved');
      const sent: { to: string; body: string }[] = [];
      await processInbound(makeDeps(sent), msg);
      expect(sent, String(i)).toHaveLength(1);
      expect(sent[0]!.body).toContain('Review Traders');
      expect(sent[0]!.body).not.toBe(ONBOARDING_PROMPT);
      const [t] = await orch.db.select().from(schema.tenants).where(eq(schema.tenants.id, id));
      expect(t).toMatchObject({ status: 'active', whatsappE164: msg.fromE164 });
    }
  });

  it('PROBE: a declined applicant just gets the normal onboarding prompt', async () => {
    const phone = '+9779807770004';
    await applicationFor(phone, 'declined');
    const sent: { to: string; body: string }[] = [];
    await processInbound(makeDeps(sent), textMsg('wamid.review-4', phone, 'hi'));
    expect(sent).toEqual([{ to: phone, body: ONBOARDING_PROMPT }]);
  });
});
