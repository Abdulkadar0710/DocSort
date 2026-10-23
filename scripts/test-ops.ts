/**
 * Fast assertions for the op engine and the ground-rule-#1 validator.
 * Run: npx tsx scripts/test-ops.ts
 *
 * These are the cases the DEV bundle's answer key actually contains, so they
 * double as regression tests for the real split.
 */
import { applyOps, naiveProposal, describeOp } from '../lib/proposal/ops';
import { validateProposal, summariseRuns } from '../lib/proposal/validate';
import { diffProposals } from '../lib/proposal/diff';
import type { Op } from '../lib/types';

let pass = 0;
const fails: string[] = [];

function check(name: string, cond: boolean, detail = '') {
  if (cond) pass++;
  else fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const PAGES = 192;

// ---------------------------------------------------------------- baseline
{
  const docs = naiveProposal(PAGES);
  check('naive proposal has one doc per page', docs.length === PAGES);
  const v = validateProposal(docs, PAGES);
  check('naive proposal is valid', v.ok, v.errors.join('; '));
  check('naive accounts for every page', v.assigned + v.excluded === PAGES);
}

// ------------------------------------------------------- merge (the 29 cases)
{
  // D001 in the answer key is pages 1-2.
  const docs = naiveProposal(PAGES);
  const { docs: after, rejected } = applyOps(docs, [
    { op: 'merge', docs: ['D001', 'D002'] },
  ]);
  check('merge rejected nothing', rejected.length === 0, JSON.stringify(rejected));
  check('merge reduced doc count by one', after.length === PAGES - 1);
  const d1 = after.find((d) => d.doc_key === 'D001')!;
  check('merged doc owns pages 1,2', d1.pages.join() === '1,2', d1.pages.join());
  check('merge keeps proposal valid', validateProposal(after, PAGES).ok);
}

// ------------------------------- NON-CONTIGUOUS: answer-key D058 = {88, 90}
{
  // Page 89 is a different person's pathology results (Kylie Marsh), wedged
  // between the two pages of a physiotherapy report. A start/end range cannot
  // represent this; page membership can.
  const docs = naiveProposal(PAGES);
  const { docs: after, rejected } = applyOps(docs, [
    { op: 'move_pages', pages: [90], to: 'D088' },
  ]);
  check('non-contiguous merge accepted', rejected.length === 0, JSON.stringify(rejected));
  const d = after.find((x) => x.doc_key === 'D088')!;
  check('document owns pages 88 and 90', d.pages.join() === '88,90', d.pages.join());
  const p89 = after.find((x) => x.pages.includes(89))!;
  check('page 89 is still its own document', p89.pages.join() === '89' && p89.doc_key !== 'D088');
  check('non-contiguous split stays valid', validateProposal(after, PAGES).ok);
}

// ------------------------------------------- exclusions (5 blanks in the key)
{
  const docs = naiveProposal(PAGES);
  const { docs: after } = applyOps(docs, [
    { op: 'exclude', pages: [11, 85, 127, 175, 192] },
  ]);
  const v = validateProposal(after, PAGES);
  check('exclusions keep proposal valid', v.ok, v.errors.join('; '));
  check('five pages counted as excluded', v.excluded === 5, String(v.excluded));
  check('remaining pages still assigned', v.assigned === PAGES - 5, String(v.assigned));
  const ex = after.filter((d) => d.excluded);
  check('each blank is its own excluded doc', ex.length === 5);
  check('excluded docs are typed Excluded', ex.every((d) => d.doc_type === 'Excluded'));
}

// ------------------------------------------------------------------- split
{
  const docs = naiveProposal(PAGES);
  // Build a 12-page doc (answer-key D020 = pages 24-35) then split it.
  const merge: Op = { op: 'merge', docs: Array.from({ length: 12 }, (_, i) => `D0${24 + i}`) };
  const { docs: merged } = applyOps(docs, [merge]);
  const big = merged.find((d) => d.pages.includes(24))!;
  check('built a 12-page document', big.pages.length === 12, String(big.pages.length));

  const { docs: split, rejected } = applyOps(merged, [
    { op: 'split', doc: big.doc_key, at_page: 30 },
  ]);
  check('split accepted', rejected.length === 0, JSON.stringify(rejected));
  const head = split.find((d) => d.doc_key === big.doc_key)!;
  const tail = split.find((d) => d.pages[0] === 30)!;
  check('split head is 24-29', head.pages.join() === '24,25,26,27,28,29', head.pages.join());
  check('split tail is 30-35', tail.pages.join() === '30,31,32,33,34,35', tail.pages.join());
  check('split keeps proposal valid', validateProposal(split, PAGES).ok);
  check('split tail flagged for review', tail.review_flags.length > 0);
}

// --------------------------------------------------- reorder (answer-key D086)
{
  const docs = naiveProposal(PAGES);
  const { docs: merged } = applyOps(docs, [
    { op: 'merge', docs: ['D128', 'D129', 'D130', 'D131', 'D132', 'D133'] },
  ]);
  const d = merged.find((x) => x.pages.includes(128))!;
  // The key notes page 6 appears before page 5 in the original.
  const { docs: after, rejected } = applyOps(merged, [
    { op: 'reorder', doc: d.doc_key, order: [128, 129, 130, 131, 133, 132] },
  ]);
  check('reorder accepted', rejected.length === 0, JSON.stringify(rejected));
  const r = after.find((x) => x.doc_key === d.doc_key)!;
  check('page order is respected', r.pages.join() === '128,129,130,131,133,132', r.pages.join());
  check('reorder keeps proposal valid', validateProposal(after, PAGES).ok);
}

// ------------------------------------------------- bad ops must be rejected
{
  const docs = naiveProposal(PAGES);
  const { docs: after, rejected } = applyOps(docs, [
    { op: 'split', doc: 'D001', at_page: 1 },       // not an interior page
    { op: 'merge', docs: ['D001'] },                 // needs two
    { op: 'merge', docs: ['D001', 'D999'] },         // unknown doc
    { op: 'reorder', doc: 'D002', order: [2, 3] },    // not the doc's pages
    { op: 'move_pages', pages: [], to: 'new' },       // no pages
  ]);
  check('all five bad ops rejected', rejected.length === 5, JSON.stringify(rejected.map((r) => r.reason)));
  check('proposal untouched by bad ops', after.length === PAGES);
  check('still valid after bad ops', validateProposal(after, PAGES).ok);
}

// ---------------------------------- manual edit survives a later AI round
{
  // The brief: "a later feedback round must keep earlier manual edits."
  const base = naiveProposal(PAGES);
  const manual = applyOps(base, [{ op: 'merge', docs: ['D005', 'D006'] }]).docs;
  const aiRound = applyOps(manual, [{ op: 'merge', docs: ['D010', 'D011'] }]).docs;
  const kept = aiRound.find((d) => d.doc_key === 'D005')!;
  check('earlier manual merge survived', kept.pages.join() === '5,6', kept.pages.join());
  check('later AI merge also applied', aiRound.find((d) => d.doc_key === 'D010')!.pages.join() === '10,11');
}

// ------------------------------------------------- validator catches damage
{
  const docs = naiveProposal(10);
  const broken = docs.filter((d) => !d.pages.includes(4)); // lose page 4
  const v = validateProposal(broken, 10);
  check('validator catches a missing page', !v.ok && v.missing.join() === '4', JSON.stringify(v));

  const dupe = naiveProposal(10);
  dupe[0].pages = [1, 2]; // page 2 now in two docs
  const v2 = validateProposal(dupe, 10);
  check('validator catches a double-assigned page', !v2.ok && v2.duplicated[0]?.page === 2);
}

// ------------------------------------------------------------------- diff
{
  const before = naiveProposal(20);
  const after = applyOps(before, [
    { op: 'merge', docs: ['D014', 'D015', 'D016'] },
    { op: 'set_meta', doc: 'D014', fields: { title: 'Discharge letter', doc_type: 'Discharge summary' } },
  ]).docs;
  const d = diffProposals(before, after);
  check('diff reports moved pages only', d.movedPages.join() === '15,16', d.movedPages.join());
  check('diff leaves the rest untouched', d.untouchedDocs === 17, String(d.untouchedDocs));
  check('diff names the removed docs', d.changes.some((c) => c.kind === 'removed' && c.doc_key === 'D015'));
}

// ------------------------------------------------------------- formatting
{
  check('run summary collapses ranges', summariseRuns([1, 2, 3, 7, 9, 10]) === '1–3, 7, 9–10', summariseRuns([1, 2, 3, 7, 9, 10]));
  check('op description reads plainly', describeOp({ op: 'exclude', pages: [11] }) === 'Excluded page 11');
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('\nFailures:');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All op-engine and validator assertions hold.\n');
