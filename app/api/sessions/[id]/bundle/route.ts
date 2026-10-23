import { NextResponse } from 'next/server';
import { BUNDLE_BUCKET, serverClient } from '@/lib/supabase';

/**
 * GET /api/sessions/:id/bundle
 *
 * A STABLE url for the original bundle, which redirects to a short-lived signed
 * Storage url.
 *
 * This exists because the viewer must not see its source change. Signing is
 * non-deterministic — asking Storage for a signed url twice yields two
 * different strings — so returning one directly in the session payload meant
 * every poll handed the viewer a "new" url, tearing down and restarting the
 * pdf.js load before it could finish. A stable url makes the preview depend on
 * the session, not on when it was last fetched.
 */

const SIGNED_TTL = 60 * 60;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sb = serverClient();

  const { data: session } = await sb
    .from('sessions')
    .select('bundle_path')
    .eq('id', id)
    .single();

  if (!session?.bundle_path) {
    return NextResponse.json({ error: 'no bundle for this session' }, { status: 404 });
  }

  const { data: signed, error } = await sb.storage
    .from(BUNDLE_BUCKET)
    .createSignedUrl(session.bundle_path, SIGNED_TTL);

  if (error || !signed) {
    return NextResponse.json(
      { error: error?.message ?? 'could not sign the bundle url' },
      { status: 500 },
    );
  }

  // Let the browser reuse the redirect for a while so pdf.js's range requests
  // do not each pay for a fresh signature.
  return NextResponse.redirect(signed.signedUrl, {
    status: 307,
    headers: { 'cache-control': `private, max-age=${SIGNED_TTL / 2}` },
  });
}
