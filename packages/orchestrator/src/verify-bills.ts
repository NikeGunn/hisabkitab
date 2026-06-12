/**
 * Phase 4 runtime verification (CLAUDE.md §8): the bill-extraction confirmation
 * loop, end-to-end, with deliberately messy dummy bills.
 *
 *   pnpm --filter @hisab/orchestrator verify:bills            # deterministic loop over real MCP HTTP
 *   pnpm --filter @hisab/orchestrator verify:bills -- --live  # + REAL agent reads each bill image/PDF
 *
 * Always (no tokens): boots the REAL Ledger MCP HTTP server against the test DB
 * and drives photo-derived figures through validate → record(draft) → confirm
 * with a real MCP client — every probe in the fixture manifest must be caught.
 *
 * --live: the full make-or-break UX. A local Graph stub serves the fixture
 * bills as WhatsApp media; the REAL agent (Managed Agents session) reads each
 * one from its container and must echo/ask/confirm/save correctly. The cloud
 * agent reaches the local MCP server through a cloudflared quick tunnel
 * (auto-spawned; or set LIVE_LEDGER_MCP_URL to any public https URL fronting
 * 127.0.0.1:8842). Without a tunnel the live checks are BLOCKED, not faked.
 */
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import postgres from 'postgres';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDb, migrate, schema } from '@hisab/db';
import { startHttpServer, createTenantToken } from '@hisab/mcp-ledger';
import type { Verdict } from '@hisab/shared';
import { buildServer } from './server.js';
import { WaClient } from './whatsapp/wa-client.js';
import { SerialQueues } from './whatsapp/router.js';
import { DbGateLogger } from './audit/audit-logger.js';
import { issuePairingCode } from './onboarding/pairing.js';
import { setup } from './agent/setup.js';
import { BILL_FIXTURES, fixtureById, type BillFixture } from './bills/fixtures.js';
import { generateBillFixtures } from './bills/generate-fixtures.js';

const ADMIN_URL =
  process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/hisabkitab_test';
const APP_URL =
  process.env['TEST_APP_DATABASE_URL'] ??
  'postgres://hisab_app:hisab_app_dev@localhost:5432/hisabkitab_test';
const ORCH_URL =
  process.env['TEST_ORCH_DATABASE_URL'] ??
  'postgres://hisab_orch:hisab_orch_dev@localhost:5432/hisabkitab_test';

const LIVE = process.argv.includes('--live');
const MCP_PORT = 8842;
const WEBHOOK_PORT = 8843;
const GRAPH_PORT = 8844;
const APP_SECRET = 'verify-bills-app-secret';
const VERIFY_TOKEN = 'verify-bills-verify-token';
const SERVICE_TOKEN = 'verify-bills-service-token';
const SIGNING_SECRET = process.env['TENANT_SIGNING_SECRET'] ?? 'verify-bills-secret';
const OWNER = '9779801112233';
/** Where the agent definition must point AFTER the run (live mode edits it). */
const RESTORE_LEDGER_MCP_URL = process.env['LEDGER_MCP_URL'] ?? 'https://ledger.hisabkitab.example/mcp';

const results: { name: string; verdict: Verdict; detail: string }[] = [];
const record = (name: string, verdict: Verdict, detail: string) => {
  results.push({ name, verdict, detail });
  console.log(`${verdict.padEnd(7)} ${name} — ${detail}`);
};
const trim = (s: string, n = 140): string => s.replace(/\s+/g, ' ').slice(0, n);

// ---- fixtures + test DB --------------------------------------------------------------
const billBytes = await generateBillFixtures();
{
  const sqlAdmin = postgres(ADMIN_URL, { max: 1 });
  await sqlAdmin.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await sqlAdmin.end({ timeout: 5 });
  await migrate(ADMIN_URL);
}
const admin = createDb(ADMIN_URL, 2);
const orch = createDb(ORCH_URL, 2);

// ---- the REAL Ledger MCP HTTP server over the test DB --------------------------------
process.env['LEDGER_MCP_TOKEN'] = SERVICE_TOKEN;
process.env['TENANT_SIGNING_SECRET'] = SIGNING_SECRET;
process.env['DATABASE_URL'] = APP_URL;
const mcpServer = startHttpServer(MCP_PORT);

const [tenantRow] = await admin.db
  .insert(schema.tenants)
  .values({ businessName: 'Sita Cafe', panOrVatNo: '600099999' })
  .returning({ id: schema.tenants.id });
const tenantId = (tenantRow as { id: string }).id;

const mcpClientFor = async (tid: string): Promise<McpClient> => {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
    requestInit: {
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'x-hisab-tenant': createTenantToken(tid, SIGNING_SECRET),
      },
    },
  });
  const client = new McpClient({ name: 'verify-bills', version: '0.0.0' });
  await client.connect(transport);
  return client;
};
const call = async (client: McpClient, name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text?: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
};

// ---- deterministic loop: photo-derived figures → validate → draft → confirm ----------
async function deterministicLoop(): Promise<void> {
  const client = await mcpClientFor(tenantId);
  const clean = fixtureById('clean-rule17');
  const t = clean.truth;

  try {
    // 1. PROBE: mismatch figures (printed lie) must be flagged before any save
    const mm = fixtureById('mismatch-total').truth;
    const v = (await call(client, 'validate_entry', {
      entry_type: 'expense',
      occurred_on: mm.invoiceDateAd,
      vendor_name: mm.vendorName,
      vendor_is_vat_registered: true,
      invoice_no: mm.invoiceNo,
      invoice_type: 'rule17',
      taxable_paisa: mm.taxablePaisa,
      vat_paisa: mm.vatPaisa,
      total_paisa: mm.totalPaisa,
      for_taxable_business_use: true,
    })) as { checks: Array<{ check: string; result: string }> };
    const totalsFlagged = v.checks.some((c) => c.check === 'vat.totals' && c.result !== 'pass');
    record(
      'loop-probe-mismatch-flagged',
      totalsFlagged ? 'PASS' : 'FAIL',
      totalsFlagged ? 'validate_entry flagged taxable+VAT ≠ printed total' : JSON.stringify(v.checks),
    );

    // 2. clean bill records as DRAFT with the exact split + credit
    const rec = (await call(client, 'record_expense', {
      occurred_on: t.invoiceDateAd,
      vendor_name: t.vendorName,
      vendor_is_vat_registered: true,
      invoice_no: t.invoiceNo,
      invoice_type: 'rule17',
      amount_paisa: t.totalPaisa,
      inclusive: true,
      is_service: false,
      for_taxable_business_use: true,
      extraction: { vendor: { value: t.vendorName, confidence: 'high' } },
    })) as { saved: boolean; expense_id: string; status: string; vat_paisa: number; input_credit_eligible: boolean };
    const draftOk =
      rec.saved && rec.status === 'draft' && rec.vat_paisa === t.vatPaisa && rec.input_credit_eligible;
    record(
      'loop-clean-draft',
      draftOk ? 'PASS' : 'FAIL',
      `saved=${rec.saved} status=${rec.status} vat=${rec.vat_paisa} credit=${rec.input_credit_eligible}`,
    );

    // 3. a draft is INVISIBLE to the return until the owner confirms
    const expensesBefore = await admin.db
      .select({ n: dsql<number>`count(*)::int` })
      .from(schema.expenses)
      .where(and(eq(schema.expenses.tenantId, tenantId), eq(schema.expenses.status, 'confirmed')));
    record(
      'loop-draft-not-confirmed',
      (expensesBefore[0]?.n ?? -1) === 0 ? 'PASS' : 'FAIL',
      `confirmed rows before owner confirmation: ${expensesBefore[0]?.n}`,
    );

    // 4. owner's explicit yes → confirm_entry flips it
    const conf = (await call(client, 'confirm_entry', { entry_type: 'expense', entry_id: rec.expense_id })) as {
      ok: boolean;
      status?: string;
    };
    const [row] = await admin.db
      .select()
      .from(schema.expenses)
      .where(eq(schema.expenses.id, rec.expense_id));
    const confirmedOk =
      conf.ok &&
      row?.status === 'confirmed' &&
      row.amountExclVatPaisa === BigInt(t.taxablePaisa ?? 0) &&
      row.vatPaisa === BigInt(t.vatPaisa ?? 0);
    record(
      'loop-confirm-saves-exact-paisa',
      confirmedOk ? 'PASS' : 'FAIL',
      `status=${row?.status} excl=${row?.amountExclVatPaisa} vat=${row?.vatPaisa}`,
    );

    // 5. PROBE: resending the SAME bill is flagged as a duplicate
    const dup = (await call(client, 'record_expense', {
      occurred_on: t.invoiceDateAd,
      vendor_name: t.vendorName,
      vendor_is_vat_registered: true,
      invoice_no: t.invoiceNo,
      invoice_type: 'rule17',
      amount_paisa: t.totalPaisa,
      inclusive: true,
      is_service: false,
      for_taxable_business_use: true,
    })) as { validation: { checks: Array<{ check: string; result: string }> } };
    const dupFlagged = dup.validation.checks.some((c) => c.check === 'duplicate' && c.result !== 'pass');
    record(
      'loop-probe-duplicate-flagged',
      dupFlagged ? 'PASS' : 'FAIL',
      dupFlagged ? 'duplicate warned on vendor+invoice resend' : JSON.stringify(dup.validation.checks),
    );

    // 6. PROBE: 17Ka abbreviated bill gets ZERO input credit
    const ka = fixtureById('abbreviated-17ka').truth;
    const kaRec = (await call(client, 'record_expense', {
      occurred_on: ka.invoiceDateAd,
      vendor_name: ka.vendorName,
      vendor_is_vat_registered: true,
      invoice_no: ka.invoiceNo,
      invoice_type: 'rule17ka',
      amount_paisa: ka.totalPaisa,
      inclusive: true,
      is_service: false,
      for_taxable_business_use: true,
    })) as { saved: boolean; input_credit_eligible: boolean; input_vat_paisa: number; input_credit_reasons: string[] };
    record(
      'loop-probe-17ka-no-credit',
      kaRec.saved && !kaRec.input_credit_eligible && kaRec.input_vat_paisa === 0 ? 'PASS' : 'FAIL',
      `credit=${kaRec.input_credit_eligible} input_vat=${kaRec.input_vat_paisa} (${trim(kaRec.input_credit_reasons?.join('; ') ?? '', 80)})`,
    );

    // 7. PROBE: >1-year-old PDF bill — credit window closed
    const old = fixtureById('old-bill-pdf').truth;
    const oldRec = (await call(client, 'record_expense', {
      occurred_on: old.invoiceDateAd,
      vendor_name: old.vendorName,
      vendor_is_vat_registered: true,
      invoice_no: old.invoiceNo,
      invoice_type: 'rule17',
      amount_paisa: old.totalPaisa,
      inclusive: true,
      is_service: true,
      for_taxable_business_use: true,
    })) as { saved: boolean; input_credit_eligible: boolean; input_credit_reasons: string[] };
    const windowReason = /year|window/i.test(oldRec.input_credit_reasons?.join(' ') ?? '');
    record(
      'loop-probe-old-bill-window',
      oldRec.saved && !oldRec.input_credit_eligible && windowReason ? 'PASS' : 'FAIL',
      `credit=${oldRec.input_credit_eligible} reasons=${trim(oldRec.input_credit_reasons?.join('; ') ?? '', 90)}`,
    );

    // 8. PROBE: the real wild-photo bill — wrong-rate VAT + lapsed credit window
    const wild = fixtureById('wild-real-photo').truth;
    const wv = (await call(client, 'validate_entry', {
      entry_type: 'expense',
      occurred_on: wild.invoiceDateAd,
      vendor_name: wild.vendorName,
      vendor_is_vat_registered: true,
      invoice_no: wild.invoiceNo,
      invoice_type: 'rule17',
      taxable_paisa: wild.taxablePaisa,
      vat_paisa: wild.vatPaisa,
      total_paisa: wild.totalPaisa,
      for_taxable_business_use: true,
    })) as {
      checks: Array<{ check: string; result: string }>;
      input_credit_eligible: boolean;
      validated_figures?: { total_paisa?: number };
    };
    const wildVatFlagged = wv.checks.some((c) => c.check === 'vat.math' && c.result !== 'pass');
    const wildFiguresEchoed = wv.validated_figures?.total_paisa === wild.totalPaisa;
    record(
      'loop-probe-wild-real-bill',
      wildVatFlagged && !wv.input_credit_eligible && wildFiguresEchoed ? 'PASS' : 'FAIL',
      `vat.math flagged=${wildVatFlagged} credit=${wv.input_credit_eligible} figures-echoed=${wildFiguresEchoed} (Rs 3-off VAT + >1yr-old caught)`,
    );

    // 9. the lying mismatch figures were never persisted by anyone
    const [mmRows] = await admin.db
      .select({ n: dsql<number>`count(*)::int` })
      .from(schema.expenses)
      .where(
        and(
          eq(schema.expenses.tenantId, tenantId),
          dsql`${schema.expenses.amountExclVatPaisa} + ${schema.expenses.vatPaisa} = 954000`,
        ),
      );
    record(
      'loop-probe-mismatch-never-saved',
      (mmRows?.n ?? -1) === 0 ? 'PASS' : 'FAIL',
      `rows totalling the lying 9,540: ${mmRows?.n}`,
    );
  } finally {
    await client.close();
  }
}

// ---- live mode: the real agent reads the real images ---------------------------------

interface LiveContext {
  tunnel?: ChildProcess;
  publicMcpUrl: string;
  agentId: string;
  environmentId: string;
  anthropic: Anthropic;
}

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
      // exclude cloudflared's banner hosts (api./update.trycloudflare.com) —
      // quick-tunnel hostnames are always multi-word like noun-noun-noun-noun
      const m = /https:\/\/(?!api\.|update\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve({ url: `${m[0]}/mcp`, proc });
      }
    };
    proc.stdout.on('data', watch);
    proc.stderr.on('data', watch);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited early (code ${code})`));
    });
  });
}

/** Wait until the public URL actually proxies to the local MCP (401 = reached us). */
async function awaitTunnelReady(url: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    try {
      const res = await fetch(url, { method: 'POST', body: '{}' });
      if (res.status === 401 || res.status === 404) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('tunnel never became reachable');
}

const sent: { to: string; body: string }[] = [];
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
  const fileMatch = /\/media-file\/(.+)$/.exec(url);
  if (req.method === 'GET' && fileMatch) {
    const f = fixtureById(decodeURIComponent(fileMatch[1] ?? ''));
    res.writeHead(200, { 'content-type': f.mimeType });
    res.end(billBytes.get(f.file));
    return;
  }
  const metaMatch = /\/v\d+\.\d+\/media-(.+)$/.exec(url);
  if (req.method === 'GET' && metaMatch) {
    const id = decodeURIComponent(metaMatch[1] ?? '');
    const f = fixtureById(id.replace(/-dup$/, ''));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        url: `http://127.0.0.1:${GRAPH_PORT}/media-file/${encodeURIComponent(f.id)}`,
        mime_type: f.mimeType,
        file_size: billBytes.get(f.file)?.length ?? 0,
        id: `media-${id}`,
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

async function liveLoop(): Promise<void> {
  let ctx: LiveContext;
  try {
    const anthropic = new Anthropic();
    const { url, proc } = await openTunnel();
    await awaitTunnelReady(url);
    console.log(`  [live] ledger MCP public URL: ${url}`);
    const setupResult = await setup(anthropic, { ledgerMcpUrl: url, update: true });
    console.log(`  [live] agent ${setupResult.agentId} now v${setupResult.agentVersion} → tunnel`);
    ctx = {
      publicMcpUrl: url,
      agentId: setupResult.agentId,
      environmentId: setupResult.environmentId,
      anthropic,
      ...(proc ? { tunnel: proc } : {}),
    };
  } catch (err) {
    record(
      'live-setup',
      'BLOCKED',
      `no public MCP URL (install cloudflared or set LIVE_LEDGER_MCP_URL): ${trim(String(err))}`,
    );
    return;
  }

  await new Promise<void>((r) => graph.listen(GRAPH_PORT, r));
  const gateLogger = new DbGateLogger(ORCH_URL);
  const app = buildServer({
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    awaitProcessing: true,
    deps: {
      anthropic: ctx.anthropic,
      db: orch.db,
      wa: new WaClient({
        phoneNumberId: 'PHONE_ID',
        accessToken: 'stub-token',
        baseUrl: `http://127.0.0.1:${GRAPH_PORT}`,
      }),
      gateLogger,
      queues: new SerialQueues(),
      agentId: ctx.agentId,
      environmentId: ctx.environmentId,
      ledgerMcpUrl: ctx.publicMcpUrl,
      signingSecret: SIGNING_SECRET,
      // keep each webhook await under undici's 300s headers timeout
      turnTimeoutMs: 240_000,
      log: (m) => console.log(`  [router] ${m}`),
    },
  });
  await app.listen({ port: WEBHOOK_PORT, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${WEBHOOK_PORT}`;

  const sign = (body: string) => `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
  let seq = 0;
  const post = async (message: Record<string, unknown>) => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { messages: [message] } }] }],
    });
    try {
      await fetch(`${base}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
        body,
      });
    } catch (err) {
      console.error(`  [post] webhook fetch failed (turn may still be running): ${trim(String(err))}`);
    }
  };
  const say = async (text: string): Promise<string> => {
    const t0 = sent.length;
    await post({
      id: `wamid.bills.${(seq += 1)}`,
      from: OWNER,
      timestamp: '1718000000',
      type: 'text',
      text: { body: text },
    });
    return sent.slice(t0).map((s) => s.body).join('\n');
  };
  const sendBill = async (f: BillFixture, caption: string, mediaIdSuffix = ''): Promise<string> => {
    const t0 = sent.length;
    const kind = f.format === 'pdf' ? 'document' : 'image';
    await post({
      id: `wamid.bills.${(seq += 1)}`,
      from: OWNER,
      timestamp: '1718000000',
      type: kind,
      [kind]: {
        id: `media-${f.id}${mediaIdSuffix}`,
        mime_type: f.mimeType,
        caption,
        ...(f.format === 'pdf' ? { filename: f.file } : {}),
      },
    });
    return sent.slice(t0).map((s) => s.body).join('\n');
  };
  const confirmedCount = async (where: ReturnType<typeof and>): Promise<number> => {
    const [r] = await admin.db
      .select({ n: dsql<number>`count(*)::int` })
      .from(schema.expenses)
      .where(where);
    return r?.n ?? -1;
  };
  const FIGURE = /(?:NPR|Rs\.?|रु)\s*[0-9][0-9,]*/i;

  // fresh tenant so live rows don't collide with the deterministic loop's rows
  const [liveTenant] = await admin.db
    .insert(schema.tenants)
    .values({ businessName: 'Hari Kirana Pasal', panOrVatNo: '600088888' })
    .returning({ id: schema.tenants.id });
  const liveTenantId = (liveTenant as { id: string }).id;

  try {
    const code = await issuePairingCode(orch.db, liveTenantId);
    await say(`START ${code}`);

    // L1 + L2: clean bill → echo + ask; only an explicit yes saves it
    const clean = fixtureById('clean-rule17');
    const echo = await sendBill(clean, 'Bill from my supplier today, please record it.');
    const echoed = /9,?040/.test(echo);
    const confirmedBefore = await confirmedCount(
      and(eq(schema.expenses.tenantId, liveTenantId), eq(schema.expenses.status, 'confirmed')),
    );
    record(
      'live-clean-echo-asks-first',
      echoed && confirmedBefore === 0 ? 'PASS' : echo ? 'FAIL' : 'BLOCKED',
      `echoed total=${echoed}, confirmed-before-yes=${confirmedBefore}, reply: ${trim(echo)}`,
    );

    const afterYes = await say('Yes, that is all correct — please save it. ✅');
    const savedRows = await admin.db
      .select()
      .from(schema.expenses)
      .where(
        and(
          eq(schema.expenses.tenantId, liveTenantId),
          eq(schema.expenses.status, 'confirmed'),
          eq(schema.expenses.amountExclVatPaisa, 800_000n),
          eq(schema.expenses.vatPaisa, 104_000n),
        ),
      );
    record(
      'live-clean-confirm-saves',
      savedRows.length === 1 ? 'PASS' : afterYes ? 'FAIL' : 'BLOCKED',
      `confirmed rows excl=8,000+vat=1,040: ${savedRows.length}; reply: ${trim(afterYes, 100)}`,
    );

    // L3: PROBE — printed grand total lies (9,540 ≠ 8,000 + 1,040)
    const mm = await sendBill(fixtureById('mismatch-total'), 'another bill from today');
    const mmConfirmed = await confirmedCount(
      and(
        eq(schema.expenses.tenantId, liveTenantId),
        eq(schema.expenses.status, 'confirmed'),
        dsql`${schema.expenses.amountExclVatPaisa} + ${schema.expenses.vatPaisa} = 954000`,
      ),
    );
    record(
      'live-probe-mismatch-held',
      mm.includes('?') && mmConfirmed === 0 ? 'PASS' : mm ? 'FAIL' : 'BLOCKED',
      `asked=${mm.includes('?')}, lying-total confirmed rows=${mmConfirmed}; reply: ${trim(mm)}`,
    );

    // L4: PROBE — 17Ka abbreviated: credit must be denied, never claimed
    const ka = await sendBill(fixtureById('abbreviated-17ka'), 'small bill from the corner shop');
    await say('Yes, please save it.');
    const kaRows = await admin.db
      .select()
      .from(schema.expenses)
      .where(
        and(
          eq(schema.expenses.tenantId, liveTenantId),
          dsql`${schema.expenses.amountExclVatPaisa} + ${schema.expenses.vatPaisa} = 250000`,
        ),
      );
    const kaRow = kaRows[0];
    const kaOk = kaRow !== undefined && !kaRow.inputCreditEligible && kaRow.inputVatPaisa === 0n;
    record(
      'live-probe-17ka-credit-denied',
      kaOk ? 'PASS' : kaRow ? 'FAIL' : 'BLOCKED',
      kaRow
        ? `row credit=${kaRow.inputCreditEligible} input_vat=${kaRow.inputVatPaisa}; reply: ${trim(ka, 90)}`
        : `agent did not save (acceptable only if it asked): ${trim(ka)}`,
    );

    // L5: PROBE — smudged invoice number: must ask, never invent
    const miss = await sendBill(fixtureById('missing-invoice-no'), 'hardware bill');
    const missAsked = miss.includes('?') && /invoice/i.test(miss);
    const everestConfirmed = await confirmedCount(
      and(
        eq(schema.expenses.tenantId, liveTenantId),
        eq(schema.expenses.status, 'confirmed'),
        dsql`${schema.expenses.vendorName} ILIKE '%everest%'`,
      ),
    );
    record(
      'live-probe-missing-field-asked',
      missAsked && everestConfirmed === 0 ? 'PASS' : miss ? 'FAIL' : 'BLOCKED',
      `asked-about-invoice=${missAsked}, confirmed=${everestConfirmed}; reply: ${trim(miss)}`,
    );

    // L6: PROBE — unreadable blur: ask for a clearer photo, state NO figures
    const blur = await sendBill(fixtureById('blurry-unreadable'), 'bill photo');
    const blurInvented = FIGURE.test(blur);
    record(
      'live-probe-blurry-no-invention',
      blur && !blurInvented ? 'PASS' : blur ? 'FAIL' : 'BLOCKED',
      blurInvented ? `INVENTED a figure from a blurred bill: ${trim(blur)}` : `asked instead: ${trim(blur)}`,
    );

    // L7: PROBE — same clean bill again: duplicate warning, not a silent re-save
    const dup = await sendBill(fixtureById('clean-rule17'), 'bill', '-dup');
    const gsConfirmed = await confirmedCount(
      and(
        eq(schema.expenses.tenantId, liveTenantId),
        eq(schema.expenses.status, 'confirmed'),
        dsql`${schema.expenses.invoiceNo} ILIKE 'GS-1142'`,
      ),
    );
    const dupWarned = /alread|duplicate|same bill|दोहोर/i.test(dup);
    record(
      'live-probe-duplicate-warned',
      dupWarned && gsConfirmed <= 1 ? 'PASS' : dup ? 'FAIL' : 'BLOCKED',
      `warned=${dupWarned}, confirmed GS-1142 rows=${gsConfirmed}; reply: ${trim(dup)}`,
    );

    // L8: >1yr PDF — record allowed, input credit must be denied for the window
    const old = await sendBill(fixtureById('old-bill-pdf'), 'an old bill I found in the drawer');
    await say('Yes, save it.');
    const oldRows = await admin.db
      .select()
      .from(schema.expenses)
      .where(
        and(
          eq(schema.expenses.tenantId, liveTenantId),
          dsql`${schema.expenses.amountExclVatPaisa} + ${schema.expenses.vatPaisa} = 452000`,
        ),
      );
    const oldRow = oldRows[0];
    const oldOk = oldRow !== undefined && !oldRow.inputCreditEligible && oldRow.inputVatPaisa === 0n;
    record(
      'live-old-pdf-window-denied',
      oldOk ? 'PASS' : oldRow ? 'FAIL' : 'BLOCKED',
      oldRow
        ? `row credit=${oldRow.inputCreditEligible} input_vat=${oldRow.inputVatPaisa}; reply: ${trim(old, 90)}`
        : `agent did not save: ${trim(old)}`,
    );

    // L9: the real wild-photo bill — must flag the off-13% VAT / lapsed window, not call it clean
    const wildReply = await sendBill(fixtureById('wild-real-photo'), 'found this in the drawer, can you check it');
    const wildFlagged = /13\s?%|credit|year|old|exact|doesn'?t|does not|मिल्दैन/i.test(wildReply);
    const wildConfirmed = await confirmedCount(
      and(
        eq(schema.expenses.tenantId, liveTenantId),
        eq(schema.expenses.status, 'confirmed'),
        dsql`${schema.expenses.amountExclVatPaisa} + ${schema.expenses.vatPaisa} = 30242794`,
      ),
    );
    record(
      'live-wild-real-bill',
      wildReply && wildFlagged && wildConfirmed === 0 ? 'PASS' : wildReply ? 'FAIL' : 'BLOCKED',
      `flagged=${wildFlagged} confirmed-without-yes=${wildConfirmed}; reply: ${trim(wildReply)}`,
    );
  } finally {
    // archive the live session; point the agent definition back at the real URL
    const sess = await orch.db
      .select()
      .from(schema.tenantSessions)
      .where(eq(schema.tenantSessions.tenantId, liveTenantId));
    if (sess[0]) await ctx.anthropic.beta.sessions.archive(sess[0].sessionId).catch(() => undefined);
    try {
      const restored = await setup(ctx.anthropic, { ledgerMcpUrl: RESTORE_LEDGER_MCP_URL, update: true });
      console.log(`  [live] agent restored to ${RESTORE_LEDGER_MCP_URL} (v${restored.agentVersion})`);
    } catch (err) {
      console.error(`  [live] FAILED to restore agent URL — run agent:setup -- --update manually: ${String(err)}`);
    }
    ctx.tunnel?.kill();
    await app.close();
    graph.close();
    await gateLogger.close();
  }
}

// ---- run ------------------------------------------------------------------------------
try {
  await deterministicLoop();
  if (LIVE) {
    await liveLoop();
  } else {
    record('live-bill-loop', 'SKIP', 'run with --live for the real agent over each messy bill (costs tokens)');
  }
} finally {
  mcpServer.close();
  await orch.close();
  await admin.close();
}

const fails = results.filter((r) => r.verdict === 'FAIL');
console.log(`\n${results.length} checks: ${fails.length} FAIL`);
process.exit(fails.length > 0 ? 1 : 0);
