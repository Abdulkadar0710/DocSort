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
 * The document register: what the split currently proposes, in page order.
 *
 * Kept to the essentials the reviewer navigates by — the key, the pages, and
 * whether it needs attention. The full detail of what each document is belongs
 * in the summary PDF; crowding it in here makes the list harder to scan, and
 * scanning is what it is for.
 */
export function DocumentSidebar({ docs, activePage, onJump }: Props) {
  const real = docs.filter((d) => !d.excluded).length;
  const identified = docs.filter((d) => !d.excluded && d.doc_type).length;

  return (
    <div className="flex h-full flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-200 px-3 py-3 dark:border-slate-800">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Documents
          <span className="ml-1.5 font-normal normal-case tracking-normal">
            ({docs.length})
          </span>
        </h2>
        {real > 0 && identified < real && (
          <p className="mt-1 text-[10px] text-slate-400">
            identifying {identified}/{real}
          </p>
        )}
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {docs.map((d, i) => {
          const color = colorFor(i, d.excluded);
          const isActive = activePage !== null && d.pages.includes(activePage);
          const serious = d.review.filter((f) => SERIOUS_REVIEW_CODES.includes(f.code));
          const needsReview = serious.length > 0 || d.relates === 'no';

          return (
            <li key={d.doc_key}>
              <button
                type="button"
                onClick={() => onJump(d.pages[0])}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left transition ${
                  isActive
                    ? 'bg-slate-100 dark:bg-slate-800'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                }`}
              >
                <span
                  className="mt-[3px] h-3 w-3 shrink-0 rounded-sm"
                  style={{
                    background: d.excluded ? 'transparent' : color.line,
                    border: d.excluded ? `1.5px dashed ${color.line}` : undefined,
                  }}
                  aria-hidden
                />

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">
                      {d.doc_key}
                    </span>
                    {needsReview && (
                      <span
                        title={
                          d.relates === 'no'
                            ? (d.relates_reason ?? 'Appears to concern another person')
                            : serious.map((f) => f.message).join(' · ')
                        }
                        className="rounded bg-amber-100 px-1 py-px text-[9px] font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-300"
                      >
                        {d.relates === 'no'
                          ? 'another person'
                          : REVIEW_LABELS[serious[0].code].toLowerCase()}
                      </span>
                    )}
                  </span>

                  <span className="mt-0.5 block truncate text-[11px] text-slate-500 dark:text-slate-400">
                    {d.pages.length === 1
                      ? `page ${d.pages[0]}`
                      : `pages ${summariseRuns(d.pages)}`}
                    {d.excluded ? ' · excluded' : ''}
                  </span>

                  {!d.excluded && (d.doc_type || d.title) && (
                    <span className="mt-0.5 block truncate text-[11px] text-slate-400 dark:text-slate-500">
                      {d.doc_type ?? d.title}
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
