import type { DocMeta, ProposalDoc } from '@/lib/types';
import { summariseRuns } from './validate';

/**
 * Revision-to-revision diff, for the brief's requirement that after a feedback
 * round "the changes are made clear". Because revisions are materialised rather
 * than folded from an event log, this is a plain comparison of two page/metadata
 * snapshots — no replay needed.
 */

export interface DocDiff {
  doc_key: string;
  kind: 'added' | 'removed' | 'pages-changed' | 'meta-changed';
  before?: { pages: number[]; label: string };
  after?: { pages: number[]; label: string };
  /** Metadata fields that changed, for 'meta-changed'. */
  fields?: { field: keyof DocMeta; from: unknown; to: unknown }[];
  summary: string;
}

export interface ProposalDiff {
  changes: DocDiff[];
  /** Page numbers whose owning document changed. The honest measure of how
   *  much of the split a revision actually disturbed. */
  movedPages: number[];
  untouchedDocs: number;
}

const META_FIELDS: (keyof DocMeta)[] = [
  'title',
  'doc_type',
  'subcategory',
  'doc_date',
  'author',
  'discipline',
  'org',
  'relates',
  'dup_of',
  'excluded',
];

function label(d: ProposalDoc): string {
  return d.title || d.doc_type || 'Untitled document';
}

export function diffProposals(
  before: ProposalDoc[],
  after: ProposalDoc[],
): ProposalDiff {
  const beforeByKey = new Map(before.map((d) => [d.doc_key, d]));
  const afterByKey = new Map(after.map((d) => [d.doc_key, d]));
  const changes: DocDiff[] = [];
  let untouchedDocs = 0;

  for (const [key, b] of beforeByKey) {
    const a = afterByKey.get(key);
    if (!a) {
      changes.push({
        doc_key: key,
        kind: 'removed',
        before: { pages: b.pages, label: label(b) },
        summary: `${key} (${label(b)}, pages ${summariseRuns(b.pages)}) no longer exists — its pages moved elsewhere`,
      });
      continue;
    }

    const pagesChanged = b.pages.join() !== a.pages.join();
    const fields = META_FIELDS.filter((f) => b[f] !== a[f]).map((f) => ({
      field: f,
      from: b[f],
      to: a[f],
    }));

    if (pagesChanged) {
      changes.push({
        doc_key: key,
        kind: 'pages-changed',
        before: { pages: b.pages, label: label(b) },
        after: { pages: a.pages, label: label(a) },
        fields: fields.length ? fields : undefined,
        summary: `${key} now covers pages ${summariseRuns(a.pages)} (was ${summariseRuns(b.pages)})`,
      });
    } else if (fields.length) {
      changes.push({
        doc_key: key,
        kind: 'meta-changed',
        before: { pages: b.pages, label: label(b) },
        after: { pages: a.pages, label: label(a) },
        fields,
        summary: `${key} details updated: ${fields
          .map((f) => `${f.field} → ${String(f.to ?? 'unknown')}`)
          .join(', ')}`,
      });
    } else {
      untouchedDocs++;
    }
  }

  for (const [key, a] of afterByKey) {
    if (beforeByKey.has(key)) continue;
    changes.push({
      doc_key: key,
      kind: 'added',
      after: { pages: a.pages, label: label(a) },
      summary: `${key} is new — ${label(a)}, pages ${summariseRuns(a.pages)}`,
    });
  }

  // Which pages changed hands.
  const ownerBefore = new Map<number, string>();
  for (const d of before) for (const p of d.pages) ownerBefore.set(p, d.doc_key);
  const movedPages: number[] = [];
  for (const d of after) {
    for (const p of d.pages) {
      if (ownerBefore.get(p) !== d.doc_key) movedPages.push(p);
    }
  }
  movedPages.sort((a, b) => a - b);

  changes.sort((x, y) => {
    const px = x.after?.pages[0] ?? x.before?.pages[0] ?? 0;
    const py = y.after?.pages[0] ?? y.before?.pages[0] ?? 0;
    return px - py;
  });

  return { changes, movedPages, untouchedDocs };
}
