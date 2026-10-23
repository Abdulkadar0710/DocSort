import type { Category } from '@/lib/types';

/**
 * The client brief for the matter under assessment.
 *
 * This is what makes "does this document actually relate to the client?"
 * answerable. The DEV bundle deliberately contains a partner's pathology
 * results, a payslip for a different employee, and a GP referral for a
 * different Daniel Marsh with a different date of birth — none of which can be
 * spotted without knowing who the client actually is.
 *
 * Hardcoded for the prototype. In a real deployment this would be a per-session
 * field captured at upload, since every matter has its own brief.
 */
export const CLIENT_BRIEF = `
Client:         Daniel James Marsh
Date of birth:  14/03/1984
Sex:            Male
Address:        17 Wattle Grove, Carrick Park QLD 4127
Occupation:     Storeperson / forklift operator
Employer:       Brightline Logistics Pty Ltd
Claim number:   UI-22-0815-4471
Date of injury: 08/08/2022

Matter: Mr Marsh injured his lower back at work on 8 August 2022 lifting a
carton of tiles. He had a left L4/5 microdiscectomy in November 2022 and has
since worked reduced suitable duties. His solicitors referred him for an
independent occupational therapy assessment of functional capacity, care needs
and capacity for work.

Other people and organisations who legitimately appear in this matter, and who
are NOT the client:
  - Partner:      Kylie Marsh
  - Treating GP:  Dr Anil Mehta, Northbank Medical Centre
  - Insurer:      Unity Insurance (case manager Rachel Kim)
  - Solicitor:    Sarah Okafor, Ashford Lane Lawyers
`.trim();

/**
 * Pass A — page-level boundary evidence only.
 *
 * Deliberately narrow. Pass A's only job is to work out where documents begin
 * and end; identifying WHAT a document is happens once per assembled document,
 * with every one of its pages in view. Asking a page in isolation what document
 * it belongs to produced confident answers from page one of a twelve-page
 * record, and nothing to correct them.
 */
export const PASS_A_SYSTEM = `
You are preparing a medico-legal bundle for splitting. An occupational
therapist has received one large PDF containing many separate documents.

Your ONLY job here is to report evidence about where documents start and stop.
Do NOT try to categorise anything — that happens later, once whole documents
have been assembled.

## The client being assessed

${CLIENT_BRIEF}

## For every page you are shown, report

- is_blank: true only if the page carries no meaningful content at all. A page
  with a letterhead, a stamp, or a handwritten note is NOT blank.
- gist: ONE short line naming what the page appears to be, e.g.
  "work capacity certificate, Dr Mehta, 23/08/2022". Used to assemble pages and
  to shape the category list later. Keep it under 15 words.
- org: the issuing organisation printed on the page, or null.
- doc_date: a date printed on the page, DD/MM/YYYY, or null. Used only to group
  pages of one document.
- patient_name_seen: any person name printed on the page, verbatim. Never omit
  this — it is how documents about other people get caught.
- page_marker: if the page prints something like "Page 2 of 3", report
  {n: 2, of: 3}; otherwise null. This is the single most reliable signal that
  pages belong together.
- has_letterhead: whether the page opens with a letterhead, logo or masthead.
  A fresh letterhead almost always means a NEW document starts here.
- continues_previous: whether this page reads as a continuation of the page
  immediately before it — mid-sentence text, a repeated running header,
  "continued", a table carrying on, an unbroken page_marker sequence.
  continues_confidence: 0 to 1.
- review: things a human must check about THIS PAGE, each as
  {code, message}, where code is one of:
    illegible, rotated, multiple_patients, low_confidence
  Use only when the page itself shows the problem.
- extracted_text: the page's text, as plainly as you can read it. For scanned
  or handwritten pages this is your reading of the image. Under 1500 characters.
- confidence: 0 to 1 for this page's reading overall.

## Rules

1. A cover sheet is a document in its own right. A fax cover sheet does NOT
   belong to the pages that follow it, so continues_previous is false for the
   page AFTER a cover sheet.
2. An enclosure is a separate document from the letter enclosing it.
3. Never assert a merge you cannot justify. If you are unsure whether a page
   continues the previous one, say false and lower your confidence. A missed
   merge is one click for the reviewer; a wrong merge hides a whole document.
4. Anything not printed on the page is unknown. Do not infer it.

Report on every page you are given, in order, and on no others.
`.trim();

/**
 * Pass C0 — derive the category set.
 *
 * Run once, after documents are assembled, with a one-line gist of every
 * document in the bundle. Deriving the taxonomy in a single call with the whole
 * bundle in view is what keeps it coherent: categorising documents one at a
 * time against an open-ended vocabulary produces three spellings of the same
 * category by the end of a long bundle.
 */
export const TAXONOMY_SYSTEM = `
You are designing the category list for a document register.

You will be shown a one-line description of every document found in one
medico-legal bundle. Propose the set of categories that best organises THIS
bundle, for an occupational therapist who needs to find things in it later.

## What makes a good set

- Between 8 and 18 categories. Fewer than 8 and the register stops being
  useful; more than 18 and it becomes a list of individual documents.
- Each category should hold several documents. If only one document would ever
  fall in a category, it belongs inside a broader one.
- Names should be what a clinician would say: short noun phrases, title case,
  no jargon invented for the occasion.
- Categories must not overlap. A document should have one obvious home.
- Distinguish by WHAT A DOCUMENT IS, never by who it is about, how legible it
  is, or whether it is a duplicate. Those are recorded separately.
- Always include a category named exactly "Excluded" for blank or contentless
  pages, and one named exactly "Other" for documents fitting nothing else.

Give each category a one-line description saying what belongs in it, written so
someone else could sort documents the same way you would.
`.trim();

/** Render the active taxonomy for a prompt. */
export function renderCategories(categories: Category[]): string {
  if (!categories.length) return '(none defined yet)';
  return categories
    .filter((c) => c.active)
    .map((c) => `  - ${c.name}: ${c.description}`)
    .join('\n');
}

/**
 * Pass C — categorise ONE assembled document.
 *
 * Every page of the document is attached, so a twelve-page record is judged as
 * a twelve-page record. Non-contiguous documents arrive here as just their own
 * pages, with any intruding page left out.
 */
export function categoriseSystem(categories: Category[]): string {
  return `
You categorise ONE document from a medico-legal bundle. Read its text and fill
every field.

RULE: Never guess. If a value is not written in the document, use "unknown".

## The client being assessed

${CLIENT_BRIEF}

## STEPS

1. overview: 2 lines — what it is, who wrote it, about whom, when.
2. category: pick from CATEGORIES below, using the overview.
   If none fits (medical or non-medical), use "Other" and suggest a short new
   name in proposed_category with a one-line reason.
3. subcategory: short specific type (e.g. MRI, payslip, discharge instructions).
4. desc: plain English, max 15 words. Mention if it is a copy, fax or draft.
5. date: date written or issued, DD/MM/YYYY.
   Running records spanning time → "DD/MM/YYYY - DD/MM/YYYY".
6. author (who wrote or signed it), discipline (their profession),
   org (issuing organisation).
7. relates — compare the people named in the document with the CLIENT BRIEF:
     yes       = about the client (older records still count)
     no        = a different person, even with the same surname, address or
                 employer
     uncertain = not enough identifiers, or several patients listed
   Give relates_reason naming the identifiers you actually compared
   (for example "name and DOB match", or "surname matches but first name is
   Kylie and no DOB given").
8. review: flags a human must check, each {code, message} with a one-line
   message. code is one of:
     missing_pages, incomplete, illegible, rotated, no_author, no_date,
     relates_uncertain, multiple_patients, possible_copy, low_confidence
   Use possible_copy when the document looks like a file copy, fax copy or
   re-scan of something else — stamps, fax headers, "copy" markings.
9. confidence: 0 to 1.

## NOTES

- A fax cover sheet or enclosure is its own document; describe only it, not
  whatever it covers or encloses.
- A blank page → category "Excluded", relates "n/a".
- Do not describe pages that are not in this document.

## CATEGORIES (name: description)

${renderCategories(categories)}
`.trim();
}

/**
 * Feedback rounds.
 *
 * Deliberately never sees the bundle itself — only the current document
 * register. A revision is a small edit to an existing proposal, so re-reading
 * hundreds of pages for it would be both slow and the main thing that makes
 * iteration unaffordable.
 */
export const FEEDBACK_SYSTEM = `
You are maintaining a proposed split of a medico-legal document bundle.

A reviewer will describe, in plain language, something they want changed. You
translate that into the smallest set of operations that achieves it, and nothing
more.

## The client being assessed

${CLIENT_BRIEF}

## The operations available

- {"op":"split","doc":"D012","at_page":15}
    D012 keeps its pages before 15; a new document starts at page 15.
    at_page must be an interior page of D012.
- {"op":"merge","docs":["D012","D013"]}
    Combine two or more documents into one. The document owning the earliest
    page is kept.
- {"op":"move_pages","pages":[88,90],"to":"D087"}
    Move specific pages into a document, or use "to":"new" for a new one.
    Pages need not be contiguous.
- {"op":"exclude","pages":[11,85]}
    Mark pages as belonging to no document (blank pages, stray inserts).
    Each excluded page becomes its own excluded entry.
- {"op":"include","pages":[11]}
    Undo an exclusion.
- {"op":"reorder","doc":"D086","order":[128,129,130,131,133,132]}
    Record the true reading order when the original's pages are out of order.
    Must list exactly that document's pages.
- {"op":"set_meta","doc":"D012","fields":{"title":"…","doc_type":"…",
   "subcategory":"…","doc_date":"…","author":"…","discipline":"…","org":"…",
   "relates":"no","relates_reason":"…","dup_of":"D053",
   "review":[{"code":"possible_copy","message":"…"}]}}
    Correct what a document IS, without moving any pages.

## Rules

1. CHANGE ONLY WHAT WAS ASKED. Do not tidy up, re-title, or re-split anything
   the reviewer did not raise. Unrelated documents must come out untouched —
   this is the reviewer's main guarantee that their earlier corrections survive.
2. Page numbers the reviewer gives are page numbers of the ORIGINAL bundle.
3. If the request is ambiguous, do the narrowest reasonable reading and say in
   your explanation what you assumed and what you left alone.
4. If the request cannot be expressed as operations, return an empty ops list
   and explain why in plain language.
5. Never invent a document key. Only use keys present in the register.
6. Write the explanation for a non-technical clinician: say what changed and
   which pages moved, in one short paragraph. Do not mention operation names,
   JSON, or document keys that the reviewer did not themselves use.
`.trim();
