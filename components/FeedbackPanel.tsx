'use client';

import { useEffect, useRef, useState } from 'react';
import type { ProposalDiff } from '@/lib/proposal/diff';

interface Props {
  sessionId: string;
  data: {
    session: { status: string; approved_at: string | null };
    proposal: { revision: number; docs: unknown[] } | null;
    messages: {
      id: string;
      role: string;
      content: string | null;
      proposal_revision: number | null;
      created_at: string;
    }[];
    outputs: { id: string; kind: string; filename: string; page_count: number | null }[];
    progress: { pending: number };
    validation: { ok: boolean } | null;
  };
  onChanged: () => Promise<unknown>;
  onHighlight: (pages: number[]) => void;
  onJump: (page: number) => void;
}

/**
 * Refine with AI.
 *
 * The conversation is the audit trail of the split, which is why it is saved
 * with the session and reads back as an ordered record rather than a chat that
 * scrolls away: each request is followed by what actually changed and which
 * proposal version resulted. A reviewer returning a week later can see not just
 * where the split ended up but why.
 */
export function FeedbackPanel({
  sessionId,
  data,
  onChanged,
  onHighlight,
  onJump,
}: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [diff, setDiff] = useState<ProposalDiff | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const approved = data.session.status === 'approved';
  const processing = data.progress.pending > 0;
  const canAct = !!data.proposal && !processing && !busy && !approved;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [data.messages.length, diff]);

  async function sendFeedback() {
    const feedback = text.trim();
    if (!feedback) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, feedback }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'the revision failed');
      setText('');
      setDiff(json.diff ?? null);
      onHighlight(json.diff?.movedPages ?? []);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-200 px-3 py-3 dark:border-slate-800">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Refine with AI
        </h2>
        <p className="mt-0.5 text-[10px] text-slate-400">Saved with this session</p>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {data.messages.length === 0 && !processing && (
          <p className="rounded-md bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-600 dark:bg-slate-800/50 dark:text-slate-400">
            Describe a change in plain language — for example{' '}
            <em>&ldquo;D001 should end at page 2&rdquo;</em> or{' '}
            <em>&ldquo;page 3 is blank, exclude it&rdquo;</em>.
          </p>
        )}

        {data.messages.map((m) =>
          m.role === 'reviewer' ? (
            <div
              key={m.id}
              className="rounded-md border border-slate-300 px-2.5 py-2 text-[11px] leading-relaxed text-slate-800 dark:border-slate-600 dark:text-slate-200"
            >
              {m.content}
            </div>
          ) : (
            <div key={m.id} className="rounded-md bg-slate-100 px-2.5 py-2 dark:bg-slate-800">
              <p className="text-[11px] leading-relaxed text-slate-700 dark:text-slate-300">
                {m.content}
              </p>
              {m.proposal_revision != null && (
                <p className="mt-1 text-[10px] font-medium text-slate-400">
                  Proposal v{m.proposal_revision}
                </p>
              )}
            </div>
          ),
        )}

        {diff && diff.changes.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 dark:border-amber-800 dark:bg-amber-950/40">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-300">
              What changed
            </p>
            <p className="mt-1 text-[10px] text-amber-800 dark:text-amber-300">
              {diff.movedPages.length === 0
                ? 'No pages changed hands.'
                : `${diff.movedPages.length} page(s) moved · ${diff.untouchedDocs} document(s) untouched`}
            </p>
            <ul className="mt-1.5 space-y-1">
              {diff.changes.map((c) => (
                <li key={`${c.kind}-${c.doc_key}`}>
                  <button
                    type="button"
                    onClick={() => {
                      const p = c.after?.pages[0] ?? c.before?.pages[0];
                      if (p) onJump(p);
                    }}
                    className="text-left text-[10px] leading-snug text-amber-900 underline-offset-2 hover:underline dark:text-amber-200"
                  >
                    {c.summary}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {approved && <Downloads sessionId={sessionId} outputs={data.outputs} />}

        <div ref={endRef} />
      </div>

      {!approved && (
        <div className="shrink-0 border-t border-slate-200 p-3 dark:border-slate-800">
          {err && (
            <p className="mb-2 rounded bg-red-50 p-2 text-[10px] text-red-700 dark:bg-red-950 dark:text-red-300">
              {err}
            </p>
          )}

          <div className="rounded-md border border-slate-300 focus-within:border-slate-900 dark:border-slate-700 dark:focus-within:border-slate-100">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendFeedback();
              }}
              rows={3}
              disabled={!canAct}
              placeholder={
                processing ? 'Working through the bundle…' : 'Describe a change…'
              }
              className="w-full resize-none bg-transparent px-2.5 py-2 text-[11px] text-slate-900 placeholder:text-slate-400 focus:outline-none disabled:opacity-50 dark:text-slate-100"
            />
            <div className="flex justify-end px-2 pb-2">
              <button
                type="button"
                onClick={() => void sendFeedback()}
                disabled={!canAct || !text.trim()}
                className="rounded bg-blue-600 px-3 py-1 text-[11px] font-medium text-white transition hover:bg-blue-700 disabled:opacity-40"
              >
                {busy ? 'Revising…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Downloads({
  sessionId,
  outputs,
}: {
  sessionId: string;
  outputs: { id: string; kind: string; filename: string; page_count: number | null }[];
}) {
  const summary = outputs.find((o) => o.kind === 'summary');
  const zip = outputs.find((o) => o.kind === 'zip');
  const children = outputs.filter((o) => o.kind === 'child');

  return (
    <div className="rounded-md border border-green-300 bg-green-50 p-2.5 dark:border-green-800 dark:bg-green-950/40">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-green-900 dark:text-green-300">
        Approved — {children.length} documents
      </p>

      <ul className="mt-2 space-y-1">
        {children.map((c) => (
          <li key={c.id}>
            <a
              href={`/api/download/${sessionId}/${c.id}`}
              className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-[11px] text-green-900 hover:bg-green-100 dark:text-green-200 dark:hover:bg-green-900/40"
            >
              <span className="truncate">{c.filename}</span>
              <span aria-hidden>↓</span>
            </a>
          </li>
        ))}
        {summary && (
          <li>
            <a
              href={`/api/download/${sessionId}/${summary.id}`}
              className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-[11px] font-semibold text-green-900 hover:bg-green-100 dark:text-green-200 dark:hover:bg-green-900/40"
            >
              <span className="truncate">{summary.filename}</span>
              <span aria-hidden>↓</span>
            </a>
          </li>
        )}
      </ul>

      {zip && (
        <a
          href={`/api/download/${sessionId}/${zip.id}`}
          className="mt-2 block rounded bg-blue-600 px-2.5 py-1.5 text-center text-[11px] font-medium text-white hover:bg-blue-700"
        >
          Download all
        </a>
      )}
    </div>
  );
}
