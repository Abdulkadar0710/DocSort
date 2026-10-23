/**
 * Assertions for person clustering.
 *   npx tsx scripts/test-people.ts
 */
import {
  clusterPeople,
  normaliseDob,
  personFolder,
  samePerson,
  UNIDENTIFIED,
} from '../lib/proposal/people';

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) pass++;
  else fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

// ----------------------------------------------------------------- matching
check('identical names match', samePerson({ name: 'Daniel James Marsh', dob: null }, { name: 'Daniel James Marsh', dob: null }));
check('fuller form matches shorter', samePerson({ name: 'Daniel Marsh', dob: null }, { name: 'Daniel James Marsh', dob: null }));
check('surname-first form matches', samePerson({ name: 'MARSH, Daniel James', dob: null }, { name: 'Daniel James Marsh', dob: null }));
check('titles are ignored', samePerson({ name: 'Mr Daniel Marsh', dob: null }, { name: 'Daniel Marsh', dob: null }));

// The case the whole feature exists for.
check(
  'same surname, different given name is a different person',
  !samePerson({ name: 'Daniel James Marsh', dob: null }, { name: 'Kylie Anne Marsh', dob: null }),
);
check(
  'a differing date of birth always splits, whatever the name',
  !samePerson(
    { name: 'Daniel James Marsh', dob: '14/03/1984' },
    { name: 'Daniel James Marsh', dob: '02/11/1979' },
  ),
);
check(
  'a matching date of birth rescues a bare surname',
  samePerson({ name: 'D Marsh', dob: '14/03/1984' }, { name: 'Marsh', dob: '14/03/1984' }),
);
check('an empty name never matches', !samePerson({ name: null, dob: '14/03/1984' }, { name: 'Daniel Marsh', dob: '14/03/1984' }));

check('dob normalises from DD/MM/YYYY', normaliseDob('14/03/1984') === '19840314');
check('dob normalises from ISO', normaliseDob('1984-03-14') === '19840314');
check('nonsense dob is null', normaliseDob('circa 1984') === null);

// ---------------------------------------------------------------- the story
// 15 documents, 5 each for three people — the scenario as described.
const doc = (key: string, page: number, name: string | null, dob: string | null) => ({
  doc_key: key,
  pages: [page],
  person_name: name,
  person_dob: dob,
});

const CLIENT = { name: 'Daniel James Marsh', dob: '14/03/1984' };

const bundle = [
  doc('D001', 1, 'Daniel James Marsh', '14/03/1984'),
  doc('D002', 2, 'Kylie Anne Marsh', '21/06/1986'),
  doc('D003', 3, 'Jason Petrakis', '02/09/1979'),
  doc('D004', 4, 'D. Marsh', '14/03/1984'),        // initialised client
  doc('D005', 5, 'MARSH, Kylie Anne', null),        // surname-first partner
  doc('D006', 6, 'Jason Petrakis', null),
  doc('D007', 7, 'Daniel Marsh', null),             // shorter client
  doc('D008', 8, 'Kylie Anne Marsh', '21/06/1986'),
  doc('D009', 9, 'Jason Petrakis', '02/09/1979'),
  doc('D010', 10, null, null),                      // continuation page
  doc('D011', 11, 'Daniel James Marsh', '14/03/1984'),
  doc('D012', 12, 'Kylie Anne Marsh', null),
  doc('D013', 13, 'Mr Jason Petrakis', '02/09/1979'),
  doc('D014', 14, 'Daniel James Marsh', null),
  doc('D015', 15, null, null),                      // unsigned note
];

const { docs, people } = clusterPeople(bundle, CLIENT);

check('four groups: three people and the unidentified', people.length === 4, String(people.length));
check('the client comes first', people[0].isClient && people[0].name.includes('Daniel'));
check('unidentified comes last', people[people.length - 1].key === UNIDENTIFIED);
check('only one group is the client', people.filter((p) => p.isClient).length === 1);

const byName = (needle: string) => people.find((p) => p.name.includes(needle))!;
check('client has five documents', byName('Daniel').docKeys.length === 5, byName('Daniel').docKeys.join());
// 15 documents split 5 / 4 / 4, with 2 that name nobody.
check('partner has four documents', byName('Kylie').docKeys.length === 4, byName('Kylie').docKeys.join());
check('third person has four documents', byName('Petrakis').docKeys.length === 4, byName('Petrakis').docKeys.join());
check('two documents are unidentified', people[3].docKeys.join() === 'D010,D015', people[3].docKeys.join());

check(
  'spelling variants collapsed into the client',
  ['D001', 'D004', 'D007', 'D011', 'D014'].every(
    (k) => docs.find((d) => d.doc_key === k)!.person_key === docs.find((d) => d.doc_key === 'D001')!.person_key,
  ),
);
check(
  'partner never merges into the client',
  docs.find((d) => d.doc_key === 'D002')!.person_key !==
    docs.find((d) => d.doc_key === 'D001')!.person_key,
);
check('the fullest spelling is used as the label', byName('Kylie').name === 'Kylie Anne Marsh', byName('Kylie').name);
check('every document is assigned', docs.every((d) => !!d.person_key));
check(
  'pages add up',
  people.reduce((n, p) => n + p.pages.length, 0) === 15,
);

// ------------------------------------------------------------------ folders
check('folder name is safe', personFolder(byName('Daniel')) === 'Daniel-James-Marsh', personFolder(byName('Daniel')));
check('unidentified gets its own folder', personFolder(people[3]) === 'Unidentified-person');

// No client named: nobody is marked as one, and the bundle still clusters.
{
  const { people: anon } = clusterPeople(bundle);
  check('with no client named, none is marked', anon.every((p) => !p.isClient));
  check('and the people are still found', anon.length === 4);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('Person clustering behaves correctly.\n');
