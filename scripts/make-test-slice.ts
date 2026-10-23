/**
 * Cut a small test bundle out of the DEV bundle, together with a matching
 * answer key so it can be scored like the real thing.
 *
 *   npx tsx scripts/make-test-slice.ts <first> <last> <out-name>
 *
 * Pages are copied with pdf-lib, so the slice is byte-identical to the original
 * — same scans, same text layers, same rotation faults. Only documents that lie
 * ENTIRELY inside the range are kept; a half-included document would make the
 * answer key wrong and the score meaningless.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

const SRC = '../OneDrive_2_23-10-2026/Unbundle_Dev_Bundle.pdf';
const KEY = '../OneDrive_2_23-10-2026/Unbundle_Dev_Answer_Key.csv';

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

const expand = (spec: string): number[] => {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const t = part.trim();
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(t);
    if (m) for (let p = +m[1]; p <= +m[2]; p++) out.push(p);
    else if (/^\d+$/.test(t)) out.push(+t);
  }
  return out;
};

/** [1,2,3,5] -> "1-3, 5" in the answer key's own notation. */
function collapse(pages: number[]): string {
  const s = [...pages].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = s[0];
  let prev = s[0];
  for (const p of s.slice(1)) {
    if (p === prev + 1) { prev = p; continue; }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = p;
  }
  parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return parts.join(', ');
}

const quote = (f: string) => (/[",\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f);

async function main() {
  const [firstArg, lastArg, outName] = process.argv.slice(2);
  const first = Number(firstArg);
  const last = Number(lastArg);
  if (!Number.isInteger(first) || !Number.isInteger(last) || !outName) {
    console.error('usage: tsx scripts/make-test-slice.ts <first> <last> <out-name>');
    process.exit(1);
  }

  // -------------------------------------------------------------- the pdf
  const src = await PDFDocument.load(await readFile(SRC), { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const indices: number[] = [];
  for (let p = first; p <= last; p++) indices.push(p - 1);

  const copied = await out.copyPages(src, indices);
  for (const page of copied) out.addPage(page);
  out.setTitle(`Unbundle test slice — original pages ${first}-${last}`);

  const pdfPath = `${outName}.pdf`;
  await writeFile(pdfPath, await out.save());

  // -------------------------------------------------------- the answer key
  const rows = parseCsv(await readFile(KEY, 'utf8'));
  const header = rows[0].map((h) => h.trim());
  const pagesCol = header.indexOf('pages');
  const nCol = header.indexOf('n');

  const kept: string[][] = [];
  const dropped: string[] = [];

  for (const r of rows.slice(1)) {
    const ps = expand(r[pagesCol]);
    const inside = ps.filter((p) => p >= first && p <= last);
    if (inside.length === 0) continue;
    if (inside.length !== ps.length) {
      dropped.push(`${r[0]} (pages ${r[pagesCol]} straddles the cut)`);
      continue;
    }
    const remapped = inside.map((p) => p - first + 1);
    const copy = [...r];
    copy[pagesCol] = collapse(remapped);
    copy[nCol] = String(remapped.length);
    kept.push(copy);
  }

  const csvPath = `${outName}_answer_key.csv`;
  await writeFile(
    csvPath,
    [header, ...kept].map((r) => r.map(quote).join(',')).join('\n') + '\n',
  );

  // ------------------------------------------------------------- report
  const pageCount = last - first + 1;
  const singles = kept.filter((r) => Number(r[nCol]) === 1).length;
  console.log(`\n${pdfPath}  —  ${pageCount} pages, ${kept.length} documents`);
  console.log(`${csvPath}  —  answer key, page numbers remapped to 1-${pageCount}\n`);
  if (dropped.length) {
    console.log(`Excluded (not wholly inside the range):\n  ${dropped.join('\n  ')}\n`);
  }
  console.log(`Naive baseline for this slice: ${singles}/${kept.length} documents`);
  console.log('Contents:');
  for (const r of kept) {
    console.log(`  ${r[0].padEnd(5)} pages ${r[pagesCol].padEnd(8)} ${r[3].slice(0, 60)}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
