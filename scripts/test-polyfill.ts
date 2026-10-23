/**
 * Asserts the Map upsert polyfill pdf.js v6 depends on.
 *   npx tsx scripts/test-polyfill.ts
 *
 * pdf.js v6 calls `Map.prototype.getOrInsertComputed` in 17 places in its main
 * build and 21 in its worker. Browsers that predate the method throw from
 * inside `page.render()` and the preview silently never appears — which is
 * exactly what happened on a reviewer's machine. The legacy pdf.js build is not
 * a way out: it uses the method too.
 *
 * The natives are deleted here before importing the polyfill, so this exercises
 * the shipped code path rather than the platform's own implementation.
 */

type Upsertable = {
  getOrInsertComputed?: unknown;
  getOrInsert?: unknown;
};

const M = Map.prototype as unknown as Upsertable;
const W = WeakMap.prototype as unknown as Upsertable;

delete M.getOrInsertComputed;
delete M.getOrInsert;
delete W.getOrInsertComputed;
delete W.getOrInsert;

interface UpsertMap<K, V> extends Map<K, V> {
  getOrInsertComputed(key: K, compute: (k: K) => V): V;
  getOrInsert(key: K, value: V): V;
}
interface UpsertWeakMap<K extends object, V> extends WeakMap<K, V> {
  getOrInsertComputed(key: K, compute: (k: K) => V): V;
}

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean) => {
  if (cond) pass++;
  else fails.push(name);
};

async function main() {
// Imported AFTER the deletions above so the polyfill actually installs.
await import('../lib/pdf/map-polyfill');

check('polyfill installed on Map', typeof M.getOrInsertComputed === 'function');
check('polyfill installed on WeakMap', typeof W.getOrInsertComputed === 'function');

const m = new Map<string, number>([['a', 1]]) as UpsertMap<string, number>;

let computeCalls = 0;
check(
  'existing key returns its stored value',
  m.getOrInsertComputed('a', () => {
    computeCalls++;
    return 99;
  }) === 1,
);
check('existing key never runs the callback', computeCalls === 0);

check('missing key computes and returns', m.getOrInsertComputed('b', () => 2) === 2);
check('missing key is actually inserted', m.get('b') === 2);
check('callback receives the key', m.getOrInsertComputed('c', (k) => k.length) === 1);

check('getOrInsert inserts when absent', m.getOrInsert('d', 4) === 4 && m.get('d') === 4);
check('getOrInsert keeps an existing value', m.getOrInsert('a', 123) === 1);

// The trap a naive `if (!this.get(key))` implementation falls into. pdf.js
// caches zeros, empty strings and nulls; recomputing them would corrupt state
// in ways that surface far from here.
const falsy = new Map<string, number>([['z', 0]]) as UpsertMap<string, number>;
check('a stored falsy value is not recomputed', falsy.getOrInsertComputed('z', () => 7) === 0);

const nullish = new Map<string, number | null>([['n', null]]) as UpsertMap<string, number | null>;
check('a stored null is not recomputed', nullish.getOrInsertComputed('n', () => 5) === null);

const key = {};
const wm = new WeakMap<object, string>() as UpsertWeakMap<object, string>;
check(
  'WeakMap upsert works',
  wm.getOrInsertComputed(key, () => 'v') === 'v' && wm.get(key) === 'v',
);

check(
  'the method is not enumerable',
  !Object.keys(Map.prototype).includes('getOrInsertComputed'),
);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('Map upsert polyfill behaves correctly.\n');
}

void main();
