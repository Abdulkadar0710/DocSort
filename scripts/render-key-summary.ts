/**
 * Render our Summary.pdf using the answer key's own 132 rows as the register.
 * If our layout can carry the key accurately, the register format is right.
 *
 * @react-pdf resolves only under a bundler, so run it through esbuild rather
 * than tsx:
 *
 *   npx esbuild scripts/render-key-summary.ts --bundle --platform=node \
 *     --format=esm --external:@react-pdf/renderer --jsx=automatic \
 *     --alias:@=. --outfile=.render-key.mjs && node .render-key.mjs out.pdf
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { renderSummaryPdf } from '@/lib/pdf/summary';
import { validateProposal } from '@/lib/proposal/validate';
import type { ProposalDoc, ReviewFlag } from '@/lib/types';

const csv = readFileSync(
  '/home/gwl/Downloads/October 2026/Hackathon/OneDrive_2_23-10-2026/Unbundle_Dev_Answer_Key.csv',
  'utf8',
);

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift()!;
  return rows.filter((r) => r[0]).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const rows = parseCsv(csv);

function pagesOf(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(',')) {
    const t = part.trim();
    const m = t.match(/^(\d+)-(\d+)$/);
    if (m) for (let n = +m[1]; n <= +m[2]; n++) out.push(n);
    else if (t) out.push(+t);
  }
  return out;
}

const docs: ProposalDoc[] = rows.map((r, i) => {
  const review: ReviewFlag[] = [];
  // Only the key's own `review` column counts as a flag; `note` is the
  // judge's commentary, which we carry as relates_reason instead.
  if (r.review) review.push({ code: 'low_confidence', message: r.review });
  return {
    id: r.id,
    sort_order: i,
    doc_key: r.id,
    pages: pagesOf(r.pages),
    overview: null,
    title: r.desc,
    doc_type: r.type,
    subcategory: null,
    proposed_category: null,
    proposed_category_reason: null,
    doc_date: r.date === '—' ? null : r.date,
    author: r.author,
    discipline: r.discipline === '—' ? null : r.discipline,
    org: r.org === '—' ? null : r.org,
    relates: (r.relates || 'unknown') as ProposalDoc['relates'],
    relates_reason: r.note || null,
    person_name: null,
    person_name_printed: null,
    person_dob: null,
    person_gender: null,
    person_age: null,
    person_patient_id: null,
    person_address: null,
    person_client_confirmed: false,
    person_key: null,
    dup_of: r.dup || null,
    review,
    confidence: null,
    excluded: r.type === 'Excluded',
  };
});

// The key's own fmt column, mapped onto the page-level signal we actually have.
const pageText = new Map<number, { native: boolean; ocrAdded: boolean }>();
for (const r of rows) {
  const native = r.fmt === 'Digital (text layer)';
  for (const p of pagesOf(r.pages)) pageText.set(p, { native, ocrAdded: !native });
}

const validation = validateProposal(docs, 192);
console.log('validation:', validation.ok ? 'OK — 192/192 pages accounted for' : validation.errors);

async function main() {
const bytes = await renderSummaryPdf({
  sessionName: 'Unbundle_Dev_Bundle',
  pageCount: 192,
  docs,
  validation,
  revisions: 1,
  feedbackRounds: 0,
  approvedAt: new Date('2026-10-24T10:00:00Z'),
  ocrPageCount: [...pageText.values()].filter((v) => !v.native).length,
  ocrTextLayerCount: [...pageText.values()].filter((v) => v.ocrAdded).length,
  pageText,
  categories: [...new Set(rows.map((r) => r.type))].map((name, i) => ({
    id: String(i),
    name,
    description: '(from the answer key)',
    short_label: null,
    origin: 'derived' as const,
    reason: null,
    active: true,
    sort_order: i,
  })),
  people: [],
});

const out = process.argv[2] ?? '/tmp/key-summary.pdf';
writeFileSync(out, bytes);
console.log('wrote', out, bytes.length, 'bytes');
}

main();
