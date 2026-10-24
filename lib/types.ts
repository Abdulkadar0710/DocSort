/**
 * Shared domain types.
 *
 * Two central decisions live here:
 *
 * 1. A document owns a *set of pages*, not a page range. The DEV bundle's
 *    answer key contains D058 = pages 88 AND 90, with page 89 belonging to a
 *    different person. Ranges cannot express that.
 *
 * 2. The category taxonomy is NOT defined in code. It is derived by the model
 *    with the whole bundle in view and stored in the `categories` table, so it
 *    fits the matter at hand rather than one borrowed from somewhere else.
 */

export type Relates = 'yes' | 'no' | 'uncertain' | 'n/a' | 'unknown';

export type SessionStatus =
  | 'uploading'
  | 'inventorying'
  | 'processing'
  | 'proposed'
  | 'approved'
  | 'failed';

/** A category as curated in the database. */
export interface Category {
  id: string;
  name: string;
  description: string;
  /** One or two words, plural — used to name child PDFs. */
  short_label: string | null;
  origin: 'derived' | 'proposed' | 'manual';
  reason: string | null;
  active: boolean;
  sort_order: number;
}

/**
 * Things a human must check, as a fixed vocabulary.
 *
 * A closed set means these can be counted, filtered and surfaced consistently;
 * the free-text message alongside says what is actually wrong with this
 * particular document.
 */
export const REVIEW_CODES = [
  'missing_pages',
  'incomplete',
  'illegible',
  'rotated',
  'no_author',
  'no_date',
  'relates_uncertain',
  'multiple_patients',
  'possible_copy',
  'identity_spelling',
  'low_confidence',
] as const;

export type ReviewCode = (typeof REVIEW_CODES)[number];

export interface ReviewFlag {
  code: ReviewCode;
  message: string;
}

/** Human-readable labels for the codes, for UI and the summary PDF. */
export const REVIEW_LABELS: Record<ReviewCode, string> = {
  missing_pages: 'Pages missing',
  incomplete: 'Incomplete',
  illegible: 'Hard to read',
  rotated: 'Rotated',
  no_author: 'No author',
  no_date: 'No date',
  relates_uncertain: 'Identity uncertain',
  multiple_patients: 'Several patients',
  possible_copy: 'Possible copy',
  identity_spelling: 'Name matched on spelling',
  low_confidence: 'Low confidence',
};

/** Codes that should stop a reviewer rather than merely inform them. */
export const SERIOUS_REVIEW_CODES: ReviewCode[] = [
  'missing_pages',
  'incomplete',
  'multiple_patients',
  'relates_uncertain',
];

/** Everything we claim about one document under the splitting guidelines. */
export interface DocMeta {
  /** Two lines: what it is, who wrote it, about whom, when. */
  overview: string | null;
  /** Plain English, max 15 words. Notes if it is a copy, fax or draft. */
  title: string | null;
  /** Category name, matching a row in `categories`. */
  doc_type: string | null;
  /** Short specific type within the category, e.g. "MRI", "payslip". */
  subcategory: string | null;
  /** Suggested new category when nothing active fitted. */
  proposed_category: string | null;
  proposed_category_reason: string | null;
  /** As printed: DD/MM/YYYY, or DD/MM/YYYY - DD/MM/YYYY for running records. */
  doc_date: string | null;
  author: string | null;
  discipline: string | null;
  org: string | null;
  relates: Relates;
  /** Must name the identifiers compared, not just assert a conclusion. */
  relates_reason: string | null;
  /** Who the document is about — the agreed label for that person, once
   *  clustering has reconciled the spellings found across the bundle. */
  person_name: string | null;
  /** The same name as it was actually printed on the page. Kept because the
   *  reconciliation above is a judgement, and a reviewer cannot check it
   *  against a name we have already overwritten. */
  person_name_printed: string | null;
  person_dob: string | null;
  /** Other identifying clues for the same subject, each as printed — only
   *  ever set from something explicitly on the page, never inferred. Used
   *  alongside the name and DOB to cluster people; see lib/proposal/people.ts. */
  person_gender: string | null;
  person_age: string | null;
  person_patient_id: string | null;
  person_address: string | null;
  /** Normalised identity used to group by person; set by clustering. */
  person_key: string | null;
  /** doc_key of the document this duplicates. */
  dup_of: string | null;
  review: ReviewFlag[];
  confidence: number | null;
  excluded: boolean;
}

export interface ProposalDoc extends DocMeta {
  id: string;
  doc_key: string; // stable label, e.g. "D007"
  pages: number[]; // ordered page numbers from the original bundle
  sort_order: number;
}

export interface Proposal {
  id: string;
  session_id: string;
  revision: number;
  parent_revision: number | null;
  origin: 'naive' | 'ai' | 'feedback' | 'manual';
  summary: string | null;
  docs: ProposalDoc[];
}

/** Collected in the browser with pdf.js immediately after upload — the file is
 *  already in memory there, so this costs no bandwidth and no server time. */
export interface PageInventory {
  page_number: number;
  rotation: number;
  width: number;
  height: number;
  has_text_layer: boolean;
  text: string;
}

/**
 * Pass A output: what we observe about a single page.
 *
 * Deliberately narrow. Pass A exists to decide where documents begin and end,
 * so it reports boundary evidence and little else — identifying *what* a
 * document is happens once per assembled document, with all of its pages in
 * view, rather than guessing from the first page.
 */
export interface PageSignals {
  page_number: number;
  is_blank: boolean;
  /** One short line, purely to help assemble and to seed the taxonomy pass. */
  gist: string | null;
  org: string | null;
  /** Any person name printed on the page, verbatim. Catches other people. */
  patient_name_seen: string | null;
  /** Parsed "Page 2 of 3" style marker, when present. */
  page_marker: { n: number; of: number } | null;
  has_letterhead: boolean;
  /** Does this page read as a continuation of the preceding one? */
  continues_previous: boolean;
  continues_confidence: number;
  /** Date printed on the page, used only to group pages of one document. */
  doc_date: string | null;
  review: ReviewFlag[];
  confidence: number;
  extracted_text: string | null;
}

/**
 * Patch operations. Both AI feedback rounds and manual edits emit these, so the
 * two paths converge on one proposal and a later AI round cannot silently undo
 * an earlier manual edit.
 */
export type Op =
  | { op: 'split'; doc: string; at_page: number }
  | { op: 'merge'; docs: string[] }
  | { op: 'move_pages'; pages: number[]; to: string | 'new' }
  | { op: 'exclude'; pages: number[] }
  | { op: 'include'; pages: number[] }
  | { op: 'reorder'; doc: string; order: number[] }
  | { op: 'set_meta'; doc: string; fields: Partial<DocMeta> };

export interface OpsResponse {
  /** Plain-language account of what changed, shown to the reviewer. */
  explanation: string;
  ops: Op[];
}

/** Word geometry from tesseract, used only to lay an invisible text layer onto
 *  scanned pages at export. Never used for classification. */
export interface OcrWord {
  text: string;
  /** Normalised 0..1 against page width/height, so it survives any scaling. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Normalise anything the model offers as "absent" to a real null. */
export function orNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || /^(unknown|n\/?a|none|null|not stated|not specified|—|-)$/i.test(t)) {
    return null;
  }
  return t;
}

export function isReviewCode(v: unknown): v is ReviewCode {
  return typeof v === 'string' && (REVIEW_CODES as readonly string[]).includes(v);
}

/** Keep only well-formed flags, de-duplicated by code. */
export function cleanReview(raw: unknown): ReviewFlag[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ReviewFlag[] = [];
  for (const f of raw) {
    const code = (f as ReviewFlag)?.code;
    if (!isReviewCode(code) || seen.has(code)) continue;
    seen.add(code);
    out.push({
      code,
      message: orNull((f as ReviewFlag)?.message) ?? REVIEW_LABELS[code],
    });
  }
  return out;
}
