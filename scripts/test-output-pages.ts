/**
 * Assertions for output page numbering.
 *   npx tsx scripts/test-output-pages.ts
 */
import { assignOutputPages, formatOutputRange } from '../lib/proposal/outputPages';

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) pass++;
  else fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const doc = (doc_key: string, pages: number[], excluded = false) => ({
  doc_key,
  pages,
  excluded,
});

// The register from the three-person bundle: scattered bundle pages, which the
// output puts back into one run each.
const register = [
  doc('D001', [1, 7]),
  doc('D002', [4, 10]),
  doc('D003', [13]),
  doc('D004', [2]),
  doc('D005', [5, 11]),
  doc('D006', [8]),
  doc('D007', [14]),
  doc('D008', [3]),
  doc('D009', [6, 12]),
  doc('D010', [9]),
  doc('D011', [15]),
];

const out = assignOutputPages(register);

check('D001 takes output pages 1-2', out.get('D001')!.from === 1 && out.get('D001')!.to === 2);
check('D002 follows at 3-4', out.get('D002')!.from === 3 && out.get('D002')!.to === 4);
check('D003 is a single page at 5', out.get('D003')!.from === 5 && out.get('D003')!.to === 5);
check('D004 is at 6', out.get('D004')!.from === 6);
check('D005 takes 7-8', out.get('D005')!.from === 7 && out.get('D005')!.to === 8);
check('the last document ends at 15', out.get('D011')!.to === 15, String(out.get('D011')!.to));

// Nothing may be skipped or double-counted: the output is a complete
// renumbering of everything that gets exported.
{
  const ranges = [...out.values()].sort((a, b) => a.from - b.from);
  const contiguous = ranges.every((r, i) => (i === 0 ? r.from === 1 : r.from === ranges[i - 1].to + 1));
  check('output numbering has no gaps or overlaps', contiguous);
  const total = ranges.reduce((n, r) => n + r.count, 0);
  check('every exported page is numbered once', total === 15, String(total));
}

// Excluded pages are not exported, so they take no output number at all.
{
  const withBlank = [doc('E1', [1]), doc('E2', [2], true), doc('E3', [3])];
  const o = assignOutputPages(withBlank);
  check('an excluded page gets no output number', !o.has('E2'));
  check('numbering closes over the gap', o.get('E3')!.from === 2, String(o.get('E3')?.from));
  check('only exported documents are numbered', o.size === 2);
}

// Order follows the register, which is ordered by person — so output pages
// group a person's records together.
{
  const byPerson = [doc('P1', [9]), doc('P2', [1]), doc('P3', [5])];
  const o = assignOutputPages(byPerson);
  check('register order wins over bundle order', o.get('P1')!.from === 1 && o.get('P2')!.from === 2);
}

check('a range reads naturally', formatOutputRange(out.get('D001')) === 'pages 1–2');
check('a single page reads naturally', formatOutputRange(out.get('D003')) === 'page 5');
check('an unknown document formats to nothing', formatOutputRange(undefined) === '');


// An empty document is never given a number.
check('an empty document is skipped', !assignOutputPages([doc('Z', [])]).has('Z'));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('Output page numbering behaves correctly.\n');
