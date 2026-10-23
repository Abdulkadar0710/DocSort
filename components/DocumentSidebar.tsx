'use client';

import { colorFor } from '@/lib/palette';
import { summariseRuns } from '@/lib/proposal/validate';
import { REVIEW_LABELS, SERIOUS_REVIEW_CODES, type ProposalDoc } from '@/lib/types';

export interface PersonSummary {
  key: string;
  name: string;
  dob: string | null;
  isClient: boolean;
  docKeys: string[];
  pages: number[];
}

interface Props {
  docs: ProposalDoc[];
  people?: PersonSummary[];
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
export function DocumentSidebar({ docs, people = [], activePage, onJump }: Props) {
  const real = docs.filter((d) => !d.excluded).length;
  const identified = docs.filter((d) => !d.excluded && d.doc_type).length;

  // Same page-order colour index the preview uses, so a document's swatch here
  // matches its rule over there. The register itself is ordered by person.
  const colourIndex = new Map(
    [...docs]
      .sort((a, b) => Math.min(...a.pages, Infinity) - Math.min(...b.pages, Infinity))
      .map((d, i) => [d.doc_key, i]),
  );

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
        {/* A person header is shown only when the bundle holds more than one.
            With a single person it would be noise; with several it is the most
            important thing on the screen, because records belonging to someone
            else are a disclosure problem, not just a filing one. */}
        {docs.map((d, i) => {
          const personKey = d.person_key ?? null;
          const prevKey = i > 0 ? (docs[i - 1].person_key ?? null) : undefined;
          const startsPerson = people.length > 1 && personKey !== prevKey;
          const person = startsPerson
            ? people.find((p) => p.key === personKey)
            : undefined;
          const color = colorFor(colourIndex.get(d.doc_key) ?? i, d.excluded);
          const isActive = activePage !== null && d.pages.includes(activePage);
          const serious = d.review.filter((f) => SERIOUS_REVIEW_CODES.includes(f.code));
          // With a person header above, repeating "another person" on every
          // row underneath it is noise.
          const needsReview = serious.length > 0 || (people.length <= 1 && d.relates === 'no');

          return (
            <li key={d.doc_key}>
              {startsPerson && (
                <div
                  className={`flex items-baseline gap-1.5 border-y px-3 py-1.5 ${
                    person?.isClient
                      ? 'border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800'
                      : 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/50'
                  }`}
                >
                  <span
                    className={`truncate text-[11px] font-semibold ${
                      person?.isClient
                        ? 'text-slate-900 dark:text-slate-100'
                        : 'text-amber-900 dark:text-amber-300'
                    }`}
                  >
                    {person?.name ?? 'Unidentified person'}
                  </span>
                  {person?.isClient ? (
                    <span className="shrink-0 text-[9px] font-medium text-slate-500">
                      the client
                    </span>
                  ) : (
                    <span className="shrink-0 text-[9px] font-medium text-amber-700 dark:text-amber-400">
                      not the client
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-[9px] text-slate-500">
                    {person?.pages.length ?? 0}p
                  </span>
                </div>
              )}

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
