import type { ProposalDoc, ReviewFlag } from '@/lib/types';
import { UNIDENTIFIED } from './people';
import { matchInsurer } from '@/lib/ai/insurers';

/**
 * Group documents into one per PERSON and category.
 *
 * Two receipts from different providers are, strictly, two documents — and the
 * brief's "each child PDF is one whole document" reads that way. This step is a
 * deliberate departure from it: the reviewer wanted a register organised by
 * what kind of thing each item is, so that a matter arrives as a handful of
 * files ("Receipts", "Imaging", "Prescriptions") rather than dozens.
 *
 * What is NOT given up:
 *   - every page still lands in exactly one document, or is excluded
 *   - each merged document records the original bundle pages it is built from,
 *     so provenance survives in the register, the summary and the child PDF's
 *     own metadata
 *   - documents about different people are never merged
 *
 * That last rule is the important one, and it is why the group key leads with
 * the person. Grouping by category alone would fold a different person's
 * pathology result into the client's pathology file — the exact mistake the
 * relatedness check exists to prevent. Keying on person as well as category
 * makes that structurally impossible rather than a rule to remember.
 */

/** Documents in these states are never merged. */
function mergeable(d: ProposalDoc, soleInsurer: string | null): boolean {
  if (d.excluded) return false;
  // A confirmed duplicate of a SPECIFIC other document stays separate — that
  // relationship (dup_of names the doc_key it copies) would be meaningless
  // once both sides are folded into one combined document.
  if (d.dup_of) return false;
  // A document naming several different patients at once is never merged —
  // that is a statement about the document's own content, not about who it
  // belongs to, and merging it would assert a single person's file contains
  // somebody else's records too.
  //
  // possible_copy (a SUSPECTED, not confirmed, copy) is NOT excluded here: the
  // reviewer asked for it to merge like any other document of its category,
  // with the flag carried onto the merged document (mergeReview, below) so it
  // is still visible there rather than silently dropped.
  if (d.review.some((f) => f.code === 'multiple_patients')) {
    return false;
  }
  // A claim is grouped by insurer, not person (see claimKey), so a claim page
  // naming nobody still belongs with the rest of its claim.
  if (claimKey(d, soleInsurer)) return true;
  // Nobody could be read from it: grouping these together would be asserting
  // they share a person, which is exactly what we do not know.
  if (!d.person_key || d.person_key === UNIDENTIFIED) return false;
  return !!d.doc_type;
}

/**
 * Insurance claim paperwork groups by WHO THE CLAIM IS MADE TO.
 *
 * One claim's pages name different people — the policyholder on Part A and the
 * NEFT form, the patient on Part B, nobody on the declaration — so grouping by
 * person tore every claim into three or four pieces. The insurer is the one
 * thing all its pages share. Claims to two different insurers stay apart.
 */
function claimKey(d: ProposalDoc, soleInsurer: string | null = null): string | null {
  if (d.excluded || d.doc_type !== 'Insurance Claims') return null;
  const insurer = matchInsurer(d.org);
  // A faint insurer name is misread differently on each page of one claim
  // ("Religare" read as "Belgure" or "Reliance"). When the bundle's claims
  // name exactly one recognised insurer, an unrecognised or unreadable name
  // is that insurer's page, not a second claim.
  if (!insurer?.known && soleInsurer) return `claim:${soleInsurer}`;
  return insurer ? `claim:${insurer.key}` : null;
}

/** The one recognised insurer the bundle's claims are made to, if exactly one. */
function soleKnownInsurer(docs: ProposalDoc[]): string | null {
  const keys = new Set(
    docs
      .filter((d) => !d.excluded && d.doc_type === 'Insurance Claims')
      .map((d) => matchInsurer(d.org))
      .filter((m) => m?.known)
      .map((m) => m!.key),
  );
  return keys.size === 1 ? [...keys][0] : null;
}

const parseDate = (s: string | null): number | null => {
  if (!s) return null;
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s.trim());
  if (!m) return null;
  return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
};

const fmtDate = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
};

/** Earliest and latest dates across a group, as the brief's range notation. */
function dateSpan(docs: ProposalDoc[]): string | null {
  const times = docs
    .flatMap((d) => (d.doc_date ?? '').split(/\s*[-–]\s*/))
    .map(parseDate)
    .filter((t): t is number => t !== null);
  if (!times.length) return null;
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  return lo === hi ? fmtDate(lo) : `${fmtDate(lo)} - ${fmtDate(hi)}`;
}

/** The one shared value, or null when the group disagrees. */
function common(values: (string | null)[]): string | null {
  const set = new Set(values.filter((v): v is string => !!v));
  return set.size === 1 ? [...set][0] : null;
}

function mergeReview(docs: ProposalDoc[]): ReviewFlag[] {
  const by = new Map<string, ReviewFlag>();
  for (const d of docs) for (const f of d.review) if (!by.has(f.code)) by.set(f.code, f);
  return [...by.values()];
}

export interface GroupResult {
  docs: ProposalDoc[];
  /** One entry per group that actually absorbed more than one document. */
  merged: { person: string; category: string; from: number; pages: number }[];
}

export function groupByCategory(
  input: ProposalDoc[],
  /** person_key order from clustering: the client first, unidentified last. */
  personOrder: string[] = [],
): GroupResult {
  const groups = new Map<string, ProposalDoc[]>();
  const standalone: ProposalDoc[] = [];
  const rank = new Map(personOrder.map((k, i) => [k, i]));
  const soleInsurer = soleKnownInsurer(input);

  for (const d of input) {
    if (!mergeable(d, soleInsurer)) {
      standalone.push(d);
      continue;
    }
    // Person FIRST, then category. Two people's prescriptions can never land
    // in the same group, whatever else they have in common. Claims are the one
    // exception: they group by insurer.
    const key = `${claimKey(d, soleInsurer) ?? d.person_key}\u0000${d.doc_type}`;
    const list = groups.get(key);
    if (list) list.push(d);
    else groups.set(key, [d]);
  }

  const merged: GroupResult['merged'] = [];
  const out: ProposalDoc[] = [...standalone];

  for (const [key, docs] of groups) {
    if (docs.length === 1) {
      out.push(docs[0]);
      continue;
    }
    const category = key.split('\u0000')[1];

    const ordered = [...docs].sort((a, b) => Math.min(...a.pages) - Math.min(...b.pages));
    const pages = ordered.flatMap((d) => d.pages).sort((a, b) => a - b);
    const span = dateSpan(ordered);

    // A claim is filed under whichever person on it ranks first — the client
    // when the client is named on any of its pages — rather than whoever
    // happened to be on its first page (usually the policyholder).
    const isClaim = key.startsWith('claim:');
    const first = isClaim
      ? [...ordered].sort(
          (a, b) =>
            (rank.get(a.person_key ?? UNIDENTIFIED) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(b.person_key ?? UNIDENTIFIED) ?? Number.MAX_SAFE_INTEGER),
        )[0]
      : ordered[0];
    // Named after a page whose insurer was recognised, never a misread one.
    const insurer = isClaim
      ? (ordered.map((d) => matchInsurer(d.org)).find((m) => m?.known) ?? matchInsurer(first.org))
      : null;

    merged.push({
      person: first.person_name ?? 'unidentified',
      category,
      from: ordered.length,
      pages: pages.length,
    });

    // Every spelling the merged documents were printed under, kept together.
    // Merging is the one place a person's variant names can be destroyed: the
    // representative keeps its own name and the rest are discarded, so a
    // bundle that printed one person four ways would report only one of them.
    const printed = [
      ...new Set(ordered.map((d) => d.person_name_printed ?? d.person_name).filter(Boolean)),
    ] as string[];

    out.push({
      ...first,
      id: `new:${category}`,
      pages,
      person_name_printed: printed.length ? printed.join('; ') : null,
      overview: insurer
        ? `Insurance claim to ${insurer.name}, ${ordered.length} parts` +
          ` (${[...new Set(ordered.map((d) => d.subcategory).filter(Boolean))].join(', ') || 'claim paperwork'})` +
          (span ? `, dated ${span}` : '') +
          `. Original bundle pages ${pages.join(', ')}.`
        : `${ordered.length} ${category.toLowerCase()} for ` +
          `${first.person_name ?? 'an unidentified person'}` +
          (span ? `, dated ${span}` : '') +
          `. Original bundle pages ${pages.join(', ')}.`,
      title: insurer
        ? `${insurer.name} — insurance claim${span ? `, ${span}` : ''}`
        : `${ordered.length} ${category.toLowerCase()}${span ? `, ${span}` : ''}`,
      doc_date: span,
      // Only claim a single author, discipline, organisation or subtype when
      // every document in the group genuinely shares it.
      author: common(ordered.map((d) => d.author)),
      discipline: common(ordered.map((d) => d.discipline)),
      org: insurer ? insurer.name : common(ordered.map((d) => d.org)),
      subcategory: common(ordered.map((d) => d.subcategory)),
      relates: first.relates,
      relates_reason: first.relates_reason,
      review: mergeReview(ordered),
      confidence: Math.min(...ordered.map((d) => d.confidence ?? 0)),
    });
  }

  // Ordered by person, then by page within that person, so the register reads
  // as whole people rather than interleaving three of them down the list. The
  // preview stays in bundle page order regardless — that is the original, and
  // it must not be reordered.
  out.sort((a, b) => {
    const pa = rank.get(a.person_key ?? UNIDENTIFIED) ?? Number.MAX_SAFE_INTEGER;
    const pb = rank.get(b.person_key ?? UNIDENTIFIED) ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return Math.min(...a.pages) - Math.min(...b.pages);
  });

  const renumbered = out.map((d, i) => ({
    ...d,
    doc_key: `D${String(i + 1).padStart(3, '0')}`,
    sort_order: i,
  }));

  return { docs: renumbered, merged };
}
