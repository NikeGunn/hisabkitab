/**
 * Render every bill fixture into fixtures/bills/ (gitignored — regenerated on
 * demand, deterministic from the manifest).
 *
 *   pnpm --filter @hisab/orchestrator fixtures:bills
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BILL_FIXTURES } from './fixtures.js';
import { renderBillPdf, renderBillPng } from './render.js';

const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
export const BILLS_DIR = join(FIXTURES_ROOT, 'bills');

export async function generateBillFixtures(): Promise<Map<string, Buffer>> {
  await mkdir(BILLS_DIR, { recursive: true });
  const byFile = new Map<string, Buffer>();
  for (const f of BILL_FIXTURES) {
    if (byFile.has(f.file)) continue; // duplicate-resend reuses the clean image
    const bytes = f.externalSource
      ? await readFile(join(FIXTURES_ROOT, f.externalSource))
      : f.render
        ? await renderBillPng(f.render.spec, f.render.messiness)
        : renderBillPdf(f.pdfLines ?? []);
    byFile.set(f.file, bytes);
    await writeFile(join(BILLS_DIR, f.file), bytes);
  }
  return byFile;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
if (isDirectRun) {
  const files = await generateBillFixtures();
  for (const [file, bytes] of files) console.log(`${file}  ${bytes.length} bytes`);
  console.log(`\n${files.size} bill fixtures written to ${BILLS_DIR}`);
}
