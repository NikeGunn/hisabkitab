/**
 * verify_filing_deadline contract test (PRD v1.1 §5) over a real MCP client +
 * Postgres. The governance guarantee: a web-fetched IRD date can CONFIRM the
 * computed deadline but NEVER overwrite it — disagreement HOLDS (BLOCKED).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { DbHandle } from '@hisab/db';
import { appDb, createTenant, openSession, type TestSession } from './helpers.js';
import { ADMIN_URL } from './urls.js';

let handle: DbHandle;
let session: TestSession;
let tenantId: string;
const adminSql = postgres(ADMIN_URL, { max: 1 });

beforeAll(async () => {
  handle = appDb();
  tenantId = await createTenant('Deadline Pasal');
  session = await openSession(handle, tenantId);
});

afterAll(async () => {
  await session.close();
  await handle.close();
  await adminSql.end({ timeout: 5 });
});

type Res = { filing_deadline_ad: string; verdict: string; detail: string; source?: string };

describe('verify_filing_deadline', () => {
  it('SKIP when no web observation is given, but still returns the computed deadline', async () => {
    const r = await session.callTool<Res>('verify_filing_deadline', { bs_year: 2082, bs_month: 1 });
    expect(r.verdict).toBe('SKIP');
    expect(r.filing_deadline_ad).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('PASS when the supplied IRD date matches the computed one', async () => {
    // first read the computed value, then feed it back as the "observed" web value
    const base = await session.callTool<Res>('verify_filing_deadline', { bs_year: 2082, bs_month: 2 });
    const r = await session.callTool<Res>('verify_filing_deadline', {
      bs_year: 2082,
      bs_month: 2,
      observed_deadline_ad: base.filing_deadline_ad,
      source_url: 'https://ird.gov.np/tax-calendar',
    });
    expect(r.verdict).toBe('PASS');
    expect(r.source).toBe('https://ird.gov.np/tax-calendar');
  });

  it('PROBE: a DISAGREEING web date BLOCKS and never overwrites the computed deadline', async () => {
    const base = await session.callTool<Res>('verify_filing_deadline', { bs_year: 2082, bs_month: 3 });
    const r = await session.callTool<Res>('verify_filing_deadline', {
      bs_year: 2082,
      bs_month: 3,
      observed_deadline_ad: '2000-01-01', // obviously wrong scrape
      source_url: 'https://ird.gov.np/x',
    });
    expect(r.verdict).toBe('BLOCKED');
    // the computed deadline is preserved — the bogus web date is NOT adopted
    expect(r.filing_deadline_ad).toBe(base.filing_deadline_ad);
    expect(r.filing_deadline_ad).not.toBe('2000-01-01');
  });

  it('audits every verification (proof of the source + verdict)', async () => {
    await session.callTool<Res>('verify_filing_deadline', {
      bs_year: 2082,
      bs_month: 4,
      observed_deadline_ad: '2000-01-01',
      source_url: 'https://ird.gov.np/audit-check',
    });
    const rows = await adminSql`
      SELECT detail FROM audit_log
      WHERE tenant_id = ${tenantId} AND action = 'verify_filing_deadline'
        AND detail->>'source_url' = 'https://ird.gov.np/audit-check'`;
    expect(rows.length).toBe(1);
    expect((rows[0]!['detail'] as { verdict: string }).verdict).toBe('BLOCKED');
  });
});
