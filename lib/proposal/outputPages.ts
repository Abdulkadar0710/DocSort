/**
 * Where each document sits in the OUTPUT, as opposed to where its pages sat in
 * the original bundle.
 *
 * A document's pages are routinely scattered — page 1 and page 7 of the bundle
 * can be one letter, with four other documents in between. The exported set
 * puts them back together, so the reviewer wants to know "this is pages 1 to 2
 * of what I am about to read", not "pages 1 and 7 of what I was sent".
 *
 * Both numbers are kept, never one instead of the other. The brief is explicit
 * that provenance is the point of the exercise — "it must always be clear
 * exactly which original pages each document came from" — and an output page
 * number proves nothing about a document's origin. The output number is for
 * navigating; the bundle pages are the evidence.
 *
 * Derived from register order rather than stored, so it cannot drift out of
 * step with a revision.
 */

export interface OutputRange {
  /** First page of this document in the exported set, 1-based. */
  from: number;
  to: number;
  count: number;
}

interface Numberable {
  doc_key: string;
  pages: number[];
  excluded: boolean;
}

/**
 * Number the documents in the order the register lists them.
 *
 * Excluded pages get no output number at all: they are not exported, and the
 * brief's first ground rule treats them as the alternative to appearing in a
 * child PDF, not as a quieter kind of inclusion.
 */
export function assignOutputPages(docs: Numberable[]): Map<string, OutputRange> {
  const out = new Map<string, OutputRange>();
  let next = 1;

  for (const doc of docs) {
    if (doc.excluded || doc.pages.length === 0) continue;
    const from = next;
    const to = next + doc.pages.length - 1;
    out.set(doc.doc_key, { from, to, count: doc.pages.length });
    next = to + 1;
  }

  return out;
}

/** "pages 1–2", or "page 5" for a single-page document. */
export function formatOutputRange(r: OutputRange | undefined): string {
  if (!r) return '';
  return r.from === r.to ? `page ${r.from}` : `pages ${r.from}–${r.to}`;
}
