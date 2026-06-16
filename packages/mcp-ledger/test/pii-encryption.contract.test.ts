/**
 * Field-level PII encryption (P15, PRD v2.0 §9) over the REAL tenant-bound Ledger
 * MCP + Postgres. Proves a vendor/party PAN is stored ENCRYPTED at rest (the raw
 * column is ciphertext, plaintext never appears) yet the tool returns it decrypted,
 * and — the PROBE — a row written with the key cannot be read back as plaintext from
 * the DB. Toggles the key via the @hisab/db test seam.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { __setPiiKeyForTests, type DbHandle } from '@hisab/db';
import { appDb, createTenant, openSession, type TestSession } from './helpers.js';
import { ADMIN_URL } from './urls.js';

const KEY = randomBytes(32);
const admin = postgres(ADMIN_URL, { max: 2 });
let handle: DbHandle;

beforeAll(() => {
  handle = appDb();
});
afterAll(async () => {
  __setPiiKeyForTests(null); // restore dev default for other suites
  await admin.end({ timeout: 5 });
  await handle.close();
});
afterEach(() => __setPiiKeyForTests(null));

interface VendorResult {
  vendor_id: string;
  name: string;
  pan_vat_no: string | null;
  is_vat_registered: boolean | null;
}

describe('vendor PAN encryption', () => {
  it('stores the PAN encrypted at rest but returns it decrypted', async () => {
    __setPiiKeyForTests(KEY);
    const tenantId = await createTenant('Crypto Vendor Pasal');
    const s: TestSession = await openSession(handle, tenantId);
    try {
      const PAN = '301234567';
      const v = await s.callTool<VendorResult>('upsert_vendor', { name: 'Acme', pan_vat_no: PAN });
      expect(v.pan_vat_no).toBe(PAN); // tool returns plaintext

      // the RAW column is ciphertext, never the plaintext PAN
      const [row] = await admin`SELECT pan_vat_no FROM vendors WHERE id = ${v.vendor_id}`;
      const stored = row!['pan_vat_no'] as string;
      expect(stored.startsWith('enc:v1:')).toBe(true);
      expect(stored).not.toContain(PAN);

      // get_vendor round-trips it back to plaintext
      const got = await s.callTool<{ found: boolean; pan_vat_no: string }>('get_vendor', { name: 'Acme' });
      expect(got.pan_vat_no).toBe(PAN);
    } finally {
      await s.close();
    }
  });

  it('PROBE: a PAN written WITH the key is unreadable as plaintext from the raw column', async () => {
    __setPiiKeyForTests(KEY);
    const tenantId = await createTenant('Probe Vendor Pasal');
    const s = await openSession(handle, tenantId);
    try {
      await s.callTool('upsert_vendor', { name: 'Secret Co', pan_vat_no: '600099999' });
      const leaked = await admin`SELECT count(*)::int AS n FROM vendors WHERE pan_vat_no LIKE '%600099999%'`;
      expect(leaked[0]!['n']).toBe(0); // the digits never sit in the DB
    } finally {
      await s.close();
    }
  });

  it('dev mode (no key) stores plaintext — back-compat, nothing breaks', async () => {
    __setPiiKeyForTests(null);
    const tenantId = await createTenant('Dev Vendor Pasal');
    const s = await openSession(handle, tenantId);
    try {
      const v = await s.callTool<VendorResult>('upsert_vendor', { name: 'Plain Co', pan_vat_no: '500011111' });
      expect(v.pan_vat_no).toBe('500011111');
      const [row] = await admin`SELECT pan_vat_no FROM vendors WHERE id = ${v.vendor_id}`;
      expect(row!['pan_vat_no']).toBe('500011111'); // plaintext in dev
    } finally {
      await s.close();
    }
  });
});

describe('party PAN encryption', () => {
  it('stores a party PAN encrypted and returns it decrypted', async () => {
    __setPiiKeyForTests(KEY);
    const tenantId = await createTenant('Crypto Party Pasal');
    const s = await openSession(handle, tenantId);
    try {
      const p = await s.callTool<{ party_id: string; pan_vat_no: string }>('upsert_party', {
        name: 'Big Customer',
        pan_vat_no: '609911223',
      });
      expect(p.pan_vat_no).toBe('609911223');
      const [row] = await admin`SELECT pan_vat_no FROM parties WHERE id = ${p.party_id}`;
      expect((row!['pan_vat_no'] as string).startsWith('enc:v1:')).toBe(true);
    } finally {
      await s.close();
    }
  });
});
