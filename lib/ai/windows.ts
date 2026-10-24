/**
 * Work division.
 *
 * A bundle is too large to judge in one pass, so Pass A walks it in overlapping
 * windows. Two pages of overlap mean every window (bar the first) opens with
 * pages it can see the lead-up to, so its "does this page continue the previous
 * one?" judgement is never made blind at a window edge — the failure mode that
 * would otherwise put a false boundary every N pages.
 *
 * 10 pages per window keeps each Claude call small and fast: well inside the
 * 100-page / 32 MB limit on PDF document blocks, and far inside any Vercel
 * function duration cap, since one tick handles one window.
 */

import type { PageSignals } from '@/lib/types';

export const WINDOW_SIZE = 10;
export const WINDOW_OVERLAP = 2;

export interface Window {
  start: number;
  end: number;
}

export function planWindows(
  pageCount: number,
  size = WINDOW_SIZE,
  overlap = WINDOW_OVERLAP,
): Window[] {
  if (pageCount < 1) return [];
  if (size <= overlap) throw new Error('window size must exceed its overlap');

  const step = size - overlap;
  const windows: Window[] = [];
  let start = 1;

  while (start <= pageCount) {
    const end = Math.min(start + size - 1, pageCount);
    windows.push({ start, end });
    if (end >= pageCount) break;
    start += step;
  }
  return windows;
}

/**
 * With overlap, a page is judged twice. The authoritative answer comes from the
 * window where the page has the most *preceding* context, which is always the
 * first window containing it — the later window sees it in its opening pages,
 * with little or nothing before it.
 */
export function isAuthoritative(page: number, w: Window, windows: Window[]): boolean {
  const first = windows.find((x) => page >= x.start && page <= x.end);
  return !!first && first.start === w.start;
}

export interface Reading {
  signals: PageSignals;
  window: Window;
}

/**
 * Combine every window's reading of one page into the signals the stitcher
 * acts on.
 *
 * The authoritative reading wins by default, but it is not trusted blindly
 * where another window that saw the same page contradicts it. A window can
 * lose count on similar-looking scans — describing page 24 as page 23 and
 * everything after it one page off — and that slip had joined a prescription
 * onto the ECG before it, and dropped a real handwritten page as "blank",
 * while the next window read both pages correctly. So:
 *
 *   - blank only if EVERY reading says blank
 *   - a letterhead seen in ANY reading means a new document starts here
 *   - "continues the previous page" stands only if no reading that could see
 *     the previous page disagrees. A window's first page is excluded from that
 *     vote: it had no previous page in view, so its answer is a blind guess.
 *
 * Every rule leans towards keeping pages apart. A wrong split is one chat
 * instruction to undo ("Merge D005 into D004"); a wrong join hides a document
 * inside another and puts it in the wrong category.
 */
export function reconcileReadings(chosen: PageSignals, others: Reading[]): PageSignals {
  if (!others.length) return chosen;

  const all = [chosen, ...others.map((o) => o.signals)];
  const sighted = others.filter((o) => o.signals.page_number !== o.window.start || o.window.start === 1);

  const blank = all.every((s) => s.is_blank);
  const letterhead = all.some((s) => s.has_letterhead);
  const vetoed = sighted.some((o) => !o.signals.continues_previous);
  const continues = chosen.continues_previous && !letterhead && !vetoed && !blank;

  const disagreed =
    blank !== chosen.is_blank ||
    letterhead !== chosen.has_letterhead ||
    continues !== chosen.continues_previous;
  if (!disagreed) return chosen;

  // Describe the page from a reading that actually saw content on it.
  const base = chosen.is_blank && !blank ? (others.find((o) => !o.signals.is_blank)?.signals ?? chosen) : chosen;

  return {
    ...base,
    is_blank: blank,
    has_letterhead: letterhead,
    continues_previous: continues,
    continues_confidence: continues ? chosen.continues_confidence : 0,
    review: [
      ...(base.review ?? []).filter((f) => f.code !== 'low_confidence'),
      {
        code: 'low_confidence',
        message: 'Overlapping readings of this page disagreed; it was kept separate rather than joined',
      },
    ],
  };
}
