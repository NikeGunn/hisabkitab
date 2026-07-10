/**
 * TallyPrime XML dialect — request builders + response parsers.
 *
 * Requests follow the OFFICIAL Envelope/Collection pattern (help.tallysolutions.com,
 * "Integration using XML interface"): Export + Collection with NATIVEMETHOD field
 * lists, company-scoped via the SVCURRENTCOMPANY static variable. The exact field
 * vocabulary per Tally release is verified against a licensed install before a real
 * pilot (docs/TALLY-INTEGRATION.md §manual-test); anything unexpected fails parsing
 * closed — a shape we don't recognize can never become a figure.
 *
 * Money strings are parsed digit-exact via @hisab/shared parseTallyAmountPaisa
 * (never through a float). Tally's sign convention (negative = debit) is normalized
 * to {paisa, side} AT THIS BOUNDARY; nothing beyond this file sees a signed string.
 */
import { XMLParser } from 'fast-xml-parser';
import {
  tallyAmountToBalance,
  type ListCompaniesPayload,
  type LedgerBalancePayload,
  type ReceivablesPayload,
  type SearchLedgersPayload,
  type TallyBalance,
  type TallyLedgerRef,
} from '@hisab/shared';

export class TallyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TallyParseError';
  }
}

// ---------------------------------------------------------------- request builders

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface CollectionRequest {
  id: string;
  objectType: 'Company' | 'Ledger' | 'Bill';
  nativeMethods: string[];
  /** company scoping + optional period (SVFROMDATE/SVTODATE as yyyymmdd) */
  staticVars?: Record<string, string>;
}

/** One builder for every read — there is deliberately NO way to express a write. */
export function buildCollectionRequest(req: CollectionRequest): string {
  const svars = Object.entries(req.staticVars ?? {})
    .map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`)
    .join('');
  const methods = req.nativeMethods.map((m) => `<NATIVEMETHOD>${m}</NATIVEMETHOD>`).join('');
  return (
    '<ENVELOPE>' +
    '<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>' +
    `<ID>${req.id}</ID></HEADER>` +
    '<BODY><DESC>' +
    `<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${svars}</STATICVARIABLES>` +
    '<TDL><TDLMESSAGE>' +
    `<COLLECTION NAME="${req.id}" ISMODIFY="No"><TYPE>${req.objectType}</TYPE>${methods}</COLLECTION>` +
    '</TDLMESSAGE></TDL>' +
    '</DESC></BODY></ENVELOPE>'
  );
}

export const requests = {
  listCompanies: (): string =>
    buildCollectionRequest({
      id: 'HKCompanies',
      objectType: 'Company',
      nativeMethods: ['NAME', 'GUID', 'STARTINGFROM', 'LASTVOUCHERDATE'],
    }),
  ledgers: (companyName: string, opts: { asOf?: string } = {}): string =>
    buildCollectionRequest({
      id: 'HKLedgers',
      objectType: 'Ledger',
      nativeMethods: [
        'NAME',
        'PARENT',
        'OPENINGBALANCE',
        'CLOSINGBALANCE',
        'TOTALDEBITS',
        'TOTALCREDITS',
      ],
      staticVars: {
        SVCURRENTCOMPANY: companyName,
        ...(opts.asOf ? { SVTODATE: isoToTallyDate(opts.asOf) } : {}),
      },
    }),
  bills: (companyName: string, opts: { asOf?: string } = {}): string =>
    buildCollectionRequest({
      id: 'HKBillsReceivable',
      objectType: 'Bill',
      nativeMethods: ['NAME', 'PARENT', 'BILLDATE', 'BILLCREDITPERIOD', 'CLOSINGBALANCE'],
      staticVars: {
        SVCURRENTCOMPANY: companyName,
        ...(opts.asOf ? { SVTODATE: isoToTallyDate(opts.asOf) } : {}),
      },
    }),
};

// ---------------------------------------------------------------- response parsing

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // keep EVERYTHING as strings — money must never become a float
  isArray: (name) => name === 'COMPANY' || name === 'LEDGER' || name === 'BILL',
});

/** Tally dates arrive as yyyymmdd ("20260701"); normalize to ISO or drop (never guess). */
export function tallyDateToIso(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return undefined;
}

export const isoToTallyDate = (iso: string): string => iso.replaceAll('-', '');

type Dict = Record<string, unknown>;

/** ENVELOPE > BODY > DATA > COLLECTION — the payload house of every Tally export. */
function collectionOf(xmlText: string): Dict {
  let doc: Dict;
  try {
    doc = parser.parse(xmlText) as Dict;
  } catch {
    throw new TallyParseError('response is not well-formed XML');
  }
  const data = ((doc['ENVELOPE'] as Dict)?.['BODY'] as Dict)?.['DATA'] as Dict | undefined;
  if (data === undefined || !('COLLECTION' in data)) {
    throw new TallyParseError('response has no ENVELOPE/BODY/DATA/COLLECTION');
  }
  const col = data['COLLECTION'];
  // An EMPTY collection parses as '' — a legitimate "zero rows" answer, not garbage.
  if (col === '' || col === null) return {};
  if (typeof col !== 'object') throw new TallyParseError('COLLECTION has an unexpected shape');
  return col as Dict;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

const balance = (v: unknown): TallyBalance | undefined => {
  const s = str(v);
  return s === undefined ? undefined : tallyAmountToBalance(s);
};

export function parseCompanies(xmlText: string): ListCompaniesPayload {
  const col = collectionOf(xmlText);
  const rows = (col['COMPANY'] as Dict[] | undefined) ?? [];
  return {
    companies: rows.flatMap((r) => {
      const name = str(r['NAME']);
      if (!name) return [];
      const booksFrom = tallyDateToIso(r['STARTINGFROM']);
      return [
        {
          // GUID is the stable identity when Tally provides one; otherwise name+books
          // (still stable per dataset, and datasets are never merged by name alone).
          source_id: str(r['GUID']) ?? `${name}|${booksFrom ?? 'unknown'}`,
          name,
          ...(booksFrom ? { books_from: booksFrom } : {}),
          ...(tallyDateToIso(r['LASTVOUCHERDATE'])
            ? { last_voucher_on: tallyDateToIso(r['LASTVOUCHERDATE'])! }
            : {}),
          currency: 'NPR',
        },
      ];
    }),
  };
}

export interface ParsedLedger extends TallyLedgerRef {
  opening?: TallyBalance;
  closing?: TallyBalance;
  totalDebits?: TallyBalance;
  totalCredits?: TallyBalance;
}

export function parseLedgers(xmlText: string): ParsedLedger[] {
  const col = collectionOf(xmlText);
  const rows = (col['LEDGER'] as Dict[] | undefined) ?? [];
  return rows.flatMap((r) => {
    const name = str(r['NAME']);
    if (!name) return [];
    const opening = balance(r['OPENINGBALANCE']);
    const closing = balance(r['CLOSINGBALANCE']);
    const totalDebits = balance(r['TOTALDEBITS']);
    const totalCredits = balance(r['TOTALCREDITS']);
    return [
      {
        name,
        group: str(r['PARENT']) ?? '',
        ...(opening ? { opening } : {}),
        ...(closing ? { closing } : {}),
        ...(totalDebits ? { totalDebits } : {}),
        ...(totalCredits ? { totalCredits } : {}),
      },
    ];
  });
}

export function toSearchPayload(
  ledgers: ParsedLedger[],
  query: string,
  cap = 50,
): SearchLedgersPayload {
  const q = query.trim().toLowerCase();
  const matched = ledgers.filter((l) => l.name.toLowerCase().includes(q));
  return {
    matches: matched.slice(0, cap).map((l) => ({
      name: l.name,
      group: l.group,
      ...(l.closing ? { closing: l.closing } : {}),
    })),
    truncated: matched.length > cap,
  };
}

export function toLedgerBalancePayload(ledger: ParsedLedger, asOf: string): LedgerBalancePayload {
  if (!ledger.opening || !ledger.closing) {
    throw new TallyParseError(`ledger "${ledger.name}" came back without opening/closing balances`);
  }
  return {
    ledger: { name: ledger.name, group: ledger.group },
    as_of: asOf,
    opening: ledger.opening,
    // Movement totals are magnitudes; Tally exports them as debit/credit-signed
    // strings — the magnitude is what the reconciliation needs. Absent ⇒ omitted
    // (the server degrades to verified_with_warnings; we NEVER synthesize a split).
    ...(ledger.totalDebits !== undefined ? { total_debits_paisa: ledger.totalDebits.paisa } : {}),
    ...(ledger.totalCredits !== undefined
      ? { total_credits_paisa: ledger.totalCredits.paisa }
      : {}),
    closing: ledger.closing,
  };
}

export function parseBills(xmlText: string, asOf: string): ReceivablesPayload {
  const col = collectionOf(xmlText);
  const rows = (col['BILL'] as Dict[] | undefined) ?? [];
  const lines = rows.flatMap((r) => {
    const party = str(r['PARENT']);
    const bal = balance(r['CLOSINGBALANCE']);
    if (!party || !bal) return [];
    const dueOn = tallyDateToIso(r['BILLDATE']);
    return [
      {
        party,
        ...(str(r['NAME']) ? { bill_ref: str(r['NAME'])! } : {}),
        ...(dueOn ? { due_on: dueOn } : {}),
        balance: bal,
      },
    ];
  });
  // A report-style export may carry its own total (simulator always does, to exercise
  // the reconciliation); a plain collection export does not — leave it absent.
  const total = balance(col['TOTALCLOSING']);
  return { as_of: asOf, lines, ...(total ? { source_total: total } : {}) };
}
