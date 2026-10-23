/**
 * Boundary colours for the preview.
 *
 * Per the brief, colour carries NO meaning: it does not encode document type or
 * any other category. Its only job is to separate neighbouring documents, and a
 * colour may be reused so long as two adjacent documents never share one.
 *
 * Cycling the palette by index satisfies that constraint by construction — for
 * any palette longer than one entry, i and i+1 can never land on the same slot.
 * No graph colouring needed.
 */
export interface BoundaryColor {
  /** Border / rule colour. */
  line: string;
  /** Tinted page background. */
  fill: string;
  /** Chip background for the document label. */
  chip: string;
  /** Text colour that reads on `chip`. */
  chipText: string;
}

export const PALETTE: BoundaryColor[] = [
  { line: '#2563eb', fill: 'rgba(37,99,235,0.06)', chip: '#dbeafe', chipText: '#1e3a8a' },
  { line: '#16a34a', fill: 'rgba(22,163,74,0.06)', chip: '#dcfce7', chipText: '#14532d' },
  { line: '#db2777', fill: 'rgba(219,39,119,0.06)', chip: '#fce7f3', chipText: '#831843' },
  { line: '#ea580c', fill: 'rgba(234,88,12,0.06)', chip: '#ffedd5', chipText: '#7c2d12' },
  { line: '#7c3aed', fill: 'rgba(124,58,237,0.06)', chip: '#ede9fe', chipText: '#4c1d95' },
  { line: '#0891b2', fill: 'rgba(8,145,178,0.06)', chip: '#cffafe', chipText: '#164e63' },
  { line: '#ca8a04', fill: 'rgba(202,138,4,0.06)', chip: '#fef9c3', chipText: '#713f12' },
  { line: '#4f46e5', fill: 'rgba(79,70,229,0.06)', chip: '#e0e7ff', chipText: '#312e81' },
];

/** Excluded pages get a deliberately non-palette treatment so they read as
 *  intentionally set aside rather than accidentally missed. */
export const EXCLUDED_COLOR: BoundaryColor = {
  line: '#94a3b8',
  fill: 'rgba(148,163,184,0.10)',
  chip: '#e2e8f0',
  chipText: '#334155',
};

export function colorFor(index: number, excluded: boolean): BoundaryColor {
  if (excluded) return EXCLUDED_COLOR;
  return PALETTE[index % PALETTE.length];
}
