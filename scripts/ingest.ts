/**
 * Headless ingest: drives the same pipeline the browser does, against a running
 * dev server. Used to test and to feed the scoring harness.
 *
 *   npx tsx scripts/ingest.ts <bundle.pdf> [--base http://localhost:3000] [--no-wait]
 *
 * Mirrors the browser's flow exactly — create session, upload to the signed
 * URL, build the page inventory locally, post it, then drive the job queue —
 * so a problem found here is a real problem, not a test-harness artefact.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createRequire } from 'node:module';
import type { PageInventory } from '../lib/types';

const require = createRequire(import.meta.url);

interface Args {
  file: string;
  base: string;
  wait: boolean;
  device: string;
  client: string;
  dob: string;
  ref: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: tsx scripts/ingest.ts <bundle.pdf> [--base URL] [--no-wait]');
    process.exit(1);
  }
  const opt = (flag: string, fallback = '') => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
  };
  if (!opt('--client').trim()) {
    console.error(
      'A client name is required — documents are filed by person.\n' +
        '  tsx scripts/ingest.ts <bundle.pdf> --client "Daniel James Marsh" [--dob 14/03/1984] [--ref UI-22-0815-4471]',
    );
    process.exit(1);
  }
  return {
    file,
    base: opt('--base', 'http://localhost:3000'),
    wait: !argv.includes('--no-wait'),
    device: opt('--device', 'script-device'),
    // Without a client the pipeline has nothing to compare documents against,
    // so every one comes back "uncertain" — which looks like a model failure
    // and is really a missing input.
    client: opt('--client'),
    dob: opt('--dob'),
    ref: opt('--ref'),
  };
}

async function buildInventoryNode(bytes: Uint8Array): Promise<PageInventory[]> {
  // The legacy build runs under Node without a DOM.
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = require.resolve(
    'pdfjs-dist/legacy/build/pdf.worker.mjs',
  );

  const task = pdfjs.getDocument({ data: bytes, useSystemFonts: true });
  const doc = await task.promise;
  const pages: PageInventory[] = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1, rotation: 0 });
    let text = '';
    try {
      const content = await page.getTextContent();
      text = content.items
        .map((i: { str?: string }) => i.str ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    } catch {
      text = '';
    }
    pages.push({
      page_number: n,
      rotation: page.rotate ?? 0,
      width: viewport.width,
      height: viewport.height,
      has_text_layer: text.replace(/\s/g, '').length >= 20,
      text,
    });
    page.cleanup();
  }

  await task.destroy();
  return pages;
}

async function main() {
  const args = parseArgs();
  const bytes = new Uint8Array(await readFile(args.file));
  console.log(`Bundle: ${basename(args.file)} (${(bytes.length / 1048576).toFixed(1)} MB)`);

  // 1. session + signed upload URL
  const createRes = await fetch(`${args.base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      device_id: args.device,
      name: basename(args.file).replace(/\.pdf$/i, ''),
      client_name: args.client,
      client_dob: args.dob,
      client_ref: args.ref,
    }),
  });
  if (!createRes.ok) throw new Error(`create session: ${await createRes.text()}`);
  const { session, upload } = await createRes.json();
  console.log(
    `Session ${session.id}  ·  client: ${args.client}` +
      (args.dob ? ` (${args.dob})` : '  (no DOB — name alone must separate people)'),
  );

  // 2. upload straight to Storage, bypassing the app server entirely
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  const { error: upErr } = await sb.storage
    .from(upload.bucket)
    .uploadToSignedUrl(upload.path, upload.token, bytes, {
      contentType: 'application/pdf',
    });
  if (upErr) throw new Error(`upload: ${upErr.message}`);
  console.log('Uploaded to storage');

  // 3. inventory
  const t0 = Date.now();
  const pages = await buildInventoryNode(bytes);
  const scans = pages.filter((p) => !p.has_text_layer).length;
  console.log(
    `Inventory: ${pages.length} pages in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `— ${pages.length - scans} with a text layer, ${scans} needing OCR`,
  );

  const invRes = await fetch(`${args.base}/api/sessions/${session.id}/inventory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pages }),
  });
  if (!invRes.ok) throw new Error(`inventory: ${await invRes.text()}`);
  const inv = await invRes.json();
  console.log(`Queued ${inv.windows} classify windows`);

  if (!args.wait) {
    console.log(`\n${args.base}/s/${session.id}`);
    return;
  }

  // 4. drive the queue, three windows at a time
  const started = Date.now();
  for (;;) {
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        fetch(`${args.base}/api/jobs/tick`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: session.id }),
        })
          .then((r) => r.json())
          .catch((e) => ({ idle: true, error: String(e) })),
      ),
    );

    const blocked = results.find((r) => r.blocked);
    if (blocked) {
      console.log(`\nStopped: ${blocked.blocked}`);
      break;
    }
    for (const r of results) {
      if (r.error) console.log(`  window error: ${r.error}`);
    }

    const last = results.find((r) => typeof r.remaining === 'number');
    if (last) {
      process.stdout.write(
        `\r  ${last.done}/${last.total} windows done (${((Date.now() - started) / 1000).toFixed(0)}s)   `,
      );
    }
    if (results.every((r) => r.idle)) break;
  }

  const final = await fetch(`${args.base}/api/sessions/${session.id}`).then((r) => r.json());
  console.log(`\n\nStatus: ${final.session.status}`);
  if (final.proposal) {
    const docs = final.proposal.docs;
    console.log(
      `Revision ${final.proposal.revision}: ${docs.length} documents ` +
        `(${docs.filter((d: { excluded: boolean }) => d.excluded).length} excluded)`,
    );
    console.log(`Summary: ${final.proposal.summary ?? '—'}`);
  }
  if (final.validation) {
    console.log(
      final.validation.ok
        ? `Page accounting: ${final.validation.assigned + final.validation.excluded}/${final.validation.pageCount} ✓`
        : `Page accounting BROKEN: ${final.validation.errors.join('; ')}`,
    );
  }
  console.log(`\n${args.base}/s/${session.id}`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
