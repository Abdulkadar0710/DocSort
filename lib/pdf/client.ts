'use client';

// Must come before pdf.js: it patches Map/WeakMap methods pdf.js v6 relies on
// and older browsers lack. ES modules evaluate in import order.
import './map-polyfill';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageInventory } from '@/lib/types';

/**
 * Browser-side PDF work: page inventory and page rendering for the preview.
 *
 * Inventory runs here rather than on the server for three reasons: the file is
 * already in memory after the user picks it, so it costs no bandwidth; pdf.js
 * needs no serverless-runtime wrangling in a browser; and a 192-page text
 * extraction never touches a Vercel function's duration budget.
 */

// Points at a shim that polyfills the worker's own global scope before loading
// the real worker — a main-thread polyfill does not reach it. Both files live
// in /public, kept current by the `copy-pdf-worker` npm script.
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.shim.mjs';

/**
 * Bundle bytes, cached per url for the life of the tab.
 *
 * React runs effects twice in development, and the workspace remounts whenever
 * the reviewer navigates back to it — without this, each of those re-downloads
 * the whole bundle. Keyed on the stable `/api/sessions/:id/bundle` url, so one
 * download serves every mount.
 */
const bundleCache = new Map<string, Promise<ArrayBuffer>>();

export function fetchBundleBytes(
  url: string,
  onProgress?: (pct: number) => void,
): Promise<ArrayBuffer> {
  const existing = bundleCache.get(url);
  if (existing) {
    onProgress?.(100);
    return existing;
  }

  const pending = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`bundle request failed (${res.status})`);

    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || total === 0) return res.arrayBuffer();

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(Math.round((received / total) * 100));
    }

    const bytes = new Uint8Array(received);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return bytes.buffer;
  })();

  // A failed download must not poison the cache for the rest of the session.
  pending.catch(() => bundleCache.delete(url));
  bundleCache.set(url, pending);
  return pending;
}

export interface OpenPdf {
  doc: PDFDocumentProxy;
  /** Tear down the worker and release the document. In pdf.js v6 this lives on
   *  the loading task rather than the document proxy. */
  destroy: () => Promise<void>;
}

export async function openPdf(data: ArrayBuffer | string): Promise<OpenPdf> {
  const src = typeof data === 'string' ? { url: data } : { data: new Uint8Array(data) };
  const task = pdfjs.getDocument({
    ...src,
    // Scanned medico-legal bundles are image-heavy; let pdf.js stream rather
    // than hold every page's resources at once.
    disableAutoFetch: false,
    disableStream: false,
  });
  const doc = await task.promise;
  return { doc, destroy: () => task.destroy() };
}

/**
 * A page counts as having a usable text layer only if it yields a meaningful
 * amount of text. Measured on the DEV bundle, 74 of 192 pages fall below this
 * line — they are 150 dpi scans with no text at all — and those are exactly the
 * pages that need vision OCR rather than text parsing.
 */
const TEXT_LAYER_MIN_CHARS = 20;

export async function buildInventory(
  doc: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void,
): Promise<PageInventory[]> {
  const out: PageInventory[] = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    // `rotate` already folds in the page's /Rotate entry. We record it so the
    // page can be de-rotated before being shown to the model, while the child
    // PDF keeps the original orientation untouched.
    const viewport = page.getViewport({ scale: 1, rotation: 0 });

    let text = '';
    try {
      const content = await page.getTextContent();
      text = content.items
        .map((i) => ('str' in i ? i.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    } catch {
      // A damaged text layer is itself a signal; treat the page as a scan.
      text = '';
    }

    out.push({
      page_number: n,
      rotation: page.rotate ?? 0,
      width: viewport.width,
      height: viewport.height,
      has_text_layer: text.replace(/\s/g, '').length >= TEXT_LAYER_MIN_CHARS,
      text,
    });

    page.cleanup();
    onProgress?.(n, doc.numPages);
  }

  return out;
}

/** Render one page to a canvas for the preview. Kept separate from inventory so
 *  the viewer can render lazily as pages scroll in. */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  targetWidth: number,
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: targetWidth / base.width });

  // Fold the device pixel ratio into the viewport scale rather than scaling a
  // 2D context by hand. pdf.js v6 takes the canvas directly and derives its own
  // context, so the canvas just has to be the size the viewport reports.
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const scaled = page.getViewport({ scale: (targetWidth / base.width) * dpr });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(scaled.width);
  canvas.height = Math.floor(scaled.height);
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  canvas.style.display = 'block';

  await page.render({ canvas, viewport: scaled }).promise;
  page.cleanup();
  return canvas;
}
