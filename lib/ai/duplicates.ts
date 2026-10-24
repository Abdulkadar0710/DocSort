import type Anthropic from '@anthropic-ai/sdk';
import { claude, MODEL_CAREFUL, readUsage, toolResult, type Usage } from './claude';
import type { ProposalDoc } from '@/lib/types';

/**
 * Duplicate documents: the same record scanned into the bundle twice.
 *
 * Two stages, so the model is only asked about pairs that could plausibly be
 * one record. Cheap metadata first — same category, same date, same number of
 * pages — then one careful call per candidate pair that looks at both. A
 * removed duplicate is never a guess: it needs both stages to agree.
 *
 * Person is deliberately NOT part of the candidate key. Handwritten names are
 * read differently on each scan ("Garuri Bai" vs "Garuri / Amit Balayaki" on
 * the same receipt), so requiring a match there is exactly what let true
 * duplicates through. The model's side-by-side look settles it instead.
 */

/** Upper bound on model calls per bundle, whatever the metadata says. */
const MAX_PAIRS = 12;

const normDate = (s: string | null): string | null => {
  const t = (s ?? '').trim().toLowerCase();
  if (!t || t === 'unknown') return null;
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(t);
  if (!m) return t;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}${m[2].padStart(2, '0')}${m[1].padStart(2, '0')}`;
};

export interface DuplicatePair {
  original: ProposalDoc;
  copy: ProposalDoc;
}

/** Pairs worth showing the model: earlier document first, the later one the
 *  candidate copy. */
export function candidatePairs(docs: ProposalDoc[]): DuplicatePair[] {
  const live = docs
    .filter((d) => !d.excluded && d.doc_type && normDate(d.doc_date))
    .sort((a, b) => Math.min(...a.pages) - Math.min(...b.pages));

  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (
        a.doc_type === b.doc_type &&
        normDate(a.doc_date) === normDate(b.doc_date) &&
        a.pages.length === b.pages.length
      ) {
        pairs.push({ original: a, copy: b });
      }
    }
  }
  return pairs.slice(0, MAX_PAIRS);
}

const DUPLICATE_TOOL: Anthropic.Tool = {
  name: 'judge_duplicate',
  description: 'Say whether the two attached documents are the same record.',
  input_schema: {
    type: 'object',
    properties: {
      same: {
        type: 'boolean',
        description:
          'True only if B is the same record as A — a photocopy, re-scan or second print ' +
          'of the very same document. False for two different documents that merely look ' +
          'alike (two receipts from one clinic, two results on one day).',
      },
      reason: { type: 'string', description: 'One line: what matched or differed.' },
    },
    required: ['same', 'reason'],
  },
};

const SYSTEM = `
You compare two documents from a scanned medical bundle and decide whether the
second (B) is a duplicate of the first (A): the same physical record scanned
twice, photocopied, or printed again.

Compare the specifics, not the type: receipt or bill numbers, amounts, line
items, dates, test values, handwriting and stamps. Scans of one record can
differ in skew, crop, contrast and colour — that does not make them different.
Two records of the same kind from the same place on the same day are NOT
duplicates unless their specifics match.

When in doubt, answer false. A wrongly removed document is worse than a kept
duplicate.
`.trim();

export async function confirmDuplicate(opts: {
  /** PDF of A's pages followed by B's pages. */
  pdfBase64: string;
  aPages: number[];
  bPages: number[];
}): Promise<{ same: boolean; reason: string; usage: Usage }> {
  const { pdfBase64, aPages, bPages } = opts;
  const res = await claude().messages.create({
    model: MODEL_CAREFUL,
    max_tokens: 400,
    system: SYSTEM,
    tools: [DUPLICATE_TOOL],
    tool_choice: { type: 'tool', name: 'judge_duplicate' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          },
          {
            type: 'text',
            text:
              `The attachment holds ${aPages.length + bPages.length} pages. ` +
              `The first ${aPages.length} are document A (bundle page ${aPages.join(', ')}); ` +
              `the last ${bPages.length} are document B (bundle page ${bPages.join(', ')}). ` +
              `Is B a duplicate of A?`,
          },
        ],
      },
    ],
  });
  const raw = toolResult<{ same: boolean; reason: string }>(res.content, 'judge_duplicate');
  return { same: raw.same === true, reason: raw.reason ?? '', usage: readUsage(res.usage) };
}

/** The register entry a confirmed copy becomes: excluded from every output,
 *  but still listed so every page stays accounted for. */
export function asRemovedDuplicate<T extends ProposalDoc>(
  copy: T,
  original: ProposalDoc,
  reason: string,
): T {
  const of = `bundle page${original.pages.length === 1 ? '' : 's'} ${original.pages.join(', ')}`;
  return {
    ...copy,
    excluded: true,
    doc_type: 'Excluded',
    subcategory: 'Duplicate',
    title: `Duplicate of ${of} — removed`,
    overview: `A second copy of ${of}. ${reason}`.trim(),
    review: [],
  };
}
