/**
 * Module C LIVE end-to-end (CLAUDE.md §8) — the REAL agent, over a real WhatsApp
 * conversation, exercising the new AR/AP + reports stack and producing a real PDF.
 *
 *   pnpm --filter @hisab/orchestrator verify:reports-live
 *
 * What it does (spends a little Anthropic credit — runs on cheap Sonnet by default):
 *   1. boots the REAL Ledger MCP HTTP server + a Graph stub that captures BOTH text
 *      replies AND document (PDF) sends + media uploads,
 *   2. opens a cloudflared quick tunnel and repoints the agent at it (force-syncs the
 *      new accounts-reports skill); restores the agent afterwards,
 *   3. drives a real session: pair → record a credit PURCHASE → record a credit SALE →
 *      confirm both → "who owes me?" → "send me the debtors PDF",
 *   4. asserts a PDF document was delivered and writes it to ./report-samples/live-*.pdf
 *      so it can be opened and eyeballed.
 *
 * Verdicts PASS|FAIL|BLOCKED; exits non-zero on FAIL/BLOCKED. Needs local Postgres,
 * cloudflared (or LIVE_LEDGER_MCP_URL), and ANTHROPIC_API_KEY.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { createDb, migrate, schema } from '@hisab/db';
import { startHttpServer } from '@hisab/mcp-ledger';
import { buildServer } from './server.js';
import { WaClient } from './whatsapp/wa-client.js';
import { SerialQueues } from './whatsapp/router.js';
import { DbGateLogger } from './audit/audit-logger.js';
import { issuePairingCode } from './onboarding/pairing.js';
import { setup } from './agent/setup.js';
import { dispatchReport } from './reports/dispatch.js';

const ADMIN_URL = process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/hisabkitab_test';
const ORCH_URL = process.env['TEST_ORCH_DATABASE_URL'] ?? 'postgres://hisab_orch:hisab_orch_dev@localhost:5432/hisabkitab_test';
const APP_URL = process.env['TEST_DATABASE_URL'] ?? 'postgres://hisab_app:hisab_app_dev@localhost:5432/hisabkitab_test';
const RESTORE_LEDGER_MCP_URL = process.env['LEDGER_MCP_URL'] ?? 'https://ledger.hisabkitab.example/mcp';

const MCP_PORT = 8862;
const GRAPH_PORT = 8863;
const WEBHOOK_PORT = 8864;
const SIGNING_SECRET = 'reports-live-signing-secret';
const SERVICE_TOKEN = 'reports-live-service-token';
const VERIFY_TOKEN = 'reports-live-verify';
const APP_SECRET = 'reports-live-app-secret';
const OWNER = '9779812345678';

type Verdict = 'PASS' | 'FAIL' | 'BLOCKED';
const results: Array<{ name: string; verdict: Verdict; note: string }> = [];
const record = (name: string, verdict: Verdict, note: string): void => {
  results.push({ name, verdict, note });
  const icon = verdict === 'PASS' ? '✅' : verdict === 'FAIL' ? '❌' : '⛔';
  console.log(`${icon} ${name}: ${verdict} — ${note}`);
};
const trim = (s: string, n = 240): string => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');

// ---- Graph stub: capture text replies, media uploads, and document sends ----
interface SentText { kind: 'text'; to: string; body: string }
interface SentDoc { kind: 'document'; to: string; filename: string; caption: string }
const sent: Array<SentText | SentDoc> = [];
const uploadedPdfs: Buffer[] = [];

const graph: Server = createServer((req, res) => {
  const url = req.url ?? '';
  // media upload (multipart) — capture the PDF bytes, return a media id
  if (req.method === 'POST' && /\/media$/.test(url)) {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const start = buf.indexOf(Buffer.from('%PDF-'));
      if (start >= 0) {
        const end = buf.lastIndexOf(Buffer.from('%%EOF'));
        uploadedPdfs.push(buf.subarray(start, end >= 0 ? end + 5 : undefined));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `media-up-${uploadedPdfs.length}` }));
    });
    return;
  }
  if (req.method === 'POST' && /\/messages$/.test(url)) {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as { to: string; type?: string; text?: { body: string }; document?: { filename: string; caption: string } };
      if (body.type === 'document' && body.document) {
        sent.push({ kind: 'document', to: body.to, filename: body.document.filename, caption: body.document.caption });
      } else {
        sent.push({ kind: 'text', to: body.to, body: body.text?.body ?? '<non-text>' });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: 'wamid.out' }] }));
    });
    return;
  }
  res.writeHead(404).end();
});

async function openTunnel(): Promise<{ url: string; proc?: ChildProcess }> {
  const preset = process.env['LIVE_LEDGER_MCP_URL'];
  if (preset) return { url: preset };
  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${MCP_PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('cloudflared did not produce a URL within 45s'));
    }, 45_000);
    let buf = '';
    const watch = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = /https:\/\/(?!api\.|update\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve({ url: `${m[0]}/mcp`, proc });
      }
    };
    proc.stdout.on('data', watch);
    proc.stderr.on('data', watch);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`cloudflared exited early (code ${code})`)); });
  });
}

async function awaitTunnelReady(url: string): Promise<void> {
  // 401 = our MCP rejected the empty body (reached us, warm). 404/502/530 = edge is
  // up but still warming to the origin — keep polling until the real 401 appears.
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(url, { method: 'POST', body: '{}' });
      if (res.status === 401) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('tunnel never became reachable (no 401 from origin within 80s)');
}

async function main(): Promise<void> {
  process.env['LEDGER_MCP_TOKEN'] = SERVICE_TOKEN;
  process.env['TENANT_SIGNING_SECRET'] = SIGNING_SECRET;
  process.env['DATABASE_URL'] = APP_URL;
  if (!process.env['HISAB_MODEL']) process.env['HISAB_MODEL'] = 'claude-sonnet-4-6'; // cheap by default

  await migrate(ADMIN_URL);
  const mcpServer = startHttpServer(MCP_PORT);
  await new Promise((r) => setTimeout(r, 300));
  const admin = createDb(ADMIN_URL);
  const orch = createDb(ORCH_URL);

  let tunnel: ChildProcess | undefined;
  let agentId: string;
  let environmentId: string;
  let publicUrl: string;
  const anthropic = new Anthropic();
  try {
    const t = await openTunnel();
    tunnel = t.proc;
    publicUrl = t.url;
    await awaitTunnelReady(publicUrl);
    console.log(`  [live] ledger MCP public URL: ${publicUrl}`);
    const s = await setup(anthropic, { ledgerMcpUrl: publicUrl, update: true, forceSkills: true });
    agentId = s.agentId;
    environmentId = s.environmentId;
    console.log(`  [live] agent ${agentId} v${s.agentVersion} on ${process.env['HISAB_MODEL']} → tunnel`);
  } catch (err) {
    record('live-setup', 'BLOCKED', `no public MCP URL / setup failed: ${trim(String(err))}`);
    mcpServer.close();
    await admin.close();
    await orch.close();
    finish();
    return;
  }

  await new Promise<void>((r) => graph.listen(GRAPH_PORT, r));
  const gateLogger = new DbGateLogger(ORCH_URL);
  const wa = new WaClient({ phoneNumberId: 'PHONE_ID', accessToken: 'stub-token', baseUrl: `http://127.0.0.1:${GRAPH_PORT}` });
  const app = buildServer({
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    awaitProcessing: true,
    deps: {
      anthropic,
      db: orch.db,
      wa,
      gateLogger,
      queues: new SerialQueues(),
      agentId,
      environmentId,
      ledgerMcpUrl: publicUrl,
      signingSecret: SIGNING_SECRET,
      turnTimeoutMs: 240_000,
      // Module C: render+deliver the PDF the agent requests, through the SAME public MCP.
      dispatchReport: (tenantId, toE164, req) =>
        dispatchReport(
          {
            db: orch.db,
            ledgerMcpUrl: publicUrl,
            signingSecret: SIGNING_SECRET,
            delivery: {
              sendDocument: (to, bytes, filename, caption) => wa.sendDocument(to, bytes, filename, caption),
              sendText: (to, body) => wa.sendText(to, body),
            },
            audit: { log: () => Promise.resolve() },
            log: (m) => console.log(`  [reports] ${m}`),
          },
          tenantId,
          toE164,
          req,
        ),
      log: (m) => console.log(`  [router] ${m}`),
    },
  });
  await app.listen({ port: WEBHOOK_PORT, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${WEBHOOK_PORT}`;

  const sign = (body: string) => `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
  let seq = 0;
  const say = async (text: string): Promise<string> => {
    const t0 = sent.length;
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: `wamid.r.${(seq += 1)}`, from: OWNER, timestamp: '1718000000', type: 'text', text: { body: text } }] } }] }],
    });
    await fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body }).catch((e) => console.error(`  [post] ${trim(String(e))}`));
    return sent.slice(t0).map((s) => (s.kind === 'text' ? s.body : `[DOC ${s.filename}: ${s.caption}]`)).join('\n');
  };

  const [liveTenant] = await admin.db
    .insert(schema.tenants)
    .values({ businessName: 'Annapurna Trading Pvt Ltd', panOrVatNo: '609911223' })
    .returning({ id: schema.tenants.id });
  const liveTenantId = (liveTenant as { id: string }).id;

  try {
    const code = await issuePairingCode(orch.db, liveTenantId);
    const paired = await say(`START ${code}`);
    record('live-pairing', /welcome|paired|Annapurna|नमस्ते|ready/i.test(paired) ? 'PASS' : paired ? 'FAIL' : 'BLOCKED', trim(paired));

    // Record a credit SALE (customer owes us) — draft → the owner confirms.
    const sale = await say('I sold goods to Sharma Traders on credit today, 14 June 2026, Rs 90,400 including VAT, due in 30 days. Please record it.');
    record('live-record-credit-sale', /9?0,?400|Sharma|draft|confirm|save|शर्मा/i.test(sale) ? 'PASS' : sale ? 'FAIL' : 'BLOCKED', trim(sale));
    const saleYes = await say('Yes, that is correct — please save it. ✅');
    const arRows = await admin.db.select().from(schema.arInvoices).where(eq(schema.arInvoices.tenantId, liveTenantId));
    const confirmedAr = arRows.filter((r) => r.status === 'confirmed');
    record('live-credit-sale-saved', confirmedAr.length === 1 && confirmedAr[0]!.totalPaisa === 9_040_000n ? 'PASS' : saleYes ? 'FAIL' : 'BLOCKED',
      `confirmed AR rows=${confirmedAr.length}, total=${confirmedAr[0]?.totalPaisa}; reply: ${trim(saleYes)}`);

    // Record a credit PURCHASE (we owe a supplier) — exercises the AP path.
    const purchase = await say('I bought stock on credit from Gurung Wholesale, a VAT-registered supplier, bill no B-77 dated 1 June 2026, Rs 45,200 including VAT, for resale, due in 15 days. Record it please.');
    record('live-record-credit-purchase', /4?5,?200|Gurung|draft|confirm|input|VAT|गुरुङ/i.test(purchase) ? 'PASS' : purchase ? 'FAIL' : 'BLOCKED', trim(purchase));
    const purchaseYes = await say('Yes, correct — save it. ✅');
    const apRows = await admin.db.select().from(schema.apBills).where(eq(schema.apBills.tenantId, liveTenantId));
    const confirmedAp = apRows.filter((r) => r.status === 'confirmed');
    record('live-credit-purchase-saved', confirmedAp.length === 1 ? 'PASS' : purchaseYes ? 'FAIL' : 'BLOCKED',
      `confirmed AP rows=${confirmedAp.length}, total=${confirmedAp[0]?.totalPaisa}, input_eligible=${confirmedAp[0]?.inputCreditEligible}; reply: ${trim(purchaseYes)}`);

    // Ask "who owes me?" — must answer from real data (the Sharma invoice).
    const owes = await say('Who owes me money right now, and how much?');
    record('live-who-owes', /Sharma|90,?400|receivable|owe|शर्मा/i.test(owes) ? 'PASS' : owes ? 'FAIL' : 'BLOCKED', trim(owes));

    // Ask for the debtors PDF — the report job must deliver a document.
    const docsBefore = sent.filter((s) => s.kind === 'document').length;
    const ask = await say('Please send me my debtors statement as a PDF.');
    // The report is dispatched AFTER the turn; give it a moment to render+deliver.
    await new Promise((r) => setTimeout(r, 4000));
    const docs = sent.filter((s) => s.kind === 'document') as SentDoc[];
    const newDoc = docs.length > docsBefore ? docs[docs.length - 1] : undefined;
    if (newDoc && uploadedPdfs.length > 0) {
      const pdf = uploadedPdfs[uploadedPdfs.length - 1]!;
      const dir = new URL('../report-samples/', import.meta.url);
      await mkdir(dir, { recursive: true });
      await writeFile(new URL('live-debtors.pdf', dir), pdf);
      const ok = pdf.subarray(0, 5).toString('latin1') === '%PDF-' && pdf.length > 1500;
      record('live-debtors-pdf-delivered', ok ? 'PASS' : 'FAIL', `doc "${newDoc.filename}" (${pdf.length} bytes), caption: ${trim(newDoc.caption)} → saved report-samples/live-debtors.pdf`);
    } else {
      record('live-debtors-pdf-delivered', ask ? 'FAIL' : 'BLOCKED', `no document delivered; last reply: ${trim(ask)}`);
    }

    // Off-topic scope guard still holds.
    const offtopic = await say('By the way, who is the prime minister of Nepal?');
    record('live-scope-guard', /outside|accounts|can'?t help|debtors|sorry|बाहिर/i.test(offtopic) && !/Oli|Dahal|Deuba|Prachanda/i.test(offtopic) ? 'PASS' : offtopic ? 'FAIL' : 'BLOCKED', trim(offtopic));
  } finally {
    const sess = await orch.db.select().from(schema.tenantSessions).where(eq(schema.tenantSessions.tenantId, liveTenantId));
    if (sess[0]) await anthropic.beta.sessions.archive(sess[0].sessionId).catch(() => undefined);
    try {
      const restored = await setup(anthropic, { ledgerMcpUrl: RESTORE_LEDGER_MCP_URL, update: true });
      console.log(`  [live] agent restored to ${RESTORE_LEDGER_MCP_URL} (v${restored.agentVersion})`);
    } catch (err) {
      console.error(`  [live] FAILED to restore agent URL — run agent:setup -- --update manually: ${String(err)}`);
    }
    tunnel?.kill();
    await app.close();
    graph.close();
    await gateLogger.close();
    mcpServer.close();
    await admin.close();
    await orch.close();
  }
  finish();
}

function finish(): void {
  const bad = results.filter((r) => r.verdict !== 'PASS');
  console.log(`\n${results.length - bad.length}/${results.length} PASS`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
