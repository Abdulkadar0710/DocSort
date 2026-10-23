import { NextResponse } from 'next/server';
import { serverClient } from '@/lib/supabase';
import { hasApiKey } from '@/lib/ai/claude';
import { classifyWindow } from '@/lib/ai/passA';
import { stitch } from '@/lib/ai/passB';
import { fetchBundle, sliceForModel } from '@/lib/pdf/slice';
import { isAuthoritative, planWindows } from '@/lib/ai/windows';
import { saveRevision } from '@/lib/proposal/store';
import { summariseRuns } from '@/lib/proposal/validate';
import type { PageSignals } from '@/lib/types';

/**
 * POST /api/jobs/tick  { session_id }
 *
 * Processes exactly ONE page window per call. This is the whole answer to
 * Vercel's function duration limit: a bundle of any size is just more ticks,
 * and no single invocation ever approaches its cap. The browser drives the loop
 * and so sees real progress rather than one long opaque wait.
 *
 * When the last classify window lands, this also runs the stitch pass and saves
 * the first real proposal.
 */

export const maxDuration = 120;

export async function POST(req: Request) {
  let body: { session_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const sessionId = body.session_id;
  if (!sessionId) {
    return NextResponse.json({ error: 'session_id is required' }, { status: 400 });
  }

  if (!hasApiKey()) {
    return NextResponse.json({
      idle: true,
      blocked: 'ANTHROPIC_API_KEY is not set, so documents cannot be identified yet. '
        + 'The bundle is uploaded and every page is listed as its own document; '
        + 'add the key and reload to run identification.',
    });
  }

  const sb = serverClient();

  const { data: session } = await sb
    .from('sessions')
    .select('id, bundle_path, page_count, status')
    .eq('id', sessionId)
    .single();
  if (!session?.bundle_path || !session.page_count) {
    return NextResponse.json({ error: 'session is not ready' }, { status: 409 });
  }

  // ---------------------------------------------------------- claim a job
  const { data: candidates } = await sb
    .from('jobs')
    .select('id, window_start, window_end, attempts')
    .eq('session_id', sessionId)
    .eq('kind', 'classify')
    .eq('status', 'pending')
    .order('window_start')
    .limit(4);

  let claimed: { id: string; window_start: number; window_end: number } | null = null;
  for (const c of candidates ?? []) {
    // Guarding the update on status='pending' makes the claim atomic: a racing
    // tick updates zero rows and moves on to the next candidate.
    const { data: got } = await sb
      .from('jobs')
      .update({ status: 'running', attempts: c.attempts + 1 })
      .eq('id', c.id)
      .eq('status', 'pending')
      .select('id, window_start, window_end');
    if (got?.length) {
      claimed = got[0];
      break;
    }
  }

  if (claimed) {
    try {
      const bundle = await fetchBundle(sb, session.bundle_path);
      const { base64, pageNumbers, rotationsCleared } = await sliceForModel(
        bundle,
        claimed.window_start,
        claimed.window_end,
      );

      const { data: pageRows } = await sb
        .from('pages')
        .select('page_number, text, has_text_layer')
        .eq('session_id', sessionId)
        .gte('page_number', claimed.window_start)
        .lte('page_number', claimed.window_end);

      const textByPage = new Map<number, string>();
      for (const r of pageRows ?? []) {
        if (r.has_text_layer && r.text) textByPage.set(r.page_number, r.text);
      }

      const { signals, usage } = await classifyWindow({
        pdfBase64: base64,
        pageNumbers,
        rotationsCleared,
        textByPage,
      });

      await sb
        .from('jobs')
        .update({ status: 'done', result: { signals, usage } })
        .eq('id', claimed.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Two shots at a window, then leave it failed. The merge pass below
      // treats an unprocessed page as its own single-page document and flags
      // it, so a failed window degrades the split rather than breaking it.
      const { data: j } = await sb
        .from('jobs')
        .select('attempts')
        .eq('id', claimed.id)
        .single();
      await sb
        .from('jobs')
        .update({
          status: (j?.attempts ?? 1) >= 2 ? 'failed' : 'pending',
          error: msg,
        })
        .eq('id', claimed.id);

      return NextResponse.json({ ok: false, error: msg }, { status: 200 });
    }
  }

  // ------------------------------------------------- merge when all are in
  const { data: all } = await sb
    .from('jobs')
    .select('status, window_start, window_end, result')
    .eq('session_id', sessionId)
    .eq('kind', 'classify');

  const remaining = (all ?? []).filter(
    (j) => j.status === 'pending' || j.status === 'running',
  ).length;
  const done = (all ?? []).filter((j) => j.status === 'done').length;

  if (remaining === 0 && session.status === 'processing') {
    try {
      await runStitch(sb, sessionId, session.page_count, all ?? []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sb.from('sessions').update({ status: 'failed', error: msg }).eq('id', sessionId);
      return NextResponse.json({ ok: false, error: msg }, { status: 200 });
    }
  }

  return NextResponse.json({
    ok: true,
    idle: !claimed && remaining === 0,
    done,
    remaining,
    total: (all ?? []).length,
  });
}

type JobRow = {
  status: string;
  window_start: number | null;
  window_end: number | null;
  result: unknown;
};

async function runStitch(
  sb: ReturnType<typeof serverClient>,
  sessionId: string,
  pageCount: number,
  jobs: JobRow[],
) {
  const windows = planWindows(pageCount);

  // Each page is described twice because windows overlap. The authoritative
  // answer comes from the window that saw the most pages before it, so its
  // "does this continue the previous page?" judgement was never made blind.
  const chosen = new Map<number, PageSignals>();
  for (const job of jobs) {
    if (job.status !== 'done' || !job.result) continue;
    const { signals } = job.result as { signals: PageSignals[] };
    const w = { start: job.window_start!, end: job.window_end! };
    for (const s of signals ?? []) {
      if (isAuthoritative(s.page_number, w, windows)) chosen.set(s.page_number, s);
    }
  }

  // Any page no window successfully described still gets a place in the split,
  // flagged, rather than disappearing. Ground rule #1 holds even on failure.
  const missing: number[] = [];
  for (let p = 1; p <= pageCount; p++) {
    if (chosen.has(p)) continue;
    missing.push(p);
    chosen.set(p, {
      page_number: p,
      is_blank: false,
      title: null,
      doc_type: null,
      doc_date: null,
      author: null,
      discipline: null,
      org: null,
      patient_name_seen: null,
      page_marker: null,
      has_letterhead: false,
      continues_previous: false,
      continues_confidence: 0,
      relates: 'uncertain',
      relates_reason: null,
      review_flags: ['Automatic description did not complete for this page'],
      extracted_text: null,
      confidence: 0,
    });
  }

  const signals = [...chosen.values()].sort((a, b) => a.page_number - b.page_number);
  const { docs, decisions } = stitch(signals);

  const nonContiguous = decisions.filter((d) => !d.contiguous);
  const summaryParts = [
    `Identified ${docs.filter((d) => !d.excluded).length} documents across ${pageCount} pages`,
    `${docs.filter((d) => d.excluded).length} page(s) excluded as blank`,
    `${decisions.length} page(s) merged into a preceding document`,
  ];
  if (nonContiguous.length) {
    summaryParts.push(
      `${nonContiguous.length} page(s) rejoined a document across unrelated pages`,
    );
  }
  if (missing.length) {
    summaryParts.push(`pages ${summariseRuns(missing)} could not be read automatically`);
  }

  await saveRevision(sb, sessionId, docs, {
    origin: 'ai',
    summary: summaryParts.join('; ') + '.',
    pageCount,
  });

  await sb
    .from('messages')
    .insert({
      session_id: sessionId,
      role: 'ai',
      content:
        `I went through all ${pageCount} pages and found ` +
        `${docs.filter((d) => !d.excluded).length} documents. ` +
        (nonContiguous.length
          ? `${nonContiguous.length} page(s) belong to a document they are not next to, ` +
            `which I have joined up. `
          : '') +
        `Documents I was unsure about are flagged in the list. ` +
        `Scroll the preview to check the split, and tell me anything that needs changing.`,
      proposal_revision: null,
    });

  await sb.from('sessions').update({ status: 'proposed' }).eq('id', sessionId);
}
