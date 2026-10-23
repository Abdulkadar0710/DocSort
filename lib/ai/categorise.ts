import type Anthropic from '@anthropic-ai/sdk';
import { claude, MODEL_BULK, readUsage, toolResult, type Usage } from './claude';
import { categoriseSystem, type ClientBrief } from './prompts';
import { normaliseName } from './taxonomy';
import {
  cleanReview,
  orNull,
  type Category,
  type DocMeta,
  type Relates,
  type ReviewFlag,
} from '@/lib/types';

/**
 * Pass C — categorise ONE assembled document.
 *
 * Every page of the document is attached, in its own reading order, so a
 * twelve-page record is judged as a twelve-page record rather than from
 * whichever page a window happened to open on. A non-contiguous document
 * arrives as exactly its own pages, with the intruding page left out — which is
 * only expressible because a document owns a set of pages rather than a range.
 */

const REVIEW_ENUM = [
  'missing_pages',
  'incomplete',
  'illegible',
  'rotated',
  'no_author',
  'no_date',
  'relates_uncertain',
  'multiple_patients',
  'possible_copy',
  'low_confidence',
];

const CATEGORISE_TOOL: Anthropic.Tool = {
  name: 'categorise_document',
  description: 'Report every field for this one document.',
  input_schema: {
    type: 'object',
    // person_name and person_dob are REQUIRED, not optional. Left optional the
    // model simply omitted the date of birth, which costs the one identifier
    // that reliably separates two people sharing a surname and an address.
    // Required, it answers "unknown" when the page prints none — which is
    // itself information, and is handled.
    required: [
      'overview',
      'category',
      'desc',
      'person_name',
      'person_dob',
      'relates',
      'relates_reason',
      'confidence',
    ],
    properties: {
      overview: { type: 'string', description: 'Two lines: what, who wrote it, about whom, when.' },
      category: { type: 'string', description: 'Exactly one of the CATEGORIES names.' },
      proposed_category: {
        type: 'string',
        description: 'Only when category is "Other": a short new category name.',
      },
      proposed_category_reason: {
        type: 'string',
        description: 'One line: why no existing category fitted.',
      },
      subcategory: { type: 'string', description: 'Short specific type, e.g. MRI, payslip.' },
      desc: { type: 'string', description: 'Plain English, max 15 words. Note copy/fax/draft.' },
      date: {
        type: 'string',
        description: 'DD/MM/YYYY, or DD/MM/YYYY - DD/MM/YYYY for running records, or "unknown".',
      },
      author: { type: 'string' },
      discipline: { type: 'string' },
      org: { type: 'string' },
      person_name: {
        type: 'string',
        description:
          'The patient, worker or subject this record is ABOUT, as printed. '
          + 'Not the author or signatory. "unknown" if nobody is named.',
      },
      person_dob: {
        type: 'string',
        description: 'That person\'s date of birth as printed, DD/MM/YYYY, or "unknown".',
      },
      relates: { type: 'string', enum: ['yes', 'no', 'uncertain', 'n/a'] },
      relates_reason: {
        type: 'string',
        description: 'Name the identifiers actually compared.',
      },
      review: {
        type: 'array',
        items: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', enum: REVIEW_ENUM },
            message: { type: 'string' },
          },
        },
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  },
};

export interface CategoriseResult {
  meta: Omit<DocMeta, 'dup_of' | 'excluded'>;
  usage: Usage;
}

interface RawCategorise {
  overview?: string;
  category?: string;
  proposed_category?: string;
  proposed_category_reason?: string;
  subcategory?: string;
  desc?: string;
  date?: string;
  author?: string;
  discipline?: string;
  org?: string;
  person_name?: string;
  person_dob?: string;
  relates?: Relates;
  relates_reason?: string;
  review?: ReviewFlag[];
  confidence?: number;
}

/** Trim a description to the stated word budget without cutting mid-word. */
function capWords(s: string | null, max: number): string | null {
  if (!s) return null;
  const words = s.trim().split(/\s+/);
  return words.length <= max ? s.trim() : words.slice(0, max).join(' ') + '…';
}

export async function categoriseDocument(opts: {
  pdfBase64: string;
  /** Bundle page numbers of this document, in reading order. */
  pageNumbers: number[];
  rotationsCleared: number[];
  categories: Category[];
  /** Text layer per page where the original had one. */
  textByPage: Map<number, string>;
  docKey: string;
  client: ClientBrief;
}): Promise<CategoriseResult> {
  const { pdfBase64, pageNumbers, rotationsCleared, categories, textByPage, docKey, client } =
    opts;

  const textBlock = pageNumbers
    .map((p) => {
      const t = textByPage.get(p);
      return t
        ? `--- Bundle page ${p} (embedded text layer) ---\n${t.slice(0, 6000)}`
        : `--- Bundle page ${p} — NO text layer; read it from the image ---`;
    })
    .join('\n\n');

  const contiguous =
    pageNumbers.length < 2 ||
    pageNumbers[pageNumbers.length - 1] - pageNumbers[0] + 1 === pageNumbers.length;

  const notes = [
    rotationsCleared.length
      ? `Page(s) ${rotationsCleared.join(', ')} display rotated in the original and ` +
        `have been straightened for you; flag them with code "rotated".`
      : null,
    contiguous
      ? null
      : `This document is NOT contiguous in the bundle — its pages are ` +
        `${pageNumbers.join(', ')}, and the pages in between belong to other ` +
        `documents. Only these pages are attached. Judge it as one document.`,
  ]
    .filter(Boolean)
    .join(' ');

  const res = await claude().messages.create({
    model: MODEL_BULK,
    max_tokens: 2000,
    system: [
      {
        type: 'text',
        text: categoriseSystem(categories, client),
        // The brief and the whole taxonomy are identical for every document in
        // the bundle, so they are cached once and read back on each of the
        // ~130 calls instead of being re-billed each time. This is the single
        // biggest lever on what this pass costs.
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [CATEGORISE_TOOL],
    tool_choice: { type: 'tool', name: 'categorise_document' },
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
              `This document is bundle page${pageNumbers.length === 1 ? '' : 's'} ` +
              `${pageNumbers.join(', ')} — ${pageNumbers.length} page` +
              `${pageNumbers.length === 1 ? '' : 's'}, attached in reading order.` +
              (notes ? `\n\n${notes}` : '') +
              `\n\n${textBlock}`,
          },
        ],
      },
    ],
  });

  const raw = toolResult<RawCategorise>(res.content, 'categorise_document');

  // Hold the model to the taxonomy: anything outside it becomes "Other" with
  // the offered name recorded as a proposal, rather than silently inventing a
  // category that no other document will ever be filed under.
  const names = new Map(categories.map((c) => [normaliseName(c.name), c.name]));
  const offered = orNull(raw.category);
  const matched = offered ? names.get(normaliseName(offered)) : null;

  let doc_type = matched ?? 'Other';
  let proposed = orNull(raw.proposed_category);
  let proposedReason = orNull(raw.proposed_category_reason);

  if (!matched && offered && !proposed) {
    proposed = offered;
    proposedReason = proposedReason ?? 'Model used a category outside the current set.';
  }
  if (proposed && names.has(normaliseName(proposed))) {
    // It "proposed" something that already exists — just use it.
    doc_type = names.get(normaliseName(proposed))!;
    proposed = null;
    proposedReason = null;
  }

  const relates = (['yes', 'no', 'uncertain', 'n/a'] as const).includes(
    raw.relates as never,
  )
    ? (raw.relates as Relates)
    : 'uncertain';

  const review = cleanReview(raw.review);

  // The brief's "a wrong answer costs more than unknown" rule, enforced rather
  // than merely requested: if the model says it is unsure who a document is
  // about, that must surface as a flag even when it forgot to raise one.
  if (relates === 'uncertain' && !review.some((f) => f.code === 'relates_uncertain')) {
    review.push({
      code: 'relates_uncertain',
      message: orNull(raw.relates_reason) ?? 'Could not confirm this is the client',
    });
  }

  return {
    meta: {
      overview: orNull(raw.overview),
      title: capWords(orNull(raw.desc), 15),
      doc_type,
      subcategory: orNull(raw.subcategory),
      proposed_category: proposed,
      proposed_category_reason: proposedReason,
      doc_date: orNull(raw.date),
      author: orNull(raw.author),
      discipline: orNull(raw.discipline),
      org: orNull(raw.org),
      relates,
      relates_reason: orNull(raw.relates_reason),
      person_name: orNull(raw.person_name),
      person_dob: orNull(raw.person_dob),
      // Assigned by clustering once every document has been read, so that
      // spelling variants of one person collapse rather than each becoming
      // their own group.
      person_key: null,
      review,
      confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
    },
    usage: readUsage(res.usage),
  };
}

export const describeDocForLog = (docKey: string, pages: number[]) =>
  `${docKey} (page${pages.length === 1 ? '' : 's'} ${pages.join(', ')})`;
