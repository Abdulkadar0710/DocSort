import { PDFDocument, degrees } from 'pdf-lib';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BUNDLE_BUCKET } from '@/lib/supabase';

/**
 * Server-side PDF slicing.
 *
 * Windows are cut with pdf-lib and handed to Claude as native PDF document
 * blocks. Nothing is rasterised, which matters because Vercel has no
 * Ghostscript, poppler or ImageMagick, and shipping a static rasteriser would
 * be the largest piece of infrastructure risk in the build.
 */

export async function fetchBundle(
  sb: SupabaseClient,
  path: string,
): Promise<Uint8Array> {
  const { data, error } = await sb.storage.from(BUNDLE_BUCKET).download(path);
  if (error || !data) {
    throw new Error(`could not download the bundle: ${error?.message ?? 'no data'}`);
  }
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Cut pages [start, end] into a standalone PDF for the model to read.
 *
 * Rotation is normalised to zero on these copies. In the DEV bundle, page 50
 * carries /Rotate 180 and page 174 carries /Rotate 90, and in both cases the
 * underlying scan is upright — the declared rotation is the defect, and it is
 * why the answer key flags those pages for human review. Clearing it on the
 * copy means the model reads upright pages instead of a sideways roster.
 *
 * This NEVER touches the export path. Child PDFs keep the original rotation
 * untouched, because the brief requires split pages to look exactly as they do
 * in the original — including when the original is wrong.
 */
export async function sliceForModel(
  bundleBytes: Uint8Array,
  start: number,
  end: number,
): Promise<{ base64: string; pageNumbers: number[]; rotationsCleared: number[] }> {
  const src = await PDFDocument.load(bundleBytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();

  const indices: number[] = [];
  const pageNumbers: number[] = [];
  for (let p = start; p <= Math.min(end, src.getPageCount()); p++) {
    indices.push(p - 1);
    pageNumbers.push(p);
  }

  const copied = await out.copyPages(src, indices);
  const rotationsCleared: number[] = [];

  copied.forEach((page, i) => {
    if (page.getRotation().angle % 360 !== 0) {
      rotationsCleared.push(pageNumbers[i]);
      page.setRotation(degrees(0));
    }
    out.addPage(page);
  });

  const bytes = await out.save();
  return {
    base64: Buffer.from(bytes).toString('base64'),
    pageNumbers,
    rotationsCleared,
  };
}
