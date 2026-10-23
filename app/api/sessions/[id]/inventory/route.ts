import { NextResponse } from 'next/server';
import { serverClient } from '@/lib/supabase';
import { naiveProposal } from '@/lib/proposal/ops';
import { saveRevision } from '@/lib/proposal/store';
import { planWindows } from '@/lib/ai/windows';
import type { PageInventory } from '@/lib/types';

/**
 * POST /api/sessions/:id/inventory
 *
 * The browser collects the page inventory with pdf.js right after upload — the
 * file is already in memory there, so this costs no extra bandwidth and no
 * server CPU, and it sidesteps configuring pdf.js for a serverless runtime.
 *
 * Receiving it does three things:
 *   1. stores per-page facts (rotation, dimensions, text layer, extracted text)
 *   2. saves revision 1 as the naive "one page, one document" split, so the
 *      reviewer has a complete, valid, inspectable proposal immediately
 *   3. queues the classify windows that Pass A will work through
 */

const MAX_PAGES = 5000;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  let body: { pages?: PageInventory[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const pages = body.pages;
  if (!Array.isArray(pages) || pages.length === 0) {
    return NextResponse.json({ error: 'pages is required' }, { status: 400 });
  }
  if (pages.length > MAX_PAGES) {
    return NextResponse.json(
      { error: `bundle exceeds the ${MAX_PAGES}-page prototype limit` },
      { status: 413 },
    );
  }

  const sb = serverClient();
  const { data: session, error: sErr } = await sb
    .from('sessions')
    .select('id, status, page_count')
    .eq('id', id)
    .single();
  if (sErr || !session) {
    return NextResponse.json({ error: 'session not found' }, { status: 404 });
  }

  // Idempotent: re-posting an inventory for an already-inventoried session is a
  // no-op rather than a duplicate proposal. Makes the upload step safely
  // retryable from the browser.
  if (session.page_count) {
    return NextResponse.json({
      ok: true,
      already: true,
      page_count: session.page_count,
    });
  }

  const pageCount = pages.length;
  const seen = new Set(pages.map((p) => p.page_number));
  for (let p = 1; p <= pageCount; p++) {
    if (!seen.has(p)) {
      return NextResponse.json(
        { error: `inventory is missing page ${p}` },
        { status: 400 },
      );
    }
  }

  await sb.from('sessions').update({ status: 'inventorying' }).eq('id', id);

  const { error: pErr } = await sb.from('pages').insert(
    pages.map((p) => ({
      session_id: id,
      page_number: p.page_number,
      has_text_layer: p.has_text_layer,
      rotation: p.rotation ?? 0,
      width: p.width,
      height: p.height,
      text: p.text?.slice(0, 20000) ?? null,
    })),
  );
  if (pErr) {
    await sb
      .from('sessions')
      .update({ status: 'failed', error: pErr.message })
      .eq('id', id);
    return NextResponse.json({ error: pErr.message }, { status: 500 });
  }

  // Revision 1: the naive split. On the DEV bundle this is already correct for
  // 103 of 132 documents, so it is a genuinely useful starting point rather
  // than a placeholder — and it means the four reviewer steps work end to end
  // before any model has been called.
  try {
    await saveRevision(sb, id, naiveProposal(pageCount), {
      origin: 'naive',
      summary:
        'Starting point: every page treated as its own document. ' +
        'Awaiting automatic classification.',
      pageCount,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from('sessions').update({ status: 'failed', error: msg }).eq('id', id);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const windows = planWindows(pageCount);
  const { error: jErr } = await sb.from('jobs').insert(
    windows.map((w) => ({
      session_id: id,
      kind: 'classify' as const,
      window_start: w.start,
      window_end: w.end,
    })),
  );
  if (jErr) {
    return NextResponse.json({ error: jErr.message }, { status: 500 });
  }

  await sb
    .from('sessions')
    .update({ status: 'processing', page_count: pageCount })
    .eq('id', id);

  const withText = pages.filter((p) => p.has_text_layer).length;
  return NextResponse.json({
    ok: true,
    page_count: pageCount,
    windows: windows.length,
    pages_with_text_layer: withText,
    pages_needing_ocr: pageCount - withText,
  });
}
