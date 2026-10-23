'use client';

import { createWorker } from 'tesseract.js';
import type { OcrWord } from '@/lib/types';
import { fetchBundleBytes, openPdf, renderPage } from '@/lib/pdf/client';

/**
 * In-browser OCR, used ONLY to make scanned pages searchable.
 *
 * Identification does not depend on this and never waits for it. Claude reads
 * the scanned pages directly from the PDF, which it does well — but vision does
 * not report where each word sits on the page, and an invisible text layer
 * needs exactly that geometry. tesseract gives word boxes, so the two are
 * complementary rather than redundant.
 *
 * Running it in the browser keeps it free and off the serverless budget, and
 * lets it take as long as it needs: on a bundle like the DEV one, 74 scanned
 * pages is a matter of minutes. Because nothing blocks on it, a reviewer can
 * refine and even approve before it finishes — those pages are then exported
 * faithfully, just without a text layer, and the summary PDF says so.
 */

/** Rendering wider than this wastes time; narrower loses small print. */
const OCR_WIDTH = 1700;

export interface OcrProgress {
  done: number;
  total: number;
  page: number;
}

export async function runOcrPass(opts: {
  sessionId: string;
  bundleUrl: string;
  /** Only pages the original had no text layer for. */
  pages: number[];
  signal?: AbortSignal;
  onProgress?: (p: OcrProgress) => void;
}): Promise<{ completed: number; failed: number }> {
  const { sessionId, bundleUrl, pages, signal, onProgress } = opts;
  if (!pages.length) return { completed: 0, failed: 0 };

  const bytes = await fetchBundleBytes(bundleUrl);
  const { doc, destroy } = await openPdf(bytes.slice(0));

  const worker = await createWorker('eng');
  let completed = 0;
  let failed = 0;

  try {
    for (const [i, pageNumber] of pages.entries()) {
      if (signal?.aborted) break;

      try {
        const canvas = await renderPage(doc, pageNumber, OCR_WIDTH);
        const { data } = await worker.recognize(canvas, {}, { blocks: true });

        const words: OcrWord[] = [];
        const w = canvas.width;
        const h = canvas.height;

        // tesseract.js v7 exposes words through the block tree.
        for (const block of data.blocks ?? []) {
          for (const para of block.paragraphs ?? []) {
            for (const line of para.lines ?? []) {
              for (const word of line.words ?? []) {
                const text = word.text?.trim();
                // Drop very low-confidence reads rather than planting wrong
                // words in a legal document's search index.
                if (!text || word.confidence < 55) continue;
                words.push({
                  text,
                  x0: word.bbox.x0 / w,
                  y0: word.bbox.y0 / h,
                  x1: word.bbox.x1 / w,
                  y1: word.bbox.y1 / h,
                });
              }
            }
          }
        }

        await fetch(`/api/sessions/${sessionId}/ocr`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ page_number: pageNumber, words }),
        });

        completed++;
      } catch {
        failed++;
      }

      onProgress?.({ done: i + 1, total: pages.length, page: pageNumber });
    }
  } finally {
    await worker.terminate();
    await destroy();
  }

  return { completed, failed };
}
