import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serverClient } from '@/lib/supabase';
import { hasApiKey } from '@/lib/ai/claude';
import { classifyWindow } from '@/lib/ai/passA';
import { stitch } from '@/lib/ai/passB';
import { categoriseDocument } from '@/lib/ai/categorise';
import { deriveAndStoreTaxonomy, ensureCategory, loadCategories } from '@/lib/ai/taxonomy';
import { fetchBundle, sliceForModel, slicePagesForModel } from '@/lib/pdf/slice';
import { isAuthoritative, planWindows } from '@/lib/ai/windows';
import { loadProposal, saveRevision } from '@/lib/proposal/store';
import { groupByCategory } from '@/lib/proposal/group';
import { clusterPeople, UNIDENTIFIED } from '@/lib/proposal/people';
import { summariseRuns } from '@/lib/proposal/validate';
import type { PageSignals } from '@/lib/types';

/**
 * POST /api/jobs/tick  { session_id }
 *
 * Processes exactly ONE unit of work per call. This is the whole answer to
 * Vercel's function duration limit: a bundle of any size is just more ticks,
 * and no single invocation ever approaches its cap. The browser drives the loop
 * and so sees real progress rather than one long opaque wait.
 *
 * Three kinds of work, in order:
 *   classify   — one page window, finding where documents begin and end
 *   taxonomy   — once, deriving the category set from the whole assembled set
 *   categorise — one document, with all of its pages in view
 */

export const maxDuration = 120;

type Kind = 'classify' | 'taxonomy' | 'categorise' | 'group';

/** Earlier kinds must finish before later ones can start. */
const ORDER: Kind[] = ['classify', 'taxonomy', 'categorise', 'group'];

interface ClaimedJob {
  id: string;
  kind: Kind;
  window_start: number | null;
  window_end: number | null;
  proposal_id: string | null;
  doc_key: string | null;
}

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
      blocked:
        'ANTHROPIC_API_KEY is not set, so documents cannot be identified yet. ' +
        'The bundle is uploaded and every page is listed as its own document; ' +
        'add the key and reload to run identification.',
    });
  }

  const sb = serverClient();

  const { data: session } = await sb
    .from('sessions')
    .select('id, bundle_path, page_count, status, client_name, client_dob, client_ref, client_notes')
    .eq('id', sessionId)
    .single();
  if (!session?.bundle_path || !session.page_count) {
    return NextResponse.json({ error: 'session is not ready' }, { status: 409 });
  }

  // --------------------------------------------------------- claim a job
  // Strictly in phase order: a categorise job must not run before the taxonomy
  // it files against exists.
  let claimed: ClaimedJob | null = null;

  for (const kind of ORDER) {
    const { data: outstanding } = await sb
      .from('jobs')
      .select('id', { count: 'exact', head: false })
      .eq('session_id', sessionId)
      .eq('kind', kind)
      .in('status', ['pending', 'running'])
      .limit(1);
    if (!outstanding?.length) continue;

    const { data: candidates } = await sb
      .from('jobs')
      .select('id, kind, window_start, window_end, proposal_id, doc_key, attempts')
      .eq('session_id', sessionId)
      .eq('kind', kind)
      .eq('status', 'pending')
      .order('window_start', { nullsFirst: true })
      .limit(4);

    for (const c of candidates ?? []) {
      // Guarding the update on status='pending' makes the claim atomic: a
      // racing tick updates zero rows and moves on to the next candidate.
      const { data: got } = await sb
        .from('jobs')
        .update({ status: 'running', attempts: c.attempts + 1 })
        .eq('id', c.id)
        .eq('status', 'pending')
        .select('id, kind, window_start, window_end, proposal_id, doc_key');
      if (got?.length) {
        claimed = got[0] as ClaimedJob;
        break;
      }
    }

    // This phase still has work, even if we could not claim any of it; do not
    // fall through to a later phase.
    break;
  }

  if (claimed) {
    try {
      if (claimed.kind === 'classify') {
        await runClassify(sb, sessionId, session.bundle_path, claimed);
      } else if (claimed.kind === 'taxonomy') {
        await runTaxonomy(sb, sessionId, claimed.id);
      } else if (claimed.kind === 'group') {
        await runGrouping(sb, sessionId, session.page_count, claimed.id, {
          name: session.client_name,
          dob: session.client_dob,
        });
      } else {
        await runCategorise(sb, sessionId, session.bundle_path, claimed, {
          name: session.client_name,
          dob: session.client_dob,
          ref: session.client_ref,
          notes: session.client_notes,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const { data: j } = await sb
        .from('jobs')
        .select('attempts')
        .eq('id', claimed.id)
        .single();
      // Two shots, then leave it failed. A failed window degrades the split
      // rather than breaking it; a failed categorise leaves one document
      // unidentified and flagged.
      await sb
        .from('jobs')
        .update({ status: (j?.attempts ?? 1) >= 2 ? 'failed' : 'pending', error: msg })
        .eq('id', claimed.id);
      return NextResponse.json({ ok: false, error: msg }, { status: 200 });
    }
  }

  // --------------------------------------------- advance between phases
  const { data: all } = await sb
    .from('jobs')
    .select('kind, status, window_start, window_end, result')
    .eq('session_id', sessionId);

  const jobs = all ?? [];
  const outstanding = (kind: Kind) =>
    jobs.filter((j) => j.kind === kind && (j.status === 'pending' || j.status === 'running'))
      .length;

  // Classification finished and nothing downstream queued yet -> assemble.
  if (
    outstanding('classify') === 0 &&
    jobs.some((j) => j.kind === 'classify') &&
    !jobs.some((j) => j.kind === 'taxonomy')
  ) {
    try {
      await runStitch(sb, sessionId, session.page_count, jobs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sb.from('sessions').update({ status: 'failed', error: msg }).eq('id', sessionId);
      return NextResponse.json({ ok: false, error: msg }, { status: 200 });
    }
  }

  // Every document now knows what it is, so same-category documents can be
  // gathered. Queued as a job so it is claimed exactly once.
  if (
    outstanding('categorise') === 0 &&
    jobs.some((j) => j.kind === 'categorise') &&
    !jobs.some((j) => j.kind === 'group')
  ) {
    await sb.from('jobs').insert({ session_id: sessionId, kind: 'group' });
    jobs.push({ kind: 'group', status: 'pending', window_start: null, window_end: null, result: null });
  }

  const remaining =
    outstanding('classify') +
    outstanding('taxonomy') +
    outstanding('categorise') +
    outstanding('group');

  if (remaining === 0 && session.status === 'processing') {
    await sb.from('sessions').update({ status: 'proposed' }).eq('id', sessionId);
  }

  return NextResponse.json({
    ok: true,
    idle: !claimed && remaining === 0,
    done: jobs.filter((j) => j.status === 'done').length,
    remaining,
    total: jobs.length,
  });
}

/* ------------------------------------------------------------------ work */

async function runClassify(
  sb: SupabaseClient,
  sessionId: string,
  bundlePath: string,
  job: { id: string; window_start: number | null; window_end: number | null },
) {
  const bundle = await fetchBundle(sb, bundlePath);
  const { base64, pageNumbers, rotationsCleared } = await sliceForModel(
    bundle,
    job.window_start!,
    job.window_end!,
  );

  const { data: pageRows } = await sb
    .from('pages')
    .select('page_number, text, has_text_layer')
    .eq('session_id', sessionId)
    .gte('page_number', job.window_start!)
    .lte('page_number', job.window_end!);

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
    .eq('id', job.id);
}

async function runTaxonomy(sb: SupabaseClient, sessionId: string, jobId: string) {
  const proposal = await loadProposal(sb, sessionId);
  if (!proposal) throw new Error('no proposal to derive a taxonomy from');

  const { categories, usage } = await deriveAndStoreTaxonomy(
    sb,
    sessionId,
    proposal.docs,
  );

  // Now that a taxonomy exists, queue one categorise job per real document.
  // Excluded pages need no categorising: they are already accounted for.
  const targets = proposal.docs.filter((d) => !d.excluded);
  if (targets.length) {
    await sb.from('jobs').insert(
      targets.map((d) => ({
        session_id: sessionId,
        kind: 'categorise' as const,
        proposal_id: proposal.id,
        doc_key: d.doc_key,
        window_start: d.pages[0],
        window_end: d.pages[d.pages.length - 1],
      })),
    );
  }

  await sb
    .from('jobs')
    .update({
      status: 'done',
      result: { categories: categories.map((c) => c.name), usage },
    })
    .eq('id', jobId);
}

async function runCategorise(
  sb: SupabaseClient,
  sessionId: string,
  bundlePath: string,
  job: { id: string; proposal_id: string | null; doc_key: string | null },
  client: { name: string | null; dob: string | null; ref: string | null; notes: string | null },
) {
  if (!job.proposal_id || !job.doc_key) throw new Error('categorise job is missing its target');

  const { data: doc } = await sb
    .from('documents')
    .select('id, doc_key, document_pages(page_number, position)')
    .eq('proposal_id', job.proposal_id)
    .eq('doc_key', job.doc_key)
    .single();
  if (!doc) throw new Error(`document ${job.doc_key} no longer exists`);

  const pages = (doc.document_pages as { page_number: number; position: number }[])
    .sort((a, b) => a.position - b.position)
    .map((p) => p.page_number);
  if (!pages.length) throw new Error(`document ${job.doc_key} has no pages`);

  const bundle = await fetchBundle(sb, bundlePath);
  // A page LIST, not a range: a non-contiguous document is sent as exactly its
  // own pages, with any intruding page left out.
  const { base64, pageNumbers, rotationsCleared } = await slicePagesForModel(bundle, pages);

  const { data: pageRows } = await sb
    .from('pages')
    .select('page_number, text, has_text_layer')
    .eq('session_id', sessionId)
    .in('page_number', pages);

  const textByPage = new Map<number, string>();
  for (const r of pageRows ?? []) {
    if (r.has_text_layer && r.text) textByPage.set(r.page_number, r.text);
  }

  const categories = await loadCategories(sb);
  const { meta, usage } = await categoriseDocument({
    pdfBase64: base64,
    pageNumbers,
    rotationsCleared,
    categories,
    textByPage,
    docKey: job.doc_key,
    client,
  });

  // A genuinely new category joins the taxonomy so later documents can use it
  // too, rather than every one of them proposing the same thing separately.
  if (meta.proposed_category && meta.proposed_category_reason) {
    await ensureCategory(sb, {
      name: meta.proposed_category,
      description: meta.proposed_category_reason,
      origin: 'proposed',
      reason: meta.proposed_category_reason,
      sessionId,
      sortOrder: 500,
    });
  }

  // Metadata fills into the existing revision rather than creating a new one.
  // The grouping has not changed — only what we know about each document — and
  // a revision per document would make the history unreadable.
  await sb
    .from('documents')
    .update({
      overview: meta.overview,
      title: meta.title,
      doc_type: meta.doc_type,
      subcategory: meta.subcategory,
      proposed_category: meta.proposed_category,
      proposed_category_reason: meta.proposed_category_reason,
      doc_date: meta.doc_date,
      author: meta.author,
      discipline: meta.discipline,
      org: meta.org,
      relates: meta.relates,
      relates_reason: meta.relates_reason,
      review: meta.review,
      confidence: meta.confidence,
    })
    .eq('id', doc.id);

  await sb.from('jobs').update({ status: 'done', result: { usage } }).eq('id', job.id);
}

async function runGrouping(
  sb: SupabaseClient,
  sessionId: string,
  pageCount: number,
  jobId: string,
  client: { name: string | null; dob: string | null },
) {
  const current = await loadProposal(sb, sessionId);
  if (!current) throw new Error('no proposal to group');

  // Work out who the bundle is about BEFORE grouping anything. Spelling
  // variants of one person collapse here, so "D. Marsh" and "Daniel James
  // Marsh" become one group rather than two, and a differing date of birth
  // always splits — which is what keeps a relative with the same surname from
  // being absorbed into the client.
  const clustered = clusterPeople(
    current.docs.map((d) => ({ ...d })),
    client,
  );

  const clientNamed = !!(client.name ?? '').trim();

  const withPeople = clustered.docs.map((d) => {
    const group = clustered.people.find((p) => p.key === d.person_key);
    const identified = !!group && group.key !== UNIDENTIFIED;

    // Whether a document is the client's is a property of the PERSON, settled
    // once across the whole bundle, not re-argued per document. Clustering sees
    // every mention of a name together, so it has strictly more evidence than
    // any single page did.
    const relates = d.excluded
      ? ('n/a' as const)
      : !clientNamed || !identified
        ? d.relates
        : group.isClient
          ? ('yes' as const)
          : ('no' as const);

    // Drop the per-document "identity uncertain" flag once identity has been
    // settled. Leaving it on every row made the register look like fifteen
    // problems when there was really one answered question — and buried the
    // flags that do need a human.
    const review =
      relates === 'uncertain' || !identified
        ? d.review
        : d.review.filter((f) => f.code !== 'relates_uncertain');

    return { ...d, relates, review };
  });

  const { docs, merged } = groupByCategory(
    withPeople,
    clustered.people.map((p) => p.key),
  );

  // Idempotent by construction: once grouped, every category holds a single
  // document, so a repeat run finds nothing to merge and changes nothing.
  if (!merged.length) {
    await sb.from('jobs').update({ status: 'done', result: { merged: [] } }).eq('id', jobId);
    return;
  }

  const peopleFound = clustered.people.filter((p) => p.docKeys.length > 0);
  const detail = merged
    .map((m) => `${m.from} ${m.category.toLowerCase()} for ${m.person} (${m.pages} pages)`)
    .join('; ');

  const peopleLine =
    peopleFound.length > 1
      ? `Found records for ${peopleFound.length} people: ` +
        peopleFound
          .map((p) => `${p.name}${p.isClient ? ' (the client)' : ''} — ${p.pages.length} pages`)
          .join('; ') + '. '
      : '';

  const saved = await saveRevision(sb, sessionId, docs, {
    origin: 'ai',
    summary: `${peopleLine}Gathered same-category documents: ${detail}.`,
    pageCount,
    parentRevision: current.revision,
  });

  const kept = docs.length - merged.length;
  await sb.from('messages').insert({
    session_id: sessionId,
    role: 'ai',
    content:
      (peopleFound.length > 1
        ? `This bundle contains records for ${peopleFound.length} different people: ` +
          peopleFound
            .map(
              (p) =>
                `${p.name}${p.isClient ? ' (the client)' : ''} on ${p.pages.length} page(s)`,
            )
            .join(', ') +
          `. I have kept them completely separate. `
        : '') +
      `I gathered documents of the same kind together — ${detail}. ` +
      `${kept} document(s) were left on their own. ` +
      `Tell me if you would rather any of them stayed separate.`,
    proposal_revision: saved.revision,
  });

  await sb.from('jobs').update({ status: 'done', result: { merged } }).eq('id', jobId);
}

type JobRow = {
  kind: string;
  status: string;
  window_start: number | null;
  window_end: number | null;
  result: unknown;
};

async function runStitch(
  sb: SupabaseClient,
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
    if (job.kind !== 'classify' || job.status !== 'done' || !job.result) continue;
    const { signals } = job.result as { signals: PageSignals[] };
    const w = { start: job.window_start!, end: job.window_end! };
    for (const s of signals ?? []) {
      if (isAuthoritative(s.page_number, w, windows)) chosen.set(s.page_number, s);
    }
  }

  // Any page no window described still gets a place in the split, flagged,
  // rather than disappearing. Ground rule #1 holds even on failure.
  const missing: number[] = [];
  for (let p = 1; p <= pageCount; p++) {
    if (chosen.has(p)) continue;
    missing.push(p);
    chosen.set(p, {
      page_number: p,
      is_blank: false,
      gist: null,
      org: null,
      doc_date: null,
      patient_name_seen: null,
      page_marker: null,
      has_letterhead: false,
      continues_previous: false,
      continues_confidence: 0,
      review: [
        { code: 'low_confidence', message: 'Automatic reading did not complete for this page' },
      ],
      extracted_text: null,
      confidence: 0,
    });
  }

  const signals = [...chosen.values()].sort((a, b) => a.page_number - b.page_number);
  const { docs, decisions } = stitch(signals);

  const nonContiguous = decisions.filter((d) => !d.contiguous);
  const parts = [
    `Found ${docs.filter((d) => !d.excluded).length} documents across ${pageCount} pages`,
    `${docs.filter((d) => d.excluded).length} page(s) excluded as blank`,
    `${decisions.length} page(s) merged into a preceding document`,
  ];
  if (nonContiguous.length) {
    parts.push(`${nonContiguous.length} page(s) rejoined a document across unrelated pages`);
  }
  if (missing.length) {
    parts.push(`pages ${summariseRuns(missing)} could not be read automatically`);
  }

  const saved = await saveRevision(sb, sessionId, docs, {
    origin: 'ai',
    summary: parts.join('; ') + '.',
    pageCount,
  });

  // One taxonomy job, which will in turn queue the per-document work.
  await sb.from('jobs').insert({
    session_id: sessionId,
    kind: 'taxonomy',
    proposal_id: saved.id,
  });

  await sb.from('messages').insert({
    session_id: sessionId,
    role: 'ai',
    content:
      `I went through all ${pageCount} pages and found ` +
      `${docs.filter((d) => !d.excluded).length} documents. ` +
      (nonContiguous.length
        ? `${nonContiguous.length} page(s) belong to a document they are not next to, ` +
          `which I have joined up. `
        : '') +
      `I am now working out what each one is. Documents I am unsure about will ` +
      `be flagged in the list.`,
    proposal_revision: saved.revision,
  });
}
