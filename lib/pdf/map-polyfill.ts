/**
 * Polyfill for `Map.prototype.getOrInsert` / `getOrInsertComputed`.
 *
 * pdf.js v6 uses these throughout — 17 call sites in the main build and 21 in
 * the worker — and they are very new (the TC39 "upsert" proposal). Browsers a
 * version or two behind throw `getOrInsertComputed is not a function` from
 * inside `page.render()`, which surfaces as a blank preview.
 *
 * The legacy pdf.js build does NOT help here: it uses them too.
 *
 * Must be imported before pdf.js itself. ES modules evaluate in import order,
 * so the import at the top of `client.ts` is enough on the main thread; the
 * worker gets the same treatment via `public/pdf.worker.shim.mjs`, since it
 * runs in a separate global scope.
 */

type Upsertable = {
  has(key: unknown): boolean;
  get(key: unknown): unknown;
  set(key: unknown, value: unknown): unknown;
  getOrInsert?: unknown;
  getOrInsertComputed?: unknown;
};

function patch(proto: Upsertable) {
  if (typeof proto.getOrInsertComputed !== 'function') {
    Object.defineProperty(proto, 'getOrInsertComputed', {
      value: function (this: Upsertable, key: unknown, compute: (k: unknown) => unknown) {
        if (this.has(key)) return this.get(key);
        const value = compute(key);
        this.set(key, value);
        return value;
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  if (typeof proto.getOrInsert !== 'function') {
    Object.defineProperty(proto, 'getOrInsert', {
      value: function (this: Upsertable, key: unknown, value: unknown) {
        if (this.has(key)) return this.get(key);
        this.set(key, value);
        return value;
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}

patch(Map.prototype as unknown as Upsertable);
patch(WeakMap.prototype as unknown as Upsertable);

// pdf.js also patches `Iterator.prototype` at module load. Node 20 (which runs
// this module during server rendering) has no global `Iterator`, so expose one
// backed by the built-in %IteratorPrototype%.
if (typeof (globalThis as { Iterator?: unknown }).Iterator === 'undefined') {
  const IteratorPrototype = Object.getPrototypeOf(
    Object.getPrototypeOf([][Symbol.iterator]()),
  );
  function Iterator() {}
  Iterator.prototype = IteratorPrototype;
  Object.defineProperty(globalThis, 'Iterator', {
    value: Iterator,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

export {};
