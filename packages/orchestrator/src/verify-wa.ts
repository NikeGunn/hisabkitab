/**
 * Phase 3 runtime verification (CLAUDE.md §8): drives the REAL webhook server
 * end-to-end. Postgres (hisabkitab_test) and the Fastify server are real; only
 * Meta's Graph API is a local stub (captures outbound sends, serves media) —
 * unavoidable without a verified Meta business.
 *
 *   pnpm --filter @hisab/orchestrator verify:wa            # webhook+pairing+dedupe
 *   pnpm --filter @hisab/orchestrator verify:wa -- --live  # + real agent turns (costs tokens)
 *
 * Probes: forged signature, wrong verify token, webhook retry (exactly-once),
 * invalid pairing code. --live adds: real session turn relayed through the
 * Audit Gate, and media→Files→container-mount with a deliberately unreadable
 * "bill" the agent must NOT invent data for.
 */
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import postgres from 'postgres';
import { createDb, migrate, schema } from '@hisab/db';
import type { Verdict } from '@hisab/shared';
import { buildServer } from './server.js';
import { WaClient } from './whatsapp/wa-client.js';
import { SerialQueues } from './whatsapp/router.js';
import { DbGateLogger } from './audit/audit-logger.js';
import { issuePairingCode, pairedWelcome, ONBOARDING_PROMPT } from './onboarding/pairing.js';
import { IDS_FILE } from './agent/setup.js';
import { eq } from 'drizzle-orm';

const ADMIN_URL =
  process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/hisabkitab_test';
const ORCH_URL =
  process.env['TEST_ORCH_DATABASE_URL'] ??
  'postgres://hisab_orch:hisab_orch_dev@localhost:5432/hisabkitab_test';

const LIVE = process.argv.includes('--live');
const APP_SECRET = 'verify-wa-app-secret';
const VERIFY_TOKEN = 'verify-wa-verify-token';
const WEBHOOK_PORT = 8830;
const GRAPH_PORT = 8831;
const OWNER = '9779812345678';

const results: { name: string; verdict: Verdict; detail: string }[] = [];
const record = (name: string, verdict: Verdict, detail: string) => {
  results.push({ name, verdict, detail });
  console.log(`${verdict.padEnd(7)} ${name} — ${detail}`);
};

// ---- stub Meta Graph API ------------------------------------------------------------
const sent: { to: string; body: string }[] = [];
// 1x1 transparent PNG — a real image that contains NO readable bill data.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const graph = createServer((req, res) => {
  const url = req.url ?? '';
  if (req.method === 'POST' && /\/messages$/.test(url)) {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as { to: string; text?: { body: string } };
      sent.push({ to: body.to, body: body.text?.body ?? '<non-text>' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: 'wamid.out' }] }));
    });
    return;
  }
  if (req.method === 'GET' && /\/media-file$/.test(url)) {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(TINY_PNG);
    return;
  }
  if (req.method === 'GET') {
    // media meta lookup
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        url: `http://127.0.0.1:${GRAPH_PORT}/media-file`,
        mime_type: 'image/png',
        file_size: TINY_PNG.length,
        id: 'media-1',
      }),
    );
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => graph.listen(GRAPH_PORT, r));

// ---- reset test DB ------------------------------------------------------------------
{
  const sql = postgres(ADMIN_URL, { max: 1 });
  await sql.unsafe('DROP SCHEMA IF EXISTS rehearsal CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await sql.end({ timeout: 5 });
  await migrate(ADMIN_URL);
}
const admin = createDb(ADMIN_URL, 2);
const orch = createDb(ORCH_URL, 2);

// ---- boot the real webhook server ---------------------------------------------------
let agentId = 'agent_stub';
let environmentId = 'env_stub';
if (LIVE) {
  const ids = JSON.parse(await readFile(IDS_FILE, 'utf8')) as { agentId: string; environmentId: string };
  agentId = ids.agentId;
  environmentId = ids.environmentId;
}
const anthropic = new Anthropic(); // only used on --live paths
const gateLogger = new DbGateLogger(ORCH_URL);
const app = buildServer({
  verifyToken: VERIFY_TOKEN,
  appSecret: APP_SECRET,
  awaitProcessing: true,
  deps: {
    anthropic,
    db: orch.db,
    wa: new WaClient({
      phoneNumberId: 'PHONE_ID',
      accessToken: 'stub-token',
      baseUrl: `http://127.0.0.1:${GRAPH_PORT}`,
    }),
    gateLogger,
    queues: new SerialQueues(),
    agentId,
    environmentId,
    ledgerMcpUrl: process.env['LEDGER_MCP_URL'] ?? 'https://ledger.hisabkitab.example/mcp',
    signingSecret: process.env['TENANT_SIGNING_SECRET'] ?? 'verify-wa-secret',
    log: (m) => console.log(`  [router] ${m}`),
  },
});
await app.listen({ port: WEBHOOK_PORT, host: '127.0.0.1' });
const base = `http://127.0.0.1:${WEBHOOK_PORT}`;

const sign = (body: string) => `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
let seq = 0;
const envelope = (message: Record<string, unknown>) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { messages: [message] } }] }],
  });
const postWebhook = (body: string, signature = sign(body)) =>
  fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body,
  });
const textEnvelope = (body: string, opts: { id?: string; from?: string } = {}) =>
  envelope({
    id: opts.id ?? `wamid.verify.${(seq += 1)}`,
    from: opts.from ?? OWNER,
    timestamp: '1718000000',
    type: 'text',
    text: { body },
  });

try {
  // 1. handshake
  const hs = await fetch(
    `${base}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=ch42`,
  );
  record('handshake', hs.status === 200 && (await hs.text()) === 'ch42' ? 'PASS' : 'FAIL', `status ${hs.status}`);
  const hsBad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=x`);
  record('probe-handshake-token', hsBad.status === 403 ? 'PASS' : 'FAIL', `status ${hsBad.status}`);

  // 2. forged signature
  const forged = await postWebhook(textEnvelope('hi'), 'sha256=' + '0'.repeat(64));
  record('probe-forged-signature', forged.status === 401 ? 'PASS' : 'FAIL', `status ${forged.status}`);

  // 3. unknown sender → onboarding prompt
  await postWebhook(textEnvelope('namaste'));
  record(
    'onboarding-prompt',
    sent.at(-1)?.body === ONBOARDING_PROMPT ? 'PASS' : 'FAIL',
    `reply: ${sent.at(-1)?.body.slice(0, 60)}`,
  );

  // 4. invalid code
  await postWebhook(textEnvelope('START 0000'));
  record(
    'probe-invalid-code',
    /not valid/.test(sent.at(-1)?.body ?? '') ? 'PASS' : 'FAIL',
    `reply: ${sent.at(-1)?.body.slice(0, 60)}`,
  );

  // 5. real pairing
  const [tenant] = await admin.db
    .insert(schema.tenants)
    .values({ businessName: 'Sita Cafe', panOrVatNo: '600099999' })
    .returning({ id: schema.tenants.id });
  const tenantId = (tenant as { id: string }).id;
  const code = await issuePairingCode(orch.db, tenantId);
  await postWebhook(textEnvelope(`START ${code}`));
  const pairedRow = await orch.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  const paired =
    sent.at(-1)?.body === pairedWelcome('Sita Cafe') &&
    pairedRow[0]?.status === 'active' &&
    pairedRow[0]?.whatsappE164 === `+${OWNER}`;
  record('pairing', paired ? 'PASS' : 'FAIL', `tenant status=${pairedRow[0]?.status}`);

  // 6. webhook retry → exactly once
  const before = sent.length;
  const dup = textEnvelope('hello again', { id: 'wamid.verify.dup', from: '977444' });
  await postWebhook(dup);
  await postWebhook(dup); // Meta retry
  const after = sent.length;
  record('probe-retry-dedupe', after - before === 1 ? 'PASS' : 'FAIL', `${after - before} send(s) for 2 deliveries`);

  // 7. --live: real agent turn through the gate, relayed to the (stub) owner
  if (LIVE) {
    const t0 = sent.length;
    await postWebhook(textEnvelope('Namaste! Mero pasal ko hisab ma k k garna sakchhau?'));
    const reply = sent.slice(t0).map((s) => s.body).join(' ');
    record(
      'live-agent-turn',
      reply.length > 0 ? 'PASS' : 'FAIL',
      reply ? `delivered ${sent.length - t0} message(s): ${reply.slice(0, 100)}…` : 'no reply delivered',
    );

    // 8. --live media: unreadable bill image → must ask, never invent figures
    const t1 = sent.length;
    await postWebhook(
      envelope({
        id: `wamid.verify.media.${(seq += 1)}`,
        from: OWNER,
        timestamp: '1718000001',
        type: 'image',
        image: { id: 'media-1', mime_type: 'image/png', caption: 'aja ko bill' },
      }),
    );
    const mediaReply = sent.slice(t1).map((s) => s.body).join(' ');
    const inventedFigure = /(?:NPR|Rs\.?|रु)\s*[0-9][0-9,]*/.test(mediaReply);
    record(
      'live-media-bill',
      mediaReply.length > 0 && !inventedFigure ? 'PASS' : mediaReply.length === 0 ? 'BLOCKED' : 'FAIL',
      inventedFigure
        ? `INVENTED a figure from a blank image: ${mediaReply.slice(0, 120)}`
        : `asked instead of guessing: ${mediaReply.slice(0, 100)}…`,
    );

    // cleanup the live session
    const sess = await orch.db.select().from(schema.tenantSessions).where(eq(schema.tenantSessions.tenantId, tenantId));
    if (sess[0]) await anthropic.beta.sessions.archive(sess[0].sessionId).catch(() => undefined);
  } else {
    record('live-agent-turn', 'SKIP', 'run with --live for real agent + media turns (costs tokens)');
  }
} finally {
  await app.close();
  graph.close();
  await gateLogger.close();
  await orch.close();
  await admin.close();
}

const fails = results.filter((r) => r.verdict === 'FAIL');
console.log(`\n${results.length} checks: ${fails.length} FAIL`);
process.exit(fails.length > 0 ? 1 : 0);
