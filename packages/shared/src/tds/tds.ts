/**
 * Nepal TDS pure functions (PRD v1.1 §5.2, Income Tax Act 2058 / Finance Act 2082).
 * The base is ALWAYS the amount EXCLUDING VAT — the type and function names enforce it.
 * Ambiguous cases (salary slabs, mixed/foreign) return `ask_accountant`, never an estimate.
 */
import { MoneyError, mulBps, type Paisa } from '../money/money.js';
import { defaultTaxConfig, type TaxConfig } from '../config/tax.js';

export type TdsCategory =
  | 'service_contract'
  | 'rent_land_building'
  | 'vehicle_transport_rent'
  | 'dividend'
  | 'interest'
  | 'commission'
  | 'salary'
  | 'goods';

export interface TdsInput {
  category: TdsCategory;
  /** Taxable amount EXCLUDING VAT. Use `tdsBase()` to derive it from an inclusive total. */
  baseExclVatPaisa: Paisa;
  /** Required for service/contract and vehicle rent. */
  recipientVatRegistered?: boolean;
  /** Rent: payer is a company/entity (10%); individual landlords are exempt (Sec 88(5)). */
  payerIsEntity?: boolean;
  /** Rent: landlord is an individual person. */
  landlordIsIndividual?: boolean;
  /** Service/contract: cumulative already paid to this party this FY, excluding this payment. */
  cumulativePaidThisYearPaisa?: Paisa;
}

export type TdsDecision =
  | { kind: 'computed'; rateBps: number; tdsPaisa: Paisa; baseExclVatPaisa: Paisa }
  | { kind: 'exempt'; reason: string }
  | { kind: 'not_applicable'; reason: string }
  | { kind: 'ask_accountant'; reason: string };

/** Derive the TDS base from a VAT-inclusive total: base = total − VAT. Never the VAT portion. */
export function tdsBase(totalPaisa: Paisa, vatPaisa: Paisa): Paisa {
  if (vatPaisa < 0n || totalPaisa < vatPaisa) {
    throw new MoneyError('invalid total/VAT for TDS base');
  }
  return totalPaisa - vatPaisa;
}

export function computeTds(input: TdsInput, cfg: TaxConfig = defaultTaxConfig): TdsDecision {
  const base = input.baseExclVatPaisa;
  if (base < 0n) throw new MoneyError(`TDS base cannot be negative: ${base}`);

  const computed = (rateBps: number): TdsDecision => ({
    kind: 'computed',
    rateBps,
    tdsPaisa: mulBps(base, rateBps),
    baseExclVatPaisa: base,
  });

  switch (input.category) {
    case 'goods':
      return { kind: 'not_applicable', reason: 'TDS generally does not apply to purchase of goods' };

    case 'salary':
      return {
        kind: 'ask_accountant',
        reason:
          'salary TDS uses progressive slabs (1%–39% + 1% SST) and needs full income data — do not estimate',
      };

    case 'service_contract': {
      if (input.cumulativePaidThisYearPaisa !== undefined) {
        const cumulative = input.cumulativePaidThisYearPaisa + base;
        if (cumulative <= cfg.contractTdsThresholdPaisa) {
          return {
            kind: 'not_applicable',
            reason:
              'cumulative payments to this party have not exceeded the NPR 50,000/year contract threshold',
          };
        }
      }
      if (input.recipientVatRegistered === undefined) {
        return {
          kind: 'ask_accountant',
          reason: 'recipient VAT registration status unknown — rate is 1.5% vs 15%, please confirm',
        };
      }
      return computed(
        input.recipientVatRegistered ? cfg.tdsServiceVatRegisteredBps : cfg.tdsServicePanOnlyBps,
      );
    }

    case 'rent_land_building': {
      if (input.landlordIsIndividual === true) {
        return { kind: 'exempt', reason: 'individual landlords are exempt from rent TDS (Sec 88(5))' };
      }
      if (input.payerIsEntity === true) return computed(cfg.tdsRentEntityBps);
      return {
        kind: 'ask_accountant',
        reason: 'rent TDS depends on payer being an entity and landlord type — please confirm both',
      };
    }

    case 'vehicle_transport_rent': {
      if (input.recipientVatRegistered === undefined) {
        return {
          kind: 'ask_accountant',
          reason: 'recipient VAT registration status unknown — rate is 1.5% vs 10%, please confirm',
        };
      }
      return computed(
        input.recipientVatRegistered ? cfg.tdsVehicleVatRegisteredBps : cfg.tdsVehicleNonVatBps,
      );
    }

    case 'dividend':
      return computed(cfg.tdsDividendBps);
    case 'interest':
      return computed(cfg.tdsInterestBps);
    case 'commission':
      return computed(cfg.tdsCommissionBps);
  }
}
