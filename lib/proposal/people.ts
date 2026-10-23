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
}

/** The bucket for documents with no readable person — continuation pages,
 *  unsigned notes, blank pages. Never guessed at. */
export const UNIDENTIFIED = 'unidentified';

const TITLES = /\b(mr|mrs|ms|miss|dr|prof|sr|jr)\b/g;

/** "MARSH, Daniel James" -> ["daniel", "james", "marsh"] */
export function nameTokens(raw: string | null): string[] {
  if (!raw) return [];
  let s = raw.toLowerCase().replace(TITLES, ' ');

  // Surname-first form, as printed on most lab reports.
  if (s.includes(',')) {
    const [surname, rest] = s.split(',', 2);
    s = `${rest} ${surname}`;
  }

  return s
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
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
 * Are these the same person?
 *
 * A differing date of birth is decisive — that is the whole point of recording
 * it, and it is what separates a client from a relative sharing his surname and
 * address. Otherwise two names match when one is a fuller form of the other, or
 * when they share at least two name parts. A shared surname alone is never
 * enough.
 */
export function samePerson(a: PersonRef, b: PersonRef): boolean {
  const da = normaliseDob(a.dob);
  const db = normaliseDob(b.dob);
  if (da && db && da !== db) return false;

  const xa = nameTokens(a.name);
  const xb = nameTokens(b.name);
  if (!xa.length || !xb.length) return false;

  const sa = new Set(xa);
  const sb = new Set(xb);
  const shared = [...sa].filter((t) => sb.has(t));
  if (!shared.length) return false;

  // One name wholly contained in the other: "Daniel Marsh" vs
  // "Daniel James Marsh".
  if (shared.length === sa.size || shared.length === sb.size) return true;

  // Otherwise two parts in common, and a matching date of birth if we have one.
  if (shared.length >= 2) return true;

  // A single shared part — usually just the surname — only counts when the
  // dates of birth positively agree.
  return !!da && da === db;
}

/** An initialised form matches a fuller one: "D. Marsh" vs "Daniel Marsh". */
function initialsCompatible(a: string[], b: string[]): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 2) return false;
  if (short[short.length - 1] !== long[long.length - 1]) return false; // surnames differ
  return short
    .slice(0, -1)
    .every((t, i) => (t.length === 1 ? long[i]?.startsWith(t) : long.includes(t)));
}

export interface PersonDoc {
  doc_key: string;
  pages: number[];
  person_name: string | null;
  person_dob: string | null;
}

export interface ClusterResult<T extends PersonDoc> {
  /** The same documents, each stamped with the person they belong to. */
  docs: (T & { person_key: string; person_name: string | null })[];
  people: PersonGroup[];
}

/**
 * Cluster documents by the person they are about.
 *
 * Documents are visited in page order so the first, usually fullest, spelling
 * of a name becomes the label for that person.
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

  for (const doc of ordered) {
    const ref: PersonRef = { name: doc.person_name, dob: doc.person_dob };

    if (!nameTokens(ref.name).length) {
      assigned.set(doc.doc_key, UNIDENTIFIED);
      continue;
    }

    const tokens = nameTokens(ref.name);
    const existing = groups.find(
      (g) =>
        samePerson({ name: g.name, dob: g.dob }, ref) ||
        (initialsCompatible(g.tokens, tokens) &&
          (!normaliseDob(g.dob) ||
            !normaliseDob(ref.dob) ||
            normaliseDob(g.dob) === normaliseDob(ref.dob))),
    );

    if (existing) {
      // Keep the fullest spelling and the first date of birth seen.
      if (tokens.length > existing.tokens.length) {
        existing.name = doc.person_name!;
        existing.tokens = tokens;
      }
      existing.dob ??= doc.person_dob;
      existing.docKeys.push(doc.doc_key);
      existing.pages.push(...doc.pages);
      assigned.set(doc.doc_key, existing.key);
      continue;
    }

    const key = `${tokens.join('-')}${normaliseDob(ref.dob) ? `-${normaliseDob(ref.dob)}` : ''}`;
    groups.push({
      key,
      name: doc.person_name!,
      dob: doc.person_dob,
      isClient: false,
      docKeys: [doc.doc_key],
      pages: [...doc.pages],
      tokens,
    });
    assigned.set(doc.doc_key, key);
  }

  // Which group is the client, if the session named one.
  if (nameTokens(client.name).length) {
    const match = groups.find((g) => samePerson({ name: g.name, dob: g.dob }, client));
    if (match) match.isClient = true;
  }

  const unidentified = ordered.filter((d) => assigned.get(d.doc_key) === UNIDENTIFIED);
  const people: PersonGroup[] = groups.map(({ tokens, ...g }) => {
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
      return { ...d, person_key: key, person_name: nameByKey.get(key) ?? d.person_name };
    }),
    people,
  };
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
