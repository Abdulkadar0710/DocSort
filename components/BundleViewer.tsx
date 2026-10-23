'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { fetchBundleBytes, openPdf, renderPage } from '@/lib/pdf/client';
import { colorFor } from '@/lib/palette';
import type { ProposalDoc } from '@/lib/types';

export interface ViewerPage {
  page_number: number;
  width: number;
  height: number;
  has_text_layer: boolean;
}

/** How many pages around the one in view are kept rasterised. Enough that
 *  scrolling stays ahead of rendering, few enough that a long bundle never
 *  holds hundreds of bitmaps. */
const RENDER_AHEAD = 6;
const RENDER_BEHIND = 2;

interface Props {
  bundleUrl: string;
  pages: ViewerPage[];
  docs: ProposalDoc[];
  /** Page to scroll to; bump the nonce to re-trigger the same page. */
  scrollTo?: { page: number; nonce: number };
  onVisiblePageChange?: (page: number) => void;
  highlightPages?: number[];
}

/**
 * The preview: the original bundle with the proposed split drawn on top.
 *
 * This is where the reviewer builds trust, so the contract is strict — every
 * page is visibly inside a coloured document or explicitly marked excluded, and
 * scrolling the whole bundle shows how every page was split. Nothing is hidden
 * behind a summary.
 *
 * Rendering is lazy. All 192 slots are laid out at their true aspect ratio from
 * the start so the scrollbar is honest and jump-to-page is exact, but a page's
 * canvas is only rasterised once it comes near the viewport, and is released
 * when it drifts far away. Rendering 192 scanned A4 pages eagerly would stall
 * the tab for minutes.
 */
export function BundleViewer({
  bundleUrl,
  pages,
  docs,
  scrollTo,
  onVisiblePageChange,
  highlightPages,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const slotRefs = useRef(new Map<number, HTMLDivElement>());
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [loadError, setLoadError] = useState('');
  const [fetchPct, setFetchPct] = useState(0);
  // Which page the reviewer is looking at. Rendering is a fixed window around
  // it rather than a set the observer adds to and deletes from — that churned
  // badly, rasterising pages only to evict them a frame later.
  //
  // Starts at the first page so the preview is never blank on arrival:
  // IntersectionObserver does not fire at all while a document is hidden (a
  // background tab, or a restored window).
  const [center, setCenter] = useState(() => pages[0]?.page_number ?? 1);

  const live = useMemo(() => {
    const set = new Set<number>();
    for (let p = center - RENDER_BEHIND; p <= center + RENDER_AHEAD; p++) set.add(p);
    return set;
  }, [center]);

  // page number -> { doc, index in register, position within the document }
  const pageMap = useMemo(() => {
    const m = new Map<
      number,
      { doc: ProposalDoc; index: number; pos: number; of: number }
    >();
    docs.forEach((d, index) => {
      d.pages.forEach((p, pos) => {
        m.set(p, { doc: d, index, pos, of: d.pages.length });
      });
    });
    return m;
  }, [docs]);

  const highlight = useMemo(
    () => new Set(highlightPages ?? []),
    [highlightPages],
  );

  useEffect(() => {
    let cancelled = false;
    let teardown: (() => Promise<void>) | null = null;

    setDoc(null);
    setLoadError('');
    setFetchPct(0);

    // Fetch the bundle ourselves and hand pdf.js the bytes, rather than giving
    // it a url to stream.
    //
    // pdf.js streams by issuing range requests and reading Content-Length and
    // Accept-Ranges off the response. Our bundle url redirects to signed
    // Storage, and a cross-origin redirect does not expose those headers unless
    // the storage host opts in — so pdf.js could not size the file and waited
    // forever with no error to show. One plain GET has none of that fragility,
    // and the bytes are cached per url so a remount costs nothing.
    (async () => {
      try {
        const bytes = await fetchBundleBytes(bundleUrl, (pct) => {
          if (!cancelled) setFetchPct(pct);
        });
        if (cancelled) return;

        const { doc: d, destroy } = await openPdf(bytes.slice(0));
        if (cancelled) {
          void destroy();
          return;
        }
        teardown = destroy;
        setDoc(d);
      } catch (e) {
        if (cancelled) return;
        console.error('could not open the bundle', e);
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      void teardown?.();
    };
  }, [bundleUrl]);

  // One observer, tracking only the topmost visible page. Everything else —
  // what to render and what the sidebar highlights — follows from that.
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;

    const visible = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) visible.add(n);
          else visible.delete(n);
        }
        if (!visible.size) return;
        const top = Math.min(...visible);
        setCenter(top);
        onVisiblePageChange?.(top);
      },
      { root, rootMargin: '0px' },
    );

    for (const el of slotRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [pages.length, onVisiblePageChange]);

  useEffect(() => {
    if (!scrollTo) return;
    const el = slotRefs.current.get(scrollTo.page);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [scrollTo]);

  if (loadError) {
    return (
      <div className="p-6 text-sm text-red-600 dark:text-red-400">
        Could not open the bundle — {loadError}
      </div>
    );
  }

  return (
    <div
      ref={scrollerRef}
      className="relative h-full overflow-y-auto overflow-x-hidden bg-slate-100 px-4 py-4 dark:bg-slate-950"
    >
      {!doc && (
        <div className="pointer-events-none sticky top-2 z-30 mx-auto w-fit rounded-full bg-slate-900/85 px-3 py-1 text-xs font-medium text-white shadow dark:bg-slate-100/90 dark:text-slate-900">
          {fetchPct > 0 && fetchPct < 100
            ? `Loading the bundle… ${fetchPct}%`
            : 'Opening the bundle…'}
        </div>
      )}

      {pages.map((p) => {
        const entry = pageMap.get(p.page_number);
        const color = colorFor(entry?.index ?? 0, entry?.doc.excluded ?? false);
        const isFirst = entry?.pos === 0;
        const isLast = entry ? entry.pos === entry.of - 1 : false;
        const excluded = entry?.doc.excluded ?? false;

        return (
          <div key={p.page_number}>
            {/* A clear gap between documents, so a boundary is visible even
                where two neighbours' colours are similar on screen. */}
            {isFirst && p.page_number !== pages[0].page_number && (
              <div className="h-6" />
            )}

            {isFirst && entry && (
              <div
                className="flex items-center gap-2 rounded-t-md px-3 py-1.5 text-xs font-medium"
                style={{
                  background: color.chip,
                  color: color.chipText,
                  borderTop: `3px solid ${color.line}`,
                }}
              >
                <span className="font-semibold">{entry.doc.doc_key}</span>
                <span className="truncate">
                  {excluded
                    ? 'Excluded — not part of any document'
                    : entry.doc.title || entry.doc.doc_type || 'Unidentified document'}
                </span>
                <span className="ml-auto shrink-0 opacity-70">
                  {entry.of === 1 ? '1 page' : `${entry.of} pages`}
                </span>
              </div>
            )}

            <div
              data-page={p.page_number}
              ref={(el) => {
                if (el) slotRefs.current.set(p.page_number, el);
                else slotRefs.current.delete(p.page_number);
              }}
              className={`relative ${isLast ? 'mb-0' : 'mb-1'}`}
              style={{
                background: color.fill,
                borderLeft: `3px solid ${color.line}`,
                borderRight: `3px solid ${color.line}`,
                borderBottom: isLast ? `3px solid ${color.line}` : 'none',
                // Reserve the correct height before the canvas exists, so the
                // scrollbar never jumps as pages rasterise.
                aspectRatio: `${p.width} / ${p.height}`,
                outline: highlight.has(p.page_number) ? '3px solid #f59e0b' : undefined,
                outlineOffset: '-3px',
              }}
            >
              {excluded && (
                <div
                  className="pointer-events-none absolute inset-0 z-10"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(45deg, rgba(100,116,139,0.18) 0 10px, transparent 10px 20px)',
                  }}
                />
              )}

              <PageCanvas
                doc={doc}
                pageNumber={p.page_number}
                active={live.has(p.page_number)}
              />

              <span className="absolute bottom-1 right-2 z-20 rounded bg-white/85 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 shadow-sm dark:bg-slate-900/85 dark:text-slate-300">
                p.{p.page_number}
                {!p.has_text_layer && (
                  <span
                    className="ml-1 opacity-70"
                    title="No text layer in the original — read by OCR"
                  >
                    scan
                  </span>
                )}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PageCanvas({
  doc,
  pageNumber,
  active,
}: {
  doc: PDFDocumentProxy | null;
  pageNumber: number;
  active: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!doc || !active || !host.current) return;
    let cancelled = false;
    const el = host.current;

    const width = el.clientWidth || 700;
    renderPage(doc, pageNumber, width)
      .then((canvas) => {
        if (cancelled) return;
        el.replaceChildren(canvas);
      })
      .catch((e) => {
        if (cancelled) return;
        // A page that will not render still occupies its slot, so no page can
        // vanish from the reviewer's view — but say so rather than showing a
        // blank rectangle that reads as an empty page.
        console.error(`page ${pageNumber} failed to render`, e);
        const note = document.createElement('div');
        note.className =
          'flex h-full w-full items-center justify-center p-4 text-center text-xs text-red-600';
        note.textContent = `Page ${pageNumber} could not be displayed`;
        el.replaceChildren(note);
      });

    return () => {
      cancelled = true;
      // Release the bitmap when the page drifts out of range; holding 192
      // canvases would exhaust memory on a long bundle.
      el.replaceChildren();
    };
  }, [doc, pageNumber, active]);

  return <div ref={host} className="h-full w-full" />;
}
