import { NextResponse } from 'next/server';
import { serverClient } from '@/lib/supabase';
import { hasApiKey } from '@/lib/ai/claude';
import { pagesMentioned, reviseFromFeedback } from '@/lib/ai/feedback';
import { applyOps, describeOp } from '@/lib/proposal/ops';
import { loadProposal, saveRevision } from '@/lib/proposal/store';
import { validateProposal } from '@/lib/proposal/validate';
import { diffProposals } from '@/lib/proposal/diff';

/**
 * POST /api/feedback  { session_id, feedback }
 *
 * One refinement round. The proposal is never regenerated — the reviewer's
 * words become a small set of edits applied to the CURRENT revision, which is
 * what keeps an earlier correction (manual or otherwise) intact through later
 * rounds, and what keeps a round from disturbing parts of the split nobody
 * asked about.
 */

export const maxDuration = 120;

export async function POST(req: Request) {
  let body: { session_id?: string; feedback?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const sessionId = body.session_id;
  const feedback = body.feedback?.trim();
  if (!sessionId || !feedback) {
    return NextResponse.json(
      { error: 'session_id and feedback are required' },
      { status: 400 },
    );
  }
  if (!hasApiKey()) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not set, so feedback cannot be interpreted.' },
      { status: 503 },
    );
  }

  const sb = serverClient();

  const { data: session } = await sb
    .from('sessions')
    .select('id, status, page_count')
    .eq('id', sessionId)
    .single();
  if (!session?.page_count) {
    return NextResponse.json({ error: 'session is not ready' }, { status: 409 });
  }
  if (session.status === 'approved') {
    return NextResponse.json(
      { error: 'this session is approved; its split can no longer be changed' },
      { status: 409 },
    );
  }

  const before = await loadProposal(sb, sessionId);
  if (!before) {
    return NextResponse.json({ error: 'this session has no proposal yet' }, { status: 409 });
  }

  // Only the pages the reviewer actually named are fetched — never the bundle.
  const mentioned = pagesMentioned(feedback, session.page_count);
  const pageText = new Map<number, string>();
  if (mentioned.length) {
    const { data: rows } = await sb
      .from('pages')
      .select('page_number, text')
      .eq('session_id', sessionId)
      .in('page_number', mentioned);
    for (const r of rows ?? []) if (r.text) pageText.set(r.page_number, r.text);
  }

  const { data: priorMessages } = await sb
    .from('messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .in('role', ['reviewer', 'ai'])
    .order('created_at');

  await sb.from('messages').insert({
    session_id: sessionId,
    role: 'reviewer',
    content: feedback,
    proposal_revision: before.revision,
  });

  try {
    const result = await reviseFromFeedback({
      feedback,
      docs: before.docs,
      pageCount: session.page_count,
      pageText,
      history: (priorMessages ?? []).map((m) => ({
        role: m.role as 'reviewer' | 'ai',
        content: m.content ?? '',
      })),
    });

    const { docs: after, rejected } = applyOps(before.docs, result.ops);

    // A revision that breaks page accounting is refused outright: better to
    // tell the reviewer nothing changed than to persist a split that has lost
    // or duplicated a page.
    const validation = validateProposal(after, session.page_count);
    if (!validation.ok) {
      const message =
        `I could not make that change safely — it would have left the split ` +
        `inconsistent (${validation.errors.join('; ')}). Nothing has been changed. ` +
        `Could you rephrase it?`;
      await sb.from('messages').insert({
        session_id: sessionId,
        role: 'ai',
        content: message,
        proposal_revision: before.revision,
      });
      return NextResponse.json({ ok: false, explanation: message, diff: null });
    }

    const saved = await saveRevision(sb, sessionId, after, {
      origin: 'feedback',
      summary: result.explanation,
      pageCount: session.page_count,
      parentRevision: before.revision,
    });

    const diff = diffProposals(before.docs, saved.docs);

    let message = result.explanation;
    if (rejected.length) {
      message +=
        `\n\nI could not apply ${rejected.length} part(s) of that: ` +
        rejected.map((r) => `${describeOp(r.op)} — ${r.reason}`).join('; ') + '.';
    }
    if (diff.changes.length === 0) {
      message += '\n\nNothing in the split actually changed as a result.';
    }

    await sb.from('messages').insert({
      session_id: sessionId,
      role: 'ai',
      content: message,
      ops: result.ops,
      proposal_revision: saved.revision,
    });

    return NextResponse.json({
      ok: true,
      explanation: message,
      revision: saved.revision,
      diff,
      rejected,
      pagesConsulted: result.pagesConsulted,
      usage: result.usage,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from('messages').insert({
      session_id: sessionId,
      role: 'ai',
      content: `Something went wrong interpreting that: ${msg}. Nothing has been changed.`,
      proposal_revision: before.revision,
    });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
