'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ProposalDiff } from '@/lib/proposal/diff';

/**
 * Starter instructions for the changes a reviewer makes most (move, reorder,
 * merge, exclude, relabel, undo). Clicking one fills
 * the box for the reviewer to adjust and send.
 *
 * Pages are named "bundle pN" on purpose: a bare "page 24 of D001" was read as
 * D001's 4th page rather than original page 24, while "bundle p24" — the label
 * printed under every page in the preview — was understood every time.
 */
const CHAT_EXAMPLES: { text: string; what: string }[] = [
  { text: 'Move bundle p19 from D001 to D002', what: 'Move a page into another document' },
  { text: 'In D004 move bundle p5 after bundle p9', what: 'Change the page order inside a document' },
  { text: 'Merge D005 into D004', what: 'Join two documents into one' },
  { text: 'Bundle p32 is blank, exclude it', what: 'Remove a blank or unwanted page' },
  { text: 'D002 is a Prescription, not Notes', what: 'Correct the category' },
  { text: 'Revert the last change', what: 'Undo the last change or step' },
];

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
  const [showExamples, setShowExamples] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-200 px-3 py-3 dark:border-slate-800">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Refine with AI
        </h2>
        <p className="mt-0.5 text-[10px] text-slate-400">Saved with this session</p>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {data.messages.length === 0 && !processing && (
          <p className="rounded-md bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-600 dark:bg-slate-800/50 dark:text-slate-400">
            Describe a change in plain language. Refer to pages by the{' '}
            <em>bundle p</em> number printed under each page, and to documents by
            their D number — for example{' '}
            <em>&ldquo;Move bundle p19 from D001 to D002&rdquo;</em>. Click{' '}
            <em>Examples</em> below for more.
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

        {approved && (
          <Link
            href={`/s/${sessionId}/download`}
            className="block rounded-md border border-green-300 px-2.5 py-2 text-center text-[11px] font-medium text-green-800 transition hover:bg-green-50 dark:border-green-800 dark:text-green-300 dark:hover:bg-green-950/40"
          >
            Split approved — go to downloads →
          </Link>
        )}

        <div ref={endRef} />
      </div>

      {!approved && (
        <div className="shrink-0 border-t border-slate-200 p-3 dark:border-slate-800">
          {err && (
            <p className="mb-2 rounded bg-red-50 p-2 text-[10px] text-red-700 dark:bg-red-950 dark:text-red-300">
              {err}
            </p>
          )}

          <button
            type="button"
            onClick={() => setShowExamples((v) => !v)}
            className="mb-1.5 text-[10px] font-medium text-blue-700 hover:underline dark:text-blue-300"
          >
            {showExamples ? 'Hide examples' : 'Examples'}
          </button>
          {showExamples && (
            <ul className="mb-2 space-y-1">
              {CHAT_EXAMPLES.map((ex) => (
                <li key={ex.text}>
                  <button
                    type="button"
                    disabled={!canAct}
                    onClick={() => {
                      setText(ex.text);
                      inputRef.current?.focus();
                    }}
                    title={ex.what}
                    className="w-full rounded border border-slate-200 px-2 py-1 text-left text-[10px] text-slate-700 transition hover:border-blue-300 hover:bg-blue-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    {ex.text}
                    <span className="block text-[9px] text-slate-400">{ex.what}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="rounded-md border border-slate-300 focus-within:border-slate-900 dark:border-slate-700 dark:focus-within:border-slate-100">
            <textarea
              ref={inputRef}
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

