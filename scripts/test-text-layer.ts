/**
 * The invisible text layer, end to end.
 *
 * OCR is only worth having if the words survive into the exported child PDF
 * and come back out when something searches it. This takes word boxes of the
 * shape tesseract produces, runs them through the real export path, then reads
 * the result back with pdf.js — the same library a viewer would use — and
 * checks the words are there, in order, and invisible.
 *
 *   npx tsx scripts/test-text-layer.ts
 */
import { createRequire } from 'node:module';
import { PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { buildChildPdfs } from '@/lib/pdf/export';
import type { OcrWord, ProposalDoc } from '@/lib/types';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

function doc(key: string, pages: number[], extra: Partial<ProposalDoc> = {}): ProposalDoc {
  return {
    id: key, sort_order: 0, doc_key: key, pages,
    overview: null, title: `${key} title`, doc_type: 'Reports', subcategory: null,
    proposed_category: null, proposed_category_reason: null, doc_date: null,
    author: null, discipline: null, org: null, relates: 'yes', relates_reason: null,
    person_name: null, person_name_printed: null, person_dob: null,
    person_gender: null, person_age: null, person_patient_id: null, person_address: null,
    person_key: null, dup_of: null,
    review: [], confidence: null, excluded: false, ...extra,
  };
}

/** A scanned-looking bundle: no text of its own, so any text found is ours. */
async function blankBundle(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) pdf.addPage([595, 842]);
  return new Uint8Array(await pdf.save());
}

/** Word boxes shaped like tesseract's: fractions of the page, top-left origin. */
function wordsFor(texts: string[]): OcrWord[] {
  return texts.map((text, i) => ({
    text,
    x0: 0.1,
    y0: 0.1 + i * 0.04,
    x1: 0.1 + Math.min(text.length * 0.02, 0.8),
    y1: 0.13 + i * 0.04,
  }));
}

const require = createRequire(import.meta.url);

async function textOfPage(bytes: Uint8Array, pageNumber: number): Promise<string> {
  // The legacy build runs under Node without a DOM.
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = require.resolve(
    'pdfjs-dist/legacy/build/pdf.worker.mjs',
  );
  // A fresh copy: pdf.js transfers the buffer it is handed, and the one from
  // pdf-lib does not survive structured cloning under tsx.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const pdf = await task.promise;
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const text = content.items
    .map((i: { str?: string }) => i.str ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  await task.destroy();
  return text;
}

async function main() {
  console.log('Invisible text layer');

  const bundle = await blankBundle(6);

  // 1. Words land in the child PDF and come back out.
  const ocr = new Map<number, OcrWord[]>([
    [1, wordsFor(['Northbank', 'Medical', 'Centre'])],
    [2, wordsFor(['Work', 'capacity', 'certificate'])],
    [4, wordsFor(['Daniel', 'James', 'Marsh'])],
  ]);

  const children = await buildChildPdfs(
    bundle,
    [doc('D001', [1, 2]), doc('D002', [4]), doc('D003', [3])],
    ocr,
    new Map([['Reports', 'Reports']]),
  );

  check('three child PDFs produced', children.length === 3, `got ${children.length}`);

  const d001 = children.find((c) => c.filename.startsWith('D001'))!;
  const p1 = await textOfPage(d001.bytes, 1);
  const p2 = await textOfPage(d001.bytes, 2);

  check('page 1 words are searchable', /Northbank/.test(p1) && /Centre/.test(p1), JSON.stringify(p1));
  check('page 1 keeps word order', p1.indexOf('Northbank') < p1.indexOf('Centre'), JSON.stringify(p1));
  check('page 2 words are searchable', /capacity/.test(p2), JSON.stringify(p2));
  check('page 2 did not inherit page 1 text', !/Northbank/.test(p2), JSON.stringify(p2));

  // 2. A page with no OCR stays empty rather than borrowing a neighbour's text.
  const d003 = children.find((c) => c.filename.startsWith('D003'))!;
  const none = await textOfPage(d003.bytes, 1);
  check('page without OCR has no text', none === '', JSON.stringify(none));

  // 3. Non-contiguous documents map OCR by BUNDLE page, not position.
  //    D004 is bundle pages 4 and 1 — the text must follow the page it came
  //    from, or a reader searching a split document finds the wrong document.
  const nonContig = await buildChildPdfs(bundle, [doc('D004', [4, 1])], ocr);
  const n1 = await textOfPage(nonContig[0].bytes, 1);
  const n2 = await textOfPage(nonContig[0].bytes, 2);
  check('non-contiguous: first page carries bundle page 4 text', /Daniel/.test(n1), JSON.stringify(n1));
  check('non-contiguous: second page carries bundle page 1 text', /Northbank/.test(n2), JSON.stringify(n2));

  // 4. The text is invisible — the whole point. Ground rule #2 says a page
  //    must look exactly as it did in the original, so the searchable words
  //    have to be there without being visible. The content stream is
  //    compressed, so this reads the graphics state the page actually uses
  //    rather than grepping the file.
  const probe = await PDFDocument.load(d001.bytes);
  const page1 = probe.getPage(0);
  const extGState = page1.node.Resources()?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
  let fullyTransparent = false;
  if (extGState) {
    for (const [, value] of extGState.asMap()) {
      const gs = extGState.context.lookupMaybe(value, PDFDict);
      const ca = gs?.get(PDFName.of('ca'));
      if (ca instanceof PDFNumber && ca.asNumber() === 0) fullyTransparent = true;
    }
  }
  check('text is drawn fully transparent', fullyTransparent);

  // 5. Excluded documents produce no file at all.
  const withExcluded = await buildChildPdfs(
    bundle,
    [doc('D005', [5]), doc('D006', [6], { excluded: true })],
    ocr,
  );
  check('excluded document is not exported', withExcluded.length === 1, `got ${withExcluded.length}`);

  // 6. A word Helvetica cannot encode must not fail the page.
  const odd = new Map<number, OcrWord[]>([[1, wordsFor(['ok', '→∑✓', 'after'])]]);
  const safe = await buildChildPdfs(bundle, [doc('D007', [1])], odd);
  const safeText = await textOfPage(safe[0].bytes, 1);
  check('unencodable word is skipped, page still exports', safe.length === 1);
  check('words around it survive', /ok/.test(safeText) && /after/.test(safeText), JSON.stringify(safeText));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
