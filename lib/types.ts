/**
 * Shared domain types.
 *
 * The central modelling decision: a document owns a *set of pages*, not a page
 * range. The DEV bundle's answer key contains D058 = pages 88 AND 90, with page
 * 89 belonging to a different person entirely. Ranges cannot express that.
 */

export type Relates = 'yes' | 'no' | 'uncertain' | 'n/a' | 'unknown';

export type SessionStatus =
  | 'uploading'
  | 'inventorying'
  | 'processing'
  | 'proposed'
  | 'approved'
  | 'failed';

/** Document type taxonomy, taken verbatim from the client's own answer key so
 *  our labels are directly comparable to ground truth in the scoring harness. */
export const DOC_TYPES = [
  'Legal correspondence',
  'Insurer correspondence',
  'Claim or insurer form',
  'Employment record',
  'Medical or work capacity certificate',
  'GP letter or referral',
  'Allied health notes',
  'Clinical or progress notes',
  'Specialist report',
  'Medico-legal or IME report',
  'Discharge summary',
  'Imaging report',
  'Imaging (image only)',
  'Pathology results',
  'Other',
  'Excluded',
] as const;

export type DocType = (typeof DOC_TYPES)[number];

/** Everything we claim about one document under the splitting guidelines. */
export interface DocMeta {
  title: string | null;
  doc_type: string | null;
  doc_date: string | null; // free text; may be 'unknown'
  author: string | null;
  discipline: string | null;
  org: string | null;
  relates: Relates;
  relates_reason: string | null;
  dup_of: string | null; // doc_key of the document this duplicates
  review_flags: string[];
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

/** Pass A output: what we observe about a single page, before any grouping. */
export interface PageSignals {
  page_number: number;
  is_blank: boolean;
  title: string | null;
  doc_type: string | null;
  doc_date: string | null;
  author: string | null;
  discipline: string | null;
  org: string | null;
  /** Any patient name visible on the page, verbatim. Drives relatedness. */
  patient_name_seen: string | null;
  /** Parsed "Page 2 of 3" style marker, when present. */
  page_marker: { n: number; of: number } | null;
  has_letterhead: boolean;
  /** Does this page read as a continuation of the preceding one? */
  continues_previous: boolean;
  continues_confidence: number;
  relates: Relates;
  relates_reason: string | null;
  review_flags: string[];
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
