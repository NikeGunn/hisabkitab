import { describe, expect, it } from 'vitest';
import { validatedFiguresEcho } from '../src/tools.js';

describe('validatedFiguresEcho (finding #2: validate_entry output is gate evidence)', () => {
  it('a bare VAT-inclusive total also returns its 13% split', () => {
    expect(validatedFiguresEcho({ total_paisa: 1130000 })).toEqual({
      total_paisa: 1130000,
      if_vat_inclusive_13pct: { excl_paisa: 1000000, vat_paisa: 130000 },
    });
  });
  it('explicit figures are echoed verbatim and never re-derived', () => {
    expect(
      validatedFiguresEcho({ taxable_paisa: 1000000, vat_paisa: 130000, total_paisa: 1130000 }),
    ).toEqual({
      taxable_paisa: 1000000,
      vat_paisa: 130000,
      total_paisa: 1130000,
    });
  });
  it('PROBE: a lying printed VAT is echoed as given (validation, not the echo, judges it) — no derived split added', () => {
    const e = validatedFiguresEcho({ vat_paisa: 999, total_paisa: 1130000 });
    expect(e).not.toHaveProperty('if_vat_inclusive_13pct');
  });
});
