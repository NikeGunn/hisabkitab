/**
 * P13 accounting-completeness contract tests over the REAL tenant-bound Ledger MCP.
 * Covers: gap-free sequential invoice numbering (per BS fiscal year), the FY reset at
 * the Shrawan boundary, credit/debit notes against a CONFIRMED invoice (draft→confirm),
 * and the RBAC gate. Adversarial PROBES per CLAUDE.md §8 are marked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@hisab/db';
import { appDb, createTenant, openSession, type TestSession } from './helpers.js';

let handle: DbHandle;
let tenant: string;
let s: TestSession;

beforeAll(async () => {
  handle = appDb();
  tenant = await createTenant('P13 Pasal');
  s = await openSession(handle, tenant);
});

afterAll(async () => {
  await s.close();
  await handle.close();
});

interface NumberResult {
  fiscal_year: number;
  fiscal_year_label: string;
  sequence: number;
  number: string;
}
interface NoteResult {
  saved: boolean;
  reason?: string;
  note_id: string;
  note_no: string;
  kind: string;
  status: string;
  taxable_paisa: number;
  vat_paisa: number;
  total_paisa: number;
}

/** Record + confirm a credit sale; return its invoice id (reused as the note target). */
async function confirmedInvoice(amountPaisa: number): Promise<{ id: string; total: number; vat: number; taxable: number }> {
  const r = await s.callTool<{ saved: boolean; invoice_id: string; total_paisa: number; vat_paisa: number; taxable_paisa: number }>(
    'record_credit_sale',
    { party: 'Note Customer', issued_on: '2026-03-01', amount_paisa: amountPaisa },
  );
  expect(r.saved).toBe(true);
  await s.callTool('confirm_arap_entry', { entry_type: 'ar_invoice', entry_id: r.invoice_id });
  return { id: r.invoice_id, total: r.total_paisa, vat: r.vat_paisa, taxable: r.taxable_paisa };
}

describe('sequential invoice numbering', () => {
  it('allocates gap-free, increasing numbers within a fiscal year', async () => {
    // 2026-03 (AD) falls in BS month ~Falgun 2082 → fiscal year 2082.
    const a = await s.callTool<NumberResult>('next_invoice_number', { issued_on: '2026-03-10' });
    const b = await s.callTool<NumberResult>('next_invoice_number', { issued_on: '2026-03-11' });
    const c = await s.callTool<NumberResult>('next_invoice_number', { issued_on: '2026-03-12' });
    expect(b.sequence).toBe(a.sequence + 1);
    expect(c.sequence).toBe(b.sequence + 1);
    expect(a.fiscal_year).toBe(b.fiscal_year);
    expect(a.number).toMatch(/^\d{4}\/\d{2}-\d{4}$/);
  });

  it('PROBE: a different fiscal year has an INDEPENDENT series starting at 1', async () => {
    // Use a fresh tenant so the count is deterministic.
    const t2 = await createTenant('FY Boundary Pasal');
    const s2 = await openSession(handle, t2);
    try {
      // Shrawan (BS month 4) 2083 ≈ late July 2026 → FY 2083.
      const fy2083 = await s2.callTool<NumberResult>('next_invoice_number', { issued_on: '2026-08-01' });
      // Falgun 2082 ≈ March 2026 → FY 2082.
      const fy2082 = await s2.callTool<NumberResult>('next_invoice_number', { issued_on: '2026-03-01' });
      expect(fy2083.fiscal_year).not.toBe(fy2082.fiscal_year);
      expect(fy2083.sequence).toBe(1);
      expect(fy2082.sequence).toBe(1); // independent series, also starts at 1
    } finally {
      await s2.close();
    }
  });

  it('PROBE: concurrent allocations never reuse or skip a number', async () => {
    const t3 = await createTenant('Concurrency Pasal');
    const s3 = await openSession(handle, t3);
    try {
      const N = 12;
      const results = await Promise.all(
        Array.from({ length: N }, () => s3.callTool<NumberResult>('next_invoice_number', { issued_on: '2026-03-15' })),
      );
      const seqs = results.map((r) => r.sequence).sort((a, b) => a - b);
      // gap-free 1..N, each exactly once (no dupes, no gaps) despite racing.
      expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    } finally {
      await s3.close();
    }
  });
});

describe('credit / debit notes', () => {
  it('a credit note against a CONFIRMED invoice saves as a draft and confirms', async () => {
    const inv = await confirmedInvoice(1_130_000); // Rs 11,300 incl → 10,000 + 1,300 VAT
    const note = await s.callTool<NoteResult>('issue_note', {
      original_invoice_id: inv.id,
      kind: 'credit',
      issued_on: '2026-03-20',
      amount_paisa: 565_000, // half, inclusive
      reason: 'partial return',
    });
    expect(note.saved).toBe(true);
    expect(note.status).toBe('draft');
    expect(note.taxable_paisa + note.vat_paisa).toBe(note.total_paisa);
    expect(note.note_no).toMatch(/^\d{4}\/\d{2}-\d{4}$/);
    const c = await s.callTool<{ ok: boolean; status: string }>('confirm_note', { note_id: note.note_id });
    expect(c.ok).toBe(true);
    expect(c.status).toBe('confirmed');
  });

  it('PROBE: a credit note larger than the original is REJECTED, nothing saved', async () => {
    const inv = await confirmedInvoice(1_130_000);
    const note = await s.callTool<NoteResult>('issue_note', {
      original_invoice_id: inv.id,
      kind: 'credit',
      issued_on: '2026-03-20',
      amount_paisa: 2_000_000, // way more than the original
    });
    expect(note.saved).toBe(false);
    expect(note.reason).toMatch(/exceeds|cannot credit/i);
  });

  it('PROBE: a note against a DRAFT (unconfirmed) invoice is REJECTED', async () => {
    const draft = await s.callTool<{ invoice_id: string }>('record_credit_sale', {
      party: 'Draft Customer',
      issued_on: '2026-03-01',
      amount_paisa: 226_000,
    });
    const note = await s.callTool<NoteResult>('issue_note', {
      original_invoice_id: draft.invoice_id,
      kind: 'credit',
      issued_on: '2026-03-22',
      amount_paisa: 113_000,
    });
    expect(note.saved).toBe(false);
    expect(note.reason).toMatch(/confirmed/i);
  });

  it('a debit note (under-bill correction) may add to the invoice', async () => {
    const inv = await confirmedInvoice(1_130_000);
    const note = await s.callTool<NoteResult>('issue_note', {
      original_invoice_id: inv.id,
      kind: 'debit',
      issued_on: '2026-03-25',
      amount_paisa: 226_000,
    });
    expect(note.saved).toBe(true);
    expect(note.kind).toBe('debit');
  });
});

describe('RBAC', () => {
  it('PROBE: a viewer cannot issue a note (record_entry denied server-side)', async () => {
    const viewer = await openSession(handle, tenant, 'viewer');
    try {
      const res = await viewer.callToolRaw('issue_note', {
        original_invoice_id: '00000000-0000-0000-0000-000000000000',
        kind: 'credit',
        issued_on: '2026-03-20',
        amount_paisa: 100_000,
      });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/role|permission|denied|cannot/i);
    } finally {
      await viewer.close();
    }
  });
});
