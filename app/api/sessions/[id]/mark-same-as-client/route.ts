import { NextResponse } from 'next/server';
import { serverClient } from '@/lib/supabase';
import { loadProposal, saveRevision } from '@/lib/proposal/store';
import { groupByCategory } from '@/lib/proposal/group';
import { clusterPeople } from '@/lib/proposal/people';
import { validateProposal } from '@/lib/proposal/validate';

/**
 * POST /api/sessions/:id/mark-same-as-client  { person_key }
 *
 * The reviewer's manual override for a mismatch automatic name-matching
 * cannot resolve: "this group IS the client, however badly it reads."
 *
 * No AI call. Flagging the documents `person_client_confirmed` and
 * re-running clusterPeople + groupByCategory — both pure, deterministic
 * functions — is enough: clusterPeople (lib/proposal/people.ts) checks that
 * flag before attempting any name match, so these documents land with the
 * client this time and on every future re-cluster, and groupByCategory then
 * merges them into whichever existing category documents the client already
 * has (Receipts into Receipts, Reports into Reports), exactly as it would for
 * any other document of theirs.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  let body: { person_key?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const personKey = body.person_key?.trim();
  if (!personKey) {
    return NextResponse.json({ error: 'person_key is required' }, { status: 400 });
  }

  const sb = serverClient();

  const { data: session } = await sb
    .from('sessions')
    .select('id, status, page_count, client_name, client_dob')
    .eq('id', id)
    .single();
  if (!session) {
    return NextResponse.json({ error: 'session not found' }, { status: 404 });
  }
  if (session.status === 'approved') {
    return NextResponse.json(
      { error: 'this session is approved; its split can no longer be changed' },
      { status: 409 },
    );
  }
  if (!session.client_name?.trim()) {
    return NextResponse.json(
      { error: 'no client is named for this matter, so there is nothing to mark documents as' },
      { status: 409 },
    );
  }

  const proposal = await loadProposal(sb, id);
  if (!proposal) {
    return NextResponse.json({ error: 'this session has no proposal yet' }, { status: 409 });
  }

  // Resolve people exactly as GET /api/sessions/:id does for the register, so
  // the key the reviewer clicked always names the same documents here. The
  // person_key saved on each document is not enough on its own: a grouping
  // pass with nothing to merge used to skip saving, leaving it null, and the
  // button then found "no documents" for a person the screen plainly showed.
  const client = { name: session.client_name, dob: session.client_dob };
  const current = clusterPeople(proposal.docs.map((d) => ({ ...d })), client);
  const keyOf = new Map(current.docs.map((d) => [d.doc_key, d.person_key]));

  const moving = proposal.docs.filter((d) => keyOf.get(d.doc_key) === personKey);
  if (!moving.length) {
    return NextResponse.json(
      { error: 'no documents are currently assigned to that person' },
      { status: 404 },
    );
  }

  const flagged = proposal.docs.map((d) =>
    keyOf.get(d.doc_key) === personKey ? { ...d, person_client_confirmed: true } : d,
  );

  const clustered = clusterPeople(flagged, client);
  const { docs: grouped, merged } = groupByCategory(
    clustered.docs,
    clustered.people.map((p) => p.key),
  );

  if (session.page_count) {
    const validation = validateProposal(grouped, session.page_count);
    if (!validation.ok) {
      return NextResponse.json(
        { error: `could not apply that safely: ${validation.errors.join('; ')}` },
        { status: 500 },
      );
    }
  }

  const pageCount = moving.reduce((n, d) => n + d.pages.length, 0);
  const summary =
    `Marked ${moving.length} document(s) (${pageCount} page(s)) as the client, ` +
    `on the reviewer's confirmation. ` +
    (merged.length
      ? `Merged into existing documents: ` +
        merged.map((m) => `${m.from} ${m.category.toLowerCase()} for ${m.person}`).join('; ') +
        '.'
      : '');

  const saved = await saveRevision(sb, id, grouped, {
    origin: 'manual',
    summary,
    pageCount: session.page_count ?? grouped.flatMap((d) => d.pages).length,
    parentRevision: proposal.revision,
  });

  await sb.from('messages').insert({
    session_id: id,
    role: 'system',
    content: summary,
    proposal_revision: saved.revision,
  });

  return NextResponse.json({ ok: true, revision: saved.revision });
}
