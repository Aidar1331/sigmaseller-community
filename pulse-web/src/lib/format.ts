// M15: branded type for kopecks. Plain `number` doesn't distinguish 100 rub
// from 100 kop, and a single accidental `priceRub * priceRub / 100` becomes
// a silent bug. Use this type at API boundaries (zod schemas, query results)
// to make the unit explicit. Callers that already use plain number can
// migrate gradually — this is additive, not a breaking change.
//
// Casting: `value as Kopecks` is intentional friction at the boundary; the
// helper `asKopecks(n)` makes the intent visible.
export type Kopecks = number & { readonly __brand: 'kopecks' };
export type Rubles  = number & { readonly __brand: 'rubles' };

export function asKopecks(n: number): Kopecks {
  return n as Kopecks;
}
export function asRubles(n: number): Rubles {
  return n as Rubles;
}
export function kopecksToRubles(k: Kopecks | number): Rubles {
  return asRubles((k as number) / 100);
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('ru-RU').format(n);
}

export function formatNumberShort(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('ru-RU', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(n);
}

export function formatRub(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n));
}

/** Format kopecks (cents) as rubles, rounded to whole numbers */
export function formatKopecksAsRub(kopecks: number): string {
  if (!Number.isFinite(kopecks)) return '—';
  return formatRub(kopecks / 100);
}

export function formatRubShort(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('ru-RU', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(n);
}

export function formatPct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);
}

const DOW_SHORT = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'] as const;

/**
 * Format ISO date "2026-02-14" → { date: "14.02", dow: "ПТ" }
 */
export function formatDateShort(iso: string): { date: string; dow: string } {
  const d = new Date(iso + 'T00:00:00Z');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return { date: `${dd}.${mm}`, dow: DOW_SHORT[d.getUTCDay()]! };
}

/**
 * Format week range from Monday ISO date → "09.02-15.02"
 */
export function formatWeekRange(isoStart: string): string {
  const d = new Date(isoStart + 'T00:00:00Z');
  const end = new Date(d);
  end.setUTCDate(end.getUTCDate() + 6);
  const dd1 = String(d.getUTCDate()).padStart(2, '0');
  const mm1 = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd2 = String(end.getUTCDate()).padStart(2, '0');
  const mm2 = String(end.getUTCMonth() + 1).padStart(2, '0');
  return `${dd1}.${mm1}-${dd2}.${mm2}`;
}
