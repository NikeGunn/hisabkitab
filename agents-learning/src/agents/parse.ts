/** Tiny deterministic parsers used by the scripted agents (never by the judge). */

/** "Rs 8,500.50" / "NPR 850" → paisa. Only currency-marked amounts. */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?:Rs\.?|NPR|रु\.?)\s*([\d,]+(?:\.\d{1,2})?)/gi)) {
    const [r = '0', f = ''] = (m[1] as string).replace(/,/g, '').split('.');
    out.push(Number(r) * 100 + Number(f.padEnd(2, '0') || '0'));
  }
  return out;
}

export interface ParsedBill {
  file_id: string;
  vendor: string;
  invoice_no: string | null;
  date: string | null;
  total_paisa: number | null;
  taxable_paisa: number | null;
  vat_paisa: number | null;
  vat_registered: boolean;
}

const field = (text: string, label: RegExp): string | null => {
  const line = text.split('\n').find((l) => label.test(l));
  return line ? line.replace(label, '').replace(/^\s*:?\s*/, '').trim() : null;
};

export function parseBill(file_id: string, ocr: string): ParsedBill {
  const lines = ocr.split('\n');
  const money = (label: RegExp) => {
    const v = field(ocr, label);
    return v ? (amountsIn(v)[0] ?? null) : null;
  };
  return {
    file_id,
    vendor: (lines[1] ?? '').trim(),
    invoice_no: field(ocr, /^Invoice No/),
    date: field(ocr, /^Date/),
    total_paisa: money(/^Grand Total/),
    taxable_paisa: money(/^Taxable Amount/),
    vat_paisa: money(/^VAT 13%/),
    vat_registered: /PAN\/VAT No/.test(ocr),
  };
}

export const npr = (paisa: number): string => {
  const r = Math.floor(paisa / 100).toString();
  const f = (paisa % 100).toString().padStart(2, '0');
  const grouped = r.length > 3 ? r.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + r.slice(-3) : r;
  return `Rs ${grouped}.${f}`;
};

export const saysYes = (t: string) => /\b(yes|save|confirm|ok|correct)\b/i.test(t) && !/\b(skip|don't|do not|wait)\b/i.test(t);
export const saysNo = (t: string) => /\b(skip|ignore it|don't save|do not save)\b/i.test(t) && !/\bonly\b/i.test(t);
export const saysCorrection = (t: string) => /\b(no wait|revised|overcharged|real total)\b/i.test(t);
export const foreignRequest = (t: string) => /(business id|brother-in-law|another business|other shop|neighbou?r)/i.test(t);
export const holdOff = (t: string) => /\b(do not save|don't save|not save it yet|check with)\b/i.test(t);
