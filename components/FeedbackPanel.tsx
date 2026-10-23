'use client';

import { useState } from 'react';
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
 * Steps 2–4 of the reviewer's journey: refine by feedback, approve, download.
 *
 * Everything before Approve is a proposal. The reviewer can refine as many
 * times as they like, and each round reports exactly what it changed — the
 * brief's requirement that a revision alter only what the feedback asked for is
 * only credible if the reviewer can see how much was touched.
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
  const [lastReply, setLastReply] = useState<string>('');

  const approved = data.session.status === 'approved';
  const processing = data.progress.pending > 0;
  const canAct = !!data.proposal && !processing && !busy;

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
      setLastReply(json.explanation ?? '');
      onHighlight(json.diff?.movedPages ?? []);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'could not produce the outputs');
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Review
        </h2>

        {data.messages.length === 0 && !processing && (
          <p className="mb-3 rounded-md bg-slate-50 p-3 text-xs leading-relaxed text-slate-600 dark:bg-slate-800/50 dark:text-slate-400">
            Scroll the preview to check every page sits in the right document.
            If something is wrong, describe it below in plain language — for
            example <em>“pages 14–16 are a separate discharge letter”</em> or{' '}
            <em>“D007 is about someone else, exclude it”</em>.
          </p>
        )}

        <ul className="space-y-2">
          {data.messages.map((m) => (
            <li
              key={m.id}
              className={`rounded-md px-3 py-2 text-xs leading-relaxed ${
                m.role === 'reviewer'
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200'
              }`}
            >
              <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide opacity-60">
                {m.role === 'reviewer' ? 'You' : 'Unbundle'}
                {m.proposal_revision ? ` · revision ${m.proposal_revision}` : ''}
              </span>
              {m.content}
            </li>
          ))}
        </ul>

        {diff && <DiffReport diff={diff} reply={lastReply} onJump={onJump} />}

        {approved && data.outputs.length > 0 && (
          <Downloads sessionId={sessionId} outputs={data.outputs} />
        )}
      </div>

      <div className="shrink-0 border-t border-slate-200 p-3 dark:border-slate-800">
        {err && (
          <p className="mb-2 rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
            {err}
          </p>
        )}

        {!approved && (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendFeedback();
              }}
              rows={3}
              disabled={!canAct}
              placeholder={
                processing
                  ? 'Waiting for the first proposal…'
                  : 'Describe what needs to change…'
              }
              className="w-full resize-none rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-100"
            />

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void sendFeedback()}
                disabled={!canAct || !text.trim()}
                className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-900 transition hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-100 dark:hover:bg-slate-800"
              >
                {busy ? 'Revising…' : 'Send feedback'}
              </button>

              <button
                type="button"
                onClick={() => void approve()}
                disabled={!canAct || !data.validation?.ok}
                title={
                  data.validation?.ok
                    ? 'Split the bundle and produce the outputs'
                    : 'Page accounting must balance before approving'
                }
                className="flex-1 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-700 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
              >
                Approve &amp; split
              </button>
            </div>

            <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
              Nothing is split until you approve. ⌘/Ctrl + Enter sends feedback.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function DiffReport({
  diff,
  reply,
  onJump,
}: {
  diff: ProposalDiff;
  reply: string;
  onJump: (page: number) => void;
}) {
  return (
    <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-300">
        What changed
      </h3>

      {reply && (
        <p className="mt-1 text-xs leading-relaxed text-amber-900 dark:text-amber-200">
          {reply}
        </p>
      )}

      <p className="mt-2 text-[11px] text-amber-800 dark:text-amber-300">
        {diff.movedPages.length === 0
          ? 'No pages changed hands.'
          : `${diff.movedPages.length} page(s) moved. ${diff.untouchedDocs} document(s) left untouched.`}
      </p>

      <ul className="mt-2 space-y-1">
        {diff.changes.map((c) => (
          <li key={`${c.kind}-${c.doc_key}`}>
            <button
              type="button"
              onClick={() => {
                const p = c.after?.pages[0] ?? c.before?.pages[0];
                if (p) onJump(p);
              }}
              className="text-left text-[11px] leading-snug text-amber-900 underline-offset-2 hover:underline dark:text-amber-200"
            >
              {c.summary}
            </button>
          </li>
        ))}
      </ul>
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
    <div className="mt-3 rounded-md border border-green-300 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950/40">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-green-900 dark:text-green-300">
        Approved — {children.length} documents
      </h3>

      <div className="mt-2 space-y-1.5">
        {zip && (
          <a
            href={`/api/download/${sessionId}/${zip.id}`}
            className="block rounded bg-green-900 px-2.5 py-1.5 text-center text-xs font-medium text-white hover:bg-green-800 dark:bg-green-200 dark:text-green-950"
          >
            Download all documents (.zip)
          </a>
        )}
        {summary && (
          <a
            href={`/api/download/${sessionId}/${summary.id}`}
            className="block rounded border border-green-700 px-2.5 py-1.5 text-center text-xs font-medium text-green-900 hover:bg-green-100 dark:border-green-700 dark:text-green-200 dark:hover:bg-green-900/40"
          >
            Download summary PDF
          </a>
        )}
      </div>

      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] font-medium text-green-900 dark:text-green-300">
          Individual documents
        </summary>
        <ul className="mt-1.5 space-y-0.5">
          {children.map((c) => (
            <li key={c.id}>
              <a
                href={`/api/download/${sessionId}/${c.id}`}
                className="block truncate text-[11px] text-green-900 hover:underline dark:text-green-200"
                title={c.filename}
              >
                {c.filename}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
