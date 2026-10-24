'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { BundleViewer, type PageOrder, type ViewerPage } from '@/components/BundleViewer';
import { DocumentSidebar, type PersonSummary } from '@/components/DocumentSidebar';
import { FeedbackPanel } from '@/components/FeedbackPanel';
import { SessionsRail } from '@/components/SessionsRail';
import { ProcessingOverlay, type Phases } from '@/components/ProcessingOverlay';
import { useRouter } from 'next/navigation';
import type { Proposal } from '@/lib/types';
import type { ValidationResult } from '@/lib/proposal/validate';

interface SessionPayload {
  session: {
    id: string;
    name: string;
    status: string;
    page_count: number | null;
    approved_at: string | null;
    error: string | null;
  };
  bundleUrl: string | null;
  proposal: Proposal | null;
  pages: ViewerPage[];
  revisions: {
    id: string;
    revision: number;
    origin: string;
    summary: string | null;
    created_at: string;
  }[];
  messages: {
    id: string;
    role: string;
    content: string | null;
    ops: unknown;
    proposal_revision: number | null;
    created_at: string;
  }[];
  outputs: { id: string; kind: string; filename: string; page_count: number | null }[];
  people: PersonSummary[];
  progress: {
    total: number;
    done: number;
    failed: number;
    pending: number;
    phases: Phases;
  };
  ocr: { scannedTotal: number; done: number; needsOcr: number[] };
  validation: ValidationResult | null;
}

/** How many classify windows to drive at once. Each tick is one short Claude
 *  call, so a little concurrency cuts a 24-window bundle down sharply without
 *  risking a function timeout. */
const TICK_CONCURRENCY = 3;

/**
 * Which sessions this tab is already driving.
 *
 * Module scope on purpose. A useRef guard resets on every remount, and React
 * remounts this tree readily — in development it mounts effects twice, and any
 * parent re-render that flips a conditional does it again. With a ref, each
 * remount started another queue driver, and because every pass refreshes the
 * session the result was a self-sustaining request storm against the server.
 * Keyed by session id, this survives remounts and cannot start twice.
 *
 * The driver deliberately does NOT stop when the effect is cleaned up. React's
 * development double-mount cleans up immediately after the first run, and an
 * earlier version aborted the loop there — while the module guard stopped the
 * second run from restarting it. The queue got exactly one pass and then sat
 * untouched. Identifying a bundle is work that should finish once started, so
 * it now runs to completion independently of whether the component is still
 * mounted; the entry is cleared at the end so a later visit can resume any
 * windows left over.
 */
const driving = new Set<string>();

/** Sessions whose OCR pass this tab has already started. Same remount-proofing
 *  as the queue driver — starting two tesseract workers would halve throughput
 *  for no benefit. */
const ocrStarted = new Set<string>();

/** Safety net: a queue that somehow never settles still stops. */
const MAX_TICK_PASSES = 200;

/** How long the OCR pass will wait for identification to finish: 200 × 3s. */
const OCR_WAIT_PASSES = 200;

/** The Documents column's draggable width, in pixels. The default matches the
 *  fixed width it replaced; the bounds keep it from disappearing entirely or
 *  swallowing the preview. */
const DOC_WIDTH_DEFAULT = 220;
const DOC_WIDTH_MIN = 160;
const DOC_WIDTH_MAX = 520;
const DOC_WIDTH_STORAGE_KEY = 'unbundle:docColumnWidth';

export function Workspace({ sessionId: id }: { sessionId: string }) {
  const router = useRouter();
  const [data, setData] = useState<SessionPayload | null>(null);
  const [error, setError] = useState('');
  const [activePage, setActivePage] = useState<number | null>(null);
  const [scrollTo, setScrollTo] = useState<{ page: number; nonce: number }>();
  const [highlight, setHighlight] = useState<number[]>([]);
  const [stalled, setStalled] = useState('');
  // Output order by default: it is the split the reviewer is being asked to
  // approve. Bundle order stays a click away because it is the only view that
  // answers "is this really what I was sent, with nothing missing?".
  const [pageOrder, setPageOrder] = useState<PageOrder>('output');
  const [approving, setApproving] = useState(false);
  const [leavingForDownloads, setLeavingForDownloads] = useState(false);
  // With Cache Components this page is hidden, not unmounted, when the
  // Downloads page opens; clear the block so coming back finds it usable.
  useEffect(() => () => setLeavingForDownloads(false), []);
  const [approveError, setApproveError] = useState('');
  const [ocrProgress, setOcrProgress] = useState<{ done: number; total: number } | null>(null);
  const [mergingKey, setMergingKey] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState('');

  // The Documents column's width, dragged via the handle beside it. Read from
  // localStorage once the component has mounted (never during the initial
  // render, which may run on the server, where localStorage does not exist),
  // so a reviewer who widens it to read a long name does not have to redo
  // that on every session they open.
  const [docWidth, setDocWidth] = useState(DOC_WIDTH_DEFAULT);
  const docWidthRef = useRef(docWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    docWidthRef.current = docWidth;
  }, [docWidth]);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(DOC_WIDTH_STORAGE_KEY));
      if (Number.isFinite(saved) && saved >= DOC_WIDTH_MIN && saved <= DOC_WIDTH_MAX) {
        setDocWidth(saved);
      }
    } catch {
      // A private window or blocked storage just means the default width.
    }
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const next = Math.min(
        DOC_WIDTH_MAX,
        Math.max(DOC_WIDTH_MIN, dragRef.current.startWidth + (e.clientX - dragRef.current.startX)),
      );
      setDocWidth(next);
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        localStorage.setItem(DOC_WIDTH_STORAGE_KEY, String(docWidthRef.current));
      } catch {
        // Nothing to do if it cannot be saved — the width still applies for
        // the rest of this visit.
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: docWidth };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [docWidth],
  );

  const load = useCallback(async () => {
    const res = await fetch(`/api/sessions/${id}`);
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? 'could not load this session');
      return null;
    }
    setData(json);
    return json as SessionPayload;
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Drive the job queue from the browser. Each tick processes one page window
  // server-side, so no single function invocation goes near its duration cap
  // and the reviewer sees steady progress instead of one long opaque wait.
  //
  // Deliberately keyed on the session alone, not on `data`. Every tick refreshes
  // `data`, so depending on it would restart this effect on each pass — and
  // when the queue cannot advance at all (no API key, every window failed) that
  // restart becomes an endless request loop against the server.
  useEffect(() => {
    if (driving.has(id)) return;
    driving.add(id);

    (async () => {
      for (let pass = 0; pass < MAX_TICK_PASSES; pass++) {
        const current = await load();
        if (!current || current.progress.pending === 0) break;
        // A reviewer who cancelled is not waiting for anything; stop asking
        // the server for more work.
        if (current.session.status === 'cancelled') break;

        const results = await Promise.all(
          Array.from({ length: TICK_CONCURRENCY }, () =>
            fetch('/api/jobs/tick', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session_id: id }),
            })
              .then((r) => r.json())
              .catch(() => ({ idle: true as const })),
          ),
        );

        // The queue is stalled rather than finished: say why instead of
        // hammering the endpoint.
        const blocked = results.find((r) => r.blocked)?.blocked;
        if (blocked) {
          setStalled(blocked);
          break;
        }
        if (results.every((r) => r.idle)) break;
      }
      await load();
      // Cleared so that reopening this session can pick up any windows that
      // failed or were left pending.
      driving.delete(id);
    })();
  }, [id, load]);

  // Make scanned pages searchable, quietly, in the background.
  //
  // Nothing waits on this: identification reads the scans directly, and a
  // reviewer can refine and approve while it is still running. It exists only
  // so the exported child PDFs carry an invisible text layer — tesseract
  // reports where each word sits, which vision does not.
  //
  // Keyed on the session alone, and it reads the page list itself rather than
  // taking it from `data`. Depending on `data` meant this effect tore down and
  // restarted on every poll, and its cleanup aborted the pass each time — so
  // the OCR never got past its first page. Same trap, and same fix, as the
  // queue driver above. For the same reason the pass is not aborted on
  // unmount: a reviewer glancing at another session should not silently throw
  // away minutes of completed work, and the module-scoped guard is what stops
  // a second worker starting.
  useEffect(() => {
    if (ocrStarted.has(id)) return;
    ocrStarted.add(id);

    void (async () => {
      try {
        // Wait out identification before competing for the CPU with it: both
        // run in this tab, and a reviewer wants the split decided first.
        // Searchability can arrive late; the proposal cannot.
        let payload: SessionPayload | null = null;
        for (let i = 0; i < OCR_WAIT_PASSES; i++) {
          const res = await fetch(`/api/sessions/${id}`);
          if (!res.ok) return;
          payload = await res.json();
          const status = payload?.session.status;
          if (status === 'cancelled' || status === 'failed') return;
          if (status !== 'uploading' && status !== 'inventorying' && status !== 'processing') break;
          await new Promise((r) => setTimeout(r, 3000));
        }

        const pages = payload?.ocr?.needsOcr ?? [];
        const bundleUrl = payload?.bundleUrl;
        if (!bundleUrl || !pages.length) return;

        const { runOcrPass } = await import('@/lib/ocr/run');
        const result = await runOcrPass({
          sessionId: id,
          bundleUrl,
          pages,
          onProgress: ({ done, total }) => setOcrProgress({ done, total }),
        });
        if (result.failed) {
          console.warn(
            `OCR: ${result.completed} of ${pages.length} scanned pages read, ${result.failed} failed. ` +
              `Those pages export faithfully, just without a text layer.`,
          );
        }
      } catch (e) {
        console.error('OCR pass failed', e);
      } finally {
        setOcrProgress(null);
        // Cleared so reopening the session retries whatever did not finish.
        ocrStarted.delete(id);
        await load();
      }
    })();
  }, [id, load]);

  const jump = useCallback((page: number) => {
    setScrollTo({ page, nonce: Date.now() });
  }, []);

  const cancel = useCallback(async () => {
    await fetch(`/api/sessions/${id}/cancel`, { method: 'POST' });
    // Clear the guard so reopening this session can resume the windows that
    // were never started.
    driving.delete(id);
    router.push('/');
  }, [id, router]);

  const approve = useCallback(async () => {
    setApproving(true);
    setApproveError('');
    try {
      const res = await fetch('/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'could not produce the outputs');
      await load();
      // Downloads are the next step, on a page of their own. Stay blocked
      // until the navigation lands.
      setLeavingForDownloads(true);
      router.push(`/s/${id}/download`);
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(false);
    }
  }, [id, load, router]);

  // Owned here, not by DocumentSidebar, specifically so the blocking overlay
  // below can cover the whole workspace — the reviewer asked not to be able to
  // click anything else while a merge is in flight, not just the sidebar.
  const markSameAsClient = useCallback(
    async (personKey: string) => {
      setMergingKey(personKey);
      setMergeError('');
      try {
        const res = await fetch(`/api/sessions/${id}/mark-same-as-client`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ person_key: personKey }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'could not mark these documents as the client');
        await load();
      } catch (e) {
        setMergeError(e instanceof Error ? e.message : String(e));
      } finally {
        setMergingKey(null);
      }
    },
    [id, load],
  );

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        <Link href="/" className="mt-4 inline-block text-sm underline">
          Back to sessions
        </Link>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <p className="text-sm text-slate-500">Loading session…</p>
      </main>
    );
  }

  const { session, bundleUrl, proposal, pages, validation, progress } = data;
  const people = data.people ?? [];
  // Block the workspace while the split is still being decided: everything on
  // screen describes a proposal the next phase is about to rewrite.
  const busy = progress.pending > 0 && session.status !== 'cancelled' && !stalled;
  const processing = progress.pending > 0;
  const approved = session.status === 'approved';

  // Approving splits the bundle and writes every output file, which takes a
  // while; anything the reviewer did meanwhile (an edit, another approve)
  // would race it. Block the whole screen until it finishes, and keep it
  // blocked while the Downloads page opens.
  const blocking = approving || leavingForDownloads;

  return (
    <main className="relative flex h-dvh flex-col bg-white dark:bg-slate-900">
      {blocking && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-busy="true"
          aria-label="Approving the split"
          className="fixed inset-0 z-[100] flex cursor-wait items-center justify-center bg-white/75 backdrop-blur-[2px] dark:bg-slate-900/75"
        >
          <div className="flex flex-col items-center gap-3 rounded-lg border border-slate-200 bg-white px-8 py-6 shadow-xl dark:border-slate-700 dark:bg-slate-800">
            <span
              aria-hidden
              className="h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600 dark:border-slate-600 dark:border-t-blue-400"
            />
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Approving the split…
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Creating your documents and summary. Please wait.
            </p>
          </div>
        </div>
      )}
      <header
        inert={blocking}
        className="shrink-0 border-b border-slate-200 dark:border-slate-800"
      >
        <div className="flex items-center gap-3 px-4 py-2.5">
          <h1 className="shrink-0 truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {session.name}
          </h1>
          <p className="min-w-0 flex-1 truncate text-xs text-slate-500 dark:text-slate-400">
            {proposal ? `Proposal v${proposal.revision}` : 'Preparing'}
            {' · '}
            {approved ? 'approved' : 'awaiting approval'}
            {session.page_count ? ` · ${session.page_count} pages` : ''}
          </p>

          {processing && !stalled && (
            <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
              {progress.done} of {progress.total}
            </span>
          )}

          {ocrProgress && (
            <span
              title="Reading scanned pages so the exported documents are searchable. Nothing waits for this."
              className="hidden shrink-0 whitespace-nowrap text-xs text-slate-400 xl:inline"
            >
              scans {ocrProgress.done}/{ocrProgress.total}
            </span>
          )}

          <div className="flex shrink-0 overflow-hidden rounded-md border border-slate-300 dark:border-slate-700">
            {(
              [
                ['output', 'Split order'],
                ['bundle', 'As sent'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setPageOrder(value)}
                title={
                  value === 'output'
                    ? 'Each document’s pages together, as they will be exported'
                    : 'The original bundle, front to back, exactly as received'
                }
                className={`px-2 py-1 text-[11px] font-medium transition ${
                  pageOrder === value
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {people.length > 1 && (
            <span
              title={people
                .map((p) => `${p.name}${p.isClient ? ' (the client)' : ''} — ${p.pages.length} pages`)
                .join('\n')}
              className="shrink-0 whitespace-nowrap rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-300"
            >
              {people.length} people in this bundle
            </span>
          )}

          {validation && <PageAccountingBadge v={validation} />}

          {!approved && (
            <button
              type="button"
              onClick={() => void approve()}
              disabled={busy || !proposal || processing || approving || !validation?.ok}
              title={
                validation?.ok
                  ? 'Split the bundle and produce the outputs'
                  : 'Page accounting must balance before approving'
              }
              className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700 disabled:opacity-40"
            >
              {approving ? 'Splitting…' : 'Approve split'}
            </button>
          )}
          {approved && (
            <Link
              href={`/s/${id}/download`}
              className="shrink-0 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-green-700"
            >
              Go to downloads
            </Link>
          )}
        </div>

        {(stalled || approveError || mergeError) && (
          <p className="border-t border-amber-200 bg-amber-50 px-4 py-1.5 text-xs leading-snug text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
            {approveError || mergeError || stalled}
          </p>
        )}
      </header>

      {/* Sessions · Documents · (drag handle) · Preview · Refine — the four
          things the reviewer moves between, all visible at once so none of
          them is a detour. */}
      {/* grid-rows-[minmax(0,1fr)] is doing real work here. Without an explicit
          row the implicit one sizes to its tallest child, so `h-full` on the
          columns resolved against content rather than the viewport: the Refine
          panel grew as the conversation did, pushing its own text box past the
          bottom of the screen and scrolling the whole page instead of the
          message list. Pinning the row to the available height makes each
          column scroll inside itself. */}
      <div
        inert={blocking}
        className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] overflow-hidden"
        style={{
          gridTemplateColumns: `clamp(130px,11vw,180px) ${docWidth}px 6px 1fr clamp(220px,20vw,320px)`,
        }}
      >
        <SessionsRail currentId={id} />

        <DocumentSidebar
          docs={proposal?.docs ?? []}
          people={people}
          activePage={activePage}
          onJump={jump}
          mergingKey={mergingKey}
          onMarkSameAsClient={(personKey) => void markSameAsClient(personKey)}
        />

        {/* The Documents column's own content truncates long names, which is
            exactly what dragging this wider is for — so a reviewer can read
            whose document that unmatched "not the client" row actually
            belongs to, instead of guessing from a clipped label. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the documents column"
          onMouseDown={startResize}
          className="group relative z-10 cursor-col-resize"
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-200 transition group-hover:bg-blue-400 group-active:bg-blue-500 dark:bg-slate-800" />
        </div>

        <div className="min-h-0 overflow-hidden">
          {bundleUrl && pages.length > 0 ? (
            <BundleViewer
              bundleUrl={bundleUrl}
              pages={pages}
              docs={proposal?.docs ?? []}
              order={pageOrder}
              scrollTo={scrollTo}
              onVisiblePageChange={setActivePage}
              highlightPages={highlight}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              {session.error ? `Failed — ${session.error}` : 'Preparing the preview…'}
            </div>
          )}
        </div>

        <FeedbackPanel
          sessionId={id}
          data={data}
          onChanged={load}
          onHighlight={setHighlight}
          onJump={jump}
        />
      </div>

      {busy && progress.phases && (
        <ProcessingOverlay
          pageCount={session.page_count}
          phases={progress.phases}
          onCancel={cancel}
        />
      )}

      {/* Blocking, deliberately, and with no cancel: a merge is one quick,
          deterministic write (no AI call — see the mark-same-as-client
          route), not a long process worth letting the reviewer walk away
          from or interrupt midway through. */}
      {mergingKey && (
        <div
          role="dialog"
          aria-modal="true"
          aria-busy="true"
          aria-label="Marking documents as the client"
          className="absolute inset-0 z-50 flex items-center justify-center bg-slate-900/70 backdrop-blur-sm"
        >
          <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <span
              className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600 dark:border-slate-600 dark:border-t-blue-400"
              aria-hidden
            />
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Merging documents into the client…
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

/**
 * Ground rule #1, made visible. The reviewer should never have to take on faith
 * that no page went missing — this says so explicitly, and turns red the moment
 * it stops being true.
 */
function PageAccountingBadge({ v }: { v: ValidationResult }) {
  const total = v.assigned + v.excluded;
  return (
    <span
      title={
        v.ok
          ? `${v.assigned} pages in documents, ${v.excluded} excluded`
          : v.errors.join(' · ')
      }
      className={`shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${
        v.ok
          ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
          : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
      }`}
    >
      {v.ok
        ? `${total} / ${v.pageCount} pages accounted for`
        : `Page accounting broken — ${v.errors.length} problem${
            v.errors.length === 1 ? '' : 's'
          }`}
    </span>
  );
}
