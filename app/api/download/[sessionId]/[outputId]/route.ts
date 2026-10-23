import { NextResponse } from 'next/server';
import { BUNDLE_BUCKET, serverClient } from '@/lib/supabase';

/**
 * GET /api/download/:sessionId/:outputId
 *
 * Hands back one approved output. Redirects to a short-lived signed url with a
 * download disposition, so the file never streams through this function.
 * Approved sessions can be reopened and their outputs downloaded again at any
 * time, which is why these live in Storage rather than being produced on demand.
 */

const TTL = 60 * 10;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ sessionId: string; outputId: string }> },
) {
  const { sessionId, outputId } = await ctx.params;
  const sb = serverClient();

  const { data: output } = await sb
    .from('outputs')
    .select('path, filename, session_id')
    .eq('id', outputId)
    .eq('session_id', sessionId)
    .single();

  if (!output) {
    return NextResponse.json({ error: 'output not found' }, { status: 404 });
  }

  const { data: signed, error } = await sb.storage
    .from(BUNDLE_BUCKET)
    .createSignedUrl(output.path, TTL, { download: output.filename });

  if (error || !signed) {
    return NextResponse.json(
      { error: error?.message ?? 'could not sign the download url' },
      { status: 500 },
    );
  }

  return NextResponse.redirect(signed.signedUrl, 307);
}
