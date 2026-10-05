/**
 * Pre-delivery Audit Gate — fixtures + invariants + adversarial PROBES (CLAUDE.md §8).
 * The probes feed the gate messages that LIE (figures with no tool evidence,
 * messages after a validation fail) — the gate MUST hold them.
 */
import { describe, expect, it } from 'vitest';
import {
  addToolResultEvidence,
  auditOutbound,
  canonNumber,
  correctiveInstruction,
  extractMoneyFigures,
  newTurnEvidence,
  shiftDecimal,
  HELD_FALLBACK_MESSAGE,
} from '../src/audit/gate.js';

describe('canonNumber / shiftDecimal (string math, no floats)', () => {
  it('normalizes separators and trailing zeros', () => {
    expect(canonNumber('1,130.00')).toBe('1130');
    expect(canonNumber('1,23,456.50')).toBe('123456.5');
    expect(canonNumber('0.50')).toBe('0.5');
    expect(canonNumber('007')).toBe('7');
    expect(canonNumber('abc')).toBe('');
  });

  it('shifts paisa↔rupee without floats', () => {
    expect(shiftDecimal('113000', -2)).toBe('1130');
    expect(shiftDecimal('1130', 2)).toBe('113000');
    expect(shiftDecimal('1130.5', 2)).toBe('113050');
    expect(shiftDecimal('5', -2)).toBe('0.05');
    expect(shiftDecimal('0.05', 2)).toBe('5');
  });
});

describe('extractMoneyFigures', () => {
  it('finds currency-marked and separator-formatted amounts', () => {
    const figures = extractMoneyFigures(
      'Total Rs 9,040.00 (VAT रु 1,040) — NPR 8,000 taxable; also 1,23,456 receivable.',
    );
    expect(new Set(figures)).toEqual(new Set(['9040', '1040', '8000', '123456']));
  });

  it('ignores bare small integers, percentages and dates (not money claims)', () => {
    expect(extractMoneyFigures('VAT rate is 13% — file by 2082-09-25, within 1 year.')).toEqual([]);
  });
});

describe('auditOutbound — happy paths', () => {
  it('delivers a message with no figures', () => {
    expect(auditOutbound('Namaste! How can I help with your hisab today?', newTurnEvidence())).toEqual(
      { action: 'deliver' },
    );
  });

  it('delivers figures evidenced by a tool result (paisa→rupee equivalence)', () => {
    const ev = newTurnEvidence();
    addToolResultEvidence(ev, '{"excl_paisa":800000,"vat_paisa":104000,"total_paisa":904000}');
    const msg = 'Bill: taxable Rs 8,000.00 + VAT Rs 1,040.00 = total Rs 9,040.00. Confirm?';
    expect(auditOutbound(msg, ev)).toEqual({ action: 'deliver' });
  });

  it('delivers rupee-denominated tool evidence quoted as rupees', () => {
    const ev = newTurnEvidence();
    addToolResultEvidence(ev, '{"net_payable":"1130.00"}');
    expect(auditOutbound('Net VAT payable: Rs 1,130', ev)).toEqual({ action: 'deliver' });
  });
});

describe('auditOutbound — adversarial PROBES (must catch lies)', () => {
  it('PROBE: holds an invented figure with no tool evidence', () => {
    const d = auditOutbound('Your VAT due is Rs 1,040.00 — shall I record it?', newTurnEvidence());
    expect(d.action).toBe('hold');
    if (d.action === 'hold') expect(d.reasons.join(' ')).toContain('1040');
  });

  it('PROBE: holds a figure that does not match any tool number', () => {
    const ev = newTurnEvidence();
    addToolResultEvidence(ev, '{"vat_paisa":104000}'); // 1,040 — agent says 1,140
    expect(auditOutbound('VAT is Rs 1,140.00', ev).action).toBe('hold');
  });

  it('PROBE: holds even a verified figure when validation failed this turn', () => {
    const ev = newTurnEvidence();
    addToolResultEvidence(ev, '{"result":"fail","reason":"totals do not reconcile","total_paisa":904000}');
    const d = auditOutbound('Saved! Total Rs 9,040.00 recorded.', ev);
    expect(d.action).toBe('hold');
    if (d.action === 'hold') expect(d.reasons.join(' ')).toContain('validation failed');
  });

  it('PROBE: an errored tool result contributes NO evidence', () => {
    const ev = newTurnEvidence();
    addToolResultEvidence(ev, '{"vat_paisa":104000}', { isError: true });
    expect(auditOutbound('VAT is Rs 1,040.00', ev).action).toBe('hold');
  });

  it('PROBE: digits inside ids/uuids never verify a money figure', () => {
    const ev = newTurnEvidence();
    addToolResultEvidence(ev, '{"sale_id":"a1040b-9040x"}');
    expect(auditOutbound('VAT is Rs 1,040', ev).action).toBe('hold');
  });
});

describe('hold messaging', () => {
  it('corrective instruction names the reasons; fallback states no figures', () => {
    const d = auditOutbound('Rs 5,555 due.', newTurnEvidence());
    expect(d.action).toBe('hold');
    if (d.action === 'hold') {
      expect(correctiveInstruction(d)).toContain('5555');
      expect(correctiveInstruction(d)).toContain('validate_entry');
    }
    expect(extractMoneyFigures(HELD_FALLBACK_MESSAGE)).toEqual([]);
  });
});

describe('owner figures + whole-turn evidence (live regression 2026-10-05)', () => {
  it('the total the OWNER typed may be echoed; derived figures still need a tool', async () => {
    const { addOwnerFigures } = await import('../src/audit/gate.js');
    const ev = newTurnEvidence();
    addOwnerFigures(ev, 'Aaja cash sale bhayo: Rs 11,300 including VAT, invoice 101');
    expect(auditOutbound('Total (VAT incl.): Rs 11,300.00', ev)).toEqual({ action: 'deliver' });
    // PROBE: VAT the owner never typed and no tool returned is still HELD
    expect(auditOutbound('VAT: Rs 1,300.00', ev).action).toBe('hold');
    addToolResultEvidence(ev, '{"excl_paisa":1000000,"vat_paisa":130000,"total_paisa":1130000}');
    expect(auditOutbound('Taxable Rs 10,000.00, VAT Rs 1,300.00, total Rs 11,300.00', ev)).toEqual({
      action: 'deliver',
    });
    // PROBE: an invented figure is still caught even with owner + tool evidence present
    expect(auditOutbound('Your net payable is Rs 4,567.00', ev).action).toBe('hold');
  });
});
