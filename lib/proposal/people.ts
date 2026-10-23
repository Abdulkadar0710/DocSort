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

export interface PersonRef {
  name: string | null;
  dob: string | null;
}

export interface PersonGroup {
  key: string;
  /** The fullest spelling seen, for display. */
  name: string;
  dob: string | null;
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
 */
const RELATION = /\b(?:[wsdch]\s*\/\s*o|(?:wife|son|daughter|care|husband)\s+of)\b/;

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

  const subject = tokenise(s.slice(0, marker.index));
  const relative = tokenise(s.slice(marker.index + marker[0].length));

  // No surname of her own: take his.
  if (subject.length === 1 && relative.length) {
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

  const xa = nameTokens(a.name);
  const xb = nameTokens(b.name);
  if (!xa.length || !xb.length) return NO_MATCH;

  if (tokensAgree(xa, xb)) return MATCH_EXACT;

  const na = xa.map(normaliseName).filter(Boolean);
  const nb = xb.map(normaliseName).filter(Boolean);
  if (!na.length || !nb.length) return NO_MATCH;
  if (tokensAgree(na, nb)) return MATCH_SPELLING;

  // A single name part on either side is too little to risk a fuzzy match on —
  // "Marsh" and "Walsh" are one letter apart and unrelated. Only a date of
  // birth can carry that.
  if (na.length < 2 || nb.length < 2) {
    return dobConfirms && editDistance(na[na.length - 1], nb[nb.length - 1]) <= SURNAME_BUDGET
      ? MATCH_SPELLING
      : NO_MATCH;
  }

  const surname = editDistance(na[na.length - 1], nb[nb.length - 1]);
  const given = editDistance(na[0], nb[0]);
  if (
    surname <= SURNAME_BUDGET &&
    given <= GIVEN_BUDGET &&
    surname + given <= TOTAL_BUDGET
  ) {
    // A date of birth that agrees settles it; the spelling no longer matters.
    return dobConfirms ? MATCH_SPELLING : MATCH_NEAR;
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
    const printed = spellings[0] ?? null;
    const ref: PersonRef = { name: printed, dob: doc.person_dob };
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
      const tier = matchTier({ name: g.name, dob: g.dob }, ref);
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
