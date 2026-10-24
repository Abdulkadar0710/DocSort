# DocSort Medical

Turns one medico-legal bundle PDF into individual, identified documents — with
every page traceable back to where it came from.

Built for the Unbundle hackathon brief (the project's original name). The reviewer's journey is four steps:
**upload → preview & refine → approve → download**. Nothing is split until the
reviewer approves, and every session is saved and can be reopened.

## Setup

```bash
npm install
```

Then put your Anthropic key in `.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

The Supabase URL and publishable key are already set. Without the Anthropic key
the app still runs end to end — upload, preview, approve and download all work —
but every page is listed as its own document, because nothing is there to
identify them.

```bash
npm run dev
```

## Testing it

```bash
npm run test:ops                                   # op engine + invariants
npm run ingest -- <bundle.pdf>                     # headless upload + identify
npm run score -- <session-id>                      # compare against the answer key
```

`ingest` drives exactly the same pipeline the browser does, so a problem it
finds is a real one. `score` compares a finished split against the client's own
answer key — which assigns all 192 pages exactly once, making it a genuine
measurement rather than a spot check.

**The number to beat is 103/132 (78%).** That is what "every page is its own
document" scores, because 103 of the key's 132 documents are single-page. The
real work is a much smaller problem than it first appears: 29 merges and 5
exclusions.

## How it works

**A document owns a set of pages, not a page range.** The central decision.
The DEV bundle contains a physiotherapy report whose two pages are 88 and 90,
with a *different person's* pathology results at page 89. A start/end model
cannot express that. Page membership also makes ground rule #1 structural — the
`document_pages` table is keyed on `(proposal_id, page_number)`, so a page
physically cannot land in two documents.

**Two passes, with different characters.**
- *Pass A* (`lib/ai/passA.ts`) reads the bundle in overlapping 10-page windows
  and describes each page independently. Local, parallel, and the only
  non-deterministic step.
- *Pass B* (`lib/ai/passB.ts`) groups described pages into documents with a
  fixed decision procedure — no model call. Reproducible, free, and arguable.

Windows overlap by two pages so no page is judged without seeing what precedes
it; otherwise every window edge becomes a false boundary.

**Revisions are materialised, not folded.** Each revision writes its own
`documents` and `document_pages` rows. History and diffing come free, and a
later AI round keeps earlier manual edits because every round applies to the
*latest* revision. The ops that produced it are kept in `messages.ops` as the
audit trail.

**Feedback never re-reads the bundle.** A revision sees the current register
plus only the pages the feedback actually names. That is what makes refining
cheap enough to repeat.

### The three ground rules

1. *Every page in exactly one child PDF, or listed as excluded* — enforced by
   `validateProposal()` before every save and by the database key, and shown in
   the UI as a live "192 / 192 pages accounted for" badge.
2. *Pages look exactly as the original* — only `pdf-lib` `copyPages` is used;
   nothing is re-rendered. Verified: an exported page renders to a
   byte-identical image as its source, including pages 50 and 174, whose
   declared rotation displays them wrongly in the original and is faithfully
   reproduced rather than silently corrected.
3. *A wrong answer costs more than "unknown"* — unreadable fields are recorded
   as unknown, never guessed, and the scoring harness checks the unknown rate is
   non-zero.

## Deployment notes

Three Vercel constraints shaped the design:

- **Function duration** — the pipeline never runs in one call. `jobs` holds page
  windows and `/api/jobs/tick` processes one per request, driven by the browser.
- **4.5 MB request body limit** — the bundle goes browser → Supabase Storage via
  a signed URL and never through a function. The DEV bundle alone is 14.6 MB.
- **No rasterisation toolchain** — nothing is rasterised server-side. Page
  windows are sliced with `pdf-lib` and sent to Claude as native PDF document
  blocks.

## Known limits

Login, scale and deployment hardening are out of scope per the brief. The client
brief is fixed to this matter rather than captured per session
(`lib/ai/prompts.ts`). RLS is currently permissive for the prototype — set
`SUPABASE_SERVICE_ROLE_KEY` and drop the `prototype_open` policies to harden.
Draggable boundaries (the brief's "nice to have") are not built; feedback and
manual edits share one op vocabulary, so the groundwork is there.
