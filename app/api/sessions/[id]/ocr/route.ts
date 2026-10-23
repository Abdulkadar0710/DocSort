import { NextResponse } from 'next/server';
import { serverClient } from '@/lib/supabase';
import type { OcrWord } from '@/lib/types';

/**
 * POST /api/sessions/:id/ocr  { page_number, words }
 *
 * Stores word geometry for one scanned page, produced by the browser OCR pass.
 * Used only to lay an invisible text layer on that page at export time, so a
 * child PDF made from scans is still searchable.
 */

const MAX_WORDS = 4000;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  let body: { page_number?: number; words?: OcrWord[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const page = body.page_number;
  if (!Number.isInteger(page) || (page as number) < 1) {
    return NextResponse.json({ error: 'page_number is required' }, { status: 400 });
  }

  const words = (Array.isArray(body.words) ? body.words : [])
    .filter(
      (w) =>
        typeof w?.text === 'string' &&
        Number.isFinite(w.x0) &&
        Number.isFinite(w.y0) &&
        Number.isFinite(w.x1) &&
        Number.isFinite(w.y1),
    )
    .slice(0, MAX_WORDS)
    .map((w) => ({
      text: w.text.slice(0, 120),
      // Normalised at the source; clamped here so a bad box cannot push text
      // off the page at export.
      x0: clamp01(w.x0),
      y0: clamp01(w.y0),
      x1: clamp01(w.x1),
      y1: clamp01(w.y1),
    }));

  const sb = serverClient();
  const { error } = await sb
    .from('pages')
    .update({ ocr_words: words })
    .eq('session_id', id)
    .eq('page_number', page);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, words: words.length });
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
