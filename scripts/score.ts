/**
 * Score a session's split against the client's own answer key.
 *
 *   npx tsx scripts/score.ts <session-id> [--key path/to/Unbundle_Dev_Answer_Key.csv]
 *
 * The answer key assigns all 192 pages exactly once, so this is a genuine
 * comparison rather than a spot check. The headline number to beat is the naive
 * baseline: because 103 of the key's 132 documents are single-page, treating
 * every page as its own document already matches 103 of them exactly.
 */
import { readFile } from 'node:fs/promises';

interface GoldDoc {
  id: string;
  pages: number[];
  type: string;
  desc: string;
  date: string;
  author: string;
  org: string;
  relates: string;
  dup: string;
  review: string;
}

interface PredDoc {
  doc_key: string;
  pages: number[];
  doc_type: string | null;
  doc_date: string | null;
  author: string | null;
  org: string | null;
  relates: string;
  dup_of: string | null;
  review_flags: string[];
  excluded: boolean;
  title: string | null;
}

/** Minimal CSV reader — the answer key quotes fields containing commas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

function expandPages(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const t = part.trim();
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(t);
    if (range) {
      for (let p = Number(range[1]); p <= Number(range[2]); p++) out.push(p);
    } else if (/^\d+$/.test(t)) out.push(Number(t));
  }
  return out;
}

const norm = (s: string | null | undefined) =>
  (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Lenient field match: unknown on both sides counts as agreement, and one
 *  string containing the other counts (e.g. "Dr Anil Mehta" vs "Anil Mehta"). */
function fieldMatch(pred: string | null, gold: string): 'hit' | 'miss' | 'bothUnknown' {
  const p = norm(pred);
  const g = norm(gold);
  const pUnknown = !p || p === 'unknown';
  const gUnknown = !g || g === 'unknown' || g === '—';
  if (pUnknown && gUnknown) return 'bothUnknown';
  if (pUnknown || gUnknown) return 'miss';
  return p === g || p.includes(g) || g.includes(p) ? 'hit' : 'miss';
}

async function main() {
  const argv = process.argv.slice(2);
  const sessionId = argv.find((a) => !a.startsWith('--'));
  if (!sessionId) {
    console.error('usage: tsx scripts/score.ts <session-id> [--key <csv>] [--base <url>]');
    process.exit(1);
  }
  const keyIdx = argv.indexOf('--key');
  const baseIdx = argv.indexOf('--base');
  const keyPath =
    keyIdx >= 0
      ? argv[keyIdx + 1]
      : '../OneDrive_2_23-10-2026/Unbundle_Dev_Answer_Key.csv';
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : 'http://localhost:3000';

  // ------------------------------------------------------------ load gold
  const rows = parseCsv(await readFile(keyPath, 'utf8'));
  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const gold: GoldDoc[] = rows.slice(1).map((r) => ({
    id: r[col('id')],
    pages: expandPages(r[col('pages')]),
    type: r[col('type')] ?? '',
    desc: r[col('desc')] ?? '',
    date: r[col('date')] ?? '',
    author: r[col('author')] ?? '',
    org: r[col('org')] ?? '',
    relates: (r[col('relates')] ?? '').trim(),
    dup: (r[col('dup')] ?? '').trim(),
    review: (r[col('review')] ?? '').trim(),
  }));

  // ------------------------------------------------------- load prediction
  const res = await fetch(`${base}/api/sessions/${sessionId}`);
  if (!res.ok) throw new Error(`could not load session: ${await res.text()}`);
  const data = await res.json();
  if (!data.proposal) throw new Error('this session has no proposal');
  const pred: PredDoc[] = data.proposal.docs;
  const pageCount: number = data.session.page_count;

  console.log(`\nBundle: ${data.session.name} — ${pageCount} pages`);
  console.log(`Proposal: revision ${data.proposal.revision}, ${pred.length} documents`);
  console.log(`Answer key: ${gold.length} documents\n`);

  // ------------------------------------------------- 1. boundary accuracy
  const goldByKey = new Map(gold.map((g) => [g.pages.join(','), g]));
  const predKeys = pred.map((p) => p.pages.join(','));
  const exact = predKeys.filter((k) => goldByKey.has(k)).length;

  const baseline = gold.filter((g) => g.pages.length === 1).length;

  console.log('── Boundaries ──────────────────────────────────────────');
  console.log(`  Exact page-set matches : ${exact} / ${gold.length}  (${pct(exact, gold.length)})`);
  console.log(`  Naive baseline to beat : ${baseline} / ${gold.length}  (${pct(baseline, gold.length)})`);
  console.log(`  Precision              : ${pct(exact, pred.length)} of ${pred.length} proposed`);

  // Pair each gold doc with the predicted doc it overlaps most, for field scoring.
  const pairs: { g: GoldDoc; p: PredDoc }[] = [];
  for (const g of gold) {
    let best: PredDoc | null = null;
    let bestOverlap = 0;
    for (const p of pred) {
      const overlap = p.pages.filter((x) => g.pages.includes(x)).length;
      if (overlap > bestOverlap) { bestOverlap = overlap; best = p; }
    }
    if (best) pairs.push({ g, p: best });
  }

  // --------------------------------------------------------- 2. the fields
  console.log('\n── Identified details (on best-overlap pairs) ──────────');
  for (const [label, get] of [
    ['Type  ', (x: { g: GoldDoc; p: PredDoc }) => [x.p.doc_type, x.g.type]],
    ['Date  ', (x: { g: GoldDoc; p: PredDoc }) => [x.p.doc_date, x.g.date]],
    ['Author', (x: { g: GoldDoc; p: PredDoc }) => [x.p.author, x.g.author]],
    ['Org   ', (x: { g: GoldDoc; p: PredDoc }) => [x.p.org, x.g.org]],
  ] as const) {
    let hit = 0, both = 0, miss = 0;
    for (const pair of pairs) {
      const [p, g] = get(pair) as [string | null, string];
      const r = fieldMatch(p, g);
      if (r === 'hit') hit++; else if (r === 'bothUnknown') both++; else miss++;
    }
    console.log(
      `  ${label} : ${pct(hit + both, pairs.length)} agree  ` +
        `(${hit} matched, ${both} unknown on both sides, ${miss} wrong)`,
    );
  }

  // ------------------------------------------------------- 3. the edge cases
  const goldExcluded = gold.filter((g) => g.type === 'Excluded');
  const predExcludedPages = new Set(pred.filter((p) => p.excluded).flatMap((p) => p.pages));
  const excludedHit = goldExcluded.filter((g) =>
    g.pages.every((p) => predExcludedPages.has(p)),
  ).length;

  const goldDups = gold.filter((g) => g.dup);
  const predDupPages = new Set(pred.filter((p) => p.dup_of).flatMap((p) => p.pages));
  const dupHit = goldDups.filter((g) => g.pages.some((p) => predDupPages.has(p))).length;

  const goldOther = gold.filter((g) => g.relates === 'no' || g.relates === 'uncertain');
  const predNotClientPages = new Set(
    pred.filter((p) => p.relates === 'no' || p.relates === 'uncertain').flatMap((p) => p.pages),
  );
  const otherHit = goldOther.filter((g) =>
    g.pages.some((p) => predNotClientPages.has(p)),
  ).length;

  const goldReview = gold.filter((g) => g.review);
  const predFlagPages = new Set(
    pred.filter((p) => p.review_flags.length).flatMap((p) => p.pages),
  );
  const reviewHit = goldReview.filter((g) =>
    g.pages.some((p) => predFlagPages.has(p)),
  ).length;

  console.log('\n── The cases that matter ───────────────────────────────');
  console.log(`  Blank pages excluded    : ${excludedHit} / ${goldExcluded.length}`);
  console.log(`  Duplicates caught       : ${dupHit} / ${goldDups.length}`);
  console.log(`  Not/maybe client caught : ${otherHit} / ${goldOther.length}`);
  console.log(`  Review-flagged caught   : ${reviewHit} / ${goldReview.length}`);

  // -------------------------------------------- 4. named regression cases
  console.log('\n── Specific regressions ────────────────────────────────');
  const nonContig = gold.find((g) => g.id === 'D058');
  if (nonContig) {
    const hit = pred.some(
      (p) => p.pages.join(',') === nonContig.pages.join(','),
    );
    console.log(
      `  D058 non-contiguous (pages ${nonContig.pages.join(', ')}) : ${hit ? 'MATCHED' : 'missed'}`,
    );
  }
  const partner = gold.find((g) => g.id === 'D059');
  if (partner) {
    const owner = pred.find((p) => p.pages.includes(partner.pages[0]));
    // Must be an explicit call. "unknown" is the un-run default, and counting
    // it as a catch would report a pass the system has not earned.
    const flagged = owner?.relates === 'no' || owner?.relates === 'uncertain';
    console.log(
      `  D059 partner's pathology (page ${partner.pages[0]}) flagged : ${flagged ? 'YES' : 'no'}`,
    );
  }

  // ------------------------------------------------------- 5. honesty check
  const unknownFields = pred.reduce(
    (n, p) =>
      n +
      [p.doc_type, p.doc_date, p.author, p.org].filter((f) => !f || f === 'unknown').length,
    0,
  );
  console.log('\n── Honesty ─────────────────────────────────────────────');
  console.log(
    `  Fields left unknown : ${unknownFields} of ${pred.length * 4}  ` +
      `(${pct(unknownFields, pred.length * 4)}) — should be non-zero; the key has unknowns too`,
  );

  const v = data.validation;
  console.log(
    `  Page accounting     : ${v?.ok ? `OK — ${v.assigned + v.excluded}/${v.pageCount}` : `BROKEN — ${v?.errors.join('; ')}`}`,
  );
  console.log('');
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
