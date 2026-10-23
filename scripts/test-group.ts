/**
 * Assertions for category grouping.
 *   npx tsx scripts/test-group.ts
 *
 * Modelled on testdata/dummy-12-mixed.pdf: 2 receipts, 1 MRI, 3 x-rays,
 * 1 blood count, 4 prescriptions, and 1 blood sugar result belonging to the
 * client's partner.
 */
import { groupByCategory } from '../lib/proposal/group';
import { clusterPeople } from '../lib/proposal/people';
import { validateProposal } from '../lib/proposal/validate';
import type { ProposalDoc } from '../lib/types';

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) pass++;
  else fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

function doc(
  key: string,
  page: number,
  type: string,
  over: Partial<ProposalDoc> = {},
): ProposalDoc {
  return {
    id: `x:${key}`,
    doc_key: key,
    pages: [page],
    sort_order: 0,
    overview: null,
    title: type,
    doc_type: type,
    subcategory: null,
    proposed_category: null,
    proposed_category_reason: null,
    doc_date: null,
    author: null,
    discipline: null,
    org: null,
    relates: 'yes',
    relates_reason: null,
    person_name: 'Daniel James Marsh',
    person_dob: '14/03/1984',
    person_key: 'daniel-james-marsh-19840314',
    dup_of: null,
    review: [],
    confidence: 0.9,
    excluded: false,
    ...over,
  };
}

const bundle: ProposalDoc[] = [
  doc('D001', 1, 'Receipts', { doc_date: '12/03/2024', org: 'Northbank Medical Centre' }),
  doc('D002', 2, 'Receipts', { doc_date: '18/03/2024', org: 'Westgate Imaging' }),
  doc('D003', 3, 'Imaging Reports', { doc_date: '18/03/2024', subcategory: 'MRI' }),
  doc('D004', 4, 'Imaging Reports', { doc_date: '22/08/2022', subcategory: 'X-ray' }),
  doc('D005', 5, 'Imaging Reports', { doc_date: '05/11/2022', subcategory: 'X-ray' }),
  doc('D006', 6, 'Imaging Reports', { doc_date: '14/06/2023', subcategory: 'X-ray' }),
  doc('D007', 7, 'Pathology Results', { doc_date: '02/02/2024', org: 'Carrick Park Pathology' }),
  doc('D008', 8, 'Prescriptions', { doc_date: '09/08/2022' }),
  doc('D009', 9, 'Prescriptions', { doc_date: '15/11/2022' }),
  doc('D010', 10, 'Prescriptions', { doc_date: '20/01/2023' }),
  doc('D011', 11, 'Prescriptions', { doc_date: '10/03/2024' }),
  // The partner's result: same category and lab as D007, different person.
  doc('D012', 12, 'Pathology Results', {
    doc_date: '02/02/2024',
    org: 'Carrick Park Pathology',
    relates: 'no',
    relates_reason: 'Patient is Kylie Anne Marsh, DOB 21/06/1986',
    person_name: 'Kylie Anne Marsh',
    person_dob: '21/06/1986',
    person_key: 'kylie-anne-marsh-19860621',
  }),
];

const clustered = clusterPeople(bundle.map((d) => ({ ...d })), {
  name: 'Daniel James Marsh',
  dob: '14/03/1984',
});
const { docs, merged } = groupByCategory(
  clustered.docs,
  clustered.people.map((p) => p.key),
);
const byKey = (k: string) => docs.find((d) => d.doc_key === k)!;
const holding = (page: number) => docs.find((d) => d.pages.includes(page))!;

// Five, not four: the partner's result shares the Pathology category but is
// held out, which also leaves the client's own blood count alone in its group.
check('twelve documents become five', docs.length === 5, String(docs.length));
check('three categories were merged', merged.length === 3, JSON.stringify(merged));

check('receipts gathered', holding(1).pages.join() === '1,2', holding(1).pages.join());
check(
  'imaging gathered',
  holding(3).pages.join() === '3,4,5,6',
  holding(3).pages.join(),
);
check(
  'prescriptions gathered',
  holding(8).pages.join() === '8,9,10,11',
  holding(8).pages.join(),
);

// THE RULE THAT MATTERS: the partner's result shares a category and a lab with
// the client's blood count. Merging by category alone would bury it.
check('the other person is NOT merged in', holding(12).pages.join() === '12');
check('the client blood count stays separate', holding(7).pages.join() === '7');
check('the other person keeps its finding', holding(12).relates === 'no');
check(
  'and keeps the reason',
  (holding(12).relates_reason ?? '').includes('Kylie'),
);

check(
  'register is renumbered in page order',
  docs.map((d) => d.doc_key).join() === 'D001,D002,D003,D004,D005',
  docs.map((d) => d.doc_key).join(),
);
check('every page still accounted for', validateProposal(docs, 12).ok);

// Merged metadata should claim only what the whole group agrees on.
check('date becomes a span', byKey('D001').doc_date === '12/03/2024 - 18/03/2024', String(byKey('D001').doc_date));
check('differing organisations collapse to none', byKey('D001').org === null);
check('shared subtype is kept where all agree', holding(8).subcategory === null);
check('provenance recorded in the overview', (holding(3).overview ?? '').includes('3, 4, 5, 6'));

// ---------------------------------------------------------------------------
// PERSON FIRST: two people with prescriptions must never share a group, even
// though the category is identical.
{
  const two = [
    doc('A1', 1, 'Prescriptions', { person_name: 'Daniel James Marsh', person_dob: '14/03/1984', person_key: null }),
    doc('A2', 2, 'Prescriptions', { person_name: 'Daniel Marsh', person_dob: null, person_key: null }),
    doc('A3', 3, 'Prescriptions', { person_name: 'Jason Petrakis', person_dob: '02/09/1979', person_key: null }),
    doc('A4', 4, 'Prescriptions', { person_name: 'Jason Petrakis', person_dob: null, person_key: null }),
  ];
  const c = clusterPeople(two.map((d) => ({ ...d })), { name: 'Daniel James Marsh', dob: '14/03/1984' });
  const { docs: g } = groupByCategory(c.docs, c.people.map((p) => p.key));
  check('two people with the same category stay apart', g.length === 2, String(g.length));
  check('the client group holds pages 1-2', g[0].pages.join() === '1,2', g[0].pages.join());
  check('the other person holds pages 3-4', g[1].pages.join() === '3,4', g[1].pages.join());
  check('client group is listed first', g[0].relates === 'yes');
}

// Documents naming nobody are never swept together.
{
  const anon = [
    doc('B1', 1, 'Notes', { person_name: null, person_key: null }),
    doc('B2', 2, 'Notes', { person_name: null, person_key: null }),
  ];
  const c = clusterPeople(anon.map((d) => ({ ...d })));
  const { docs: g } = groupByCategory(c.docs, c.people.map((p) => p.key));
  check('unidentified documents stay separate', g.length === 2, String(g.length));
}

// ---------------------------------------------------------------------------
// The register reads as whole people: every document of one person together,
// then the next. Interleaving them was the bug that made the sidebar repeat
// the same name down the page.
{
  const mixed = [
    doc('M1', 1, 'Prescriptions', { person_name: 'Daniel James Marsh', person_dob: '14/03/1984', person_key: null }),
    doc('M2', 2, 'Imaging Reports', { person_name: 'Kylie Anne Marsh', person_dob: '21/06/1986', person_key: null }),
    doc('M3', 3, 'Imaging Reports', { person_name: 'Jason Petrakis', person_dob: '02/09/1979', person_key: null }),
    doc('M4', 4, 'Imaging Reports', { person_name: 'Daniel James Marsh', person_dob: '14/03/1984', person_key: null }),
    doc('M5', 5, 'Prescriptions', { person_name: 'Kylie Anne Marsh', person_dob: '21/06/1986', person_key: null }),
    doc('M6', 6, 'Prescriptions', { person_name: 'Jason Petrakis', person_dob: '02/09/1979', person_key: null }),
  ];
  const c = clusterPeople(mixed.map((d) => ({ ...d })), {
    name: 'Daniel James Marsh',
    dob: '14/03/1984',
  });
  const { docs: g } = groupByCategory(c.docs, c.people.map((p) => p.key));

  const order = g.map((d) => d.person_name);
  const blocks = order.filter((n, i) => i === 0 || n !== order[i - 1]);
  check(
    'each person appears as one unbroken block',
    blocks.length === new Set(blocks).size,
    order.join(' | '),
  );
  check('the client leads the register', g[0].person_name === 'Daniel James Marsh', String(g[0].person_name));
  check('keys run in register order', g.map((d) => d.doc_key).join() === 'D001,D002,D003,D004,D005,D006');

  // Colour is assigned from PAGE order, so neighbours in the preview differ
  // even though the register is ordered by person.
  const byPage = [...g].sort((a, b) => Math.min(...a.pages) - Math.min(...b.pages));
  const adjacentClash = byPage.some((d, i) => i > 0 && (i % 8) === ((i - 1) % 8));
  check('page-adjacent documents never share a colour slot', !adjacentClash);
}

// A single document in its own category is left exactly as it was.
{
  const { docs: only, merged: m } = groupByCategory([doc('D001', 1, 'Receipts')]);
  check('a lone document is untouched', only.length === 1 && m.length === 0);
}

// Blank pages are never swept into a category.
{
  const { docs: withBlank } = groupByCategory([
    doc('D001', 1, 'Receipts'),
    doc('D002', 2, 'Receipts'),
    doc('D003', 3, 'Excluded', { excluded: true, relates: 'n/a' }),
  ]);
  check('blank page stays its own document', withBlank.find((d) => d.pages.includes(3))!.pages.join() === '3');
  check('blank page stays excluded', withBlank.find((d) => d.pages.includes(3))!.excluded);
}

// A suspected copy stays separate so it can be compared.
{
  const { docs: withCopy } = groupByCategory([
    doc('D001', 1, 'Reports'),
    doc('D002', 2, 'Reports', {
      review: [{ code: 'possible_copy', message: 'Looks like a file copy of D001' }],
    }),
  ]);
  check('a possible copy is not absorbed', withCopy.length === 2, String(withCopy.length));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('Category grouping behaves correctly.\n');
