'use client';

import { colorFor } from '@/lib/palette';
import { summariseRuns } from '@/lib/proposal/validate';
import { assignOutputPages, formatOutputRange } from '@/lib/proposal/outputPages';
import { REVIEW_LABELS, SERIOUS_REVIEW_CODES, type ProposalDoc } from '@/lib/types';

export interface PersonSummary {
  key: string;
  name: string;
  dob: string | null;
  isClient: boolean;
  docKeys: string[];
  pages: number[];
  /** Other spellings of this name found in the bundle. */
  variants?: string[];
}

interface Props {
  docs: ProposalDoc[];
  people?: PersonSummary[];
  activePage: number | null;
  onJump: (page: number) => void;
  /** The "Mark same as client" action, and which person (if any) it is
   *  currently running for — owned by the parent, which blocks the whole app
   *  while it runs rather than just this panel. */
  mergingKey: string | null;
  onMarkSameAsClient: (personKey: string) => void;
}

/**
 * The document register: what the split currently proposes, in page order.
 *
 * Kept to the essentials the reviewer navigates by — the key, the pages, and
 * whether it needs attention. The full detail of what each document is belongs
 * in the summary PDF; crowding it in here makes the list harder to scan, and
 * scanning is what it is for.
 */
export function DocumentSidebar({
  docs,
  people = [],
  activePage,
  onJump,
  mergingKey,
  onMarkSameAsClient,
}: Props) {
  const hasClient = people.some((p) => p.isClient);

  // Who each document actually belongs to, read from `people`'s own docKeys —
  // not from matching d.person_key against people[i].key by string equality.
  // Those two can drift (the client's key gains a date-of-birth suffix the
  // moment one is added to the session, for instance, while already-grouped
  // documents keep whatever key they were grouped under before that) even
  // though both sides agree on who the document actually belongs to. A drifted
  // key made a document that WAS correctly identified display as "Unidentified
  // person" with no way to fix it, since the lookup below would silently fail.
  const personByDocKey = new Map<string, PersonSummary>();
  for (const p of people) {
    for (const dk of p.docKeys) personByDocKey.set(dk, p);
  }

  // Blank pages and removed duplicates are not documents a reviewer works
  // with, so they leave the list. They are still counted here and listed in
  // the summary PDF, which is what keeps every page accounted for.
  const listed = docs.filter((d) => !d.excluded);
  const removedPages = docs.filter((d) => d.excluded);
  const duplicates = removedPages.filter((d) => d.subcategory === 'Duplicate');
  const blankCount = removedPages.reduce((n, d) => n + (d.subcategory === 'Duplicate' ? 0 : d.pages.length), 0);
  const duplicateCount = duplicates.reduce((n, d) => n + d.pages.length, 0);

  const real = listed.length;
  const identified = listed.filter((d) => d.doc_type).length;

  // Where each document lands in the exported set. Shown alongside the bundle
  // pages, never instead of them: the output number is for navigating, the
  // bundle pages are the provenance the brief turns on.
  const outputPages = assignOutputPages(docs);

  // Same page-order colour index the preview uses, so a document's swatch here
  // matches its rule over there. The register itself is ordered by person.
  const colourIndex = new Map(
    [...docs]
      .sort((a, b) => Math.min(...a.pages, Infinity) - Math.min(...b.pages, Infinity))
      .map((d, i) => [d.doc_key, i]),
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-200 px-3 py-3 dark:border-slate-800">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Documents
          <span className="ml-1.5 font-normal normal-case tracking-normal">
            ({listed.length})
          </span>
        </h2>
        {real > 0 && identified < real && (
          <p className="mt-1 text-[10px] text-slate-400">
            identifying {identified}/{real}
          </p>
        )}
        {removedPages.length > 0 && (
          <p
            className="mt-1 text-[10px] text-slate-400"
            title={removedPages.map((d) => `bundle p${summariseRuns(d.pages)}: ${d.title ?? 'blank'}`).join('\n')}
          >
            removed{' '}
            {[
              blankCount ? `${blankCount} blank page${blankCount === 1 ? '' : 's'}` : null,
              duplicateCount ? `${duplicateCount} duplicate page${duplicateCount === 1 ? '' : 's'}` : null,
            ]
              .filter(Boolean)
              .join(', ')}
          </p>
        )}
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {/* A person header is shown only when the bundle holds more than one.
            With a single person it would be noise; with several it is the most
            important thing on the screen, because records belonging to someone
            else are a disclosure problem, not just a filing one. */}
        {listed.map((d, i) => {
          const docPerson = personByDocKey.get(d.doc_key);
          const personKey = docPerson?.key ?? null;
          const prevKey = i > 0 ? (personByDocKey.get(listed[i - 1].doc_key)?.key ?? null) : undefined;
          const startsPerson = people.length > 1 && personKey !== prevKey;
          const person = startsPerson ? docPerson : undefined;
          const color = colorFor(colourIndex.get(d.doc_key) ?? i, d.excluded);
          const isActive = activePage !== null && d.pages.includes(activePage);
          // Whose document this is belongs to the person header above, not to
          // every row beneath it. A badge here says only what a reviewer must
          // CHECK — and it says what the flag actually is, rather than
          // restating the person. An earlier version chose the badge text from
          // `relates`, so a document flagged "identity uncertain" displayed
          // "another person" instead, hiding the thing it was raised for.
          const serious = d.review.filter((f) => SERIOUS_REVIEW_CODES.includes(f.code));
          const flag = serious[0];

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
                    <>
                      <span className="shrink-0 text-[9px] font-medium text-amber-700 dark:text-amber-400">
                        not the client
                      </span>
                      {/* The reviewer's override for a mismatch automatic
                          name-matching cannot resolve. Only offered when a
                          client is actually named — with nothing to merge
                          into, the action would have nowhere to go. */}
                      {hasClient && person && (
                        <button
                          type="button"
                          disabled={mergingKey !== null}
                          onClick={(e) => {
                            e.stopPropagation();
                            onMarkSameAsClient(person.key);
                          }}
                          className="shrink-0 rounded border border-amber-300 px-1 py-px text-[9px] font-medium text-amber-800 transition hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950"
                        >
                          {mergingKey === person.key ? 'Merging…' : 'Mark same as client'}
                        </button>
                      )}
                    </>
                  )}
                  <span className="ml-auto shrink-0 text-[9px] text-slate-500">
                    {person?.pages.length ?? 0}p
                  </span>
                </div>
              )}

              {/* The other spellings this person's name was printed under.
                  Shown because the merge is a judgement: a reviewer who thinks
                  these are two people needs to see what was on the pages, and
                  cannot get that from the label we picked. */}
              {startsPerson && !!person?.variants?.length && (
                <p
                  className={`truncate border-b px-3 pb-1.5 text-[9px] italic ${
                    person.isClient
                      ? 'border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400'
                      : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-400'
                  }`}
                  title={person.variants.join('; ')}
                >
                  also printed as {person.variants.join('; ')}
                </p>
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
                    {flag && (
                      <span
                        title={serious.map((f) => f.message).join(' · ')}
                        className="rounded bg-amber-100 px-1 py-px text-[9px] font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-300"
                      >
                        {REVIEW_LABELS[flag.code].toLowerCase()}
                      </span>
                    )}
                  </span>

                  {d.excluded ? (
                    <span className="mt-0.5 block truncate text-[11px] text-slate-500 dark:text-slate-400">
                      excluded · bundle p{summariseRuns(d.pages)}
                    </span>
                  ) : (
                    <span className="mt-0.5 block truncate text-[11px] text-slate-500 dark:text-slate-400">
                      {formatOutputRange(outputPages.get(d.doc_key))}
                    </span>
                  )}

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
