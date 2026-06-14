/**
 * Minimal types for pdfmake@0.2.x's server-side printer (its package `main` is the
 * PdfPrinter class). The published @types/pdfmake only describe the browser `createPdf`
 * API, so we declare just enough here to construct a PdfPrinter and emit a PDFKit stream.
 */
declare module 'pdfmake' {
  import type { TDocumentDefinitions, TFontDictionary } from 'pdfmake/interfaces.js';

  interface PdfKitDocument {
    on(event: 'data', cb: (chunk: Buffer) => void): void;
    on(event: 'end', cb: () => void): void;
    on(event: 'error', cb: (err: unknown) => void): void;
    end(): void;
  }

  class PdfPrinter {
    constructor(fonts: TFontDictionary);
    createPdfKitDocument(docDefinition: TDocumentDefinitions): PdfKitDocument;
  }

  export default PdfPrinter;
}
