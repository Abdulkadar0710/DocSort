import type { ProposalDoc } from '@/lib/types';

/**
 * Ground rule #1 from the brief, as an executable check:
 *
 *   "Every page of the original appears in exactly one child PDF, or is listed
 *    in the summary PDF as excluded."
 *
 * The database enforces half of this already — `document_pages` is primary-keyed
 * on (proposal_id, page_number), so a page physically cannot be written into two
 * documents. This function covers the other half (nothing missing) and runs
 * before every save, with its result shown in the UI as a persistent
 * "192 / 192 pages accounted for" badge. That badge is the single strongest
 * trust signal in the whole prototype: it is how the reviewer knows no page
 * went missing unnoticed.
 */

export interface ValidationResult {
  ok: boolean;
  pageCount: number;
  /** Pages sitting in a non-excluded document. */
  assigned: number;
  /** Pages sitting in an excluded document. */
  excluded: number;
  /** Pages in no document at all — always a bug. */
  missing: number[];
  /** Pages claimed by more than one document — always a bug. */
  duplicated: { page: number; docs: string[] }[];
  /** Documents holding zero pages — always a bug. */
  emptyDocs: string[];
  errors: string[];
}

export function validateProposal(
  docs: ProposalDoc[],
  pageCount: number,
): ValidationResult {
  const owners = new Map<number, string[]>();
  let excluded = 0;
  let assigned = 0;
  const emptyDocs: string[] = [];

  for (const doc of docs) {
    if (doc.pages.length === 0) emptyDocs.push(doc.doc_key);
    for (const p of doc.pages) {
      const list = owners.get(p);
      if (list) list.push(doc.doc_key);
      else owners.set(p, [doc.doc_key]);
      if (doc.excluded) excluded++;
      else assigned++;
    }
  }

  const missing: number[] = [];
  for (let p = 1; p <= pageCount; p++) {
    if (!owners.has(p)) missing.push(p);
  }

  const duplicated = [...owners.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([page, list]) => ({ page, docs: list }))
    .sort((a, b) => a.page - b.page);

  const outOfRange = [...owners.keys()].filter((p) => p < 1 || p > pageCount);

  const errors: string[] = [];
  if (missing.length) {
    errors.push(
      `${missing.length} page(s) are in no document: ${summariseRuns(missing)}`,
    );
  }
  for (const d of duplicated) {
    errors.push(`Page ${d.page} is claimed by ${d.docs.join(' and ')}`);
  }
  if (emptyDocs.length) {
    errors.push(`Document(s) with no pages: ${emptyDocs.join(', ')}`);
  }
  if (outOfRange.length) {
    errors.push(`Page number(s) outside 1–${pageCount}: ${outOfRange.join(', ')}`);
  }

  return {
    ok: errors.length === 0,
    pageCount,
    assigned,
    excluded,
    missing,
    duplicated,
    emptyDocs,
    errors,
  };
}

/** Collapse [1,2,3,7,9,10] into "1–3, 7, 9–10" for readable messages. */
export function summariseRuns(pages: number[]): string {
  if (!pages.length) return '';
  const sorted = [...pages].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (const p of sorted.slice(1)) {
    if (p === prev + 1) {
      prev = p;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = prev = p;
  }
  parts.push(start === prev ? `${start}` : `${start}–${prev}`);
  return parts.join(', ');
}
