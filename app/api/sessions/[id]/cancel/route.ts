import { NextResponse } from 'next/server';
import { serverClient } from '@/lib/supabase';

/**
 * POST /api/sessions/:id/cancel
 *
 * Stop processing a bundle the reviewer no longer wants.
 *
 * Cancelling abandons the work, not the record. The session, the uploaded
 * bundle and whatever was identified before the stop are all kept: a reviewer
 * who uploaded the wrong file wants it off their screen, but one who stopped a
 * long run by accident should not lose it. Reopening a cancelled session
 * resumes the outstanding windows.
 *
 * Jobs already running are left alone rather than killed. A tick that is
 * mid-call will finish and write its result, which is harmless — the pending
 * ones are what actually cost time and money, and those stop immediately.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sb = serverClient();

  const { data: session } = await sb
    .from('sessions')
    .select('id, status')
    .eq('id', id)
    .single();

  if (!session) {
    return NextResponse.json({ error: 'session not found' }, { status: 404 });
  }
  if (session.status === 'approved') {
    return NextResponse.json(
      { error: 'this session is already approved; there is nothing to cancel' },
      { status: 409 },
    );
  }

  // Status first. Every tick checks it before claiming work, so flipping it
  // here stops the next one dead — including the phase-advance that would
  // otherwise queue the following pass seconds after the reviewer stopped it.
  await sb
    .from('sessions')
    .update({ status: 'cancelled', error: null })
    .eq('id', id);

  const { data: stopped } = await sb
    .from('jobs')
    .update({ status: 'cancelled' })
    .eq('session_id', id)
    .eq('status', 'pending')
    .select('id');

  await sb.from('messages').insert({
    session_id: id,
    role: 'system',
    content:
      `Processing cancelled by the reviewer. ` +
      `${stopped?.length ?? 0} piece(s) of work were not started. ` +
      `Reopening this session will pick up where it stopped.`,
  });

  return NextResponse.json({ ok: true, cancelled: stopped?.length ?? 0 });
}
