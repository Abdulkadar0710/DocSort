import React from 'react';
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import { REVIEW_LABELS, type Category, type ProposalDoc } from '@/lib/types';
import { UNIDENTIFIED, type PersonGroup } from '@/lib/proposal/people';
import { summariseRuns, type ValidationResult } from '@/lib/proposal/validate';

/**
 * The summary PDF.
 *
 * The brief asks for two things here, and both matter: an account of how the
 * bundle was split and what was identified about each child PDF, AND the design
 * choices behind the solution. The second half is written out in full below
 * rather than left implicit.
 */

const styles = StyleSheet.create({
  page: { paddingTop: 34, paddingBottom: 40, paddingHorizontal: 28, fontSize: 7.5, color: '#0f172a' },
  h1: { fontSize: 15, fontFamily: 'Helvetica-Bold', marginBottom: 3 },
  h2: { fontSize: 10, fontFamily: 'Helvetica-Bold', marginTop: 14, marginBottom: 5 },
  h3: { fontSize: 8.5, fontFamily: 'Helvetica-Bold', marginTop: 9, marginBottom: 3 },
  sub: { fontSize: 8, color: '#475569', marginBottom: 2 },
  body: { fontSize: 8, lineHeight: 1.5, color: '#1e293b', marginBottom: 5 },

  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8, marginBottom: 2 },
  stat: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 3, paddingVertical: 4, paddingHorizontal: 7, minWidth: 84 },
  statN: { fontSize: 13, fontFamily: 'Helvetica-Bold' },
  statL: { fontSize: 6.5, color: '#475569', marginTop: 1 },

  tHead: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#0f172a', backgroundColor: '#f1f5f9', paddingVertical: 3, paddingLeft: 3, marginTop: 4 },
  tRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderColor: '#cbd5e1', paddingVertical: 3, paddingLeft: 3 },
  th: { fontFamily: 'Helvetica-Bold', fontSize: 6.5 },
  td: { fontSize: 6.8, paddingRight: 3 },

  cId: { width: 30 }, cPg: { width: 48 }, cTy: { width: 74 },
  cDesc: { width: 128 }, cDt: { width: 56 }, cAu: { width: 92 }, cOrg: { width: 82 },
  cCl: { width: 34 }, cDup: { width: 30 }, cFmt: { width: 62 }, cFlag: { flex: 1 },
  italic: { fontFamily: 'Helvetica-Oblique', color: '#334155' },
  rowFlagged: { backgroundColor: '#fef6dc' },

  muted: { color: '#64748b' },
  warn: { color: '#b45309' },
  bad: { color: '#b91c1c' },
  footer: { position: 'absolute', bottom: 18, left: 28, right: 28, flexDirection: 'row', justifyContent: 'space-between', fontSize: 6.5, color: '#94a3b8' },
});

export interface SummaryInput {
  sessionName: string;
  pageCount: number;
  docs: ProposalDoc[];
  validation: ValidationResult;
  revisions: number;
  feedbackRounds: number;
  approvedAt: Date;
  /** Pages the original carried no text layer for — scans, faxes, handwriting. */
  ocrPageCount: number;
  /** Of those, how many got an invisible text layer from the browser OCR pass. */
  ocrTextLayerCount: number;
  /**
   * Per page: did the original carry a text layer, and did we add one?
   *
   * Reported per document in the register, because "can I search this child
   * PDF?" is a question about the file in front of the reviewer, not about the
   * bundle as a whole — and a document whose text had to be read off an image
   * carries more risk of a misread name or date than one read from the file.
   */
  pageText: Map<number, { native: boolean; ocrAdded: boolean }>;
  /** The category set derived for this bundle. */
  categories: Category[];
  /** Everyone the bundle turned out to be about. */
  people: PersonGroup[];
}

/**
 * "unknown" and "—" are not the same claim and are not collapsed into one.
 * "unknown" means the field was looked for and could not be read; "—" means
 * it does not apply, as on a blank page. Flattening the first into the second
 * hides the admission the splitting guidelines specifically ask us to make.
 */
const dash = (v: string | null | undefined) => (v ? v : '—');

/**
 * How a document's pages reached us, and whether the exported child PDF is
 * searchable. Three states, because they carry different consequences:
 * text read from the file is reliable, text read off an image is not, and a
 * page with neither cannot be searched at all.
 */
function formatOf(
  pages: number[],
  pageText: SummaryInput['pageText'],
): { label: string; needsOcr: boolean } {
  let native = 0;
  let added = 0;
  for (const p of pages) {
    const t = pageText.get(p);
    if (t?.native) native++;
    else if (t?.ocrAdded) added++;
  }
  const scanned = pages.length - native;
  if (scanned === 0) return { label: 'Digital (text layer)', needsOcr: false };
  if (native > 0) {
    return {
      label: `Mixed — ${native} digital, ${scanned} scanned${added ? ` (${added} OCR'd)` : ''}`,
      needsOcr: true,
    };
  }
  return {
    label: added === pages.length ? 'Scanned (text layer added)' : 'Scanned (OCR needed)',
    needsOcr: true,
  };
}

function Stat({ n, label }: { n: number | string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statN}>{String(n)}</Text>
      <Text style={styles.statL}>{label}</Text>
    </View>
  );
}

function Footer() {
  return (
    <View style={styles.footer} fixed>
      <Text>DocSort Medical — medico-legal document preparation</Text>
      <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );
}

function SummaryDoc(input: SummaryInput) {
  const { docs, pageCount, validation } = input;
  const real = docs.filter((d) => !d.excluded);
  const excluded = docs.filter((d) => d.excluded);
  // Removed at processing time: blank pages, and confirmed second copies.
  const removedDupPages = excluded.filter((d) => d.subcategory === 'Duplicate').flatMap((d) => d.pages);
  const blankPages = excluded.filter((d) => d.subcategory !== 'Duplicate').flatMap((d) => d.pages);
  const dups = real.filter((d) => d.dup_of);
  const otherPerson = real.filter((d) => d.relates === 'no');
  const uncertain = real.filter((d) => d.relates === 'uncertain');
  const flagged = real.filter((d) => d.review.length > 0);
  const nonContiguous = real.filter(
    (d) => d.pages.length > 1 && d.pages[d.pages.length - 1] - d.pages[0] + 1 !== d.pages.length,
  );
  const scannedDocs = real.filter((d) => formatOf(d.pages, input.pageText).needsOcr);

  return (
    <Document title={`DocSort Medical summary — ${input.sessionName}`}>
      {/* ------------------------------------------------ overview + register */}
      <Page size="A4" orientation="landscape" style={styles.page}>
        <Text style={styles.h1}>Document register</Text>
        <Text style={styles.sub}>
          {input.sessionName} · {pageCount} pages · split approved{' '}
          {input.approvedAt.toLocaleString('en-AU')}
        </Text>

        <View style={styles.statRow}>
          <Stat n={real.length} label="Documents identified" />
          <Stat n={blankPages.length} label="Blank pages removed" />
          <Stat n={removedDupPages.length} label="Duplicate pages removed" />
          <Stat n={pageCount} label="Pages in bundle" />
          <Stat n={dups.length} label="Duplicates flagged" />
          {/* Kept apart rather than summed: "this is somebody else's record"
              is a finding, "I could not tell whose this is" is an open
              question, and they need different handling. */}
          <Stat n={otherPerson.length} label="About another person" />
          <Stat n={uncertain.length} label="Uncertain identity" />
          <Stat n={flagged.length} label="Flagged for review" />
          <Stat n={scannedDocs.length} label="Scanned / fax (OCR needed)" />
          <Stat n={`${input.ocrTextLayerCount}/${input.ocrPageCount}`} label="Scanned pages given text" />
          <Stat n={input.feedbackRounds} label="Reviewer revisions" />
        </View>

        <Text style={styles.body}>
          &quot;Bundle pages&quot; is where each document&apos;s pages came from in
          the original, which is often scattered — and which is the number that
          matters if the origin of a document is ever questioned. Blank pages
          and second copies were removed during processing; they are counted
          above and listed under &quot;Pages excluded&quot;, so every page of the
          original is still accounted for.
        </Text>

        <Text style={styles.body}>
          &quot;Format&quot; says where this document&apos;s text came from.
          Digital pages were read from the file itself and their details are as
          reliable as the original. Scanned, faxed and handwritten pages had to
          be read off an image, so names, dates and reference numbers on them
          are the most likely place for a misreading — and the OCR text layer
          added on export is an aid to searching, not a transcript to rely on.
        </Text>

        <Text style={[styles.body, validation.ok ? styles.muted : styles.bad]}>
          {validation.ok
            ? `Page accounting checks out: all ${pageCount} pages of the original appear in exactly one child PDF, or are listed as excluded below. No page is in two documents and none is missing.`
            : `PAGE ACCOUNTING PROBLEM: ${validation.errors.join('; ')}`}
        </Text>

        {/* Laid out as the reviewer's reference register. Blank pages and
            removed duplicates are not documents, so they are not rows here:
            they are counted above and listed under "Pages excluded". */}
        <View style={styles.tHead} fixed>
          <Text style={[styles.th, styles.cId]}>ID</Text>
          <Text style={[styles.th, styles.cPg]}>Bundle pages</Text>
          <Text style={[styles.th, styles.cTy]}>Type</Text>
          <Text style={[styles.th, styles.cDesc]}>Description</Text>
          <Text style={[styles.th, styles.cDt]}>Date</Text>
          <Text style={[styles.th, styles.cAu]}>Author / discipline</Text>
          <Text style={[styles.th, styles.cOrg]}>Organisation</Text>
          <Text style={[styles.th, styles.cCl]}>Client?</Text>
          <Text style={[styles.th, styles.cDup]}>Dup of</Text>
          <Text style={[styles.th, styles.cFmt]}>Format</Text>
          <Text style={[styles.th, styles.cFlag]}>Review flags and judge notes</Text>
        </View>

        {real.map((d) => (
          <View
            key={d.doc_key}
            style={[styles.tRow, d.review.length > 0 ? styles.rowFlagged : {}]}
            wrap={false}
          >
            <Text style={[styles.td, styles.cId]}>{d.doc_key}</Text>
            <Text style={[styles.td, styles.cPg]}>{summariseRuns(d.pages)}</Text>
            <Text style={[styles.td, styles.cTy]}>{dash(d.doc_type)}</Text>
            <Text style={[styles.td, styles.cDesc]}>{dash(d.title)}</Text>
            <Text style={[styles.td, styles.cDt]}>{dash(d.doc_date)}</Text>
            <View style={[styles.td, styles.cAu]}>
              <Text>{dash(d.author)}</Text>
              {d.discipline ? <Text style={styles.italic}>{d.discipline}</Text> : null}
            </View>
            <Text style={[styles.td, styles.cOrg]}>{dash(d.org)}</Text>
            <Text
              style={[
                styles.td,
                styles.cCl,
                d.relates === 'no' ? styles.bad : d.relates === 'uncertain' ? styles.warn : {},
              ]}
            >
              {d.relates}
            </Text>
            <Text style={[styles.td, styles.cDup]}>{dash(d.dup_of)}</Text>
            <Text style={[styles.td, styles.cFmt, styles.muted]}>
              {formatOf(d.pages, input.pageText).label}
            </Text>
            {/* Only what needs attention. The identity reasoning is shown when
                a document is NOT plainly the client's — on a confirmed match
                it is reassurance, not a flag, and filling this column with it
                on every row buries the entries that do need a human. */}
            <Text style={[styles.td, styles.cFlag]}>
              {[
                ...d.review.map((f) => `${REVIEW_LABELS[f.code]}: ${f.message}`),
                d.relates !== 'yes' && d.relates_reason ? d.relates_reason : null,
              ]
                .filter(Boolean)
                .join('; ')}
            </Text>
          </View>
        ))}

        <Footer />
      </Page>

      {/* --------------------------------------------------------- the people */}
      {input.people.length > 1 && (
        <Page size="A4" orientation="landscape" style={styles.page}>
          <Text style={styles.h1}>People in this bundle</Text>
          <Text style={styles.body}>
            This bundle contains records for more than one person. They have
            been kept completely separate: no document about one person has
            been merged with another&apos;s, and each person&apos;s records are
            exported into their own folder. Nothing has been discarded —
            everything found is listed below and produced.
          </Text>

          <View style={styles.tHead}>
            <Text style={[styles.th, { width: 160 }]}>Person</Text>
            <Text style={[styles.th, { width: 70 }]}>Date of birth</Text>
            <Text style={[styles.th, { width: 60 }]}>Documents</Text>
            <Text style={[styles.th, { width: 50 }]}>Pages</Text>
            <Text style={[styles.th, { width: 140 }]}>Bundle pages</Text>
            <Text style={[styles.th, { flex: 1 }]}>Also printed as</Text>
          </View>

          {input.people.map((p) => (
            <View key={p.key} style={styles.tRow} wrap={false}>
              <Text style={[styles.td, { width: 160 }, p.isClient ? {} : styles.warn]}>
                {p.name}
                {p.isClient ? ' — the client' : ''}
              </Text>
              <Text style={[styles.td, { width: 70 }]}>{dash(p.dob)}</Text>
              <Text style={[styles.td, { width: 60 }]}>{p.docKeys.length}</Text>
              <Text style={[styles.td, { width: 50 }]}>{p.pages.length}</Text>
              <Text style={[styles.td, { width: 140 }]}>{summariseRuns(p.pages)}</Text>
              {/* Every spelling this person's name appeared under. A reviewer
                  who disagrees that these are one person needs to see what was
                  actually on the pages, not just the label we chose. */}
              <Text style={[styles.td, { flex: 1 }, styles.muted]}>
                {p.variants.length ? p.variants.join('; ') : '—'}
              </Text>
            </View>
          ))}

          <Text style={styles.h3}>Why this matters</Text>
          <Text style={styles.body}>
            A bundle that should hold one person&apos;s records and turns out to
            hold several is a disclosure problem as much as a filing one. The
            pages belonging to anyone other than the client are listed above so
            they can be dealt with deliberately rather than discovered later.
            {input.people.some((p) => p.variants.length)
              ? ' Where one person\u2019s name was printed several ways, the variants are listed so the grouping can be checked rather than taken on trust; any that rested on spelling alone also carry a flag in the register.'
              : ''}
            {input.people.some((p) => p.key === UNIDENTIFIED)
              ? ' Pages naming nobody are grouped as an unidentified person rather than guessed at.'
              : ''}
          </Text>

          <Footer />
        </Page>
      )}

      {/* ------------------------------------------------------- the taxonomy */}
      <Page size="A4" orientation="landscape" style={styles.page}>
        <Text style={styles.h1}>How this bundle was categorised</Text>
        <Text style={styles.body}>
          These categories were not taken from a fixed list. They were derived
          from this bundle — every document&apos;s description was read together
          and a category set proposed to fit what is actually here, then each
          document was filed against it. A borrowed taxonomy tends not to fit
          the matter at hand; letting each document invent its own produces
          three names for the same thing by the end of a long bundle.
        </Text>

        <View style={styles.tHead}>
          <Text style={[styles.th, { width: 150 }]}>Category</Text>
          <Text style={[styles.th, { width: 44 }]}>Documents</Text>
          <Text style={[styles.th, { width: 56 }]}>Origin</Text>
          <Text style={[styles.th, { flex: 1 }]}>What belongs in it</Text>
        </View>

        {input.categories.map((c) => {
          const count = docs.filter((d) => d.doc_type === c.name).length;
          return (
            <View key={c.id} style={styles.tRow} wrap={false}>
              <Text style={[styles.td, { width: 150 }]}>{c.name}</Text>
              <Text style={[styles.td, { width: 44 }]}>{count || '—'}</Text>
              <Text style={[styles.td, { width: 56 }, styles.muted]}>{c.origin}</Text>
              <Text style={[styles.td, { flex: 1 }]}>{c.description}</Text>
            </View>
          );
        })}

        {docs.some((d) => d.proposed_category) && (
          <>
            <Text style={styles.h2}>Categories proposed while filing</Text>
            <Text style={styles.body}>
              Raised because a document fitted nothing in the set above. Each has
              been added so later documents could use it; they are worth a look
              before the taxonomy is reused on another matter.
            </Text>
            {docs
              .filter((d) => d.proposed_category)
              .map((d) => (
                <Text key={d.doc_key} style={styles.body}>
                  {d.doc_key}: &quot;{d.proposed_category}&quot; —{' '}
                  {d.proposed_category_reason ?? 'no reason given'}
                </Text>
              ))}
          </>
        )}

        <Footer />
      </Page>

      {/* ---------------------------------------------------- what to check */}
      <Page size="A4" orientation="landscape" style={styles.page}>
        <Text style={styles.h1}>What needs a human eye</Text>
        <Text style={styles.body}>
          Listed here because a wrong answer costs more than an admitted
          uncertainty. Everything below was still split and exported; these are
          the places where the automatic reading should not be taken on trust.
        </Text>

        <Text style={styles.h2}>Pages excluded from every document ({excluded.length})</Text>
        {excluded.length === 0 ? (
          <Text style={styles.body}>None.</Text>
        ) : (
          excluded.map((d) => (
            <Text key={d.doc_key} style={styles.body}>
              {d.doc_key} — page {summariseRuns(d.pages)}:{' '}
              {d.review.map((f) => f.message).join('; ') || 'blank page'}
            </Text>
          ))
        )}

        <Text style={styles.h2}>May not concern the client ({otherPerson.length + uncertain.length})</Text>
        {otherPerson.length + uncertain.length === 0 ? (
          <Text style={styles.body}>None.</Text>
        ) : (
          [...otherPerson, ...uncertain].map((d) => (
            <Text key={d.doc_key} style={styles.body}>
              {d.doc_key} (pages {summariseRuns(d.pages)}) — {d.relates.toUpperCase()}:{' '}
              {d.relates_reason ?? 'no reason recorded'}
            </Text>
          ))
        )}

        <Text style={styles.h2}>Possible duplicates ({dups.length})</Text>
        {dups.length === 0 ? (
          <Text style={styles.body}>None.</Text>
        ) : (
          dups.map((d) => (
            <Text key={d.doc_key} style={styles.body}>
              {d.doc_key} (pages {summariseRuns(d.pages)}) appears to duplicate {d.dup_of}.
              Both have been exported; neither was discarded.
            </Text>
          ))
        )}

        <Text style={styles.h2}>Documents whose pages are not contiguous ({nonContiguous.length})</Text>
        {nonContiguous.length === 0 ? (
          <Text style={styles.body}>None.</Text>
        ) : (
          nonContiguous.map((d) => (
            <Text key={d.doc_key} style={styles.body}>
              {d.doc_key} is made of pages {d.pages.join(', ')} — unrelated pages sit
              between them in the original. Worth confirming.
            </Text>
          ))
        )}

        <Text style={styles.h2}>Other review flags</Text>
        {flagged.filter((d) => !d.dup_of && d.relates === 'yes').length === 0 ? (
          <Text style={styles.body}>None.</Text>
        ) : (
          flagged
            .filter((d) => !d.dup_of && d.relates === 'yes')
            .map((d) => (
              <Text key={d.doc_key} style={styles.body}>
                {d.doc_key} (pages {summariseRuns(d.pages)}):{' '}
                {d.review.map((f) => `${REVIEW_LABELS[f.code]} — ${f.message}`).join('; ')}
              </Text>
            ))
        )}

        <Footer />
      </Page>

      {/* -------------------------------------------------- design choices */}
      <Page size="A4" orientation="landscape" style={styles.page}>
        <Text style={styles.h1}>How this was built, and why</Text>

        <Text style={styles.h3}>The shape of the problem</Text>
        <Text style={styles.body}>
          A bundle is too large to judge in one pass, the same judgement has to
          hold across hundreds of pages, every decision has to trace back to its
          pages, and a reviewer is waiting. Those four constraints, not the
          interface, drove the design.
        </Text>

        <Text style={styles.h3}>A document owns a set of pages, not a page range</Text>
        <Text style={styles.body}>
          The central data decision. Documents in a scanned bundle are not always
          contiguous — this bundle contains a report whose two pages are
          separated by a page belonging to someone else entirely. A
          start-page/end-page model cannot express that, and would have forced a
          wrong answer. Storing page membership also makes the first ground rule
          a database constraint rather than a hope: the page table is keyed on
          (proposal, page number), so a page physically cannot be written into
          two documents at once.
        </Text>

        <Text style={styles.h3}>How the work is divided</Text>
        <Text style={styles.body}>
          Two passes with different characters. Pass A reads the bundle in
          overlapping ten-page windows and describes each page on its own terms:
          what it is, who wrote it, whose it is, whether it carries a
          &quot;page n of m&quot; marker, whether it reads as a continuation. This is
          local, parallel, and the only non-deterministic step. Pass B then
          groups those described pages into documents using a fixed decision
          procedure — no model call at all. Grouping is global and needs the
          whole picture, so doing it inside a window would have turned every
          window edge into a false document boundary. Windows overlap by two
          pages so that no page is ever judged without seeing what came before
          it, and where the two windows disagree the one with more preceding
          context wins.
        </Text>

        <Text style={styles.h3}>How results are kept consistent</Text>
        <Text style={styles.body}>
          By moving every judgement that can be deterministic out of the model.
          Grouping, duplicate grouping, page accounting, filename generation and
          validation are ordinary code: they produce the same answer every run
          and can be read and argued with. The starting point is also
          deliberately dull — every page begins as its own document, which on
          this bundle is already correct for most of them — so the model is only
          ever asked to justify merging pages together, never to find boundaries
          in a wall of text. A merge happens only when something concrete
          supports it: an unbroken page-marker sequence, an explicit
          continuation, or a shared organisation and date with no new letterhead.
        </Text>

        <Text style={styles.h3}>How it stays traceable</Text>
        <Text style={styles.body}>
          Every child PDF records the original bundle pages it came from in its
          own metadata, and this register lists them again. Each revision of the
          split is stored in full rather than as a patch, so any earlier state
          can be reproduced exactly, and the operations that produced it are kept
          alongside as an audit trail. Pages are copied, never re-rendered, so a
          split page is byte-for-byte the original — including the two pages
          whose declared rotation makes them display wrongly, which are
          reproduced as they are rather than silently corrected.
        </Text>

        <Text style={styles.h3}>How it stays affordable</Text>
        <Text style={styles.body}>
          Three levers. The client brief and type taxonomy are sent as a cached
          prompt prefix, so they are paid for once rather than on each of the
          two dozen windows. Pages that already carry a text layer have that text
          passed through directly, so the model is not asked to re-read what is
          already machine readable. And a reviewer&apos;s feedback round never
          re-reads the bundle: it sees only the current register and the pages the
          feedback actually names, which is what makes iterating cheap enough to
          do as often as the reviewer likes.
        </Text>

        <Text style={styles.h3}>What we refuse to guess</Text>
        <Text style={styles.body}>
          Unreadable or absent fields are recorded as unknown rather than filled
          with something plausible, and documents that may concern another person
          are flagged rather than dropped. Nothing is ever discarded on the
          system&apos;s own authority: suspected duplicates and material about
          other people are still exported, still listed, and simply marked.
        </Text>

        <Text style={styles.h3}>Known limits of this prototype</Text>
        <Text style={styles.body}>
          Login, scale and deployment hardening are out of scope, as the brief
          allows. The client brief is fixed to this matter rather than captured
          per session. Searchability of scanned pages depends on an in-browser
          OCR pass that runs separately from identification; where it had not
          finished, those pages are exported faithfully but without a text layer.
          Illegibility is reported from the model&apos;s own reading of a page
          rather than measured.
        </Text>

        <Footer />
      </Page>
    </Document>
  );
}

export async function renderSummaryPdf(input: SummaryInput): Promise<Uint8Array> {
  const buf = await renderToBuffer(<SummaryDoc {...input} />);
  return new Uint8Array(buf);
}
