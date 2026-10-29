/**
 * Common date utilities
 * 
 * Consolidates duplicated date functions across the codebase.
 * Import from here instead of defining locally.
 */

/**
 * Format date as ISO date string (YYYY-MM-DD)
 */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Add days to a date (returns new Date)
 */
export function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

/**
 * Subtract days from a date (returns new Date)
 */
export function subDays(d: Date, days: number): Date {
  return addDays(d, -days);
}

/**
 * Get start of day (UTC)
 */
export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

/**
 * Get end of day (UTC)
 */
export function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
}

/**
 * Parse ISO date string to Date
 */
export function parseIsoDate(s: string): Date {
  return new Date(s + 'T00:00:00Z');
}

/**
 * Get today's date as ISO string
 */
export function today(): string {
  return isoDate(new Date());
}

/**
 * Get date N days ago as ISO string
 */
export function daysAgo(n: number): string {
  return isoDate(subDays(new Date(), n));
}

/**
 * Check if date string is valid
 */
export function isValidDate(s: string): boolean {
  const d = new Date(s);
  return !isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Get date range array (inclusive)
 */
export function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  let current = parseIsoDate(from);
  const end = parseIsoDate(to);
  
  while (current <= end) {
    dates.push(isoDate(current));
    current = addDays(current, 1);
  }
  
  return dates;
}

/**
 * Format date for display (Russian locale)
 */
export function formatDateRu(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Get days between two dates
 */
export function daysBetween(from: Date | string, to: Date | string): number {
  const d1 = typeof from === 'string' ? new Date(from) : from;
  const d2 = typeof to === 'string' ? new Date(to) : to;
  const diffMs = d2.getTime() - d1.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}
