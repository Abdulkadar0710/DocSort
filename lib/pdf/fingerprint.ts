import { createHash } from 'node:crypto';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFRawStream,
  PDFRef,
  type PDFObject,
} from 'pdf-lib';

/**
 * Find pages that are exact copies of an earlier page.
 *
 * A bundle often carries the same page twice — the same scan inserted again,
 * or a whole document repeated. The page reader cannot be relied on to notice:
 * a copied page directly after its original reads as "continues the previous
 * page", and was joined into the same document, where the document-level
 * duplicate check never looks.
 *
 * Exact copies need no model at all. Each page is fingerprinted from
 * everything that draws it — its content streams and the images, fonts and
 * forms they use — so two pages with the same fingerprint render identically.
 * Re-scans of one record differ byte-for-byte and are left to the model's
 * side-by-side check (lib/ai/duplicates.ts).
 *
 * Returns copy page → the earliest page it duplicates (1-based).
 */
export async function exactDuplicatePages(bundle: Uint8Array): Promise<Map<number, number>> {
  const doc = await PDFDocument.load(bundle, { ignoreEncryption: true });
  const ctx = doc.context;

  const fingerprint = (page: PDFDict): string => {
    const hash = createHash('sha256');
    const seen = new Set<string>();
    const walk = (obj: PDFObject | undefined): void => {
      if (obj === undefined) return;
      if (obj instanceof PDFRef) {
        if (seen.has(obj.tag)) return;
        seen.add(obj.tag);
        return walk(ctx.lookup(obj));
      }
      if (obj instanceof PDFRawStream) {
        hash.update(obj.getContents());
        return walk(obj.dict);
      }
      if (obj instanceof PDFDict) {
        for (const [key, value] of obj.entries()) {
          // The parent is the page tree, shared by every page: not content.
          if (key.asString() === '/Parent') continue;
          hash.update(key.asString());
          walk(value);
        }
        return;
      }
      if (obj instanceof PDFArray) {
        for (const value of obj.asArray()) walk(value);
        return;
      }
      hash.update(String(obj));
    };
    walk(page);
    return hash.digest('hex');
  };

  const firstSeen = new Map<string, number>();
  const copies = new Map<number, number>();
  doc.getPages().forEach((page, i) => {
    const fp = fingerprint(page.node);
    const original = firstSeen.get(fp);
    if (original === undefined) firstSeen.set(fp, i + 1);
    else copies.set(i + 1, original);
  });
  return copies;
}
