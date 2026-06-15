/**
 * Tamper-evident audit-log hash-chain (PRD v2.0 §9). The point of the probes: a
 * silently altered / inserted / deleted / reordered row MUST be caught.
 */
import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  hashAuditRow,
  verifyAuditChain,
  canonicalize,
  type AuditRowCore,
  type ChainedAuditRow,
} from '../src/index.js';

const TENANT = '11111111-2222-3333-4444-555555555555';

/** Build a valid chain of `n` rows (each chained from the previous row_hash). */
function buildChain(n: number): ChainedAuditRow[] {
  const rows: ChainedAuditRow[] = [];
  let prev = GENESIS_HASH;
  for (let i = 0; i < n; i += 1) {
    const core: AuditRowCore = {
      tenantId: TENANT,
      actor: 'agent',
      action: `record_sale.${i}`,
      detail: { i, amount_paisa: 1000 * (i + 1) },
      createdAtMs: 1_700_000_000_000 + i * 1000,
    };
    const rowHash = hashAuditRow(prev, core);
    rows.push({ ...core, prevHash: prev, rowHash });
    prev = rowHash;
  }
  return rows;
}

describe('canonicalize', () => {
  it('is stable regardless of key order', () => {
    expect(canonicalize({ b: 1, a: { d: 4, c: 3 } })).toBe(canonicalize({ a: { c: 3, d: 4 }, b: 1 }));
  });
});

describe('verifyAuditChain', () => {
  it('PASS on an empty log and on a valid chain', () => {
    expect(verifyAuditChain([]).verdict).toBe('PASS');
    expect(verifyAuditChain(buildChain(5)).verdict).toBe('PASS');
  });

  it('PROBE: editing a row detail is caught (row_hash mismatch)', () => {
    const rows = buildChain(5);
    // someone edits row 2's amount but leaves the stored hashes
    rows[2] = { ...rows[2]!, detail: { i: 2, amount_paisa: 999_999 } };
    const v = verifyAuditChain(rows);
    expect(v.verdict).toBe('FAIL');
    if (v.verdict === 'FAIL') {
      expect(v.brokenAtIndex).toBe(2);
      expect(v.reason).toMatch(/altered/);
    }
  });

  it('PROBE: deleting a row breaks the chain (prev_hash mismatch)', () => {
    const rows = buildChain(5);
    rows.splice(2, 1); // remove row 2 — row 3's prev_hash no longer matches row 1
    const v = verifyAuditChain(rows);
    expect(v.verdict).toBe('FAIL');
    if (v.verdict === 'FAIL') expect(v.brokenAtIndex).toBe(2);
  });

  it('PROBE: inserting a forged row is caught', () => {
    const rows = buildChain(5);
    const forged: ChainedAuditRow = {
      tenantId: TENANT,
      actor: 'agent',
      action: 'record_sale.evil',
      detail: { amount_paisa: 1 },
      createdAtMs: 1_700_000_002_500,
      prevHash: rows[2]!.rowHash,
      rowHash: 'deadbeef'.repeat(8),
    };
    rows.splice(3, 0, forged);
    expect(verifyAuditChain(rows).verdict).toBe('FAIL');
  });

  it('PROBE: reordering two rows is caught', () => {
    const rows = buildChain(5);
    [rows[1], rows[2]] = [rows[2]!, rows[1]!];
    expect(verifyAuditChain(rows).verdict).toBe('FAIL');
  });

  it('PROBE: a tampered genesis prev_hash is caught', () => {
    const rows = buildChain(3);
    rows[0] = { ...rows[0]!, prevHash: 'f'.repeat(64) };
    const v = verifyAuditChain(rows);
    expect(v.verdict).toBe('FAIL');
    if (v.verdict === 'FAIL') expect(v.brokenAtIndex).toBe(0);
  });
});
