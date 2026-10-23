'use client';

import { useState } from 'react';

export interface PhaseCount {
  total: number;
  done: number;
  failed: number;
  pending: number;
}

export interface Phases {
  classify: PhaseCount;
  taxonomy: PhaseCount;
  categorise: PhaseCount;
  group: PhaseCount;
}

interface Props {
  pageCount: number | null;
  phases: Phases;
  onCancel: () => Promise<void>;
}

/**
 * Shown while a bundle is being worked through.
 *
 * Deliberately blocking. Everything underneath — the register, the preview,
 * Approve, the feedback box — describes a split that is still being decided,
 * and acting on a half-finished proposal produces work the next phase
 * overwrites. The one thing a reviewer can usefully do while waiting is stop,
 * so that is the one control offered.
 *
 * The phases are reported separately rather than as a single count because
 * they are not comparable units of work: a classify window reads ten pages, a
 * categorise job reads one whole document. "14 of 19" would be true and
 * useless; "identifying document 6 of 11" is what somebody watching actually
 * wants to know.
 */
export function ProcessingOverlay({ pageCount, phases, onCancel }: Props) {
  const [cancelling, setCancelling] = useState(false);

  const steps: { key: keyof Phases; label: string; detail: (p: PhaseCount) => string }[] = [
    {
      key: 'classify',
      label: 'Reading the pages',
      detail: (p) =>
        `${p.done} of ${p.total} section${p.total === 1 ? '' : 's'}` +
        (pageCount ? ` · ${pageCount} pages` : ''),
    },
    {
      key: 'taxonomy',
      label: 'Working out the categories',
      detail: () => 'reading every document at once',
    },
    {
      key: 'categorise',
      label: 'Identifying each document',
      detail: (p) => `${p.done} of ${p.total} document${p.total === 1 ? '' : 's'}`,
    },
    {
      key: 'group',
      label: 'Gathering by person and type',
      detail: () => 'almost done',
    },
  ];

  // Weighted so the bar tracks effort rather than job count: reading the pages
  // and identifying the documents are the long stretches.
  const WEIGHT: Record<keyof Phases, number> = {
    classify: 0.45,
    taxonomy: 0.05,
    categorise: 0.45,
    group: 0.05,
  };

  let pct = 0;
  for (const { key } of steps) {
    const p = phases[key];
    // A phase with no jobs yet has not been planned, so it contributes nothing.
    if (p.total > 0) pct += (p.done / p.total) * WEIGHT[key] * 100;
  }
  pct = Math.min(99, Math.round(pct));

  const activeIndex = steps.findIndex((s) => phases[s.key].pending > 0);
  const current = activeIndex >= 0 ? steps[activeIndex] : steps[steps.length - 1];
  const failed = steps.reduce((n, s) => n + phases[s.key].failed, 0);

  async function cancel() {
    setCancelling(true);
    try {
      await onCancel();
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Processing the bundle"
      aria-busy="true"
      className="absolute inset-0 z-50 flex items-center justify-center bg-slate-900/70 backdrop-blur-sm"
    >
      <div className="w-[min(26rem,calc(100vw-2rem))] rounded-lg border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center gap-3">
          <span
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600 dark:border-slate-600 dark:border-t-blue-400"
            aria-hidden
          />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {current.label}
          </h2>
          <span className="ml-auto text-sm font-semibold tabular-nums text-slate-500">
            {pct}%
          </span>
        </div>

        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
          <div
            className="h-full rounded-full bg-blue-600 transition-[width] duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>

        <ol className="mt-4 space-y-1.5">
          {steps.map((s, i) => {
            const p = phases[s.key];
            const planned = p.total > 0;
            const complete = planned && p.pending === 0 && p.done > 0;
            const active = i === activeIndex;

            return (
              <li
                key={s.key}
                className={`flex items-baseline gap-2 text-xs ${
                  active
                    ? 'text-slate-900 dark:text-slate-100'
                    : complete
                      ? 'text-slate-400 dark:text-slate-500'
                      : 'text-slate-300 dark:text-slate-600'
                }`}
              >
                <span className="w-3 shrink-0 text-center" aria-hidden>
                  {complete ? '✓' : active ? '•' : '·'}
                </span>
                <span className="flex-1">{s.label}</span>
                {planned && (active || complete) && (
                  <span className="shrink-0 tabular-nums">{s.detail(p)}</span>
                )}
              </li>
            );
          })}
        </ol>

        {failed > 0 && (
          <p className="mt-3 rounded bg-amber-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
            {failed} piece{failed === 1 ? '' : 's'} of work could not be
            completed. Those pages are still accounted for, and will be flagged
            for review.
          </p>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          Nothing is split until you approve. You can stop now and come back —
          the work done so far is kept.
        </p>

        <button
          type="button"
          onClick={() => void cancel()}
          disabled={cancelling}
          className="mt-3 w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {cancelling ? 'Stopping…' : 'Cancel and go back'}
        </button>
      </div>
    </div>
  );
}
