/**
 * Who a document is about.
 *
 * A bundle routinely contains records for more than one person: a partner's
 * pathology result filed with the client's, another employee's payslip, a
 * different patient with the same surname. Answering only "is this the client?"
 * leaves all of them in one pile, and the reviewer still has to read every one
 * to find out whose it is.
 *
 * So documents carry a person, and people are clustered before anything else is
 * grouped. The clustering rule is deliberately cautious in one direction and
 * generous in the other: a differing date of birth ALWAYS splits two people,
 * while missing identifiers never merge them.
 *
 * Names also arrive spelled several ways for one person — transliteration
 * varies, scanners drop letters, and some records identify somebody by their
 * relationship to somebody else. Matching is therefore tiered rather than
 * yes/no, so a merge that rested on spelling can be marked as such instead of
 * being passed off as a confirmed identity.
 */

export type Gender = 'male' | 'female';

export interface PersonRef {
  name: string | null;
  dob: string | null;
  /** Only ever set from an explicit printed field or title — never guessed
   *  from the given name itself. */
  gender?: Gender | null;
  /** Patient/registration/UHID number, as printed. */
  patientId?: string | null;
  address?: string | null;
  /** Birth year implied by a printed age and the document's own date — not a
   *  date of birth, just loose enough to catch an age that reads decades off,
   *  the way a differing DOB does. */
  approxBirthYear?: number | null;
}

export interface PersonGroup {
  key: string;
  /** The fullest spelling seen, for display. */
  name: string;
  dob: string | null;
  gender?: Gender | null;
  patientId?: string | null;
  address?: string | null;
  approxBirthYear?: number | null;
  isClient: boolean;
  docKeys: string[];
  pages: number[];
  /** Other spellings of this person found in the bundle, as printed. */
  variants: string[];
}

/** The bucket for documents with no readable person — continuation pages,
 *  unsigned notes, blank pages. Never guessed at. */
export const UNIDENTIFIED = 'unidentified';

const TITLES = /\b(mr|mrs|ms|miss|dr|prof|sr|jr|shri|smt|kum)\b/g;

/**
 * "Gouri w/o Amit Solanki" names TWO people: Gouri, whose record this is, and
 * Amit, who is only mentioned to identify her. Indian records commonly use
 * these, and so do hospital notes everywhere in the "c/o" form.
 *
 * Reading the whole string as one name is not merely imprecise, it is wrong in
 * a way that misfiles records: the husband's full name is in there, so the
 * document matches HIM better than it matches her.
 *
 * The slash itself is optional: OCR and manual retyping both drop it as often
 * as not ("Gori Wo Amit"), leaving a bare two-letter word sitting between two
 * names. Requiring the slash missed exactly that case — the whole string fell
 * back to being read as one ungrouped name and matched nobody. A dot is
 * accepted too ("W.O."). This does mean a real surname that happens to be
 * bare "Ho", "So" or "Do" — genuine East Asian surnames — sitting between two
 * other name-like words could be misread as a marker; accepted here because
 * this parser is for Indian medico-legal records, where that marker is common
 * and such surnames are not.
 */
const RELATION = /\b(?:[wsdch]\s*[/.]?\s*o|(?:wife|son|daughter|care|husband)\s+of)\b/;

/**
 * Spelling variants of one name, collapsed.
 *
 * Transliteration from a script that does not map one-to-one onto the Latin
 * alphabet produces families like Gauri / Gouri / Gowri, and aspirated
 * consonants come out as ph, kh, gh, th, dh, bh or not at all. Folding those
 * choices away first means the edit distance below only has to absorb what is
 * genuinely damage — a dropped letter, a scanner's misread — rather than a
 * legitimate difference of opinion about spelling.
 */
const FOLD: [RegExp, string][] = [
  [/ph/g, 'f'], [/kh/g, 'k'], [/gh/g, 'g'], [/th/g, 't'],
  [/dh/g, 'd'], [/bh/g, 'b'], [/ck/g, 'k'], [/sh/g, 's'],
  [/ee|ie|ea/g, 'i'], [/oo|ou|au|aw|ow/g, 'u'], [/ai|ay|ei|ey/g, 'e'],
  [/v/g, 'w'], [/z/g, 's'],
  [/(.)\1+/g, '$1'],
];

export function normaliseName(token: string): string {
  let s = token.toLowerCase();
  for (const [re, to] of FOLD) s = s.replace(re, to);
  return s.replace(/[^a-z]/g, '');
}

/** Levenshtein, two rows. Names are short; this never gets hot. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = [...Array(n + 1).keys()];
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

export interface ParsedName {
  /** The person the record is about. */
  subject: string[];
  /** Anyone named only to identify them — a husband, a parent, a carer. */
  relative: string[];
}

/**
 * "MARSH, Daniel James" -> ["daniel", "james", "marsh"]
 * "Gouri w/o Amit Solanki" -> subject ["gouri", "solanki"], relative ["amit", "solanki"]
 *
 * Where the subject carries no surname of her own — which is the usual shape of
 * these — the surname is inherited from the relative, since that is plainly
 * what the page means. The relative is kept separate and never matched against,
 * so the record cannot drift into his file.
 */
export function parseName(raw: string | null): ParsedName {
  if (!raw) return { subject: [], relative: [] };
  let s = raw.toLowerCase().replace(TITLES, ' ');

  // Surname-first form, as printed on most lab reports.
  if (s.includes(',')) {
    const [surname, rest] = s.split(',', 2);
    s = `${rest} ${surname}`;
  }

  const tokenise = (t: string) =>
    t.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((x) => x.length > 1);

  const marker = RELATION.exec(s);
  if (!marker) return { subject: tokenise(s), relative: [] };

  // A parenthetical aside ("Amit Balasuya (Dhar)") is a note about the
  // relative, not a second surname to borrow — same rule parsePeople applies.
  const subject = tokenise(s.slice(0, marker.index).replace(/\([^)]*\)/g, ''));
  const relative = tokenise(
    s.slice(marker.index + marker[0].length).replace(/\([^)]*\)/g, ''),
  );

  // No surname of her own: take his — but only when he has one to give. A
  // relative reduced to a single token ("S/O Amit 210", the 210 a lab number
  // stripped away above) has no surname either, and borrowing that token
  // manufactures a surname nobody has ("Gouri Amit"), which is worse than
  // leaving her with none: a bare given name still matches the fuller name
  // on file, a fabricated surname does not.
  if (subject.length === 1 && relative.length > 1) {
    subject.push(relative[relative.length - 1]);
  }
  return { subject: subject.length ? subject : relative, relative };
}

/** The tokens a name should be matched on — its subject, not its relatives. */
export function nameTokens(raw: string | null): string[] {
  return parseName(raw).subject;
}

/** Normalise a date of birth to YYYYMMDD, or null if it is not one. */
export function normaliseDob(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  let m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  if (m) return `${m[3]}${m[2].padStart(2, '0')}${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  return null;
}

/** Normalise a printed gender/sex field or title to a plain Male/Female, or
 *  null for anything else (including "unknown" and anything not explicitly
 *  one of the two) — this is never guessed from the given name. */
export function normaliseGender(raw: string | null | undefined): Gender | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (/^m(ale)?$/.test(s) || TITLES_MALE.has(s)) return 'male';
  if (/^f(emale)?$/.test(s) || TITLES_FEMALE.has(s)) return 'female';
  return null;
}

const TITLES_MALE = new Set(['mr', 'shri', 'sri']);
const TITLES_FEMALE = new Set(['mrs', 'ms', 'miss', 'smt', 'kum', 'kumari']);

/** Patient/registration/UHID numbers compared on their digits-and-letters
 *  only, so "UHID-2019/00123" and "uhid 2019 00123" read as the same value —
 *  genuinely different numbers still differ once punctuation is stripped. */
function normaliseId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  return s || null;
}

const ADDRESS_FILLER = new Set([
  'road', 'street', 'st', 'near', 'opp', 'opposite', 'behind', 'house', 'no',
  'ward', 'colony', 'nagar', 'dist', 'district', 'tehsil', 'taluka', 'po',
  'ps', 'pin', 'india', 'the', 'and', 'of',
]);

function addressTokens(raw: string): Set<string> {
  return new Set(
    raw
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !ADDRESS_FILLER.has(t)),
  );
}

/**
 * Two addresses read as the same place once filler words — "road", "near",
 * "dist" — are stripped out: what is left (house/plot numbers, street and
 * area names) overlaps enough to say so.
 *
 * Deliberately loose, and deliberately only ever used to CONFIRM an
 * already-plausible name match (see matchTier) — never to merge two
 * genuinely different names on its own. A shared address is exactly as
 * likely to mean "two family members" as "one person", which is why it never
 * acts alone; see matchTier's gender and approxBirthYear checks for the other
 * half of that guard.
 */
function sameishAddress(a: string, b: string): boolean {
  const ta = addressTokens(a);
  const tb = addressTokens(b);
  if (!ta.size || !tb.size) return false;
  const shared = [...ta].filter((t) => tb.has(t));
  const smaller = Math.min(ta.size, tb.size);
  return shared.length >= 2 && shared.length / smaller >= 0.6;
}

/** How many years apart two documents' implied birth years may be before an
 *  age reading is treated as a genuine conflict rather than rounding. */
const AGE_TOLERANCE_YEARS = 2;

/** A rough birth year implied by a printed age and the date the document
 *  itself carries — e.g. age "45" on a document dated 12/06/2022 implies a
 *  birth year around 1977. Deliberately coarse: ages are commonly rounded, so
 *  this only ever catches a gross mismatch (decades off), never confirms an
 *  identity on its own. */
export function approxBirthYear(
  age: string | null | undefined,
  docDate: string | null | undefined,
): number | null {
  if (!age || !docDate) return null;
  const ageNum = parseInt(age, 10);
  if (!Number.isFinite(ageNum) || ageNum <= 0 || ageNum > 120) return null;
  const first = docDate.split(/\s*[-–]\s*/)[0]?.trim();
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(first ?? '');
  if (!m) return null;
  return Number(m[3]) - ageNum;
}

/**
 * How strong is the case that these are the same person?
 *
 *   0  the names agree as written
 *   1  they agree once spelling variants are folded away, or a date of birth
 *      confirms them
 *   2  they are a near miss — one letter out, a truncated surname — merged,
 *      but recorded as resting on spelling rather than on identity
 *   3  different people
 *
 * Tier 2 exists because the alternative is worse in both directions: splitting
 * a client across three folders over a scanner's dropped letter, or merging on
 * a guess and never saying so. It is merged AND marked.
 */
export const MATCH_EXACT = 0;
export const MATCH_SPELLING = 1;
export const MATCH_NEAR = 2;
export const NO_MATCH = 3;

/** How far each part of a name may be wrong before it is a different name.
 *  Given names vary far more than surnames, and a surname is the part that
 *  actually separates families, so it is held much tighter. */
const GIVEN_BUDGET = 2;
const SURNAME_BUDGET = 1;
const TOTAL_BUDGET = 2;

function tokensAgree(xa: string[], xb: string[]): boolean {
  const sa = new Set(xa);
  const sb = new Set(xb);
  const shared = [...sa].filter((t) => sb.has(t));
  if (!shared.length) return false;
  // One name wholly contained in the other: "Daniel Marsh" vs "Daniel James Marsh".
  if (shared.length === sa.size || shared.length === sb.size) return true;
  return shared.length >= 2;
}

export function matchTier(a: PersonRef, b: PersonRef): number {
  const da = normaliseDob(a.dob);
  const db = normaliseDob(b.dob);
  // Decisive, and checked first. This is the whole point of recording a date of
  // birth: it is what separates a client from a relative sharing his surname,
  // his address and half his name.
  if (da && db && da !== db) return NO_MATCH;
  const dobConfirms = !!da && da === db;

  // Gender and a derived birth year are the other two identifiers that a
  // family member sharing a surname AND an address cannot also share, so they
  // carry the same weight as a differing date of birth: decisive, checked
  // before the name is even read, and never overridden by how close the
  // spelling is.
  if (a.gender && b.gender && a.gender !== b.gender) return NO_MATCH;
  if (
    a.approxBirthYear != null &&
    b.approxBirthYear != null &&
    Math.abs(a.approxBirthYear - b.approxBirthYear) > AGE_TOLERANCE_YEARS
  ) {
    return NO_MATCH;
  }

  // A patient/registration ID is assigned by the facility specifically to
  // settle this question, so two different values printed for two documents
  // is as decisive as two different dates of birth.
  const idA = normaliseId(a.patientId);
  const idB = normaliseId(b.patientId);
  if (idA && idB && idA !== idB) return NO_MATCH;
  const idConfirms = !!idA && idA === idB;

  const addressConfirms =
    !!a.address && !!b.address && sameishAddress(a.address, b.address);

  // The spouse/guardian named only to identify the subject ("w/o Amit") is
  // discarded from the subject's own tokens below so the record cannot drift
  // into HIS file — but it is still read for the opposite purpose: if two
  // documents disagree on the subject's own surname yet agree on who her
  // husband is, that is real corroboration, not a coincidence.
  const parsedA = parseName(a.name);
  const parsedB = parseName(b.name);
  const relA = parsedA.relative.map(normaliseName).filter(Boolean);
  const relB = parsedB.relative.map(normaliseName).filter(Boolean);
  const spouseConfirms = relA.length > 0 && relB.length > 0 && tokensAgree(relA, relB);

  // None of these four is ever enough on its own to rescue a name that reads
  // as a different person (checked below, at the same two spots the lone
  // dobConfirms check used to occupy) — only to settle a name that is already
  // a plausible spelling variant.
  const confirms = dobConfirms || idConfirms || addressConfirms || spouseConfirms;

  const xa = parsedA.subject;
  const xb = parsedB.subject;
  if (!xa.length || !xb.length) return NO_MATCH;

  if (tokensAgree(xa, xb)) return MATCH_EXACT;

  const na = xa.map(normaliseName).filter(Boolean);
  const nb = xb.map(normaliseName).filter(Boolean);
  if (!na.length || !nb.length) return NO_MATCH;
  if (tokensAgree(na, nb)) return MATCH_SPELLING;

  // One side has lost its surname entirely — not uncommon here, since a
  // subject named only by relation ("w/o Amit") keeps no surname of her own
  // when the relative's name is itself reduced to one word. The lone token is
  // compared against BOTH ends of the fuller name, because it could be either:
  // a bare surname ("Marsh" and "Walsh" are one letter apart and unrelated, so
  // that reading needs a confirming clue to trust) or a bare given name (far
  // less commonly shared, and the usual shape of a name a relation-marker
  // stripped down to), which a close spelling match can carry on its own.
  if (na.length < 2 || nb.length < 2) {
    const long = na.length >= nb.length ? na : nb;
    const lone = na.length >= nb.length ? nb : na;
    const matchesGiven = editDistance(lone[0], long[0]) <= GIVEN_BUDGET;
    const matchesSurname = editDistance(lone[0], long[long.length - 1]) <= SURNAME_BUDGET;
    if (confirms && (matchesGiven || matchesSurname)) return MATCH_SPELLING;
    return matchesGiven ? MATCH_NEAR : NO_MATCH;
  }

  const surname = editDistance(na[na.length - 1], nb[nb.length - 1]);
  const given = editDistance(na[0], nb[0]);
  if (
    surname <= SURNAME_BUDGET &&
    given <= GIVEN_BUDGET &&
    surname + given <= TOTAL_BUDGET
  ) {
    // A confirming clue that agrees settles it; the spelling no longer matters.
    return confirms ? MATCH_SPELLING : MATCH_NEAR;
  }

  // The check above assumes the given name sits first and the surname last —
  // true of a clean "Gauri Solanki", false the moment anything trails after
  // the real surname ("Gauri Solanki Devi", a lab code, a second honorific):
  // the surname gets pushed out of the last slot and the check above fails
  // even though both names are plainly right there. Whatever sits BETWEEN or
  // AROUND the given name and surname — a relation marker's leftovers, a
  // registration number, a title the regex didn't catch — is noise once a
  // clean two-token reference (a session's typed client name, or a person
  // group's already-settled label) is being compared against a messier
  // printed one: if the given name shows up somewhere in the messier name and
  // the surname shows up somewhere else in it, position no longer matters.
  const [clean, messy] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (clean.length === 2) {
    const [cleanGiven, cleanSurname] = clean;
    const givenAt = messy.findIndex((t) => editDistance(t, cleanGiven) <= GIVEN_BUDGET);
    const surnameAt = messy.findIndex(
      (t, i) => i !== givenAt && editDistance(t, cleanSurname) <= SURNAME_BUDGET,
    );
    if (givenAt !== -1 && surnameAt !== -1) {
      return confirms ? MATCH_SPELLING : MATCH_NEAR;
    }
  }

  return NO_MATCH;
}

/** Are these the same person? Kept as a boolean for callers that only branch. */
export function samePerson(a: PersonRef, b: PersonRef): boolean {
  return matchTier(a, b) < NO_MATCH;
}

export interface PersonDoc {
  doc_key: string;
  pages: number[];
  person_name: string | null;
  /**
   * What the page printed, before any earlier run replaced person_name with a
   * group label. Clustering reads this when it is there, so re-running on
   * already-clustered documents still sees the original spellings.
   *
   * Semicolon-separated when the document is itself a merge of several, each
   * of which may have been printed differently. The first is matched on; all
   * of them are reported as variants.
   */
  person_name_printed?: string | null;
  person_dob: string | null;
  /** Only ever set from an explicit printed field or title — never guessed
   *  from the given name itself. */
  person_gender?: string | null;
  person_patient_id?: string | null;
  person_address?: string | null;
  /** As printed, e.g. "45" — combined with doc_date to derive a rough birth
   *  year for documents that print an age instead of a date of birth. */
  person_age?: string | null;
  doc_date?: string | null;
  /** A reviewer has manually confirmed this document IS the client — see the
   *  check at the top of clusterPeople's per-document loop. */
  person_client_confirmed?: boolean;
}

export interface ClusterResult<T extends PersonDoc> {
  /** The same documents, each stamped with the person they belong to. */
  docs: (T & {
    person_key: string;
    person_name: string | null;
    /** How this document's name was matched to its person. */
    identity_tier: number;
  })[];
  people: PersonGroup[];
}

/** The display name for a person: the fullest spelling, by token count. */
function fuller(a: string, b: string): string {
  return nameTokens(b).length > nameTokens(a).length ? b : a;
}

/**
 * Cluster documents by the person they are about.
 *
 * Documents are visited in page order so the first, usually fullest, spelling
 * of a name becomes the label for that person. The client named at the start of
 * the session seeds the first group, so their records gather under the name the
 * reviewer actually typed rather than under whichever variant the bundle
 * happened to print first.
 */
export function clusterPeople<T extends PersonDoc>(
  input: T[],
  client: PersonRef = { name: null, dob: null },
): ClusterResult<T> {
  const ordered = [...input].sort(
    (a, b) => Math.min(...a.pages, Infinity) - Math.min(...b.pages, Infinity),
  );

  const groups: (PersonGroup & { tokens: string[] })[] = [];
  const assigned = new Map<string, string>();
  const tiers = new Map<string, number>();

  const clientTokens = nameTokens(client.name);
  if (clientTokens.length) {
    groups.push({
      key: keyFor(clientTokens, client.dob),
      name: client.name!,
      dob: client.dob,
      gender: client.gender ?? null,
      patientId: client.patientId ?? null,
      address: client.address ?? null,
      approxBirthYear: client.approxBirthYear ?? null,
      isClient: true,
      docKeys: [],
      pages: [],
      variants: [],
      tokens: clientTokens,
    });
  }

  for (const doc of ordered) {
    const spellings = (doc.person_name_printed ?? doc.person_name ?? '')
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean);

    // A reviewer has manually confirmed this specific document IS the
    // client — skip matching entirely, even when the printed name is
    // unreadable or reads as nothing like the client at all. Checked before
    // the "no readable name" exit below, since that is exactly the kind of
    // document this override exists for.
    if (doc.person_client_confirmed) {
      const clientGroup = groups.find((g) => g.isClient);
      if (clientGroup) {
        for (const spelling of spellings) {
          if (nameTokens(spelling).join(' ') === nameTokens(clientGroup.name).join(' ')) continue;
          if (!clientGroup.variants.includes(spelling)) clientGroup.variants.push(spelling);
        }
        clientGroup.docKeys.push(doc.doc_key);
        clientGroup.pages.push(...doc.pages);
        assigned.set(doc.doc_key, clientGroup.key);
        tiers.set(doc.doc_key, MATCH_EXACT); // confirmed by a reviewer — nothing to flag
        continue;
      }
    }

    const printed = spellings[0] ?? null;
    const gender = normaliseGender(doc.person_gender);
    const patientId = doc.person_patient_id?.trim() || null;
    const address = doc.person_address?.trim() || null;
    const birthYear = approxBirthYear(doc.person_age, doc.doc_date);
    const ref: PersonRef = {
      name: printed,
      dob: doc.person_dob,
      gender,
      patientId,
      address,
      approxBirthYear: birthYear,
    };
    const tokens = nameTokens(printed);

    if (!tokens.length) {
      assigned.set(doc.doc_key, UNIDENTIFIED);
      continue;
    }

    // Best available match wins, so an exact hit is never stolen by a near one
    // sitting earlier in the list.
    let best: (typeof groups)[number] | null = null;
    let bestTier = NO_MATCH;
    for (const g of groups) {
      const tier = matchTier(
        {
          name: g.name,
          dob: g.dob,
          gender: g.gender,
          patientId: g.patientId,
          address: g.address,
          approxBirthYear: g.approxBirthYear,
        },
        ref,
      );
      if (tier < bestTier) {
        best = g;
        bestTier = tier;
        if (tier === MATCH_EXACT) break;
      }
    }

    if (best) {
      for (const spelling of spellings) {
        if (nameTokens(spelling).join(' ') === nameTokens(best.name).join(' ')) continue;
        if (!best.variants.includes(spelling)) best.variants.push(spelling);
      }
      // The client's group keeps the name the reviewer typed; everyone else
      // takes the fullest spelling the bundle offered.
      if (!best.isClient) {
        const label = fuller(best.name, printed!);
        if (label !== best.name) {
          best.name = label;
          best.tokens = nameTokens(label);
        }
      }
      best.dob ??= doc.person_dob;
      best.gender ??= gender;
      best.patientId ??= patientId;
      best.address ??= address;
      best.approxBirthYear ??= birthYear;
      best.docKeys.push(doc.doc_key);
      best.pages.push(...doc.pages);
      assigned.set(doc.doc_key, best.key);
      tiers.set(doc.doc_key, bestTier);
      continue;
    }

    const key = keyFor(tokens, ref.dob);
    groups.push({
      key,
      name: printed!,
      dob: doc.person_dob,
      gender,
      patientId,
      address,
      approxBirthYear: birthYear,
      isClient: false,
      docKeys: [doc.doc_key],
      pages: [...doc.pages],
      variants: spellings.slice(1).filter((x) => nameTokens(x).join(' ') !== tokens.join(' ')),
      tokens,
    });
    assigned.set(doc.doc_key, key);
    tiers.set(doc.doc_key, MATCH_EXACT);
  }

  // A seeded client nobody matched is not a person in this bundle.
  const live = groups.filter((g) => g.docKeys.length > 0);

  const unidentified = ordered.filter((d) => assigned.get(d.doc_key) === UNIDENTIFIED);
  const people: PersonGroup[] = live.map(({ tokens, ...g }) => {
    void tokens;
    return { ...g, pages: [...g.pages].sort((a, b) => a - b) };
  });

  if (unidentified.length) {
    people.push({
      key: UNIDENTIFIED,
      name: 'Unidentified person',
      dob: null,
      isClient: false,
      docKeys: unidentified.map((d) => d.doc_key),
      pages: unidentified.flatMap((d) => d.pages).sort((a, b) => a - b),
      variants: [],
    });
  }

  // Client first, then by first page. Unidentified last, since it is a
  // statement about what could not be read rather than about a person.
  people.sort((a, b) => {
    if (a.isClient !== b.isClient) return a.isClient ? -1 : 1;
    if ((a.key === UNIDENTIFIED) !== (b.key === UNIDENTIFIED)) {
      return a.key === UNIDENTIFIED ? 1 : -1;
    }
    return (a.pages[0] ?? 0) - (b.pages[0] ?? 0);
  });

  const nameByKey = new Map(people.map((p) => [p.key, p.key === UNIDENTIFIED ? null : p.name]));

  return {
    docs: input.map((d) => {
      const key = assigned.get(d.doc_key) ?? UNIDENTIFIED;
      return {
        ...d,
        person_key: key,
        person_name: nameByKey.get(key) ?? d.person_name,
        identity_tier: tiers.get(d.doc_key) ?? NO_MATCH,
      };
    }),
    people,
  };
}

/** Stable across runs and across spellings, so the same person keeps the same
 *  key whichever variant of their name the bundle happened to print first. */
function keyFor(tokens: string[], dob: string | null): string {
  const folded = tokens.map(normaliseName).filter(Boolean).join('-');
  const d = normaliseDob(dob);
  return `${folded || tokens.join('-')}${d ? `-${d}` : ''}`;
}

/** Folder-safe form of a person's name, for the export. */
export function personFolder(p: PersonGroup): string {
  if (p.key === UNIDENTIFIED) return 'Unidentified-person';
  const safe = p.name
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 48);
  return safe || 'Unnamed-person';
}
