import { NextResponse } from 'next/server';
import { BUNDLE_BUCKET, serverClient } from '@/lib/supabase';

/**
 * GET  /api/sessions?device=…   list this device's sessions
 * POST /api/sessions            create a session and mint a signed upload URL
 *
 * The bundle is uploaded by the browser straight to Supabase Storage using the
 * signed URL minted here. It never passes through this function, which is what
 * keeps us clear of Vercel's 4.5 MB request body limit — the DEV bundle alone is
 * 14.6 MB and real bundles run to thousands of pages.
 */

export async function GET(req: Request) {
  const device = new URL(req.url).searchParams.get('device');
  if (!device) {
    return NextResponse.json({ error: 'device is required' }, { status: 400 });
  }

  const sb = serverClient();
  const { data, error } = await sb
    .from('sessions')
    .select('id, name, status, page_count, approved_at, created_at')
    .eq('device_id', device)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Document count of the latest revision, for the session list.
  const ids = (data ?? []).map((s) => s.id);
  const counts = new Map<string, number>();
  if (ids.length) {
    const { data: props } = await sb
      .from('proposals')
      .select('session_id, revision, documents(count)')
      .in('session_id', ids)
      .order('revision', { ascending: false });
    for (const p of props ?? []) {
      if (!counts.has(p.session_id)) {
        const c = (p.documents as unknown as { count: number }[] | null)?.[0]?.count;
        if (typeof c === 'number') counts.set(p.session_id, c);
      }
    }
  }

  return NextResponse.json({
    sessions: (data ?? []).map((s) => ({ ...s, doc_count: counts.get(s.id) ?? null })),
  });
}

export async function POST(req: Request) {
  let body: {
    device_id?: string;
    name?: string;
    client_name?: string;
    client_dob?: string;
    client_ref?: string;
    client_notes?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const device_id = body.device_id?.trim();
  const name = body.name?.trim();
  if (!device_id || !name) {
    return NextResponse.json(
      { error: 'device_id and name are required' },
      { status: 400 },
    );
  }

  // The client's name is required, not merely helpful. Documents are filed
  // under a person, and relatedness is decided by comparing the names found in
  // the bundle against this one; without it every document resolves to an
  // unidentified person and the grouping is meaningless. Date of birth and
  // claim number stay optional — they refine the match, they do not enable it.
  const client_name = body.client_name?.trim();
  if (!client_name) {
    return NextResponse.json(
      { error: 'client_name is required — documents are filed by person' },
      { status: 400 },
    );
  }

  const sb = serverClient();
  const { data: session, error } = await sb
    .from('sessions')
    .insert({
      device_id,
      name,
      status: 'uploading',
      // Who the matter is about. Everything else found in the bundle is
      // reported as another person rather than quietly discarded.
      client_name,
      client_dob: body.client_dob?.trim() || null,
      client_ref: body.client_ref?.trim() || null,
      client_notes: body.client_notes?.trim() || null,
    })
    .select('id, name, status, created_at')
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const path = `${session.id}/bundle.pdf`;
  const { data: signed, error: sErr } = await sb.storage
    .from(BUNDLE_BUCKET)
    .createSignedUploadUrl(path);
  if (sErr) {
    return NextResponse.json({ error: sErr.message }, { status: 500 });
  }

  await sb.from('sessions').update({ bundle_path: path }).eq('id', session.id);

  return NextResponse.json({
    session,
    upload: { path, token: signed.token, bucket: BUNDLE_BUCKET },
  });
}
