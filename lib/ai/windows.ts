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
