/**
 * Runs once at server start, before any request is rendered.
 *
 * Client components that import pdf.js are still evaluated on the server for
 * the initial render, and pdf.js patches `Iterator.prototype` at module load.
 * Node 20 has no global `Iterator`, and import order inside `lib/pdf/client.ts`
 * is not enough to guarantee the polyfill runs first on the server, so it is
 * installed here as well.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./lib/pdf/map-polyfill');
  }
}
