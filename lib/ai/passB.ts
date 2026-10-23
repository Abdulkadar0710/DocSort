import type { PageSignals, ProposalDoc, ReviewFlag } from '@/lib/types';

/**
 * Pass B — group described pages into whole documents.
 *
 * Deliberately deterministic. Pass A did the reading; what is left is a
 * decision procedure over its evidence, and a decision procedure is
 * reproducible, inspectable, free, and cannot drift between runs. The brief
 * asks how results are kept consistent across hundreds of pages — this is the
 * answer: the only non-determinism in the split lives in per-page reading and
 * per-document categorising, never in where the seams fall.
 *
 * The starting point is "every page is its own document", which on the DEV
 * bundle is already correct for 103 of its 132 documents. So this pass is not
 * hunting boundaries across 192 pages; it is deciding a much smaller number of
 * merges, and it only merges when it can say why.
 *
 * It assigns NO metadata beyond what grouping itself establishes. Identifying
 * what each document is happens afterwards in Pass C, with all of a document's
 * pages in view.
 */

/** Below this, "this page continues the previous one" is not acted on. A missed
 *  merge is one click for the reviewer; a wrong merge hides a whole document. */
const CONTINUE_THRESHOLD = 0.62;

/** How far back to look when rejoining a document across intruding pages. */
const LOOKBACK = 4;

export interface MergeDecision {
  page: number;
  into: number;
  reason: string;
  contiguous: boolean;
}

export interface StitchResult {
  docs: ProposalDoc[];
  decisions: MergeDecision[];
}

export function stitch(signals: PageSignals[]): StitchResult {
  const byPage = new Map(signals.map((s) => [s.page_number, s]));
  const pages = [...byPage.keys()].sort((a, b) => a - b);

  const groupOf = new Map<number, number>();
  const members = new Map<number, number[]>();
  for (const p of pages) {
    groupOf.set(p, p);
    members.set(p, [p]);
  }

  const decisions: MergeDecision[] = [];

  const join = (page: number, anchor: number, reason: string, contiguous: boolean) => {
    const target = groupOf.get(anchor)!;
    const source = groupOf.get(page)!;
    if (target === source) return;
    const moving = members.get(source)!;
    members.get(target)!.push(...moving);
    for (const m of moving) groupOf.set(m, target);
    members.delete(source);
    decisions.push({ page, into: anchor, reason, contiguous });
  };

  // ---------------------------------------------------------------- pass 1
  // Contiguous merges: does this page continue the one directly before it?
  for (let i = 1; i < pages.length; i++) {
    const p = pages[i];
    const prev = pages[i - 1];
    const cur = byPage.get(p)!;
    const before = byPage.get(prev)!;

    if (cur.is_blank || before.is_blank) continue;
    // A page naming a different person never joins the one before it.
    if (namesConflict(before.patient_name_seen, cur.patient_name_seen)) continue;

    const anchorPages = members.get(groupOf.get(prev)!)!;
    const head = byPage.get(Math.min(...anchorPages))!;

    // Strongest evidence: an unbroken "Page n of m" sequence.
    if (
      cur.page_marker &&
      before.page_marker &&
      cur.page_marker.of === before.page_marker.of &&
      cur.page_marker.n === before.page_marker.n + 1
    ) {
      join(p, prev, `continues "page ${cur.page_marker.n} of ${cur.page_marker.of}"`, true);
      continue;
    }

    // A fresh letterhead means a new document, whatever else the page says.
    if (cur.has_letterhead && !(cur.page_marker && cur.page_marker.n > 1)) continue;

    if (cur.continues_previous && cur.continues_confidence >= CONTINUE_THRESHOLD) {
      join(p, prev, 'reads as a continuation of the previous page', true);
      continue;
    }

    // Same issuing organisation and date, with no letterhead to suggest a new
    // document has begun — typical of multi-page forms and records.
    if (
      !cur.has_letterhead &&
      cur.org &&
      head.org &&
      sameish(cur.org, head.org) &&
      cur.doc_date &&
      head.doc_date &&
      cur.doc_date === head.doc_date
    ) {
      join(p, prev, 'same organisation and date, no new letterhead', true);
    }
  }

  // ---------------------------------------------------------------- pass 2
  // Non-contiguous rejoining.
  //
  // The DEV bundle contains a physiotherapy report whose pages sit at 88 and
  // 90, with a DIFFERENT PERSON'S pathology results at 89. Boundary detection
  // cannot express that; page membership can. A page announcing itself as
  // "page n of m" that was not merged is looked back at: if a nearby group
  // holds the preceding part of the same run, it rejoins across the intruder.
  for (const p of pages) {
    const cur = byPage.get(p)!;
    if (!cur.page_marker || cur.page_marker.n < 2) continue;
    if (members.get(groupOf.get(p)!)!.length > 1) continue; // already placed

    for (let back = 1; back <= LOOKBACK; back++) {
      const candidate = p - back;
      if (!byPage.has(candidate)) break;
      const group = members.get(groupOf.get(candidate)!)!.map((m) => byPage.get(m)!);
      const last = group[group.length - 1];

      const continuesRun =
        last.page_marker &&
        last.page_marker.of === cur.page_marker.of &&
        last.page_marker.n === cur.page_marker.n - 1;
      const sameSource =
        sameish(cur.org ?? '', last.org ?? '') || sameish(cur.gist ?? '', last.gist ?? '');

      if (
        continuesRun &&
        sameSource &&
        !namesConflict(last.patient_name_seen, cur.patient_name_seen)
      ) {
        join(
          p,
          candidate,
          `rejoins page ${last.page_marker!.n} of the same document across unrelated page(s)`,
          false,
        );
        break;
      }
    }
  }

  // ---------------------------------------------------------- materialise
  const groups = [...members.values()]
    .map((ms) => [...ms].sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);

  const docs: ProposalDoc[] = groups.map((groupPages, i) => {
    const ss = groupPages.map((p) => byPage.get(p)!);
    const head = ss[0];
    const blank = ss.every((s) => s.is_blank);

    // Union the page-level flags; Pass C adds the document-level ones.
    const review: ReviewFlag[] = [];
    const seen = new Set<string>();
    for (const s of ss) {
      for (const f of s.review) {
        if (seen.has(f.code)) continue;
        seen.add(f.code);
        review.push(f);
      }
    }

    // An incomplete "page n of m" run is exactly what a reviewer must see.
    const marker = ss.find((s) => s.page_marker)?.page_marker;
    if (marker && groupPages.length < marker.of && !seen.has('missing_pages')) {
      review.push({
        code: 'missing_pages',
        message: `${groupPages.length} of ${marker.of} pages present`,
      });
    }

    const key = `D${String(i + 1).padStart(3, '0')}`;

    return {
      id: `new:${key}`,
      doc_key: key,
      sort_order: i,
      pages: groupPages,
      // Provisional only — Pass C replaces these having seen every page.
      overview: null,
      title: blank ? 'Blank page' : head.gist,
      doc_type: blank ? 'Excluded' : null,
      subcategory: null,
      proposed_category: null,
      proposed_category_reason: null,
      doc_date: blank ? null : head.doc_date,
      author: null,
      discipline: null,
      org: blank ? null : head.org,
      relates: blank ? 'n/a' : 'unknown',
      relates_reason: null,
      dup_of: null,
      review,
      confidence: Math.min(...ss.map((s) => s.confidence)),
      excluded: blank,
    };
  });

  return { docs, decisions };
}

/**
 * Do two pages name clearly different people?
 *
 * Only blocks a merge on positive evidence of a conflict. A page with no name
 * on it — most continuation pages — never blocks anything, and a shared
 * surname is not a conflict: the DEV bundle contains the client's partner,
 * Kylie Marsh, precisely to catch a system that matches on surname alone.
 */
function namesConflict(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const tokens = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(mr|mrs|ms|miss|dr|prof)\b/g, '')
      .replace(/[^a-z\s]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 1);

  const x = tokens(a);
  const y = tokens(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return false;

  // Same full set of names in any order is the same person.
  const xs = new Set(x);
  const ys = new Set(y);
  const shared = [...xs].filter((t) => ys.has(t));
  if (shared.length === Math.min(xs.size, ys.size)) return false;

  // Sharing only the surname while the given names differ is a conflict.
  return shared.length < Math.min(xs.size, ys.size);
}

function sameish(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/\b(pty|ltd|inc|the)\b/g, '').replace(/[^a-z0-9]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}
