/**
 * Who a claim is made to.
 *
 * The model reads the insurer's name off the form, but a scanned claim names it
 * several ways across its own pages — "Religare Health Insurance Company
 * Limited" on Part A, "RELIGARE" on the NEFT form, "Care Health Insurance"
 * after the 2020 rebrand — and grouping on the raw string would split one
 * claim into three. Every known variant maps to one canonical name here.
 *
 * Third-party administrators (TPAs) and government schemes are listed too:
 * claim paperwork is often on a TPA's letterhead rather than the insurer's.
 * Anything not listed still works, just tidied rather than recognised.
 */

interface Insurer {
  /** Canonical full name, as shown in titles and the summary. */
  name: string;
  /** One or two words for the child PDF's file name. */
  short: string;
  /** Distinctive phrases, matched as whole words against the lowercased name. */
  aliases: string[];
}

export const INSURERS: Insurer[] = [
  // Standalone health insurers
  { name: 'Care Health Insurance (formerly Religare Health Insurance)', short: 'Care Health', aliases: ['care health', 'religare'] },
  { name: 'Star Health and Allied Insurance', short: 'Star Health', aliases: ['star health'] },
  { name: 'Niva Bupa Health Insurance (formerly Max Bupa)', short: 'Niva Bupa', aliases: ['niva bupa', 'max bupa', 'bupa'] },
  { name: 'Aditya Birla Health Insurance', short: 'Aditya Birla', aliases: ['aditya birla'] },
  { name: 'ManipalCigna Health Insurance', short: 'ManipalCigna', aliases: ['manipalcigna', 'manipal cigna', 'cigna ttk', 'cignattk', 'cigna'] },
  { name: 'Galaxy Health Insurance', short: 'Galaxy Health', aliases: ['galaxy health'] },
  { name: 'Narayana Health Insurance', short: 'Narayana Health', aliases: ['narayana health insurance'] },
  // Public sector general insurers
  { name: 'The New India Assurance Company', short: 'New India', aliases: ['new india'] },
  { name: 'United India Insurance Company', short: 'United India', aliases: ['united india'] },
  { name: 'National Insurance Company', short: 'National Insurance', aliases: ['national insurance'] },
  { name: 'The Oriental Insurance Company', short: 'Oriental', aliases: ['oriental insurance'] },
  // Private general insurers. Bank and finance-group names on their own
  // ("HDFC", "ICICI", "Bajaj") are deliberately NOT aliases: a claim's NEFT
  // form carries the claimant's bank, and that must not read as the insurer.
  { name: 'HDFC ERGO General Insurance', short: 'HDFC ERGO', aliases: ['hdfc ergo', 'apollo munich'] },
  { name: 'ICICI Lombard General Insurance', short: 'ICICI Lombard', aliases: ['icici lombard'] },
  { name: 'Bajaj Allianz General Insurance', short: 'Bajaj Allianz', aliases: ['bajaj allianz', 'bajaj general'] },
  { name: 'Tata AIG General Insurance', short: 'Tata AIG', aliases: ['tata aig'] },
  { name: 'Reliance General Insurance', short: 'Reliance General', aliases: ['reliance general', 'reliance health insurance'] },
  { name: 'SBI General Insurance', short: 'SBI General', aliases: ['sbi general'] },
  { name: 'IFFCO Tokio General Insurance', short: 'IFFCO Tokio', aliases: ['iffco tokio', 'iffco'] },
  { name: 'Cholamandalam MS General Insurance', short: 'Cholamandalam', aliases: ['cholamandalam', 'chola ms'] },
  { name: 'Generali Central Insurance (formerly Future Generali)', short: 'Generali', aliases: ['future generali', 'generali central', 'generali'] },
  { name: 'Universal Sompo General Insurance', short: 'Universal Sompo', aliases: ['universal sompo'] },
  { name: 'Royal Sundaram General Insurance', short: 'Royal Sundaram', aliases: ['royal sundaram'] },
  { name: 'Liberty General Insurance', short: 'Liberty General', aliases: ['liberty general', 'liberty videocon'] },
  { name: 'Zurich Kotak General Insurance (formerly Kotak Mahindra General)', short: 'Zurich Kotak', aliases: ['zurich kotak', 'kotak mahindra general', 'kotak general'] },
  { name: 'Go Digit General Insurance', short: 'Digit', aliases: ['go digit', 'digit insurance', 'digit general'] },
  { name: 'Acko General Insurance', short: 'Acko', aliases: ['acko'] },
  { name: 'Navi General Insurance', short: 'Navi', aliases: ['navi general'] },
  { name: 'Magma General Insurance (formerly Magma HDI)', short: 'Magma', aliases: ['magma general', 'magma hdi'] },
  { name: 'Shriram General Insurance', short: 'Shriram', aliases: ['shriram general'] },
  { name: 'Zuno General Insurance (formerly Edelweiss General)', short: 'Zuno', aliases: ['zuno', 'edelweiss general'] },
  { name: 'Kshema General Insurance (formerly Raheja QBE)', short: 'Kshema', aliases: ['kshema', 'raheja qbe'] },
  // Third-party administrators
  { name: 'Medi Assist Insurance TPA', short: 'Medi Assist', aliases: ['medi assist', 'mediassist'] },
  { name: 'Paramount Health Services & Insurance TPA', short: 'Paramount TPA', aliases: ['paramount health', 'paramount'] },
  { name: 'MDIndia Health Insurance TPA', short: 'MDIndia TPA', aliases: ['mdindia', 'md india'] },
  { name: 'Family Health Plan Insurance TPA', short: 'FHPL', aliases: ['family health plan', 'fhpl'] },
  { name: 'Raksha Health Insurance TPA', short: 'Raksha TPA', aliases: ['raksha'] },
  { name: 'Vidal Health Insurance TPA', short: 'Vidal TPA', aliases: ['vidal health', 'vidal'] },
  { name: 'Health India Insurance TPA', short: 'Health India TPA', aliases: ['health india'] },
  { name: 'Heritage Health Insurance TPA', short: 'Heritage TPA', aliases: ['heritage health'] },
  { name: 'Ericson Insurance TPA', short: 'Ericson TPA', aliases: ['ericson'] },
  { name: 'Park Mediclaim Insurance TPA', short: 'Park Mediclaim', aliases: ['park mediclaim'] },
  { name: 'Safeway Insurance TPA', short: 'Safeway TPA', aliases: ['safeway'] },
  { name: 'Genins India Insurance TPA', short: 'Genins TPA', aliases: ['genins'] },
  { name: 'East West Assist Insurance TPA', short: 'East West TPA', aliases: ['east west assist'] },
  { name: 'Good Health Insurance TPA', short: 'Good Health TPA', aliases: ['good health'] },
  { name: 'Vipul Medcorp Insurance TPA', short: 'Vipul TPA', aliases: ['vipul medcorp', 'vipul'] },
  // Government schemes
  { name: 'Ayushman Bharat PM-JAY', short: 'PM-JAY', aliases: ['pm jay', 'pmjay', 'ayushman bharat', 'ayushman'] },
  { name: 'Central Government Health Scheme (CGHS)', short: 'CGHS', aliases: ['cghs', 'central government health scheme'] },
  { name: "Employees' State Insurance (ESIC)", short: 'ESIC', aliases: ['esic', 'employees state insurance'] },
];

const words = (s: string) =>
  ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Company-form words that say nothing about WHICH insurer it is. */
const FILLER =
  /\b(the|company|co|limited|ltd|pvt|private|insurance|general|health|assurance|tpa|india|of)\b/g;

export interface InsurerMatch {
  name: string;
  short: string;
  /** Stable grouping key: the same for every spelling of one insurer. */
  key: string;
  /** False when the name was tidied but not found in the list. */
  known: boolean;
}

/** Resolve an insurer name as read off a page, or null if there is none. */
export function matchInsurer(raw: string | null | undefined): InsurerMatch | null {
  const text = (raw ?? '').trim();
  if (!text || /^unknown$/i.test(text)) return null;

  const hay = words(text);
  for (const ins of INSURERS) {
    if (ins.aliases.some((a) => hay.includes(` ${a} `))) {
      return { name: ins.name, short: ins.short, key: ins.short.toLowerCase(), known: true };
    }
  }

  // Not a listed insurer: keep the name as read, minus the company-form words,
  // so "Acme Insurance Co. Ltd" and "ACME INSURANCE" still group together.
  const core = hay.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  if (!core) return null;
  const tidy = text.replace(/\b(company|co\.?|limited|ltd\.?|pvt\.?|private)\b/gi, '').replace(/\s+/g, ' ').trim();
  const short = core.split(' ').slice(0, 2).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return { name: tidy, short, key: core, known: false };
}
