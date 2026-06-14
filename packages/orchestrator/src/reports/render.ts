/**
 * Deterministic PDF renderer (PRD v1.2 §C4.3) — produces a professional, Tally-grade
 * report. Default backend is pdfmake (pure-JS, no browser download; reliable on
 * Windows/offline). The PdfRenderer interface lets a Playwright HTML→PDF backend be
 * swapped in later for typography polish without touching the report job.
 *
 * Layout: branded header bar (business + PAN/VAT + title + period), a summary band of
 * metric cards, a zebra-striped body table with a bold totals row, an aging matrix
 * (receivables/payables), and a statutory footer with the disclaimer + page numbers.
 * Numbers come ONLY from the model; this module never invents a figure.
 */
// pdfmake@0.2.x exposes the server-side PdfPrinter as its package `main`. The published
// @types describe the browser `createPdf` build, so we type the printer locally (shim).
import PdfPrinter from 'pdfmake';
import type { TDocumentDefinitions, Content, TableCell } from 'pdfmake/interfaces.js';
import { formatNpr } from '@hisab/shared';
import { agingRows, DISCLAIMER, type ReportModel, type SummaryMetric } from './model.js';

export interface PdfRenderer {
  render(model: ReportModel): Promise<Buffer>;
}

// Helvetica is a PDF core font — pdfmake renders it without shipping ttf binaries.
const FONTS = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
};

/** pdfmake margins must be a fixed-length tuple; this keeps inference from widening to number[]. */
type Margin = [number, number, number, number];
const m = (l: number, t: number, r: number, b: number): Margin => [l, t, r, b];

const BRAND = '#0B6E4F'; // deep green — matches the HisabKitab landing palette
const BRAND_LIGHT = '#E6F2ED';
const INK = '#1a1a1a';
const MUTE = '#6b7280';
const ZEBRA = '#f7f9f8';

export class PdfmakeRenderer implements PdfRenderer {
  private readonly printer = new PdfPrinter(FONTS);

  async render(model: ReportModel): Promise<Buffer> {
    const def = this.buildDocDefinition(model);
    return await new Promise<Buffer>((resolve, reject) => {
      const doc = this.printer.createPdfKitDocument(def);
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });
  }

  private buildDocDefinition(model: ReportModel): TDocumentDefinitions {
    const content: Content[] = [
      this.headerBar(model),
      ...(model.summary.length ? [this.summaryBand(model.summary)] : []),
      { text: '', margin: m(0, 6, 0, 0) },
      this.bodyTable(model),
    ];

    if (model.aging) {
      content.push({ text: 'AGEING ANALYSIS', style: 'section', margin: m(0, 18, 0, 6) });
      content.push(this.agingTable(model));
    }

    return {
      content,
      defaultStyle: { font: 'Helvetica', fontSize: 9, color: INK, lineHeight: 1.15 },
      pageMargins: [36, 36, 36, 64],
      footer: (currentPage: number, pageCount: number) => ({
        margin: m(36, 10, 36, 0),
        columns: [
          { text: DISCLAIMER, style: 'footer', width: '*' },
          { text: `Page ${currentPage} of ${pageCount}`, style: 'footer', width: 'auto', alignment: 'right' },
        ],
      }),
      styles: {
        section: { fontSize: 10.5, bold: true, color: BRAND },
        footer: { fontSize: 7, color: MUTE, italics: true },
      },
    };
  }

  /** Branded header: business name + PAN/VAT on the left, report title + period on a green bar. */
  private headerBar(model: ReportModel): Content {
    const { header } = model;
    return {
      stack: [
        {
          columns: [
            {
              width: '*',
              stack: [
                { text: header.businessName, fontSize: 17, bold: true, color: INK },
                { text: `PAN / VAT No: ${header.panOrVatNo}`, fontSize: 9, color: MUTE, margin: m(0, 2, 0, 0) },
              ],
            },
            {
              width: 'auto',
              stack: [
                { text: 'HisabKitab', fontSize: 11, bold: true, color: BRAND, alignment: 'right' },
                { text: 'Pocket Accountant', fontSize: 7.5, color: MUTE, alignment: 'right' },
              ],
            },
          ],
        },
        {
          table: {
            widths: ['*'],
            body: [
              [
                {
                  stack: [
                    { text: header.title.toUpperCase(), fontSize: 12.5, bold: true, color: '#ffffff' },
                    ...(header.subtitle ? [{ text: header.subtitle, fontSize: 9, color: '#dff0e9', margin: m(0, 1, 0, 0) }] : []),
                    { text: header.periodLabel, fontSize: 9, color: '#dff0e9', margin: m(0, 1, 0, 0) },
                  ],
                  fillColor: BRAND,
                  margin: m(10, 7, 10, 7),
                },
              ],
            ],
          },
          layout: 'noBorders',
          margin: m(0, 12, 0, 0),
        },
        {
          text: `Generated: ${header.generatedAtIso}`,
          fontSize: 7.5,
          color: MUTE,
          alignment: 'right',
          margin: m(0, 3, 0, 0),
        },
      ],
    };
  }

  /** A row of metric "cards" (label on top, value below) above the table. */
  private summaryBand(metrics: SummaryMetric[]): Content {
    const cell = (metric: SummaryMetric): TableCell => ({
      stack: [
        { text: metric.label.toUpperCase(), fontSize: 7, color: MUTE, characterSpacing: 0.3 },
        {
          text: metric.valuePaisa !== undefined ? formatNpr(metric.valuePaisa) : (metric.text ?? ''),
          fontSize: metric.emphasize ? 13 : 11,
          bold: true,
          color: metric.emphasize ? BRAND : INK,
          margin: m(0, 3, 0, 0),
        },
      ],
      fillColor: metric.emphasize ? BRAND_LIGHT : '#fbfcfc',
      margin: m(10, 8, 10, 8),
    });
    return {
      table: { widths: metrics.map(() => '*'), body: [metrics.map(cell)] },
      layout: {
        defaultBorder: false,
        paddingLeft: () => 2,
        paddingRight: () => 2,
        paddingTop: () => 2,
        paddingBottom: () => 2,
      },
      margin: m(0, 12, 0, 0),
    };
  }

  private bodyTable(model: ReportModel): Content {
    const widths = model.columns.map((c) => c.width ?? (c.numeric ? 'auto' : '*'));
    const headerRow: TableCell[] = model.columns.map((c) => ({
      text: c.label,
      bold: true,
      color: '#ffffff',
      fillColor: BRAND,
      alignment: (c.numeric ? 'right' : 'left') as 'right' | 'left',
      margin: m(0, 2, 0, 2),
    }));

    const dataRows: TableCell[][] =
      model.rows.length > 0
        ? model.rows.map((row, ri) =>
            row.map((cell, ci) => ({
              text: cell,
              alignment: (model.columns[ci]?.numeric ? 'right' : 'left') as 'right' | 'left',
              fillColor: ri % 2 === 1 ? ZEBRA : undefined,
              margin: m(0, 1.5, 0, 1.5),
            })),
          )
        : [
            [
              {
                text: 'No records for this period.',
                colSpan: model.columns.length,
                italics: true,
                color: MUTE,
                margin: m(0, 4, 0, 4),
              } as TableCell,
              ...Array(model.columns.length - 1).fill({} as TableCell),
            ],
          ];

    const body: TableCell[][] = [headerRow, ...dataRows];
    if (model.totalsRow) {
      body.push(
        model.totalsRow.map((cell, ci) => ({
          text: cell,
          bold: true,
          alignment: (model.columns[ci]?.numeric ? 'right' : 'left') as 'right' | 'left',
          fillColor: BRAND_LIGHT,
          margin: m(0, 3, 0, 3),
        })),
      );
    }

    return {
      table: { headerRows: 1, widths, body, dontBreakRows: true },
      layout: {
        hLineWidth: (i: number, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0.3),
        vLineWidth: () => 0,
        hLineColor: () => '#d9e2dd',
      },
    };
  }

  /** Aging matrix: bucket label Â· amount, with a bold grand-total row. */
  private agingTable(model: ReportModel): Content {
    const rows = agingRows(model.aging!);
    const body: TableCell[][] = [
      [
        { text: 'AGE BAND', bold: true, color: '#ffffff', fillColor: BRAND, margin: m(0, 2, 0, 2) },
        { text: 'AMOUNT', bold: true, color: '#ffffff', fillColor: BRAND, alignment: 'right', margin: m(0, 2, 0, 2) },
      ],
      ...rows.map(([label, value], ri) => [
        { text: label, fillColor: ri % 2 === 1 ? ZEBRA : undefined, margin: m(0, 1.5, 0, 1.5) } as TableCell,
        { text: value, alignment: 'right', fillColor: ri % 2 === 1 ? ZEBRA : undefined, margin: m(0, 1.5, 0, 1.5) } as TableCell,
      ]),
      [
        { text: model.grandTotalLabel, bold: true, fillColor: BRAND_LIGHT, margin: m(0, 3, 0, 3) },
        { text: formatNpr(model.grandTotalPaisa), bold: true, alignment: 'right', fillColor: BRAND_LIGHT, margin: m(0, 3, 0, 3) },
      ],
    ];
    return {
      table: { widths: ['*', 'auto'], body },
      layout: {
        hLineWidth: (i: number, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0.3),
        vLineWidth: () => 0,
        hLineColor: () => '#d9e2dd',
      },
    };
  }
}
