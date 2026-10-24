import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { OcrWord, ProposalDoc } from '@/lib/types';
import { matchInsurer } from '@/lib/ai/insurers';

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
  /** Path inside the archive, e.g. "Daniel-James-Marsh/D001 Invoices.pdf". */
  filename: string;
  /** Folder component only, for grouping in the UI. */
  folder: string | null;
  bytes: Uint8Array;
  pageCount: number;
}

/**
 * Name a child PDF: "D001 Letters.pdf".
 *
 * The document key carries the provenance — it is what the summary PDF, the
 * sidebar and the reviewer's own feedback all refer to — and a single plural
 * noun says what kind of thing it is. That noun comes from the category's
 * `short_label`, which the taxonomy pass produces alongside the category
 * itself, so naming stays model-managed rather than mapped in code.
 *
 * Deliberately short. Packing the date, full category and issuing organisation
 * into the name produced things like
 * "D001_2024-02-05_Legal-correspondence_Ashford-Lane-Lawyers.pdf", which is
 * unreadable in a file listing and truncated by most mail clients. All of that
 * detail is in the summary PDF, and in the child PDF's own metadata.
 */
export function childFilename(
  doc: ProposalDoc,
  labelFor?: (categoryName: string | null) => string | null,
): string {
  // A claim's file says who it is made to — "D007 Insurance Claim - Care
  // Health.pdf" — because a matter can carry claims to more than one insurer
  // and the category noun alone cannot tell them apart.
  if (doc.doc_type === 'Insurance Claims') {
    const insurer = matchInsurer(doc.org);
    if (insurer) {
      const safe = insurer.short.replace(/[^A-Za-z0-9 -]/g, '').trim();
      return `${doc.doc_key} Insurance Claim - ${safe}.pdf`;
    }
  }

  const fallback = (doc.doc_type ?? 'Documents')
    .replace(/[^A-Za-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^(and|or|the|of|a|an)$/i.test(w))
    .pop();

  const raw = labelFor?.(doc.doc_type) ?? fallback ?? 'Documents';
  const word = raw.trim().replace(/[^A-Za-z\s]/g, '').split(/\s+/).slice(0, 2).join(' ');
  const label = word
    ? word[0].toUpperCase() + word.slice(1)
    : 'Documents';

  return `${doc.doc_key} ${/s$/i.test(label) ? label : `${label}s`}.pdf`;
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
  /** category name -> its short plural label, from the derived taxonomy. */
  shortLabels: Map<string, string> = new Map(),
  /** person_key -> folder name. When more than one person appears in a bundle,
   *  their documents are filed in separate folders so a reviewer can hand over
   *  one person's records without sweeping up somebody else's. */
  personFolders: Map<string, string> = new Map(),
): Promise<ChildPdf[]> {
  const labelFor = (name: string | null) => (name ? shortLabels.get(name) ?? null : null);
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
        doc.person_name && `About: ${doc.person_name}`,
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

    const folder = doc.person_key ? (personFolders.get(doc.person_key) ?? null) : null;
    const name = childFilename(doc, labelFor);

    children.push({
      doc_key: doc.doc_key,
      filename: folder ? `${folder}/${name}` : name,
      folder,
      bytes: await out.save(),
      pageCount: indices.length,
    });
  }

  return children;
}
