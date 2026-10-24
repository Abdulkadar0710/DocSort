import type { SupabaseClient } from '@supabase/supabase-js';
import type { Category } from '@/lib/types';

/**
 * The category set.
 *
 * Fixed, not derived. An earlier version asked an LLM to design a taxonomy
 * fresh for every bundle, which guarantees drift by construction: there is
 * always another wording a previous fix has not seen — "Hospital Bills"
 * becomes "Hospital Billing" becomes "Diagnostic Centre Receipts", each one a
 * new, unique-looking category that folding-after-the-fact can never fully
 * keep up with. The `categories` table accumulated 85+ such near-duplicates
 * from one afternoon of testing before this was replaced.
 *
 * Six categories, decided once, in code. If a document does not fit Letters,
 * Receipts, Prescriptions, Reports or Notes, it is Unknown Type — never a new
 * name invented on the spot. Judging FIT is still entirely Pass C's own
 * reading of the document (categoriseSystem in prompts.ts); nothing here
 * matches on keywords.
 */
export const FIXED_CATEGORIES: { name: string; description: string; short_label: string }[] = [
  {
    name: 'Letters',
    description:
      'Any letter or correspondence — referral, specialist, GP, insurer or legal correspondence.',
    short_label: 'Letters',
  },
  {
    name: 'Receipts',
    description:
      'Any bill, invoice, receipt or payment acknowledgement for an expense, whatever the expense was for and whoever issued it.',
    short_label: 'Receipts',
  },
  {
    name: 'Prescriptions',
    description: 'Any prescription or medication order.',
    short_label: 'Prescriptions',
  },
  {
    name: 'Reports',
    description:
      'Any pathology, laboratory, imaging, investigation or other diagnostic report, from any department or provider.',
    short_label: 'Reports',
  },
  {
    name: 'Notes',
    description: 'Any clinical, consultation, progress or handwritten note.',
    short_label: 'Notes',
  },
  {
    name: 'Unknown Type',
    description:
      'Does not fit Letters, Receipts, Prescriptions, Reports or Notes — a consent form, ' +
      'claim form, identification document, witness statement, or anything else outside ' +
      'those five.',
    short_label: 'Documents',
  },
  {
    name: 'Excluded',
    description: 'Blank or contentless page belonging to no document.',
    short_label: 'Excluded',
  },
];

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
    .select('id, name, description, short_label, origin, reason, active, sort_order')
    .order('sort_order')
    .order('name');
  if (opts.activeOnly !== false) q = q.eq('active', true);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Category[];
}

/** Insert a category unless an equivalent name already exists. Returns the
 *  name that should actually be used. Kept as a general-purpose primitive —
 *  ensureBaseCategories below does not use it, because it needs to UPDATE an
 *  existing row's description/short_label too, which this intentionally never
 *  does (an insert-if-missing that silently overwrote an existing category
 *  would be a surprising thing for a future caller to run into). */
export async function ensureCategory(
  sb: SupabaseClient,
  input: {
    name: string;
    description: string;
    shortLabel?: string | null;
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
    short_label: input.shortLabel ?? deriveShortLabel(input.name),
    origin: input.origin,
    reason: input.reason ?? null,
    origin_session_id: input.sessionId ?? null,
    sort_order: input.sortOrder ?? existing.length * 10,
  });

  // A concurrent insert of the same name is fine — the unique index did its job.
  if (error && !/duplicate key/i.test(error.message)) throw error;
  return input.name;
}

/** Fallback when a category has no usable short label: the last substantive
 *  word of its name, pluralised. "Specialist Letters" -> "Letters". Not
 *  needed by FIXED_CATEGORIES itself (every entry already names one) — kept
 *  for ensureCategory, the general-purpose primitive above. */
export function deriveShortLabel(name: string): string {
  const words = name
    .replace(/[^A-Za-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^(and|or|the|of|a|an)$/i.test(w));
  const last = words[words.length - 1] ?? 'Documents';
  const word = last[0].toUpperCase() + last.slice(1);
  return /s$/i.test(word) ? word : `${word}s`;
}

/**
 * Which of the currently active categories are NOT one of the fixed seven —
 * the pure, testable half of ensureBaseCategories's cleanup step.
 */
export function staleCategoryNames(
  active: { name: string }[],
  fixed: { name: string }[] = FIXED_CATEGORIES,
): string[] {
  const keep = new Set(fixed.map((c) => normaliseName(c.name)));
  return active.filter((c) => !keep.has(normaliseName(c.name))).map((c) => c.name);
}

/**
 * Make the `categories` table match FIXED_CATEGORIES exactly: every entry
 * present with its current name's description and short_label (UPDATED, not
 * left stale, if the row already existed under an earlier wording), and
 * every other active category deactivated.
 *
 * Idempotent — safe to call on every bundle, not just the first. This is also
 * what self-heals the table: the next bundle processed after this shipped
 * automatically deactivates every category any previous (now-removed)
 * per-bundle taxonomy call ever invented, with no separate migration needed.
 */
export async function ensureBaseCategories(sb: SupabaseClient): Promise<void> {
  const existing = await loadCategories(sb, { activeOnly: false });
  const byName = new Map(existing.map((c) => [normaliseName(c.name), c]));

  for (const [i, c] of FIXED_CATEGORIES.entries()) {
    const sortOrder = /^excluded$/i.test(c.name) ? 900 : i * 10;
    const row = byName.get(normaliseName(c.name));
    if (row) {
      const { error } = await sb
        .from('categories')
        .update({
          description: c.description,
          short_label: c.short_label,
          active: true,
          sort_order: sortOrder,
        })
        .eq('id', row.id);
      if (error) throw error;
    } else {
      const { error } = await sb.from('categories').insert({
        name: c.name,
        description: c.description,
        short_label: c.short_label,
        origin: 'manual',
        active: true,
        sort_order: sortOrder,
      });
      if (error) throw error;
    }
  }

  const stale = staleCategoryNames(
    existing.filter((c) => c.active),
    FIXED_CATEGORIES,
  );
  if (stale.length) {
    const ids = existing.filter((c) => stale.includes(c.name)).map((c) => c.id);
    const { error } = await sb.from('categories').update({ active: false }).in('id', ids);
    if (error) throw error;
  }
}
