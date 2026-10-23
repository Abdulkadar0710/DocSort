'use client';

import { colorFor } from '@/lib/palette';
import { summariseRuns } from '@/lib/proposal/validate';
import { REVIEW_LABELS, SERIOUS_REVIEW_CODES, type ProposalDoc } from '@/lib/types';

interface Props {
  docs: ProposalDoc[];
  activePage: number | null;
  onJump: (page: number) => void;
}

/**
 * The document register. Clicking an entry jumps the preview to its first page.
 *
 * Flags are deliberately prominent: under the brief's "a wrong answer costs
 * more than unknown" rule, the useful signal for a reviewer is not only what we
 * identified but where we were unsure, where a document duplicates another, and
 * where it may concern someone other than the client.
 */
export function DocumentSidebar({ docs, activePage, onJump }: Props) {
  const identified = docs.filter((d) => !d.excluded && d.doc_type).length;
  const real = docs.filter((d) => !d.excluded).length;

  return (
    <div className="h-full overflow-y-auto border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-3 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Proposed documents
          <span className="ml-1.5 font-normal normal-case tracking-normal">
            ({docs.length})
          </span>
        </h2>
        {real > 0 && identified < real && (
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            Identifying… {identified} of {real} done
          </p>
        )}
      </div>

      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {docs.map((d, i) => {
          const color = colorFor(i, d.excluded);
          const isActive = activePage !== null && d.pages.includes(activePage);
          const serious = d.review.filter((f) =>
            SERIOUS_REVIEW_CODES.includes(f.code),
          );
          const minor = d.review.filter(
            (f) => !SERIOUS_REVIEW_CODES.includes(f.code),
          );

          return (
            <li key={d.doc_key}>
              <button
                type="button"
                onClick={() => onJump(d.pages[0])}
                className={`flex w-full gap-2 px-3 py-2 text-left transition ${
                  isActive
                    ? 'bg-slate-100 dark:bg-slate-800'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                }`}
              >
                <span
                  className="mt-0.5 h-full w-1 shrink-0 self-stretch rounded-full"
                  style={{ background: color.line }}
                  aria-hidden
                />

                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="font-mono text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                      {d.doc_key}
                    </span>
                    <span className="truncate text-xs font-medium text-slate-900 dark:text-slate-100">
                      {d.excluded
                        ? 'Excluded page'
                        : d.title || d.doc_type || 'Identifying…'}
                    </span>
                  </span>

                  {!d.excluded && (d.doc_type || d.subcategory) && (
                    <span className="mt-1 flex flex-wrap items-center gap-1">
                      {d.doc_type && (
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{ background: color.chip, color: color.chipText }}
                        >
                          {d.doc_type}
                        </span>
                      )}
                      {d.subcategory && (
                        <span className="text-[10px] text-slate-500 dark:text-slate-400">
                          {d.subcategory}
                        </span>
                      )}
                    </span>
                  )}

                  <span className="mt-0.5 block text-[11px] text-slate-500 dark:text-slate-400">
                    {d.pages.length === 1
                      ? `Page ${d.pages[0]}`
                      : `Pages ${summariseRuns(d.pages)}`}
                    {d.doc_date ? ` · ${d.doc_date}` : ''}
                    {d.org ? ` · ${d.org}` : ''}
                  </span>

                  {(d.dup_of ||
                    d.relates === 'no' ||
                    d.proposed_category ||
                    d.review.length > 0) && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {d.dup_of && <Tag tone="slate">Duplicate of {d.dup_of}</Tag>}
                      {d.relates === 'no' && (
                        <Tag tone="red" title={d.relates_reason ?? undefined}>
                          Another person
                        </Tag>
                      )}
                      {d.proposed_category && (
                        <Tag
                          tone="violet"
                          title={d.proposed_category_reason ?? undefined}
                        >
                          New category: {d.proposed_category}
                        </Tag>
                      )}
                      {serious.map((f) => (
                        <Tag key={f.code} tone="red" title={f.message}>
                          {REVIEW_LABELS[f.code]}
                        </Tag>
                      ))}
                      {minor.map((f) => (
                        <Tag key={f.code} tone="amber" title={f.message}>
                          {REVIEW_LABELS[f.code]}
                        </Tag>
                      ))}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Tag({
  children,
  tone,
  title,
}: {
  children: React.ReactNode;
  tone: 'slate' | 'amber' | 'red' | 'violet';
  title?: string;
}) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    amber: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
    red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
    violet: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-300',
  } as const;

  return (
    <span
      title={title}
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
