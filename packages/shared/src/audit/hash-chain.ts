/**
 * Tamper-evident audit-log hash-chain (PRD v2.0 §9; CLAUDE.md §3 "audit-log
 * immutability + hash-chaining"). PURE, no IO.
 *
 * The audit_log is the financial system of record — the SINGLE source of truth for
 * "what the agent and owner actually did". Append-only grants stop the app from
 * editing rows, but a DB-level actor (or a bug) could still rewrite history
 * silently. Hash-chaining makes that DETECTABLE: each row carries
 *
 *   row_hash = SHA-256( prev_hash + "\n" + canonical(row) )
 *
 * where `prev_hash` is the previous row's `row_hash` for the SAME tenant (the
 * genesis row chains from GENESIS_HASH). Any insert, edit, delete, or reorder
 * changes a hash and breaks every link after it, so a pure re-walk catches it.
 *
 * Canonicalisation is deterministic (stable key order, integer ms timestamp) so the
 * same row always hashes the same on write and on verify — no float/format drift.
 */
import { createHash } from 'node:crypto';

/** The chain root: the prev_hash of a tenant's very first audit row. */
export const GENESIS_HASH = '0'.repeat(64);

/** The fields that are hashed. `id` is NOT included (it's assigned by the DB and
 *  the chain order is carried by prev_hash, not the serial). */
export interface AuditRowCore {
  tenantId: string;
  actor: string;
  action: string;
  /** The detail JSON (any shape) — canonicalised deterministically below. */
  detail: unknown;
  /** Creation time as integer epoch ms (stable across read/write; no tz drift). */
  createdAtMs: number;
}

/** Deterministic JSON: object keys sorted recursively, so the bytes never drift. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** The exact preimage string that gets hashed for a row (prev_hash + canonical row). */
export function auditRowPreimage(prevHash: string, row: AuditRowCore): string {
  const canonicalRow = canonicalize({
    tenantId: row.tenantId,
    actor: row.actor,
    action: row.action,
    detail: row.detail ?? null,
    createdAtMs: row.createdAtMs,
  });
  return `${prevHash}\n${canonicalRow}`;
}

/** row_hash = SHA-256(prev_hash + "\n" + canonical(row)), hex. */
export function hashAuditRow(prevHash: string, row: AuditRowCore): string {
  return createHash('sha256').update(auditRowPreimage(prevHash, row)).digest('hex');
}

/** A stored row as read back for verification (carries its recorded hashes). */
export interface ChainedAuditRow extends AuditRowCore {
  prevHash: string;
  rowHash: string;
}

export type ChainVerdict =
  | { verdict: 'PASS'; rows: number }
  | { verdict: 'FAIL'; rows: number; brokenAtIndex: number; reason: string };

/**
 * Re-walk a tenant's rows IN ORDER and prove the chain is intact:
 *   - row 0's prev_hash must be GENESIS_HASH,
 *   - each row's prev_hash must equal the previous row's row_hash,
 *   - each row's recorded row_hash must equal the recomputed hash.
 * The first violation is reported (a tamper anywhere breaks here). Empty = PASS.
 */
export function verifyAuditChain(rows: readonly ChainedAuditRow[]): ChainVerdict {
  let prev = GENESIS_HASH;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.prevHash !== prev) {
      return { verdict: 'FAIL', rows: rows.length, brokenAtIndex: i, reason: `prev_hash mismatch at row ${i} (chain broken or row inserted/deleted)` };
    }
    const expected = hashAuditRow(prev, row);
    if (row.rowHash !== expected) {
      return { verdict: 'FAIL', rows: rows.length, brokenAtIndex: i, reason: `row_hash mismatch at row ${i} (row content was altered)` };
    }
    prev = row.rowHash;
  }
  return { verdict: 'PASS', rows: rows.length };
}
