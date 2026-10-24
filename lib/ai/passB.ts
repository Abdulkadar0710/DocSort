import type { PageSignals, ProposalDoc, ReviewFlag } from '@/lib/types';
import { matchTier, nameTokens, NO_MATCH } from '@/lib/proposal/people';

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

    const anchorPages = members.get(groupOf.get(prev)!)!;
    const head = byPage.get(Math.min(...anchorPages))!;

    // Strongest evidence: an unbroken "Page n of m" sequence. Checked FIRST and
    // overriding everything below, because the document says so itself. An
    // earlier version ran the person-name check ahead of this and lost a
    // two-page incident report: the supervisor and WHS coordinator who signed
    // page 2 read as "different people" and vetoed a page 1 of 2 -> page 2 of 2
    // that could not have been clearer.
    if (
      cur.page_marker &&
      before.page_marker &&
      cur.page_marker.of === before.page_marker.of &&
      cur.page_marker.n === before.page_marker.n + 1
    ) {
      join(p, prev, `continues "page ${cur.page_marker.n} of ${cur.page_marker.of}"`, true);
      continue;
    }

    // A page about a demonstrably different person never joins the one before.
    if (namesConflict(before.patient_name_seen, cur.patient_name_seen)) continue;

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
      // Filled in by the categorise pass, which reads the whole document.
      person_name: blank ? null : (head.patient_name_seen?.split(/[,;]/)[0]?.trim() ?? null),
      person_name_printed: blank ? null : (head.patient_name_seen?.split(/[,;]/)[0]?.trim() ?? null),
      person_dob: null,
      person_gender: null,
      person_age: null,
      person_patient_id: null,
      person_address: null,
      person_key: null,
      dup_of: null,
      review,
      confidence: Math.min(...ss.map((s) => s.confidence)),
      excluded: blank,
    };
  });

  return { docs, decisions };
}

/** The clustering matcher, applied to bare token lists. Pass A reads names off
 *  a page and never sees a date of birth, so there is none to pass. */
function tokensSamePerson(a: string[], b: string[]): boolean {
  return matchTier({ name: a.join(' '), dob: null }, { name: b.join(' '), dob: null }) < NO_MATCH;
}

/**
 * Do two pages name demonstrably different people, with nobody in common?
 *
 * Pass A reports EVERY person named on a page, which is what catches a
 * document about somebody else — but it also picks up authors, signatories and
 * witnesses. So "the lists differ" means nothing on its own: page 2 of a form
 * naturally names the supervisor who signed it and not the claimant named on
 * page 1.
 *
 * A conflict therefore requires that the two pages share NO person at all.
 * Matching is per person rather than per word, because a shared surname is not
 * a shared person: the DEV bundle contains the client's partner, Kylie Anne
 * Marsh, precisely to catch a system that matches on surname alone.
 *
 * It uses the same comparison as the clustering pass, so a spelling variant
 * that counts as one person there counts as one person here too. Two matchers
 * drifting apart would mean a page could be stitched into a document and then
 * filed under somebody else.
 */
function namesConflict(a: string | null, b: string | null): boolean {
  const left = parsePeople(a);
  const right = parsePeople(b);
  if (!left.length || !right.length) return false;
  return !left.some((x) => right.some((y) => tokensSamePerson(x, y)));
}

/**
 * Split "Daniel James Marsh, Craig Dunlop" into the people it names.
 *
 * Note what is NOT a separator: the slash. An earlier version split on it,
 * which tore "Gouri w/o Amit Solanki" into "gouri w" and "o amit solanki" —
 * two people, neither of them real. Relationship markers are the one place a
 * slash appears inside a name, and parseName below understands them.
 */
function parsePeople(raw: string | null): string[][] {
  if (!raw) return [];
  return raw
    .split(/[;]|\band\b/i)
    .flatMap((part) => splitOnCommas(part))
    .map((part) => nameTokens(part.replace(/\([^)]*\)/g, '')))
    .filter((tokens) => tokens.length > 0);
}

/**
 * A comma separates two people — except when it is the surname-first form a lab
 * report prints, "MARSH, Daniel James", which is one. Two parts either side of
 * a single comma, no other commas: treat it as one person and let parseName
 * sort out the order.
 */
function splitOnCommas(part: string): string[] {
  const bits = part.split(',');
  if (bits.length === 2 && bits.every((b) => b.trim().split(/\s+/).length <= 3)) {
    return [part];
  }
  return bits;
}

function sameish(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/\b(pty|ltd|inc|the)\b/g, '').replace(/[^a-z0-9]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}
