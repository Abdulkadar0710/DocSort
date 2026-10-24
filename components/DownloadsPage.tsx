'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Output {
  id: string;
  kind: string;
  filename: string;
  page_count: number | null;
}

interface Payload {
  session: { name: string; status: string; approved_at: string | null; page_count: number | null };
  outputs: Output[];
}

/**
 * Step 3 of the reviewer's journey: the approved outputs.
 *
 * A page of its own rather than a box at the foot of the chat, so approving
 * reads as finishing a step: review, approve, then collect the files here.
 * The review stays one click away for re-approving after a change.
 */
export function DownloadsPage({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/sessions/${sessionId}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? 'could not load this session');
        setData(json);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [sessionId]);

  const back = (
    <Link href={`/s/${sessionId}`} className="text-sm text-blue-700 hover:underline dark:text-blue-300">
      ← Back to review
    </Link>
  );

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        <div className="mt-4">{back}</div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <p className="text-sm text-slate-500">Loading downloads…</p>
      </main>
    );
  }

  const { session, outputs } = data;
  const children = outputs.filter((o) => o.kind === 'child');
  const summary = outputs.find((o) => o.kind === 'summary');
  const zip = outputs.find((o) => o.kind === 'zip');
  const href = (o: Output) => `/api/download/${sessionId}/${o.id}`;

  if (session.status !== 'approved' || !children.length) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Nothing to download yet</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Approve the split first — the documents are produced when you do.
        </p>
        <div className="mt-4">{back}</div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      {back}

      <header className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-green-700 dark:text-green-400">
          Split approved
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          {session.name}
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {children.length} document{children.length === 1 ? '' : 's'}
          {session.page_count ? ` from ${session.page_count} pages` : ''}, plus a summary
          {session.approved_at ? ` · approved ${new Date(session.approved_at).toLocaleString()}` : ''}
        </p>
      </header>

      {zip && (
        <a
          href={href(zip)}
          className="mt-6 flex items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          Download all <span className="font-normal opacity-80">(.zip)</span>
        </a>
      )}

      <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">Documents</h2>
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {children.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-4 px-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-900 dark:text-slate-100">{c.filename}</p>
                {c.page_count != null && (
                  <p className="text-xs text-slate-500">
                    {c.page_count} page{c.page_count === 1 ? '' : 's'}
                  </p>
                )}
              </div>
              <a
                href={href(c)}
                className="shrink-0 rounded border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Download
              </a>
            </li>
          ))}
        </ul>
      </section>

      {summary && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">Summary</h2>
          <div className="flex items-center justify-between gap-4 rounded-md border border-slate-200 px-4 py-2.5 dark:border-slate-800">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{summary.filename}</p>
              <p className="text-xs text-slate-500">Document register, categories and review notes</p>
            </div>
            <a
              href={href(summary)}
              className="shrink-0 rounded border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Download
            </a>
          </div>
        </section>
      )}

      <div className="mt-10 border-t border-slate-200 pt-4 text-sm dark:border-slate-800">
        <Link href="/" className="text-blue-700 hover:underline dark:text-blue-300">
          Start a new session
        </Link>
      </div>
    </main>
  );
}
