import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { OcrWord, ProposalDoc } from '@/lib/types';

/**
 * Child PDF production.
 *
 * Ground rule #2 — "pages in your split PDFs look exactly as they do in the
 * original" — is met by only ever using `copyPages`, which lifts each page's
 * content stream and resources across untouched. Nothing is re-rendered or
 * re-encoded, and the page's /Rotate entry travels with it. That matters here:
 * two pages of the DEV bundle declare a rotation that displays them sideways or
 * upside down, and the child PDF must reproduce that fault rather than quietly
 * correct it. (The copy sent to the model is straightened separately, in
 * slice.ts, which never touches this path.)
 */

export interface ChildPdf {
  doc_key: string;
  filename: string;
  bytes: Uint8Array;
  pageCount: number;
}

/** Turn a document's identified details into a filename a reviewer can scan.
 *  The brief asks for child PDFs "named so a reviewer can tell what each one
 *  is", so the key, date, type and source organisation all appear. */
export function childFilename(doc: ProposalDoc): string {
  const clean = (s: string | null, max = 40) =>
    (s ?? '')
      .replace(/[^\p{L}\p{N}\s&'-]/gu, ' ')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, max)
      .replace(/-+$/, '');

  // DD/MM/YYYY sorts badly in a file listing; ISO does not.
  let date = '';
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(doc.doc_date ?? '');
  if (m) date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  else if (doc.doc_date && /^\d{4}-\d{2}-\d{2}$/.test(doc.doc_date)) date = doc.doc_date;
  else date = 'undated';

  const parts = [
    doc.doc_key,
    date,
    clean(doc.excluded ? 'Excluded' : doc.doc_type ?? 'Unidentified', 34),
    clean(doc.org, 28),
  ].filter(Boolean);

  return `${parts.join('_')}.pdf`.replace(/_+/g, '_');
}

/**
 * Lay an invisible text layer over a scanned page so the child PDF is
 * searchable.
 *
 * The words come from tesseract in the browser, which unlike the vision pass
 * reports where each word sits. Drawn fully transparent, so the page still
 * looks byte-identical while find-in-page works.
 */
async function addInvisibleText(
  out: PDFDocument,
  pageIndex: number,
  words: OcrWord[],
) {
  if (!words.length) return;
  const page = out.getPage(pageIndex);
  const { width, height } = page.getSize();
  const font = await out.embedFont(StandardFonts.Helvetica);

  for (const w of words) {
    const text = w.text?.trim();
    if (!text) continue;

    const boxW = Math.max((w.x1 - w.x0) * width, 1);
    const boxH = Math.max((w.y1 - w.y0) * height, 1);
    // Size the glyphs to the box so selection rectangles land roughly over the
    // words they belong to.
    const size = Math.max(Math.min(boxH * 0.9, 72), 1);

    let scaled = size;
    try {
      const natural = font.widthOfTextAtSize(text, size);
      if (natural > 0) scaled = Math.min(size, (size * boxW) / natural);
    } catch {
      continue; // a glyph Helvetica cannot encode: skip the word, keep the page
    }

    try {
      page.drawText(text, {
        x: w.x0 * width,
        // OCR boxes are measured from the top; PDF user space is from the bottom.
        y: height - w.y1 * height + boxH * 0.15,
        size: Math.max(scaled, 1),
        font,
        color: rgb(0, 0, 0),
        opacity: 0,
      });
    } catch {
      // Never let one unprintable word fail a whole document.
    }
  }
}

export async function buildChildPdfs(
  bundleBytes: Uint8Array,
  docs: ProposalDoc[],
  ocrByPage: Map<number, OcrWord[]>,
): Promise<ChildPdf[]> {
  const src = await PDFDocument.load(bundleBytes, { ignoreEncryption: true });
  const total = src.getPageCount();
  const children: ChildPdf[] = [];

  for (const doc of docs) {
    // Ground rule #1 is an either/or: a page appears in exactly one child PDF,
    // OR it is listed in the summary PDF as excluded. Writing a child PDF for
    // an excluded page would satisfy neither reading — it would hand the
    // clinician a blank document in their evidence set while still claiming the
    // page was set aside. Excluded pages are accounted for in the summary.
    if (doc.excluded) continue;

    const out = await PDFDocument.create();

    out.setTitle(doc.title || doc.doc_type || doc.doc_key);
    out.setSubject(
      [
        doc.doc_type && `Type: ${doc.doc_type}`,
        doc.doc_date && `Date: ${doc.doc_date}`,
        doc.author && `Author: ${doc.author}`,
        doc.org && `Organisation: ${doc.org}`,
        // Provenance is the point of the whole exercise: record it in the file.
        `Original bundle pages: ${doc.pages.join(', ')}`,
      ]
        .filter(Boolean)
        .join(' · '),
    );
    out.setProducer('Unbundle');

    const indices = doc.pages
      .filter((p) => p >= 1 && p <= total)
      .map((p) => p - 1);
    if (!indices.length) continue;

    const copied = await out.copyPages(src, indices);
    for (const page of copied) out.addPage(page);

    // Only scanned pages need a text layer; digital pages already have one.
    for (let i = 0; i < doc.pages.length; i++) {
      const words = ocrByPage.get(doc.pages[i]);
      if (words?.length) await addInvisibleText(out, i, words);
    }

    children.push({
      doc_key: doc.doc_key,
      filename: childFilename(doc),
      bytes: await out.save(),
      pageCount: indices.length,
    });
  }

  return children;
}
