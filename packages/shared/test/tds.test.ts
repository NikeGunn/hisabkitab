import { describe, expect, it } from 'vitest';
import { MoneyError } from '../src/money/money.js';
import { computeTds, tdsBase } from '../src/tds/tds.js';

const BASE = 800_000n; // Rs 8,000 excl VAT

describe('tdsBase', () => {
  it('strips VAT from an inclusive total', () => {
    expect(tdsBase(904_000n, 104_000n)).toBe(800_000n);
  });

  it('PROBE: rejects impossible total/VAT pairs', () => {
    expect(() => tdsBase(100n, 200n)).toThrow(MoneyError);
    expect(() => tdsBase(100n, -1n)).toThrow(MoneyError);
  });
});

describe('computeTds — service/contract', () => {
  it('1.5% when the recipient is VAT-registered', () => {
    expect(computeTds({ category: 'service_contract', baseExclVatPaisa: BASE, recipientVatRegistered: true })).toEqual(
      { kind: 'computed', rateBps: 150, tdsPaisa: 12_000n, baseExclVatPaisa: BASE },
    );
  });

  it('15% when PAN-only', () => {
    const d = computeTds({ category: 'service_contract', baseExclVatPaisa: BASE, recipientVatRegistered: false });
    expect(d).toMatchObject({ kind: 'computed', rateBps: 1500, tdsPaisa: 120_000n });
  });

  it('asks instead of guessing when VAT status is unknown', () => {
    expect(computeTds({ category: 'service_contract', baseExclVatPaisa: BASE }).kind).toBe('ask_accountant');
  });

  it('contract threshold: no TDS at exactly NPR 50,000 cumulative, TDS once exceeded', () => {
    const atThreshold = computeTds({
      category: 'service_contract',
      baseExclVatPaisa: 1_000_000n, // this payment Rs 10,000
      recipientVatRegistered: true,
      cumulativePaidThisYearPaisa: 4_000_000n, // Rs 40,000 before → exactly 50,000 total
    });
    expect(atThreshold.kind).toBe('not_applicable');

    const overThreshold = computeTds({
      category: 'service_contract',
      baseExclVatPaisa: 1_000_001n,
      recipientVatRegistered: true,
      cumulativePaidThisYearPaisa: 4_000_000n,
    });
    expect(overThreshold.kind).toBe('computed');
  });
});

describe('computeTds — rent', () => {
  it('PROBE: individual landlord is exempt (Sec 88(5)) even if payer is an entity', () => {
    const d = computeTds({
      category: 'rent_land_building',
      baseExclVatPaisa: BASE,
      payerIsEntity: true,
      landlordIsIndividual: true,
    });
    expect(d.kind).toBe('exempt');
  });

  it('10% when an entity pays a non-individual landlord', () => {
    const d = computeTds({
      category: 'rent_land_building',
      baseExclVatPaisa: BASE,
      payerIsEntity: true,
      landlordIsIndividual: false,
    });
    expect(d).toMatchObject({ kind: 'computed', rateBps: 1000, tdsPaisa: 80_000n });
  });

  it('asks when the facts are not established', () => {
    expect(computeTds({ category: 'rent_land_building', baseExclVatPaisa: BASE }).kind).toBe('ask_accountant');
  });
});

describe('computeTds — other categories', () => {
  it('vehicle rent: 1.5% VAT-registered / 10% not', () => {
    expect(
      computeTds({ category: 'vehicle_transport_rent', baseExclVatPaisa: BASE, recipientVatRegistered: true }),
    ).toMatchObject({ rateBps: 150 });
    expect(
      computeTds({ category: 'vehicle_transport_rent', baseExclVatPaisa: BASE, recipientVatRegistered: false }),
    ).toMatchObject({ rateBps: 1000 });
  });

  it('dividend 5%, interest 15%, commission 15%', () => {
    expect(computeTds({ category: 'dividend', baseExclVatPaisa: BASE })).toMatchObject({ rateBps: 500 });
    expect(computeTds({ category: 'interest', baseExclVatPaisa: BASE })).toMatchObject({ rateBps: 1500 });
    expect(computeTds({ category: 'commission', baseExclVatPaisa: BASE })).toMatchObject({ rateBps: 1500 });
  });

  it('goods purchases carry no TDS', () => {
    expect(computeTds({ category: 'goods', baseExclVatPaisa: BASE }).kind).toBe('not_applicable');
  });

  it('PROBE: salary must never be estimated with a flat rate', () => {
    expect(computeTds({ category: 'salary', baseExclVatPaisa: BASE }).kind).toBe('ask_accountant');
  });

  it('PROBE: negative base throws', () => {
    expect(() => computeTds({ category: 'dividend', baseExclVatPaisa: -1n })).toThrow(MoneyError);
  });
});
