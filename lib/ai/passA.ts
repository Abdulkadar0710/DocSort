import type Anthropic from '@anthropic-ai/sdk';
import { claude, MODEL_BULK, readUsage, toolResult, type Usage } from './claude';
import { PASS_A_SYSTEM } from './prompts';
import { cleanReview, orNull, type PageSignals } from '@/lib/types';

/**
 * Pass A — where do documents begin and end?
 *
 * Separating "where are the seams" from "what is this document" is the core of
 * how the work is divided. Seam-finding is local, parallelisable and cheap, and
 * needs only the pages either side of a boundary. Identifying a document is
 * global to that document and needs all of its pages at once — so it happens
 * later, in Pass C, rather than being guessed from whichever page a window
 * happened to start on.
 */

const REPORT_TOOL: Anthropic.Tool = {
  name: 'report_pages',
  description: 'Report boundary evidence for every page you were shown, in order.',
  input_schema: {
    type: 'object',
    required: ['pages'],
    properties: {
      pages: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'page_number',
            'is_blank',
            'has_letterhead',
            'continues_previous',
            'continues_confidence',
            'confidence',
          ],
          properties: {
            page_number: {
              type: 'integer',
              description: 'The bundle page number given in the instruction.',
            },
            is_blank: { type: 'boolean' },
            gist: { type: 'string', description: 'One short line, under 15 words.' },
            org: { type: 'string' },
            doc_date: { type: 'string', description: 'DD/MM/YYYY as printed.' },
            patient_name_seen: {
              type: 'string',
              description: 'Any person name printed on the page, verbatim.',
            },
            page_marker: {
              type: 'object',
              properties: { n: { type: 'integer' }, of: { type: 'integer' } },
              required: ['n', 'of'],
            },
            has_letterhead: { type: 'boolean' },
            continues_previous: { type: 'boolean' },
            continues_confidence: { type: 'number', minimum: 0, maximum: 1 },
            review: {
              type: 'array',
              items: {
                type: 'object',
                required: ['code', 'message'],
                properties: {
                  code: {
                    type: 'string',
                    enum: ['illegible', 'rotated', 'multiple_patients', 'low_confidence'],
                  },
                  message: { type: 'string' },
                },
              },
            },
            extracted_text: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
  },
};

export interface PassAResult {
  signals: PageSignals[];
  usage: Usage;
  rotationsCleared: number[];
}

const clamp = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0));

function coerce(raw: Partial<PageSignals>, fallbackPage: number): PageSignals {
  return {
    page_number: raw.page_number ?? fallbackPage,
    is_blank: raw.is_blank ?? false,
    gist: orNull(raw.gist),
    org: orNull(raw.org),
    doc_date: orNull(raw.doc_date),
    patient_name_seen: orNull(raw.patient_name_seen),
    page_marker:
      raw.page_marker && raw.page_marker.of > 0 ? raw.page_marker : null,
    has_letterhead: raw.has_letterhead ?? false,
    continues_previous: raw.continues_previous ?? false,
    continues_confidence: clamp(raw.continues_confidence),
    review: cleanReview(raw.review),
    extracted_text: raw.extracted_text?.slice(0, 1500) ?? null,
    confidence: clamp(raw.confidence ?? 0.5),
  };
}

export async function classifyWindow(opts: {
  pdfBase64: string;
  pageNumbers: number[];
  rotationsCleared: number[];
  /** Embedded text layer per page, where the original had one. Given alongside
   *  the pages so the model need not re-read what is already machine readable. */
  textByPage: Map<number, string>;
}): Promise<PassAResult> {
  const { pdfBase64, pageNumbers, rotationsCleared, textByPage } = opts;

  const textBlock = pageNumbers
    .map((p) => {
      const t = textByPage.get(p);
      return t
        ? `--- Bundle page ${p} (embedded text layer) ---\n${t.slice(0, 4000)}`
        : `--- Bundle page ${p} — NO text layer; read it from the image ---`;
    })
    .join('\n\n');

  const rotationNote = rotationsCleared.length
    ? `\n\nNote: bundle page(s) ${rotationsCleared.join(', ')} declare a rotation ` +
      `in the original that displays them sideways or upside down. They have ` +
      `been straightened for you here, but the defect is real — flag each with ` +
      `code "rotated".`
    : '';

  const instruction =
    `This window covers bundle pages ${pageNumbers[0]} to ` +
    `${pageNumbers[pageNumbers.length - 1]}. The attached PDF contains exactly ` +
    `those pages in order, so the first page of the attachment is bundle page ` +
    `${pageNumbers[0]}.\n\n` +
    `Report on every one of these ${pageNumbers.length} pages, using the bundle ` +
    `page numbers above — not the position within the attachment.` +
    rotationNote +
    `\n\n${textBlock}`;

  const res = await claude().messages.create({
    model: MODEL_BULK,
    max_tokens: 16000,
    system: [
      {
        type: 'text',
        text: PASS_A_SYSTEM,
        // Identical for every window of every bundle, so it is written to the
        // cache once and read back on each of the ~24 calls rather than
        // re-billed in full.
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [REPORT_TOOL],
    tool_choice: { type: 'tool', name: 'report_pages' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          },
          { type: 'text', text: instruction },
        ],
      },
    ],
  });

  const { pages } = toolResult<{ pages: Partial<PageSignals>[] }>(
    res.content,
    'report_pages',
  );

  // Trust the window's page range over the model's arithmetic: keep only pages
  // we actually sent, and fill in any it skipped, so a dropped page can never
  // silently vanish from the split.
  const byNumber = new Map<number, PageSignals>();
  (pages ?? []).forEach((raw, i) => {
    const s = coerce(raw, pageNumbers[i] ?? pageNumbers[0]);
    if (pageNumbers.includes(s.page_number)) byNumber.set(s.page_number, s);
  });

  const signals = pageNumbers.map(
    (p) =>
      byNumber.get(p) ?? {
        ...coerce({}, p),
        review: [
          {
            code: 'low_confidence' as const,
            message: 'Automatic reading failed for this page',
          },
        ],
        confidence: 0,
      },
  );

  for (const p of rotationsCleared) {
    const s = byNumber.get(p);
    if (s && !s.review.some((f) => f.code === 'rotated')) {
      s.review.push({
        code: 'rotated',
        message: 'Page displays sideways or upside down in the original',
      });
    }
  }

  return { signals, usage: readUsage(res.usage), rotationsCleared };
}
