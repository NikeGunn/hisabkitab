/**
 * Tax rates and deadlines are CONFIG, not scattered literals (CLAUDE.md §3).
 * Defaults are the verified FY 2082/83 rates from PRD v1.1 §5 — do not invent rates.
 */
import { z } from 'zod';

const bps = (def: number) => z.coerce.number().int().min(0).max(10_000).default(def);
const paisa = (def: bigint) =>
  z
    .string()
    .regex(/^\d+$/)
    .default(def.toString())
    .transform((s) => BigInt(s));

const TaxConfigSchema = z.object({
  VAT_RATE_BPS: bps(1300),
  TDS_SERVICE_VAT_REGISTERED_BPS: bps(150),
  TDS_SERVICE_PAN_ONLY_BPS: bps(1500),
  TDS_RENT_ENTITY_BPS: bps(1000),
  TDS_VEHICLE_VAT_REGISTERED_BPS: bps(150),
  TDS_VEHICLE_NON_VAT_BPS: bps(1000),
  TDS_DIVIDEND_BPS: bps(500),
  TDS_INTEREST_BPS: bps(1500),
  TDS_COMMISSION_BPS: bps(1500),
  CONTRACT_TDS_THRESHOLD_PAISA: paisa(5_000_000n), // NPR 50,000
  INPUT_CREDIT_WINDOW_YEARS: z.coerce.number().int().min(1).max(5).default(1),
  VAT_TOLERANCE_PAISA: paisa(1n),
  MAX_AMOUNT_PAISA: paisa(100_000_000_000n), // NPR 1 billion sanity ceiling
});

export interface TaxConfig {
  vatRateBps: number;
  tdsServiceVatRegisteredBps: number;
  tdsServicePanOnlyBps: number;
  tdsRentEntityBps: number;
  tdsVehicleVatRegisteredBps: number;
  tdsVehicleNonVatBps: number;
  tdsDividendBps: number;
  tdsInterestBps: number;
  tdsCommissionBps: number;
  contractTdsThresholdPaisa: bigint;
  inputCreditWindowYears: number;
  vatTolerancePaisa: bigint;
  maxAmountPaisa: bigint;
}

export function loadTaxConfig(env: Record<string, string | undefined> = process.env): TaxConfig {
  const e = TaxConfigSchema.parse(env);
  return {
    vatRateBps: e.VAT_RATE_BPS,
    tdsServiceVatRegisteredBps: e.TDS_SERVICE_VAT_REGISTERED_BPS,
    tdsServicePanOnlyBps: e.TDS_SERVICE_PAN_ONLY_BPS,
    tdsRentEntityBps: e.TDS_RENT_ENTITY_BPS,
    tdsVehicleVatRegisteredBps: e.TDS_VEHICLE_VAT_REGISTERED_BPS,
    tdsVehicleNonVatBps: e.TDS_VEHICLE_NON_VAT_BPS,
    tdsDividendBps: e.TDS_DIVIDEND_BPS,
    tdsInterestBps: e.TDS_INTEREST_BPS,
    tdsCommissionBps: e.TDS_COMMISSION_BPS,
    contractTdsThresholdPaisa: e.CONTRACT_TDS_THRESHOLD_PAISA,
    inputCreditWindowYears: e.INPUT_CREDIT_WINDOW_YEARS,
    vatTolerancePaisa: e.VAT_TOLERANCE_PAISA,
    maxAmountPaisa: e.MAX_AMOUNT_PAISA,
  };
}

/** FY 2082/83 defaults (no env overrides applied). */
export const defaultTaxConfig: TaxConfig = loadTaxConfig({});
