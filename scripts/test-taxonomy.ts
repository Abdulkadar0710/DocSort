/**
 * Assertions for the fixed category taxonomy.
 *   npx tsx scripts/test-taxonomy.ts
 *
 * ensureBaseCategories itself touches the database and is not unit-tested
 * here — staleCategoryNames is the pure, deterministic half of its cleanup
 * step: deciding which currently-active categories are NOT one of the fixed
 * seven, so they can be deactivated.
 */
import { FIXED_CATEGORIES, normaliseName, staleCategoryNames } from '../lib/ai/taxonomy';

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) pass++;
  else fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const cat = (name: string) => ({ name });

// The taxonomy is exactly these seven, nothing more.
{
  const names = FIXED_CATEGORIES.map((c) => c.name);
  check('there are exactly 9 fixed categories (8 + Excluded)', names.length === 9, names.join(', '));
  check(
    'the eight reviewer-facing categories are all present',
    ['Letters', 'Receipts', 'Prescriptions', 'Reports', 'Notes', 'Discharge Summaries', 'Insurance Claims', 'Unknown Type'].every((n) =>
      names.includes(n),
    ),
    names.join(', '),
  );
  check('Excluded is still present for blank pages', names.includes('Excluded'));
  check(
    'every category has a real name, description and short label',
    FIXED_CATEGORIES.every((c) => c.name && c.description && c.short_label),
  );
}

// staleCategoryNames: the fixed ones are never stale, whatever else is active.
{
  const active = FIXED_CATEGORIES.map((c) => cat(c.name));
  check('the fixed categories themselves are never stale', staleCategoryNames(active).length === 0);
}

// The exact kind of pollution this design replaces — real category names
// pulled from this session's own database — all come back as stale.
{
  const pollution = [
    'Lab Reports',
    'Laboratory Reports',
    'Laboratory Results',
    'Hospital Bills',
    'Hospital Billing',
    'Hospital Bills and Receipts',
    'Diagnostic Centre Receipts',
    'Pharmacy Receipts',
    'Pharmacy Bills and Receipts',
    'Pharmacy Memos',
    'Payment Receipts',
    'Invoices',
    'Clinical Consultation Notes',
    'GP Records and Correspondence',
    'Other',
  ].map(cat);
  const stale = staleCategoryNames([...FIXED_CATEGORIES.map((c) => cat(c.name)), ...pollution]);
  check(
    'every polluted category name comes back as stale',
    pollution.every((p) => stale.includes(p.name)),
    stale.join(', '),
  );
  check(
    'none of the fixed categories are caught up in the cleanup',
    FIXED_CATEGORIES.every((c) => !stale.includes(c.name)),
    stale.join(', '),
  );
  check('exactly the pollution, nothing more, comes back as stale', stale.length === pollution.length);
}

// A spelling/casing variant of a fixed category is NOT stale — the same
// normaliseName-based identity check ensureCategory already used.
{
  const stale = staleCategoryNames([cat('letters'), cat('RECEIPTS'), cat('Prescription')]);
  check(
    'a case or pluralisation variant of a fixed name is not treated as stale',
    stale.length === 0,
    stale.join(', '),
  );
}

// An empty active list is simply empty — nothing to deactivate.
check('nothing active means nothing stale', staleCategoryNames([]).length === 0);

// normaliseName itself: sanity check it still folds the way ensureBaseCategories relies on.
check('normaliseName folds casing and plurals', normaliseName('Receipts') === normaliseName('receipt'));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('Fixed taxonomy behaves correctly.\n');
