import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { claude, MODEL_CAREFUL, readUsage, toolResult, type Usage } from './claude';
import { TAXONOMY_SYSTEM } from './prompts';
import type { Category, ProposalDoc } from '@/lib/types';

/**
 * Pass C0 — derive the category set.
 *
 * Nothing is hardcoded. The taxonomy is produced once per bundle, from a
 * one-line description of every document in it, and stored in the `categories`
 * table for every later pass to use.
 *
 * Doing it in a single call with the whole bundle in view is the point. The
 * obvious alternative — let each document invent its own category when nothing
 * fits — is order-dependent and drifts: by the end of a long bundle you have
 * "Physio report", "Physiotherapy notes" and "Allied health" all meaning the
 * same thing, and a register that cannot be sorted. Sonnet rather than Haiku
 * because this one call shapes how every other document is filed.
 */

const TAXONOMY_TOOL: Anthropic.Tool = {
  name: 'propose_categories',
  description: 'Propose the category set for this bundle.',
  input_schema: {
    type: 'object',
    required: ['categories'],
    properties: {
      categories: {
        type: 'array',
        minItems: 8,
        maxItems: 18,
        items: {
          type: 'object',
          required: ['name', 'description'],
          properties: {
            name: { type: 'string', description: 'Short noun phrase, title case.' },
            description: {
              type: 'string',
              description: 'One line: what belongs in this category.',
            },
          },
        },
      },
    },
  },
};

/** Fold near-identical names together so "GP Letters" and "GP letter" cannot
 *  both exist. Deliberately crude — it only has to catch spelling drift. */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(the|a|an|and|or|of)\b/g, '')
    .replace(/s\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function loadCategories(
  sb: SupabaseClient,
  opts: { activeOnly?: boolean } = {},
): Promise<Category[]> {
  let q = sb
    .from('categories')
    .select('id, name, description, origin, reason, active, sort_order')
    .order('sort_order')
    .order('name');
  if (opts.activeOnly !== false) q = q.eq('active', true);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Category[];
}

/** Insert a category unless an equivalent name already exists. Returns the
 *  name that should actually be used. */
export async function ensureCategory(
  sb: SupabaseClient,
  input: {
    name: string;
    description: string;
    origin: Category['origin'];
    reason?: string | null;
    sessionId?: string | null;
    sortOrder?: number;
  },
): Promise<string> {
  const existing = await loadCategories(sb, { activeOnly: false });
  const target = normaliseName(input.name);
  const match = existing.find((c) => normaliseName(c.name) === target);
  if (match) return match.name;

  const { error } = await sb.from('categories').insert({
    name: input.name,
    description: input.description,
    origin: input.origin,
    reason: input.reason ?? null,
    origin_session_id: input.sessionId ?? null,
    sort_order: input.sortOrder ?? existing.length * 10,
  });

  // A concurrent insert of the same name is fine — the unique index did its job.
  if (error && !/duplicate key/i.test(error.message)) throw error;
  return input.name;
}

export interface TaxonomyResult {
  categories: { name: string; description: string }[];
  usage: Usage;
}

export async function deriveTaxonomy(docs: ProposalDoc[]): Promise<TaxonomyResult> {
  // One line per document: enough to see the shape of the bundle, small enough
  // that a 130-document bundle is a few thousand tokens.
  const listing = docs
    .filter((d) => !d.excluded)
    .map((d, i) => {
      const bits = [d.title, d.org, d.doc_date].filter(Boolean).join(' · ');
      return `${i + 1}. ${bits || 'unidentified document'} (${d.pages.length} page${
        d.pages.length === 1 ? '' : 's'
      })`;
    })
    .join('\n');

  const blankCount = docs.filter((d) => d.excluded).length;

  const res = await claude().messages.create({
    model: MODEL_CAREFUL,
    max_tokens: 4000,
    system: [{ type: 'text', text: TAXONOMY_SYSTEM }],
    tools: [TAXONOMY_TOOL],
    tool_choice: { type: 'tool', name: 'propose_categories' },
    messages: [
      {
        role: 'user',
        content:
          `This bundle contains ${docs.length} documents` +
          (blankCount ? `, of which ${blankCount} are blank pages` : '') +
          `. Here is a one-line description of each:\n\n${listing}\n\n` +
          `Propose the category set for this bundle.`,
      },
    ],
  });

  const { categories } = toolResult<{
    categories: { name?: string; description?: string }[];
  }>(res.content, 'propose_categories');

  const cleaned = (categories ?? [])
    .map((c) => ({
      name: (c.name ?? '').trim(),
      description: (c.description ?? '').trim(),
    }))
    .filter((c) => c.name && c.description);

  // These two must exist whatever the model proposed: every bundle has blank
  // pages to set aside, and every taxonomy needs somewhere to put the thing it
  // did not anticipate.
  for (const required of [
    { name: 'Other', description: 'Does not fit any other category; a new one may be proposed.' },
    { name: 'Excluded', description: 'Blank or contentless page belonging to no document.' },
  ]) {
    if (!cleaned.some((c) => normaliseName(c.name) === normaliseName(required.name))) {
      cleaned.push(required);
    }
  }

  return { categories: cleaned, usage: readUsage(res.usage) };
}

/** Derive and persist in one step. Returns the stored taxonomy. */
export async function deriveAndStoreTaxonomy(
  sb: SupabaseClient,
  sessionId: string,
  docs: ProposalDoc[],
): Promise<{ categories: Category[]; usage: Usage }> {
  const { categories, usage } = await deriveTaxonomy(docs);

  for (const [i, c] of categories.entries()) {
    await ensureCategory(sb, {
      name: c.name,
      description: c.description,
      origin: 'derived',
      sessionId,
      // "Other" and "Excluded" sort last wherever the model happened to put them.
      sortOrder: /^(other|excluded)$/i.test(c.name) ? 900 + i : i * 10,
    });
  }

  return { categories: await loadCategories(sb), usage };
}
