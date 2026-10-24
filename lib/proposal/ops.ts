import type { DocMeta, Op, ProposalDoc, ReviewFlag } from '@/lib/types';

/**
 * The op engine. Every change to a proposal — whether the AI produced it from
 * reviewer feedback or the reviewer made it by hand — goes through here.
 *
 * Two consequences the brief asks for fall out of this directly:
 *   - A revision alters only what the feedback asked for, because an op names
 *     the documents or pages it touches and nothing else is rewritten.
 *   - A later AI round keeps earlier manual edits, because each round is applied
 *     to the *latest* revision rather than recomputed from the original split.
 *
 * `doc_key`s are stable across revisions so that reviewer feedback referring to
 * "D007" keeps meaning the same document. Display order comes from `sort_order`
 * (recomputed from page position), not from the key.
 */

const EXCLUDED_TYPE = 'Excluded';

function blankMeta(): DocMeta {
  return {
    overview: null,
    title: null,
    doc_type: null,
    subcategory: null,
    proposed_category: null,
    proposed_category_reason: null,
    doc_date: null,
    author: null,
    discipline: null,
    org: null,
    relates: 'unknown',
    relates_reason: null,
    person_name: null,
    person_name_printed: null,
    person_dob: null,
    person_gender: null,
    person_age: null,
    person_patient_id: null,
    person_address: null,
    person_client_confirmed: false,
    person_key: null,
    dup_of: null,
    review: [],
    confidence: null,
    excluded: false,
  };
}

/** Union two flag lists, keeping one entry per code. */
function mergeReview(a: ReviewFlag[], b: ReviewFlag[]): ReviewFlag[] {
  const by = new Map<string, ReviewFlag>();
  for (const f of [...a, ...b]) if (!by.has(f.code)) by.set(f.code, f);
  return [...by.values()];
}

function nextKey(docs: ProposalDoc[], taken: Set<string>): string {
  let max = 0;
  for (const key of [...docs.map((d) => d.doc_key), ...taken]) {
    const m = /^D(\d+)$/.exec(key);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const key = `D${String(max + 1).padStart(3, '0')}`;
  taken.add(key);
  return key;
}

function makeDoc(
  key: string,
  pages: number[],
  meta: Partial<DocMeta> = {},
): ProposalDoc {
  return {
    id: `new:${key}`, // replaced with a real uuid when the revision is persisted
    doc_key: key,
    pages: [...pages],
    sort_order: 0,
    ...blankMeta(),
    ...meta,
  };
}

function excludedDoc(key: string, page: number, reason: string): ProposalDoc {
  return makeDoc(key, [page], {
    overview: `Page ${page} carries no document content.`,
    title: 'Excluded page',
    doc_type: EXCLUDED_TYPE,
    doc_date: null,
    relates: 'n/a',
    excluded: true,
    review: [{ code: 'low_confidence', message: reason }],
    confidence: 1,
  });
}

/** Resolve a document by key, tolerating case and missing zero-padding. */
function find(docs: ProposalDoc[], key: string): ProposalDoc | undefined {
  const want = key.trim().toUpperCase();
  return (
    docs.find((d) => d.doc_key.toUpperCase() === want) ??
    docs.find((d) => d.doc_key.toUpperCase().replace(/^D0*/, 'D') === want.replace(/^D0*/, 'D'))
  );
}

export interface ApplyResult {
  docs: ProposalDoc[];
  /** Ops that could not be applied, with why. Surfaced to the reviewer rather
   *  than failing the whole round — a partially applied revision beats none. */
  rejected: { op: Op; reason: string }[];
}

export function applyOps(input: ProposalDoc[], ops: Op[]): ApplyResult {
  // Deep-ish copy so callers keep their original revision intact.
  let docs: ProposalDoc[] = input.map((d) => ({
    ...d,
    pages: [...d.pages],
    review: d.review.map((f) => ({ ...f })),
  }));
  const rejected: ApplyResult['rejected'] = [];
  const taken = new Set<string>(docs.map((d) => d.doc_key));

  const detach = (pages: number[]) => {
    for (const d of docs) d.pages = d.pages.filter((p) => !pages.includes(p));
  };

  for (const op of ops) {
    try {
      switch (op.op) {
        case 'split': {
          const doc = find(docs, op.doc);
          if (!doc) throw new Error(`no document ${op.doc}`);
          const ordered = [...doc.pages].sort((a, b) => a - b);
          const idx = ordered.indexOf(op.at_page);
          if (idx <= 0) {
            throw new Error(
              `page ${op.at_page} is not an interior page of ${doc.doc_key}`,
            );
          }
          const tail = ordered.slice(idx);
          doc.pages = ordered.slice(0, idx);
          // The tail inherits the parent's metadata as a starting point; the
          // reviewer or a later set_meta refines it.
          docs.push(
            makeDoc(nextKey(docs, taken), tail, {
              ...blankMeta(),
              doc_type: doc.doc_type,
              org: doc.org,
              review: [
                {
                  code: 'low_confidence',
                  message: 'Created by splitting another document; details need checking',
                },
              ],
            }),
          );
          break;
        }

        case 'merge': {
          const targets = op.docs.map((k) => {
            const d = find(docs, k);
            if (!d) throw new Error(`no document ${k}`);
            return d;
          });
          if (targets.length < 2) throw new Error('merge needs two or more documents');
          // Keep the document that owns the earliest page.
          targets.sort((a, b) => Math.min(...a.pages) - Math.min(...b.pages));
          const [keep, ...rest] = targets;
          for (const r of rest) {
            keep.pages.push(...r.pages);
            keep.review = mergeReview(keep.review, r.review);
          }
          keep.pages.sort((a, b) => a - b);
          keep.excluded = targets.every((t) => t.excluded);
          docs = docs.filter((d) => !rest.includes(d));
          break;
        }

        case 'move_pages': {
          if (!op.pages.length) throw new Error('no pages given');
          detach(op.pages);
          if (op.to === 'new') {
            docs.push(
              makeDoc(nextKey(docs, taken), [...op.pages].sort((a, b) => a - b), {
                review: [
                  {
                    code: 'low_confidence',
                    message: 'Created by moving pages; details need checking',
                  },
                ],
              }),
            );
          } else {
            const target = find(docs, op.to);
            if (!target) throw new Error(`no document ${op.to}`);
            target.pages.push(...op.pages);
            target.pages.sort((a, b) => a - b);
          }
          break;
        }

        case 'exclude': {
          if (!op.pages.length) throw new Error('no pages given');
          detach(op.pages);
          for (const p of [...op.pages].sort((a, b) => a - b)) {
            docs.push(excludedDoc(nextKey(docs, taken), p, 'Excluded by reviewer'));
          }
          break;
        }

        case 'include': {
          if (!op.pages.length) throw new Error('no pages given');
          detach(op.pages);
          for (const p of [...op.pages].sort((a, b) => a - b)) {
            docs.push(
              makeDoc(nextKey(docs, taken), [p], {
                review: [
                  {
                    code: 'low_confidence',
                    message: 'Re-included by the reviewer; details need checking',
                  },
                ],
              }),
            );
          }
          break;
        }

        case 'reorder': {
          const doc = find(docs, op.doc);
          if (!doc) throw new Error(`no document ${op.doc}`);
          const same =
            op.order.length === doc.pages.length &&
            [...op.order].sort((a, b) => a - b).join() ===
              [...doc.pages].sort((a, b) => a - b).join();
          if (!same) throw new Error('reorder must list exactly the document’s pages');
          doc.pages = [...op.order];
          break;
        }

        case 'set_meta': {
          const doc = find(docs, op.doc);
          if (!doc) throw new Error(`no document ${op.doc}`);
          Object.assign(doc, op.fields);
          if (op.fields.excluded === true) doc.doc_type = EXCLUDED_TYPE;
          break;
        }

        default: {
          throw new Error(`unknown op ${(op as { op: string }).op}`);
        }
      }
    } catch (e) {
      rejected.push({ op, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // Drop anything emptied out, then order by first page for display.
  //
  // Deliberately does NOT sort pages within a document: `reorder` exists
  // precisely so a document whose pages appear out of order in the original
  // (answer-key D086 has page 6 before page 5) can be recorded that way. Ops
  // that insert pages sort at the point of insertion instead.
  docs = docs.filter((d) => d.pages.length > 0);
  docs.sort((a, b) => Math.min(...a.pages) - Math.min(...b.pages));
  docs.forEach((d, i) => {
    d.sort_order = i;
  });

  return { docs, rejected };
}

/** "Every page is its own document" — the starting proposal. Already ~78%
 *  recall on the DEV bundle, where 103 of 132 documents are single-page, which
 *  is why the app is demoable before any model has been called. */
export function naiveProposal(pageCount: number): ProposalDoc[] {
  const docs: ProposalDoc[] = [];
  for (let p = 1; p <= pageCount; p++) {
    docs.push(makeDoc(`D${String(p).padStart(3, '0')}`, [p]));
  }
  docs.forEach((d, i) => (d.sort_order = i));
  return docs;
}

/** Human-readable one-liner per op, for the "what changed" display. */
export function describeOp(op: Op): string {
  switch (op.op) {
    case 'split':
      return `Split ${op.doc} so a new document starts at page ${op.at_page}`;
    case 'merge':
      return `Merged ${op.docs.join(' + ')} into one document`;
    case 'move_pages':
      return `Moved page${op.pages.length > 1 ? 's' : ''} ${op.pages.join(', ')} to ${
        op.to === 'new' ? 'a new document' : op.to
      }`;
    case 'exclude':
      return `Excluded page${op.pages.length > 1 ? 's' : ''} ${op.pages.join(', ')}`;
    case 'include':
      return `Re-included page${op.pages.length > 1 ? 's' : ''} ${op.pages.join(', ')}`;
    case 'reorder':
      return `Reordered ${op.doc} to page order ${op.order.join(', ')}`;
    case 'set_meta': {
      const keys = Object.keys(op.fields);
      return `Updated ${keys.join(', ')} on ${op.doc}`;
    }
  }
}
