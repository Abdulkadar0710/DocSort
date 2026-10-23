/**
 * Assertions for person clustering.
 *   npx tsx scripts/test-people.ts
 */
import {
  clusterPeople,
  matchTier,
  MATCH_EXACT,
  MATCH_NEAR,
  MATCH_SPELLING,
  NO_MATCH,
  normaliseDob,
  parseName,
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

// ------------------------------------------------- spelling and relationships
//
// One person, several spellings. Transliteration varies, scanners drop
// letters, and some records name somebody only by their relationship to
// somebody else. Each must reach the client typed at the start of the session.

const gauri = { name: 'Gauri Solanki', dob: null };
const tier = (n: string, dob: string | null = null) => matchTier(gauri, { name: n, dob });

check('an identical name is an exact match', tier('Gauri Solanki') === MATCH_EXACT);
check('surname-first still exact', tier('SOLANKI, Gauri') === MATCH_EXACT);
check('a transliteration variant matches on spelling', tier('Gouri Solanki') === MATCH_SPELLING, String(tier('Gouri Solanki')));
check('another vowel variant matches on spelling', tier('Gowri Solanki') === MATCH_SPELLING);
check('a dropped letter in both parts is a near miss', tier('Gori Solank') === MATCH_NEAR, String(tier('Gori Solank')));

// The defect this feature exists to fix: "w/o" means wife of, so the subject
// is the name BEFORE it. Reading the whole phrase as one name matched the
// husband better than the wife and filed her records under him.
check(
  'a relationship marker resolves to the subject',
  parseName('Gouri w/o Amit Solanki').subject.join(' ') === 'gouri solanki',
  parseName('Gouri w/o Amit Solanki').subject.join(' '),
);
check('the relative is kept separately', parseName('Gouri w/o Amit Solanki').relative.join(' ') === 'amit solanki');
check('"wife of" spelled out works too', parseName('Gouri wife of Amit Solanki').subject.join(' ') === 'gouri solanki');
check('s/o resolves to the son', parseName('Rahul s/o Amit Solanki').subject.join(' ') === 'rahul solanki');
check('a name with no marker is unchanged', parseName('Amit Solanki').subject.join(' ') === 'amit solanki');
check('the subject matches the client', tier('Gouri w/o Amit Solanki') === MATCH_SPELLING, String(tier('Gouri w/o Amit Solanki')));
check(
  'and does NOT match the husband named in it',
  matchTier({ name: 'Gouri w/o Amit Solanki', dob: null }, { name: 'Amit Solanki', dob: null }) === NO_MATCH,
);

// Loosening on spelling must not loosen on identity.
check('a different given name is a different person', tier('Amit Solanki') === NO_MATCH);
check('a surname two letters out is a different family', tier('Gauri Solankar') === NO_MATCH);
check('an unrelated surname never matches', tier('Gauri Sharma') === NO_MATCH);
check('Marsh is not Marsden', matchTier({ name: 'Daniel Marsh', dob: null }, { name: 'Daniel Marsden', dob: null }) === NO_MATCH);

// A date of birth outranks spelling in both directions.
// A date of birth on one side only is not a disagreement. Most pages print
// no date of birth at all, and treating an absent one as a conflict would
// split nearly every person in the bundle.
check('a date of birth on one side only changes nothing', tier('Gori Solank', '01/02/1990') === MATCH_NEAR);
check(
  'a date of birth on both sides promotes a near miss out of flagging',
  matchTier({ name: 'Gauri Solanki', dob: '01/02/1990' }, { name: 'Gori Solank', dob: '01/02/1990' }) === MATCH_SPELLING,
);
check(
  'a differing date of birth splits even an identical name',
  matchTier({ name: 'Gauri Solanki', dob: '01/02/1990' }, { name: 'Gauri Solanki', dob: '03/04/1985' }) === NO_MATCH,
);

// Clustering end to end: the variants collapse, the husband does not.
const spelt = clusterPeople(
  [
    { doc_key: 'D001', pages: [1], person_name: 'Gauri Solanki', person_dob: null },
    { doc_key: 'D002', pages: [2], person_name: 'Gori Solank', person_dob: null },
    { doc_key: 'D003', pages: [3], person_name: 'Gouri w/o Amit Solanki', person_dob: null },
    { doc_key: 'D004', pages: [4], person_name: 'Amit Solanki', person_dob: null },
    { doc_key: 'D005', pages: [5], person_name: null, person_dob: null },
  ],
  { name: 'Gauri Solanki', dob: null },
);
const gauriGroup = spelt.people.find((p) => p.isClient)!;
const keyOf = (k: string) => spelt.docs.find((d) => d.doc_key === k)!.person_key;

check('three spellings cluster as one person', gauriGroup.docKeys.join() === 'D001,D002,D003', gauriGroup.docKeys.join());
check('the husband is his own person', keyOf('D004') !== keyOf('D001'));
check('the client keeps the name the reviewer typed', gauriGroup.name === 'Gauri Solanki', gauriGroup.name);
check(
  'every variant spelling is recorded',
  gauriGroup.variants.join('; ') === 'Gori Solank; Gouri w/o Amit Solanki',
  gauriGroup.variants.join('; '),
);
check('three groups: the client, the husband and the unidentified', spelt.people.length === 3, String(spelt.people.length));

// Only the genuinely doubtful merge is flagged. Flagging the transliteration
// variant too would bury it: a bundle of forty such pages would flag all forty.
const tierOf = (k: string) => spelt.docs.find((d) => d.doc_key === k)!.identity_tier;
check('the exact spelling is not flagged', tierOf('D001') === MATCH_EXACT);
check('the near miss is flagged', tierOf('D002') === MATCH_NEAR, String(tierOf('D002')));
check('the transliteration variant is not flagged', tierOf('D003') === MATCH_SPELLING, String(tierOf('D003')));

// A client nobody matched must not leave an empty group in the register.
const absent = clusterPeople(
  [{ doc_key: 'D001', pages: [1], person_name: 'Amit Solanki', person_dob: null }],
  { name: 'Gauri Solanki', dob: null },
);
check('a client with no documents is not listed', absent.people.length === 1, String(absent.people.length));
check('and nobody is wrongly marked the client', absent.people.every((p) => !p.isClient));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('Person clustering behaves correctly.\n');
