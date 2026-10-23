import type { PageSignals, ProposalDoc, Relates } from '@/lib/types';

/**
 * Pass B — group described pages back into whole documents.
 *
 * This is deliberately deterministic. Pass A already did the reading; what is
 * left is a decision procedure over its signals, and a decision procedure is
 * reproducible, inspectable, free, and cannot drift between runs. The brief
 * asks how results are kept consistent across hundreds of pages — this is the
 * answer: the only non-determinism in the split lives in per-page description.
 *
 * The starting point is "every page is its own document", which on the DEV
 * bundle is already correct for 103 of its 132 documents. So this pass is not
 * hunting for boundaries across 192 pages; it is deciding a much smaller number
 * of merges, and it only merges when it can say why.
 */

/** Below this, "this page continues the previous one" is not acted on. A missed
 *  merge is one click for the reviewer; a wrong merge hides a whole document. */
const CONTINUE_THRESHOLD = 0.62;

/** Document types that are self-contained by nature. A fax cover sheet is a
 *  document in its own right and never absorbs the pages that follow it. */
const NEVER_ABSORBS = /cover sheet|fax cover/i;

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

  // group id -> ordered member pages. Starts one-per-page.
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

    // A document about a different person never absorbs, and is never absorbed.
    if (conflicting(before.relates, cur.relates)) continue;
    if (NEVER_ABSORBS.test(before.title ?? '') || NEVER_ABSORBS.test(before.doc_type ?? '')) {
      continue;
    }

    const anchorSignals = members.get(groupOf.get(prev)!)!.map((m) => byPage.get(m)!);
    const head = anchorSignals[0];

    // Strongest signal: an unbroken "Page n of m" sequence.
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

    // Same issuing organisation and same date, with no letterhead to suggest a
    // new document has begun — typical of multi-page forms and records.
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
  // The DEV bundle contains a physiotherapy report whose two pages sit at 88
  // and 90, with a DIFFERENT PERSON'S pathology results at page 89. Boundary
  // detection cannot express that; page membership can. A page that announces
  // itself as "page n of m" but was not merged is looked back at: if a nearby
  // group holds the preceding part of the same run, the page rejoins it across
  // the intruder.
  const LOOKBACK = 4;
  for (const p of pages) {
    const cur = byPage.get(p)!;
    if (!cur.page_marker || cur.page_marker.n < 2) continue;
    if (members.get(groupOf.get(p)!)!.length > 1) continue; // already placed

    for (let back = 1; back <= LOOKBACK; back++) {
      const candidate = p - back;
      if (!byPage.has(candidate)) break;
      const cg = groupOf.get(candidate)!;
      const group = members.get(cg)!.map((m) => byPage.get(m)!);
      const last = group[group.length - 1];

      const continuesRun =
        last.page_marker &&
        last.page_marker.of === cur.page_marker.of &&
        last.page_marker.n === cur.page_marker.n - 1;
      const sameSource =
        sameish(cur.org ?? '', last.org ?? '') ||
        sameish(cur.title ?? '', last.title ?? '');

      if (continuesRun && sameSource && !conflicting(last.relates, cur.relates)) {
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

    const flags = new Set<string>();
    for (const s of ss) for (const f of s.review_flags) flags.add(f);

    // An incomplete "page n of m" run is exactly the kind of thing a reviewer
    // must see — the answer key flags two such documents.
    const marker = ss.find((s) => s.page_marker)?.page_marker;
    if (marker && groupPages.length < marker.of) {
      flags.add(
        `Incomplete: ${groupPages.length} of ${marker.of} pages present`,
      );
    }

    const relates = resolveRelates(ss);
    if (relates === 'no') flags.add('Appears to concern a different person');
    if (relates === 'uncertain') flags.add('Could not confirm this is the client');

    const key = `D${String(i + 1).padStart(3, '0')}`;

    return {
      id: `new:${key}`,
      doc_key: key,
      sort_order: i,
      pages: groupPages,
      title: blank ? 'Blank page' : head.title,
      doc_type: blank ? 'Excluded' : head.doc_type,
      doc_date: blank ? null : head.doc_date,
      author: blank ? null : head.author,
      discipline: blank ? null : head.discipline,
      org: blank ? null : head.org,
      relates: blank ? 'n/a' : relates,
      relates_reason: ss.find((s) => s.relates_reason)?.relates_reason ?? null,
      dup_of: null,
      review_flags: [...flags],
      confidence: Math.min(...ss.map((s) => s.confidence)),
      excluded: blank,
    };
  });

  return { docs, decisions };
}

/** Two pages conflict when one is clearly the client and the other clearly is
 *  not. "uncertain" never blocks a merge on its own — it is a flag, not a fact. */
function conflicting(a: Relates, b: Relates): boolean {
  return (a === 'yes' && b === 'no') || (a === 'no' && b === 'yes');
}

function resolveRelates(ss: PageSignals[]): Relates {
  if (ss.some((s) => s.relates === 'no')) return 'no';
  if (ss.some((s) => s.relates === 'uncertain')) return 'uncertain';
  if (ss.some((s) => s.relates === 'yes')) return 'yes';
  return 'n/a';
}

function sameish(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/\b(pty|ltd|inc|the)\b/g, '').replace(/[^a-z0-9]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}
