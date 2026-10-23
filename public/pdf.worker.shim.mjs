/**
 * Worker entry point for pdf.js.
 *
 * The worker runs in its own global scope, so a polyfill applied on the main
 * thread does not reach it. pdf.js v6's worker calls
 * `Map.prototype.getOrInsertComputed` in 21 places; on a browser that predates
 * that method the worker dies and the preview silently never renders.
 *
 * This file patches the scope, then loads the real worker. pdf.js spawns its
 * worker with `type: "module"`, so the import below is valid.
 *
 * Kept in sync with the installed pdf.js by the `copy-pdf-worker` npm script,
 * which also runs on postinstall.
 */

function patch(proto) {
  if (typeof proto.getOrInsertComputed !== 'function') {
    Object.defineProperty(proto, 'getOrInsertComputed', {
      value: function (key, compute) {
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
      value: function (key, value) {
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

patch(Map.prototype);
patch(WeakMap.prototype);

await import('./pdf.worker.min.mjs');
