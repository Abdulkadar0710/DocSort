import { NextResponse } from 'next/server';
import JSZip from 'jszip';
import { BUNDLE_BUCKET, serverClient } from '@/lib/supabase';
import { loadProposal } from '@/lib/proposal/store';
import { validateProposal } from '@/lib/proposal/validate';
import { fetchBundle } from '@/lib/pdf/slice';
import { buildChildPdfs } from '@/lib/pdf/export';
import { renderSummaryPdf } from '@/lib/pdf/summary';
import { loadCategories } from '@/lib/ai/taxonomy';
import type { OcrWord } from '@/lib/types';

/**
 * POST /api/approve  { session_id }
 *
 * Step 3 and 4 of the reviewer's journey. Nothing is split until this is
 * called, and it refuses to run on a proposal whose page accounting does not
 * balance — the one invariant that must hold before anything is produced.
 */

export const maxDuration = 300;

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

  const sb = serverClient();

  const { data: session } = await sb
    .from('sessions')
    .select('id, name, status, page_count, bundle_path, approved_at')
    .eq('id', sessionId)
    .single();
  if (!session?.bundle_path || !session.page_count) {
    return NextResponse.json({ error: 'session is not ready' }, { status: 409 });
  }

  const proposal = await loadProposal(sb, sessionId);
  if (!proposal) {
    return NextResponse.json({ error: 'this session has no proposal yet' }, { status: 409 });
  }

  // Ground rule #1, enforced at the only moment it finally matters.
  const validation = validateProposal(proposal.docs, session.page_count);
  if (!validation.ok) {
    return NextResponse.json(
      {
        error:
          'Page accounting does not balance, so nothing was split: ' +
          validation.errors.join('; '),
      },
      { status: 409 },
    );
  }

  // Re-approving replaces the previous outputs rather than stacking duplicates.
  const { data: previous } = await sb
    .from('outputs')
    .select('path')
    .eq('session_id', sessionId);
  if (previous?.length) {
    await sb.storage.from(BUNDLE_BUCKET).remove(previous.map((p) => p.path));
    await sb.from('outputs').delete().eq('session_id', sessionId);
  }

  try {
    const bundle = await fetchBundle(sb, session.bundle_path);

    // Word geometry for scanned pages, where the browser OCR pass has produced
    // it. Absent, the page is still exported faithfully, just without a text
    // layer — identification never depended on this.
    const { data: pageRows } = await sb
      .from('pages')
      .select('page_number, ocr_words, has_text_layer')
      .eq('session_id', sessionId);

    const ocrByPage = new Map<number, OcrWord[]>();
    let ocrPageCount = 0;
    let ocrTextLayerCount = 0;
    for (const r of pageRows ?? []) {
      if (!r.has_text_layer) ocrPageCount++;
      const words = r.ocr_words as OcrWord[] | null;
      if (words?.length) {
        ocrByPage.set(r.page_number, words);
        if (!r.has_text_layer) ocrTextLayerCount++;
      }
    }

    const categories = await loadCategories(sb, { activeOnly: false });
    const shortLabels = new Map(
      categories.filter((c) => c.short_label).map((c) => [c.name, c.short_label!]),
    );
    const children = await buildChildPdfs(bundle, proposal.docs, ocrByPage, shortLabels);

    const { count: feedbackRounds } = await sb
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .eq('role', 'reviewer');

    const approvedAt = new Date();
    const summaryBytes = await renderSummaryPdf({
      sessionName: session.name,
      pageCount: session.page_count,
      docs: proposal.docs,
      validation,
      revisions: proposal.revision,
      feedbackRounds: feedbackRounds ?? 0,
      approvedAt,
      ocrPageCount,
      ocrTextLayerCount,
      categories,
    });

    // Plain "Summary.pdf" to sit alongside "D001 Letters.pdf" in the listing.
    const safeName = session.name.replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 40);
    const summaryName = 'Summary.pdf';

    // One archive so the reviewer can take the whole evidence set in a click.
    const zip = new JSZip();
    const folder = zip.folder('documents')!;
    for (const c of children) folder.file(c.filename, c.bytes);
    zip.file(summaryName, summaryBytes);
    const zipBytes = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const base = `${sessionId}/out`;
    const uploads: {
      kind: 'child' | 'summary' | 'zip';
      path: string;
      filename: string;
      page_count: number | null;
      document_id: string | null;
    }[] = [];

    const put = async (path: string, bytes: Uint8Array, type: string) => {
      const { error } = await sb.storage
        .from(BUNDLE_BUCKET)
        .upload(path, bytes, { contentType: type, upsert: true });
      if (error) throw new Error(`could not store ${path}: ${error.message}`);
    };

    for (const c of children) {
      const path = `${base}/${c.filename}`;
      await put(path, c.bytes, 'application/pdf');
      uploads.push({
        kind: 'child',
        path,
        filename: c.filename,
        page_count: c.pageCount,
        document_id: proposal.docs.find((d) => d.doc_key === c.doc_key)?.id ?? null,
      });
    }

    const summaryPath = `${base}/${summaryName}`;
    await put(summaryPath, summaryBytes, 'application/pdf');
    uploads.push({
      kind: 'summary',
      path: summaryPath,
      filename: summaryName,
      page_count: null,
      document_id: null,
    });

    const zipPath = `${base}/${safeName}-documents.zip`;
    await put(zipPath, zipBytes, 'application/zip');
    uploads.push({
      kind: 'zip',
      path: zipPath,
      filename: `${safeName}-documents.zip`,
      page_count: null,
      document_id: null,
    });

    await sb
      .from('outputs')
      .insert(uploads.map((u) => ({ session_id: sessionId, ...u })));

    await sb
      .from('sessions')
      .update({ status: 'approved', approved_at: approvedAt.toISOString(), error: null })
      .eq('id', sessionId);

    const excludedCount = proposal.docs.filter((d) => d.excluded).length;
    await sb.from('messages').insert({
      session_id: sessionId,
      role: 'system',
      content:
        `Split approved. ${children.length} documents produced from ` +
        `${session.page_count} pages` +
        (excludedCount
          ? `, with ${excludedCount} page(s) excluded and listed in the summary`
          : '') +
        `, plus a summary PDF.`,
      proposal_revision: proposal.revision,
    });

    return NextResponse.json({
      ok: true,
      documents: children.length,
      excluded: excludedCount,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from('sessions').update({ error: msg }).eq('id', sessionId);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
