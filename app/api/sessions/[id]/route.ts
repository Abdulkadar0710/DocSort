import { NextResponse } from 'next/server';
import { serverClient } from '@/lib/supabase';
import { loadProposal, listRevisions } from '@/lib/proposal/store';
import { validateProposal } from '@/lib/proposal/validate';
import { clusterPeople } from '@/lib/proposal/people';

/**
 * GET /api/sessions/:id[?revision=N]
 *
 * Everything the workspace needs in one round trip: the session, a signed URL
 * for the original bundle, the proposal to display, its validation state, the
 * revision history and the feedback conversation.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const revParam = new URL(req.url).searchParams.get('revision');
  const revision = revParam ? Number(revParam) : undefined;
  if (revParam && !Number.isInteger(revision)) {
    return NextResponse.json({ error: 'revision must be an integer' }, { status: 400 });
  }

  const sb = serverClient();

  const { data: session, error } = await sb
    .from('sessions')
    .select('id, name, status, page_count, bundle_path, approved_at, created_at, error, client_name, client_dob, client_ref')
    .eq('id', id)
    .single();
  if (error || !session) {
    return NextResponse.json({ error: 'session not found' }, { status: 404 });
  }

  // A stable app url rather than a freshly signed one. Signing is
  // non-deterministic, so returning a signed url here would change on every
  // poll and restart the viewer's pdf load each time.
  const bundleUrl = session.bundle_path ? `/api/sessions/${id}/bundle` : null;

  const proposal = await loadProposal(sb, id, revision);
  const revisions = await listRevisions(sb, id);

  // Geometry only — never the page text, which would balloon this payload.
  // The viewer needs each page's aspect ratio up front so it can lay out all
  // pages at the correct height and render canvases lazily as they scroll in.
  const { data: pageRows } = await sb
    .from('pages')
    .select('page_number, rotation, width, height, has_text_layer, ocr_words')
    .eq('session_id', id)
    .order('page_number');

  // Which scanned pages still need an invisible text layer. Sent as page
  // numbers so the browser can pick up an interrupted OCR pass where it left
  // off rather than redoing the whole bundle.
  const needsOcr = (pageRows ?? [])
    .filter((p) => !p.has_text_layer && !p.ocr_words)
    .map((p) => p.page_number);
  const scannedTotal = (pageRows ?? []).filter((p) => !p.has_text_layer).length;

  const { data: messages } = await sb
    .from('messages')
    .select('id, role, content, ops, proposal_revision, created_at')
    .eq('session_id', id)
    .order('created_at');

  const { data: jobs } = await sb
    .from('jobs')
    .select('kind, status')
    .eq('session_id', id);


  const progress = (jobs ?? []).reduce<Record<string, number>>((acc, j) => {
    acc[j.status] = (acc[j.status] ?? 0) + 1;
    return acc;
  }, {});

  /**
   * Progress by phase rather than one undifferentiated count.
   *
   * The phases are not comparable units of work — a classify window reads ten
   * pages, a categorise job reads one document — so "14 of 19 jobs" tells a
   * waiting reviewer nothing. Reported separately, the UI can say which stage
   * it is in and how far through that stage it is, which is the question
   * somebody watching a progress bar is actually asking.
   */
  const countPhase = (kind: string) => {
    const of = (jobs ?? []).filter((j) => j.kind === kind);
    return {
      total: of.length,
      done: of.filter((j) => j.status === 'done').length,
      failed: of.filter((j) => j.status === 'failed').length,
      pending: of.filter((j) => j.status === 'pending' || j.status === 'running').length,
    };
  };

  const phases = {
    classify: countPhase('classify'),
    taxonomy: countPhase('taxonomy'),
    categorise: countPhase('categorise'),
    group: countPhase('group'),
  };

  const { data: outputs } = await sb
    .from('outputs')
    .select('id, kind, filename, page_count, document_id')
    .eq('session_id', id)
    .order('kind');

  return NextResponse.json({
    session,
    bundleUrl,
    proposal,
    pages: (pageRows ?? []).map(({ ocr_words, ...rest }) => {
      void ocr_words; // geometry is large and the viewer never needs it
      return rest;
    }),
    ocr: {
      scannedTotal,
      done: scannedTotal - needsOcr.length,
      needsOcr,
    },
    revisions,
    messages: messages ?? [],
    outputs: outputs ?? [],
    progress: {
      total: (jobs ?? []).length,
      done: progress.done ?? 0,
      failed: progress.failed ?? 0,
      pending: (progress.pending ?? 0) + (progress.running ?? 0),
      phases,
    },
    // Who the bundle turned out to be about, so the register can be read as
    // whole people rather than a flat list.
    people: proposal
      ? clusterPeople(proposal.docs.map((d) => ({ ...d })), {
          name: session.client_name,
          dob: session.client_dob,
        }).people
      : [],
    validation:
      proposal && session.page_count
        ? validateProposal(proposal.docs, session.page_count)
        : null,
  });
}
