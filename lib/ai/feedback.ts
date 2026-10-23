import type Anthropic from '@anthropic-ai/sdk';
import { claude, MODEL_CAREFUL, readUsage, toolResult, type Usage } from './claude';
import { FEEDBACK_SYSTEM } from './prompts';
import { summariseRuns } from '@/lib/proposal/validate';
import type { Op, OpsResponse, ProposalDoc } from '@/lib/types';

/**
 * Turn a reviewer's plain-language feedback into edit operations.
 *
 * This never re-reads the bundle. It sees the current register and, at most,
 * the text of the handful of pages the feedback actually names. That is what
 * makes refining affordable enough to repeat as often as the reviewer likes —
 * re-running identification over hundreds of pages for every "pages 14–16 are a
 * separate discharge letter" would be both slow and the single largest cost in
 * the system.
 *
 * Sonnet rather than Haiku: misreading an instruction silently corrupts a split
 * the reviewer believes they have corrected, which is expensive and hard to
 * notice.
 */

const EDIT_TOOL: Anthropic.Tool = {
  name: 'revise_split',
  description:
    'Apply the smallest set of edits that satisfies the reviewer, and explain them.',
  input_schema: {
    type: 'object',
    required: ['explanation', 'ops'],
    properties: {
      explanation: {
        type: 'string',
        description:
          'One short paragraph for a non-technical clinician: what changed and ' +
          'which pages moved. Mention anything you assumed or deliberately left alone.',
      },
      ops: {
        type: 'array',
        items: {
          type: 'object',
          required: ['op'],
          properties: {
            op: {
              type: 'string',
              enum: [
                'split',
                'merge',
                'move_pages',
                'exclude',
                'include',
                'reorder',
                'set_meta',
              ],
            },
            doc: { type: 'string' },
            docs: { type: 'array', items: { type: 'string' } },
            pages: { type: 'array', items: { type: 'integer' } },
            at_page: { type: 'integer' },
            to: { type: 'string' },
            order: { type: 'array', items: { type: 'integer' } },
            fields: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                doc_type: { type: 'string' },
                doc_date: { type: 'string' },
                author: { type: 'string' },
                discipline: { type: 'string' },
                org: { type: 'string' },
                relates: { type: 'string', enum: ['yes', 'no', 'uncertain', 'n/a'] },
                relates_reason: { type: 'string' },
                dup_of: { type: 'string' },
                review_flags: { type: 'array', items: { type: 'string' } },
                excluded: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  },
};

/** The register, as compactly as it can be stated without losing anything the
 *  model needs to target an edit. ~130 documents fits in a few thousand tokens. */
export function renderRegister(docs: ProposalDoc[]): string {
  return docs
    .map((d) => {
      const bits = [
        d.doc_key,
        `pages ${summariseRuns(d.pages)}`,
        d.excluded ? 'EXCLUDED' : d.doc_type ?? 'unidentified type',
        d.title ?? 'no description',
        d.doc_date ? `dated ${d.doc_date}` : 'undated',
        d.author ? `by ${d.author}` : 'author unknown',
        d.org ?? 'organisation unknown',
        d.relates !== 'yes' ? `client: ${d.relates}` : null,
        d.dup_of ? `duplicate of ${d.dup_of}` : null,
        d.review_flags.length ? `flags: ${d.review_flags.join(', ')}` : null,
      ].filter(Boolean);
      return `- ${bits.join(' | ')}`;
    })
    .join('\n');
}

/** Page numbers the reviewer mentioned, so we can show the model those pages
 *  specifically rather than the whole bundle. */
export function pagesMentioned(feedback: string, maxPage: number): number[] {
  const found = new Set<number>();

  for (const m of feedback.matchAll(/\b(\d{1,4})\s*(?:-|–|—|to|through)\s*(\d{1,4})\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a >= 1 && b <= maxPage && b >= a && b - a < 60) {
      for (let p = a; p <= b; p++) found.add(p);
    }
  }
  for (const m of feedback.matchAll(/\b(?:page|pages|p\.?)\s*(\d{1,4})\b/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= maxPage) found.add(n);
  }

  return [...found].sort((a, b) => a - b).slice(0, 40);
}

export interface FeedbackResult extends OpsResponse {
  usage: Usage;
  pagesConsulted: number[];
}

export async function reviseFromFeedback(opts: {
  feedback: string;
  docs: ProposalDoc[];
  pageCount: number;
  /** Text of the pages the feedback named, where we have it. */
  pageText: Map<number, string>;
  /** Earlier rounds, so a follow-up like "no, the other one" has context. */
  history: { role: 'reviewer' | 'ai'; content: string }[];
}): Promise<FeedbackResult> {
  const { feedback, docs, pageCount, pageText, history } = opts;

  const consulted = [...pageText.keys()].sort((a, b) => a - b);
  const pageBlock = consulted.length
    ? `\n\nThe reviewer referred to these pages. Their text, for reference:\n\n` +
      consulted
        .map((p) => `--- Bundle page ${p} ---\n${(pageText.get(p) ?? '').slice(0, 1200)}`)
        .join('\n\n')
    : '';

  const priorRounds = history.length
    ? `\n\nEarlier in this review:\n` +
      history
        .slice(-6)
        .map((h) => `${h.role === 'reviewer' ? 'Reviewer' : 'You'}: ${h.content}`)
        .join('\n')
    : '';

  const res = await claude().messages.create({
    model: MODEL_CAREFUL,
    max_tokens: 4000,
    system: [
      {
        type: 'text',
        text: FEEDBACK_SYSTEM,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [EDIT_TOOL],
    tool_choice: { type: 'tool', name: 'revise_split' },
    messages: [
      {
        role: 'user',
        content:
          `The bundle has ${pageCount} pages. The current proposed split is:\n\n` +
          `${renderRegister(docs)}` +
          priorRounds +
          pageBlock +
          `\n\nThe reviewer says:\n\n"${feedback}"\n\n` +
          `Make only the change they asked for.`,
      },
    ],
  });

  const parsed = toolResult<{ explanation?: string; ops?: Op[] }>(
    res.content,
    'revise_split',
  );

  return {
    explanation: parsed.explanation ?? 'Applied the requested change.',
    ops: Array.isArray(parsed.ops) ? parsed.ops : [],
    usage: readUsage(res.usage),
    pagesConsulted: consulted,
  };
}
