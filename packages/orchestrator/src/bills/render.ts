/**
 * Deterministic dummy-bill renderers for Phase 4 (no real customer data).
 * PNG bills are laid out as SVG and rasterized with sharp, with optional
 * "messiness" (slight rotation like a phone photo, heavy blur for the
 * unreadable probe, a smudge box over a field the agent must ask about).
 * The PDF bill is a minimal hand-rolled one-page PDF (no dependency).
 */
import sharp from 'sharp';

export interface BillRenderSpec {
  /** "TAX INVOICE" (Rule 17) or "ABBREVIATED TAX INVOICE" (Rule 17Ka). */
  header: string;
  vendorName: string;
  vendorAddress: string;
  /** e.g. "VAT No: 600123456" or "PAN: 301445566". Omit to leave it off the bill. */
  taxIdLine?: string;
  /** Omit AND set smudgeInvoiceNo to render an unreadable smudge instead. */
  invoiceNo?: string;
  smudgeInvoiceNo?: boolean;
  dateLine: string;
  buyerLine?: string;
  items: ReadonlyArray<readonly [description: string, amount: string]>;
  totals: ReadonlyArray<readonly [label: string, value: string]>;
  footer?: string;
}

export interface BillMessiness {
  /** Gaussian blur sigma — 12+ makes text genuinely unreadable. */
  blurSigma?: number;
  /** Small rotation so the bill looks photographed, not generated. */
  rotateDeg?: number;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const WIDTH = 720;

export function billSvg(spec: BillRenderSpec): string {
  const lines: string[] = [];
  let y = 70;
  const text = (s: string, opts: { x?: number; size?: number; bold?: boolean; anchor?: string } = {}) => {
    lines.push(
      `<text x="${opts.x ?? 48}" y="${y}" font-family="Arial, sans-serif" font-size="${opts.size ?? 22}"` +
        `${opts.bold ? ' font-weight="bold"' : ''}${opts.anchor ? ` text-anchor="${opts.anchor}"` : ''}>${esc(s)}</text>`,
    );
  };
  const rule = () => {
    lines.push(`<line x1="48" y1="${y}" x2="${WIDTH - 48}" y2="${y}" stroke="#444" stroke-width="1"/>`);
    y += 34;
  };

  text(spec.vendorName, { x: WIDTH / 2, anchor: 'middle', size: 30, bold: true });
  y += 32;
  text(spec.vendorAddress, { x: WIDTH / 2, anchor: 'middle', size: 18 });
  y += 28;
  if (spec.taxIdLine) {
    text(spec.taxIdLine, { x: WIDTH / 2, anchor: 'middle', size: 20 });
    y += 30;
  }
  text(spec.header, { x: WIDTH / 2, anchor: 'middle', size: 24, bold: true });
  y += 24;
  rule();

  if (spec.smudgeInvoiceNo) {
    text('Invoice No:');
    // an ink smudge where the number should be — unreadable by design
    lines.push(`<rect x="180" y="${y - 22}" width="170" height="30" rx="8" fill="#3a3a3a" opacity="0.92"/>`);
    lines.push(`<rect x="195" y="${y - 14}" width="130" height="12" rx="6" fill="#222"/>`);
  } else if (spec.invoiceNo) {
    text(`Invoice No: ${spec.invoiceNo}`);
  }
  y += 34;
  text(spec.dateLine);
  y += 34;
  if (spec.buyerLine) {
    text(spec.buyerLine);
    y += 34;
  }
  rule();

  for (const [desc, amount] of spec.items) {
    text(desc);
    text(amount, { x: WIDTH - 48, anchor: 'end' });
    y += 34;
  }
  rule();
  for (const [label, value] of spec.totals) {
    const grand = /grand/i.test(label);
    text(label, { x: 360, bold: grand });
    text(value, { x: WIDTH - 48, anchor: 'end', bold: grand });
    y += 36;
  }
  if (spec.footer) {
    y += 20;
    text(spec.footer, { x: WIDTH / 2, anchor: 'middle', size: 16 });
  }
  y += 60;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${y}" viewBox="0 0 ${WIDTH} ${y}">` +
    `<rect width="100%" height="100%" fill="#fdfcf7"/>` +
    lines.join('') +
    `</svg>`
  );
}

export async function renderBillPng(spec: BillRenderSpec, messiness: BillMessiness = {}): Promise<Buffer> {
  let img = sharp(Buffer.from(billSvg(spec)));
  if (messiness.rotateDeg) {
    img = sharp(await img.rotate(messiness.rotateDeg, { background: '#e8e4da' }).toBuffer());
  }
  if (messiness.blurSigma) {
    // blur + flatten contrast: figures must be genuinely unrecoverable
    img = img.blur(messiness.blurSigma).linear(0.45, 120);
  }
  return img.png().toBuffer();
}

// ---------------------------------------------------------------- minimal PDF

const pdfEsc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** One-page A4 text PDF, hand-rolled (deterministic, dependency-free). */
export function renderBillPdf(textLines: readonly string[]): Buffer {
  const content =
    'BT\n/F1 12 Tf\n50 780 Td\n16 TL\n' +
    textLines.map((l) => `(${pdfEsc(l)}) Tj\nT*`).join('\n') +
    '\nET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
