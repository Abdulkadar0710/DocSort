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

export type PageOrder = 'output' | 'bundle';

interface Props {
  bundleUrl: string;
  pages: ViewerPage[];
  docs: ProposalDoc[];
  /**
   * 'output' walks the pages in register order, so each document's pages sit
   * together as they will in the exported set. 'bundle' walks the original
   * from front to back.
   */
  order?: PageOrder;
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
  order = 'output',
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

  // page number -> { doc, colour index, position within the document }
  //
  // The colour index comes from PAGE order, never the register's order. The
  // brief's one hard rule about colour is that two adjacent documents never
  // share one, and adjacency is what the reviewer sees while scrolling. Once
  // the register began listing whole people rather than following the bundle,
  // its index stopped tracking what sits next to what.
  const pageMap = useMemo(() => {
    const byFirstPage = [...docs].sort(
      (a, b) => Math.min(...a.pages, Infinity) - Math.min(...b.pages, Infinity),
    );
    const colourIndex = new Map(byFirstPage.map((d, i) => [d.doc_key, i]));

    const m = new Map<
      number,
      { doc: ProposalDoc; index: number; pos: number; of: number }
    >();
    for (const d of docs) {
      d.pages.forEach((p, pos) => {
        m.set(p, {
          doc: d,
          index: colourIndex.get(d.doc_key) ?? 0,
          pos,
          of: d.pages.length,
        });
      });
    }
    return m;
  }, [docs]);

  const highlight = useMemo(
    () => new Set(highlightPages ?? []),
    [highlightPages],
  );

  /**
   * The order pages are shown in.
   *
   * A document's pages are routinely scattered through the bundle — page 1 and
   * page 7 can be one letter — so reading the proposal in bundle order means
   * jumping about to see whether a document holds together. Output order walks
   * the register instead, putting each document's pages side by side as they
   * will appear once split.
   *
   * Bundle order is kept a click away, because it is the only view that
   * answers "is this really what I was sent, with nothing missing?" — which is
   * the check the whole preview exists for.
   */
  const shown = useMemo(() => {
    const byNumber = new Map(pages.map((p) => [p.page_number, p]));
    if (order === 'bundle') {
      return [...pages].sort((a, b) => a.page_number - b.page_number);
    }

    const out: ViewerPage[] = [];
    const seen = new Set<number>();
    for (const d of docs) {
      for (const n of d.pages) {
        const page = byNumber.get(n);
        if (page && !seen.has(n)) {
          seen.add(n);
          out.push(page);
        }
      }
    }
    // Any page no document claims is still shown, at the end, rather than
    // disappearing — the preview must account for every page either way.
    for (const p of pages) if (!seen.has(p.page_number)) out.push(p);
    return out;
  }, [pages, docs, order]);

  // Which pages are worth rasterising: a window around the one in view,
  // measured along the ORDER SHOWN rather than by page number, since in output
  // order the next page down the screen is rarely the next number.
  const live = useMemo(() => {
    const at = shown.findIndex((p) => p.page_number === center);
    const from = Math.max(0, (at < 0 ? 0 : at) - RENDER_BEHIND);
    const to = (at < 0 ? 0 : at) + RENDER_AHEAD;
    return new Set(shown.slice(from, to + 1).map((p) => p.page_number));
  }, [shown, center]);


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
        // "Topmost" is a position on screen, not the lowest page number —
        // in output order those are different things.
        const rank = new Map(shown.map((p, i) => [p.page_number, i]));
        const top = [...visible].sort(
          (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0),
        )[0];
        setCenter(top);
        onVisiblePageChange?.(top);
      },
      { root, rootMargin: '0px' },
    );

    for (const el of slotRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [shown, onVisiblePageChange]);

  // Jump to a page when the register is clicked.
  //
  // Positioned directly rather than with smooth scrolling: pages rasterise as
  // they come into range, and the resulting layout shifts cancelled the smooth
  // animation partway, leaving the reviewer wherever it happened to stop. The
  // slots carry their true aspect ratio from the start, so offsetTop is exact
  // even for pages that have not been drawn yet.
  useEffect(() => {
    if (!scrollTo) return;
    const el = slotRefs.current.get(scrollTo.page);
    const root = scrollerRef.current;
    if (!el || !root) return;
    // Measured from rects rather than offsetTop: each page sits inside a
    // positioned wrapper, which makes it the offsetParent, so offsetTop reports
    // a few pixels within that wrapper instead of the distance down the
    // scroller.
    const top =
      el.getBoundingClientRect().top -
      root.getBoundingClientRect().top +
      root.scrollTop -
      8;
    root.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    setCenter(scrollTo.page);
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

      {shown.map((p, shownIndex) => {
        const entry = pageMap.get(p.page_number);
        const color = colorFor(entry?.index ?? 0, entry?.doc.excluded ?? false);
        const isFirst = entry?.pos === 0;
        const isLast = entry ? entry.pos === entry.of - 1 : false;
        const excluded = entry?.doc.excluded ?? false;

        return (
          // Pages are held to a modest width on purpose. The reviewer's task
          // here is to see how the bundle was divided, which means taking in
          // several pages and the boundaries between them at once; a page
          // rendered large enough to read line by line shows one at a time and
          // hides exactly what they came to check.
          <div key={p.page_number} className="relative mx-auto w-full max-w-[420px]">
            {/* A gap between documents, so a boundary reads even where two
                neighbouring colours look similar on screen. */}
            {isFirst && shownIndex !== 0 && <div className="h-5" />}

            <div className="flex items-stretch gap-2">
              {/* The coloured rule runs down the whole document rather than
                  boxing each page, so where one ends and the next begins is
                  legible at a glance while scrolling. */}
              <div className="relative w-1 shrink-0">
                <div
                  className="absolute inset-x-0"
                  style={{
                    background: color.line,
                    top: isFirst ? 4 : 0,
                    bottom: isLast ? 4 : 0,
                    borderTopLeftRadius: isFirst ? 2 : 0,
                    borderTopRightRadius: isFirst ? 2 : 0,
                    borderBottomLeftRadius: isLast ? 2 : 0,
                    borderBottomRightRadius: isLast ? 2 : 0,
                    opacity: excluded ? 0.45 : 1,
                  }}
                />
              </div>

              <div
                data-page={p.page_number}
                ref={(el) => {
                  if (el) slotRefs.current.set(p.page_number, el);
                  else slotRefs.current.delete(p.page_number);
                }}
                className={`relative min-w-0 flex-1 bg-white shadow-sm dark:bg-slate-100 ${
                  isLast ? '' : 'mb-1'
                }`}
                style={{
                  aspectRatio: `${p.width} / ${p.height}`,
                  border: excluded
                    ? `1.5px dashed ${color.line}`
                    : '1px solid rgba(100,116,139,0.25)',
                  outline: highlight.has(p.page_number) ? '2px solid #f59e0b' : undefined,
                  outlineOffset: 1,
                }}
              >
                {excluded ? (
                  // Excluded pages are shown as a stated outcome, not a blank
                  // gap. The brief's whole trust argument rests on every page
                  // visibly belonging somewhere or being deliberately set aside.
                  <div className="flex h-full w-full items-center justify-center">
                    <span className="text-[11px] font-medium text-slate-400">
                      Blank page · excluded
                    </span>
                  </div>
                ) : (
                  <PageCanvas
                    doc={doc}
                    pageNumber={p.page_number}
                    active={live.has(p.page_number)}
                  />
                )}

                <span className="absolute bottom-1 right-1.5 z-20 rounded bg-white/85 px-1 text-[9px] font-medium text-slate-500">
                  {/* Always the ORIGINAL bundle page. In output order the
                      pages no longer run 1,2,3 down the screen, and this is
                      the number that ties a page back to what was sent. */}
                  bundle p{p.page_number}
                  {!p.has_text_layer && !excluded && (
                    <span
                      className="ml-1 opacity-70"
                      title="No text layer in the original — read by OCR"
                    >
                      scan
                    </span>
                  )}
                </span>
              </div>

              {/* The document chip sits beside the page it starts on, so the
                  key the reviewer types into feedback is always in view. */}
              <div className="w-12 shrink-0 pt-0.5">
                {isFirst && entry && (
                  <span
                    className="inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold"
                    style={{ background: color.chip, color: color.chipText }}
                    title={
                      excluded
                        ? 'Belongs to no document'
                        : (entry.doc.title ?? entry.doc.doc_type ?? '')
                    }
                  >
                    {entry.doc.doc_key}
                  </span>
                )}
              </div>
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
