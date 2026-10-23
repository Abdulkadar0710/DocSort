import type Anthropic from '@anthropic-ai/sdk';
import { claude, MODEL_BULK, readUsage, toolResult, type Usage } from './claude';
import { PASS_A_SYSTEM } from './prompts';
import { DOC_TYPES, type PageSignals } from '@/lib/types';

/**
 * Pass A — describe every page, without yet deciding where documents begin.
 *
 * Separating "what is on this page" from "which pages form a document" is the
 * core of how the work is divided. Page description is local, parallelisable
 * and cheap; grouping is global and needs the whole picture. Mixing them would
 * force the expensive judgement to be made a window at a time, and a window
 * edge would silently become a document boundary.
 */

const REPORT_TOOL: Anthropic.Tool = {
  name: 'report_pages',
  description: 'Report your description of every page you were shown, in order.',
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
            'relates',
            'continues_previous',
            'continues_confidence',
            'confidence',
          ],
          properties: {
            page_number: {
              type: 'integer',
              description: 'The bundle page number printed in the label above the page.',
            },
            is_blank: { type: 'boolean' },
            title: { type: ['string', 'null'] },
            doc_type: { type: ['string', 'null'], enum: [...DOC_TYPES, 'unknown', null] },
            doc_date: {
              type: ['string', 'null'],
              description: 'As printed, DD/MM/YYYY where possible, or "unknown".',
            },
            author: { type: ['string', 'null'] },
            discipline: { type: ['string', 'null'] },
            org: { type: ['string', 'null'] },
            patient_name_seen: {
              type: ['string', 'null'],
              description: 'Any person name printed on the page, verbatim.',
            },
            page_marker: {
              type: ['object', 'null'],
              properties: { n: { type: 'integer' }, of: { type: 'integer' } },
              required: ['n', 'of'],
            },
            has_letterhead: { type: 'boolean' },
            continues_previous: { type: 'boolean' },
            continues_confidence: { type: 'number', minimum: 0, maximum: 1 },
            relates: { type: 'string', enum: ['yes', 'no', 'uncertain', 'n/a'] },
            relates_reason: { type: ['string', 'null'] },
            review_flags: { type: 'array', items: { type: 'string' } },
            extracted_text: { type: ['string', 'null'], maxLength: 1500 },
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

function coerce(raw: Partial<PageSignals>, fallbackPage: number): PageSignals {
  const unknownish = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!t || /^(unknown|n\/?a|none|null)$/i.test(t)) return null;
    return t;
  };

  return {
    page_number: raw.page_number ?? fallbackPage,
    is_blank: raw.is_blank ?? false,
    title: unknownish(raw.title),
    doc_type: unknownish(raw.doc_type),
    doc_date: unknownish(raw.doc_date),
    author: unknownish(raw.author),
    discipline: unknownish(raw.discipline),
    org: unknownish(raw.org),
    patient_name_seen: unknownish(raw.patient_name_seen),
    page_marker:
      raw.page_marker && raw.page_marker.of > 0 ? raw.page_marker : null,
    has_letterhead: raw.has_letterhead ?? false,
    continues_previous: raw.continues_previous ?? false,
    continues_confidence: clamp(raw.continues_confidence ?? 0),
    relates: raw.relates ?? 'uncertain',
    relates_reason: unknownish(raw.relates_reason),
    review_flags: Array.isArray(raw.review_flags) ? raw.review_flags : [],
    extracted_text: raw.extracted_text?.slice(0, 1500) ?? null,
    confidence: clamp(raw.confidence ?? 0.5),
  };
}

const clamp = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));

export async function classifyWindow(opts: {
  pdfBase64: string;
  pageNumbers: number[];
  rotationsCleared: number[];
  /** Embedded text layer per page, where the original had one. Given to the
   *  model alongside the pages so it need not OCR what is already machine
   *  readable — cheaper and more accurate than reading pixels. */
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
      `been straightened for you here, but that defect is real — flag each for ` +
      `human review.`
    : '';

  const instruction =
    `This window covers bundle pages ${pageNumbers[0]} to ` +
    `${pageNumbers[pageNumbers.length - 1]}. The attached PDF contains exactly ` +
    `those pages in order, so the first page of the PDF is bundle page ` +
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
        // The brief and taxonomy are identical for every window in every
        // bundle, so they are written to the cache once and read back ~24 times
        // on a 192-page bundle instead of being re-billed each call.
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
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64,
            },
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
  // we actually sent, and fill in any the model skipped so a dropped page can
  // never silently vanish from the split.
  const byNumber = new Map<number, PageSignals>();
  (pages ?? []).forEach((raw, i) => {
    const s = coerce(raw, pageNumbers[i] ?? pageNumbers[0]);
    if (pageNumbers.includes(s.page_number)) byNumber.set(s.page_number, s);
  });

  const signals = pageNumbers.map(
    (p) =>
      byNumber.get(p) ?? {
        ...coerce({}, p),
        review_flags: ['Automatic description failed for this page'],
        confidence: 0,
      },
  );

  for (const p of rotationsCleared) {
    const s = byNumber.get(p);
    const flag =
      'Page declares a rotation in the original and displays sideways or upside down';
    if (s && !s.review_flags.some((f) => /rotat/i.test(f))) {
      s.review_flags.push(flag);
    }
  }

  return { signals, usage: readUsage(res.usage), rotationsCleared };
}
