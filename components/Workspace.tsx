'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BundleViewer, type ViewerPage } from '@/components/BundleViewer';
import { DocumentSidebar } from '@/components/DocumentSidebar';
import { FeedbackPanel } from '@/components/FeedbackPanel';
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
  progress: { total: number; done: number; failed: number; pending: number };
  ocr: { scannedTotal: number; done: number; needsOcr: number[] };
  validation: ValidationResult | null;
}

/** How many classify windows to drive at once. Each tick is one short Claude
 *  call, so a little concurrency cuts a 24-window bundle down sharply without
 *  risking a function timeout. */
const TICK_CONCURRENCY = 3;

/**
 * Which sessions this tab is already driving, or has finished driving.
 *
 * Module scope on purpose. A useRef guard resets on every remount, and React
 * remounts this tree readily — in development it mounts effects twice, and any
 * parent re-render that flips a conditional does it again. With a ref, each
 * remount started another queue driver, and because every pass refreshes the
 * session the result was a self-sustaining request storm against the server.
 * Keyed by session id, this survives remounts and cannot start twice.
 */
const driving = new Map<string, 'running' | 'finished'>();

/** Sessions whose OCR pass this tab has already started. Same remount-proofing
 *  as the queue driver — starting two tesseract workers would halve throughput
 *  for no benefit. */
const ocrStarted = new Set<string>();

/** Safety net: a queue that somehow never settles still stops. */
const MAX_TICK_PASSES = 200;

export function Workspace({ sessionId: id }: { sessionId: string }) {
  const [data, setData] = useState<SessionPayload | null>(null);
  const [error, setError] = useState('');
  const [activePage, setActivePage] = useState<number | null>(null);
  const [scrollTo, setScrollTo] = useState<{ page: number; nonce: number }>();
  const [highlight, setHighlight] = useState<number[]>([]);
  const [stalled, setStalled] = useState('');
  const [ocrProgress, setOcrProgress] = useState<{ done: number; total: number } | null>(null);

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
    if (driving.get(id)) return;
    driving.set(id, 'running');
    let stopped = false;

    (async () => {
      for (let pass = 0; pass < MAX_TICK_PASSES; pass++) {
        if (stopped) break;

        const current = await load();
        if (!current || current.progress.pending === 0) break;

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
      // Deliberately left as 'finished' rather than cleared: the queue is
      // settled (or stalled), and a remount must not start it over.
      driving.set(id, 'finished');
    })();

    return () => {
      stopped = true;
    };
  }, [id, load]);

  // Make scanned pages searchable, quietly, in the background.
  //
  // Nothing waits on this: identification reads the scans directly, and a
  // reviewer can refine and approve while it is still running. It exists only
  // so the exported child PDFs carry an invisible text layer — tesseract
  // reports where each word sits, which vision does not.
  useEffect(() => {
    if (!data || ocrStarted.has(id)) return;
    if (!data.bundleUrl || !data.ocr?.needsOcr.length) return;

    ocrStarted.add(id);
    const controller = new AbortController();
    const pending = data.ocr.needsOcr;
    const bundleUrl = data.bundleUrl;

    void (async () => {
      try {
        const { runOcrPass } = await import('@/lib/ocr/run');
        await runOcrPass({
          sessionId: id,
          bundleUrl,
          pages: pending,
          signal: controller.signal,
          onProgress: ({ done, total }) => setOcrProgress({ done, total }),
        });
      } catch (e) {
        console.error('OCR pass failed', e);
      } finally {
        setOcrProgress(null);
        await load();
      }
    })();

    return () => controller.abort();
  }, [data, id, load]);

  const jump = useCallback((page: number) => {
    setScrollTo({ page, nonce: Date.now() });
  }, []);

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
  const processing = progress.pending > 0;
  const approved = session.status === 'approved';

  return (
    <main className="flex h-dvh flex-col">
      <header className="shrink-0 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <Link
            href="/"
            className="shrink-0 whitespace-nowrap text-sm text-slate-500 transition hover:text-slate-900 dark:hover:text-slate-100"
          >
            ← Sessions
          </Link>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
              {session.name}
            </h1>
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">
              {session.page_count ?? '—'} pages
              {proposal ? ` · revision ${proposal.revision}` : ''}
              {approved ? ' · approved' : ''}
            </p>
          </div>

          {processing && !stalled && (
            <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-slate-600 dark:text-slate-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
              {progress.done} of {progress.total} sections
            </span>
          )}

          {ocrProgress && (
            <span
              title="Reading scanned pages so the exported documents are searchable. Nothing waits for this."
              className="hidden shrink-0 whitespace-nowrap text-xs text-slate-500 lg:inline dark:text-slate-400"
            >
              Making scans searchable — {ocrProgress.done}/{ocrProgress.total}
            </span>
          )}

          {validation && <PageAccountingBadge v={validation} />}
        </div>

        {stalled && (
          <p className="border-t border-amber-200 bg-amber-50 px-4 py-1.5 text-xs leading-snug text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
            {stalled}
          </p>
        )}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[clamp(240px,22vw,340px)_1fr_clamp(280px,26vw,420px)]">
        <DocumentSidebar
          docs={proposal?.docs ?? []}
          activePage={activePage}
          onJump={jump}
        />

        <div className="min-h-0">
          {bundleUrl && pages.length > 0 ? (
            <BundleViewer
              bundleUrl={bundleUrl}
              pages={pages}
              docs={proposal?.docs ?? []}
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
