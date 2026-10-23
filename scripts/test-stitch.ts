/**
 * Assertions for Pass B, the deterministic grouping step.
 *   npx tsx scripts/test-stitch.ts
 *
 * Every case here is one the DEV bundle actually contains, and two of them are
 * regressions from real failures seen on live runs.
 */
import { stitch } from '../lib/ai/passB';
import type { PageSignals } from '../lib/types';

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) pass++;
  else fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

function page(n: number, over: Partial<PageSignals> = {}): PageSignals {
  return {
    page_number: n,
    is_blank: false,
    gist: null,
    org: null,
    doc_date: null,
    patient_name_seen: null,
    page_marker: null,
    has_letterhead: false,
    continues_previous: false,
    continues_confidence: 0,
    review: [],
    extracted_text: null,
    confidence: 0.9,
    ...over,
  };
}

const pagesOf = (docs: ReturnType<typeof stitch>['docs'], p: number) =>
  docs.find((d) => d.pages.includes(p))!.pages.join(',');

// ---------------------------------------------------------------------------
// REGRESSION: a two-page incident report whose page 2 is signed by different
// people. Pass A reports EVERY name on a page, so page 2 named the supervisor
// and WHS coordinator rather than the claimant. An earlier version ran the
// person-name check before the page-marker check, and this conclusive
// "page 1 of 2 -> page 2 of 2" lost to a false identity conflict.
{
  const { docs } = stitch([
    page(8, {
      page_marker: { n: 1, of: 2 },
      has_letterhead: true,
      org: 'Brightline Logistics Pty Ltd',
      doc_date: '08/08/2022',
      patient_name_seen: 'Daniel James Marsh, Craig Dunlop, Liam Turner',
    }),
    page(9, {
      page_marker: { n: 2, of: 2 },
      continues_previous: true,
      continues_confidence: 0.98,
      org: 'Brightline Logistics Pty Ltd',
      doc_date: '08/08/2022',
      patient_name_seen: 'Craig Dunlop, Megan Ross',
    }),
  ]);
  check('page 1 of 2 and page 2 of 2 merge', docs.length === 1, pagesOf(docs, 8));
  check('signatories do not veto a page marker', pagesOf(docs, 8) === '8,9');
}

// ---------------------------------------------------------------------------
// A genuinely different person must still block a merge. The client's partner
// shares his surname and address, which is exactly the trap.
{
  const { docs } = stitch([
    page(88, {
      continues_previous: false,
      org: 'Harbour Physio',
      patient_name_seen: 'Daniel James Marsh',
    }),
    page(89, {
      continues_previous: true,
      continues_confidence: 0.9,
      org: 'Harbour Physio',
      patient_name_seen: 'Kylie Anne Marsh',
    }),
  ]);
  check('a different person blocks the merge', docs.length === 2, pagesOf(docs, 88));
  check('shared surname is not a shared person', pagesOf(docs, 89) === '89');
}

// A fuller form of the same name is the same person and must not block.
{
  const { docs } = stitch([
    page(1, { patient_name_seen: 'Daniel James Marsh' }),
    page(2, {
      continues_previous: true,
      continues_confidence: 0.9,
      patient_name_seen: 'Daniel Marsh',
    }),
  ]);
  check('"Daniel Marsh" matches "Daniel James Marsh"', docs.length === 1, pagesOf(docs, 1));
}

// ---------------------------------------------------------------------------
// NON-CONTIGUOUS: answer-key D058 is pages 88 and 90, with a different
// person's pathology results at 89.
{
  const { docs, decisions } = stitch([
    page(88, {
      page_marker: { n: 1, of: 2 },
      org: 'Harbour Physio',
      patient_name_seen: 'Daniel James Marsh',
    }),
    page(89, {
      has_letterhead: true,
      org: 'Meridian Pathology',
      patient_name_seen: 'Kylie Anne Marsh',
    }),
    page(90, {
      page_marker: { n: 2, of: 2 },
      org: 'Harbour Physio',
      patient_name_seen: 'Daniel James Marsh',
    }),
  ]);
  check('document rejoins across the intruder', pagesOf(docs, 88) === '88,90', pagesOf(docs, 88));
  check('the intruding page stays separate', pagesOf(docs, 89) === '89');
  check('the rejoin is recorded as non-contiguous', decisions.some((d) => !d.contiguous));
}

// ---------------------------------------------------------------------------
// A fresh letterhead starts a new document even when the page looks continuous.
{
  const { docs } = stitch([
    page(1, { org: 'Northbank Medical Centre' }),
    page(2, {
      has_letterhead: true,
      continues_previous: true,
      continues_confidence: 0.8,
      org: 'Westgate Imaging',
    }),
  ]);
  check('a new letterhead starts a new document', docs.length === 2);
}

// Low-confidence continuation is not acted on: a missed merge is one click,
// a wrong merge hides a document.
{
  const { docs } = stitch([
    page(1, {}),
    page(2, { continues_previous: true, continues_confidence: 0.4 }),
  ]);
  check('weak continuation does not merge', docs.length === 2);
}

// ---------------------------------------------------------------------------
// Blank pages are excluded and never absorb or get absorbed.
{
  const { docs } = stitch([
    page(10, {}),
    page(11, { is_blank: true }),
    page(12, { continues_previous: true, continues_confidence: 0.99 }),
  ]);
  check('blank page is its own document', pagesOf(docs, 11) === '11');
  check('blank page is marked excluded', docs.find((d) => d.pages.includes(11))!.excluded);
  check('a page after a blank does not merge through it', pagesOf(docs, 12) === '12');
}

// An incomplete run is flagged rather than silently accepted.
{
  const { docs } = stitch([
    page(1, { page_marker: { n: 1, of: 3 }, org: 'X' }),
    page(2, { page_marker: { n: 2, of: 3 }, org: 'X' }),
  ]);
  const d = docs.find((x) => x.pages.includes(1))!;
  check('short run flagged missing_pages', d.review.some((f) => f.code === 'missing_pages'));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('Pass B grouping behaves correctly.\n');
