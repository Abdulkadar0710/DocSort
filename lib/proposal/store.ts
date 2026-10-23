import type { SupabaseClient } from '@supabase/supabase-js';
import type { Proposal, ProposalDoc, ReviewFlag } from '@/lib/types';
import { cleanReview } from '@/lib/types';
import { validateProposal } from './validate';

/**
 * Proposal persistence.
 *
 * Revisions are MATERIALISED: each one writes its own `documents` and
 * `document_pages` rows under a fresh `proposal_id`. At ~132 documents per
 * revision this costs nothing, and in exchange reads stay a single join, and
 * history and diffing come free without an event-replay engine. The op log
 * lives in `messages.ops` purely as the audit trail.
 */

interface DocRow {
  id: string;
  doc_key: string;
  title: string | null;
  doc_type: string | null;
  doc_date: string | null;
  author: string | null;
  discipline: string | null;
  org: string | null;
  relates: ProposalDoc['relates'];
  relates_reason: string | null;
  person_name: string | null;
  person_dob: string | null;
  person_key: string | null;
  dup_of: string | null;
  review: ReviewFlag[] | null;
  confidence: number | null;
  overview: string | null;
  subcategory: string | null;
  proposed_category: string | null;
  proposed_category_reason: string | null;
  excluded: boolean;
  sort_order: number | null;
  document_pages: { page_number: number; position: number }[];
}

function rowToDoc(r: DocRow): ProposalDoc {
  const pages = [...r.document_pages]
    .sort((a, b) => a.position - b.position)
    .map((p) => p.page_number);
  return {
    id: r.id,
    doc_key: r.doc_key,
    title: r.title,
    doc_type: r.doc_type,
    doc_date: r.doc_date,
    author: r.author,
    discipline: r.discipline,
    org: r.org,
    relates: r.relates ?? 'unknown',
    relates_reason: r.relates_reason,
    person_name: r.person_name,
    person_dob: r.person_dob,
    person_key: r.person_key,
    dup_of: r.dup_of,
    review: cleanReview(r.review),
    overview: r.overview,
    subcategory: r.subcategory,
    proposed_category: r.proposed_category,
    proposed_category_reason: r.proposed_category_reason,
    confidence: r.confidence,
    excluded: r.excluded,
    sort_order: r.sort_order ?? 0,
    pages,
  };
}

const DOC_SELECT = `
  id, doc_key, title, doc_type, doc_date, author, discipline, org,
  relates, relates_reason, person_name, person_dob, person_key,
  dup_of, review, confidence, excluded, sort_order,
  overview, subcategory, proposed_category, proposed_category_reason,
  document_pages ( page_number, position )
`;

export async function loadProposal(
  sb: SupabaseClient,
  sessionId: string,
  revision?: number,
): Promise<Proposal | null> {
  let q = sb
    .from('proposals')
    .select('id, session_id, revision, parent_revision, origin, summary')
    .eq('session_id', sessionId);

  q = revision === undefined
    ? q.order('revision', { ascending: false }).limit(1)
    : q.eq('revision', revision);

  const { data: props, error } = await q;
  if (error) throw error;
  if (!props?.length) return null;
  const p = props[0];

  const { data: docs, error: dErr } = await sb
    .from('documents')
    .select(DOC_SELECT)
    .eq('proposal_id', p.id)
    .order('sort_order');
  if (dErr) throw dErr;

  return {
    id: p.id,
    session_id: p.session_id,
    revision: p.revision,
    parent_revision: p.parent_revision,
    origin: p.origin,
    summary: p.summary,
    docs: ((docs ?? []) as DocRow[]).map(rowToDoc),
  };
}

export async function saveRevision(
  sb: SupabaseClient,
  sessionId: string,
  docs: ProposalDoc[],
  opts: {
    origin: Proposal['origin'];
    summary?: string | null;
    pageCount: number;
    parentRevision?: number | null;
  },
): Promise<Proposal> {
  // Never persist a proposal that breaks ground rule #1.
  const check = validateProposal(docs, opts.pageCount);
  if (!check.ok) {
    throw new Error(`Refusing to save an invalid proposal: ${check.errors.join('; ')}`);
  }

  const { data: last } = await sb
    .from('proposals')
    .select('revision')
    .eq('session_id', sessionId)
    .order('revision', { ascending: false })
    .limit(1);
  const revision = (last?.[0]?.revision ?? 0) + 1;

  const { data: created, error: pErr } = await sb
    .from('proposals')
    .insert({
      session_id: sessionId,
      revision,
      parent_revision: opts.parentRevision ?? (revision > 1 ? revision - 1 : null),
      origin: opts.origin,
      summary: opts.summary ?? null,
    })
    .select('id, session_id, revision, parent_revision, origin, summary')
    .single();
  if (pErr) throw pErr;

  const ordered = [...docs].sort(
    (a, b) => Math.min(...a.pages) - Math.min(...b.pages),
  );

  const { data: insertedDocs, error: dErr } = await sb
    .from('documents')
    .insert(
      ordered.map((d, i) => ({
        proposal_id: created.id,
        doc_key: d.doc_key,
        title: d.title,
        doc_type: d.doc_type,
        doc_date: d.doc_date,
        author: d.author,
        discipline: d.discipline,
        org: d.org,
        relates: d.relates,
        relates_reason: d.relates_reason,
        person_name: d.person_name,
        person_dob: d.person_dob,
        person_key: d.person_key,
        dup_of: d.dup_of,
        review: d.review,
        overview: d.overview,
        subcategory: d.subcategory,
        proposed_category: d.proposed_category,
        proposed_category_reason: d.proposed_category_reason,
        confidence: d.confidence,
        excluded: d.excluded,
        sort_order: i,
      })),
    )
    .select('id, doc_key');
  if (dErr) throw dErr;

  const idByKey = new Map((insertedDocs ?? []).map((d) => [d.doc_key, d.id]));
  const pageRows = ordered.flatMap((d) =>
    d.pages.map((page, position) => ({
      proposal_id: created.id,
      document_id: idByKey.get(d.doc_key)!,
      page_number: page,
      position,
    })),
  );

  // The (proposal_id, page_number) primary key makes a double-assigned page a
  // hard database error rather than a silently wrong split.
  const { error: dpErr } = await sb.from('document_pages').insert(pageRows);
  if (dpErr) throw dpErr;

  return {
    ...created,
    docs: ordered.map((d, i) => ({
      ...d,
      id: idByKey.get(d.doc_key)!,
      sort_order: i,
    })),
  };
}

export async function listRevisions(sb: SupabaseClient, sessionId: string) {
  const { data, error } = await sb
    .from('proposals')
    .select('id, revision, parent_revision, origin, summary, created_at')
    .eq('session_id', sessionId)
    .order('revision', { ascending: false });
  if (error) throw error;
  return data ?? [];
}
