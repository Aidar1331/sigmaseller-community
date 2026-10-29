/**
 * Format utilities for currency and percentage conversions.
 * All functions are pure and have no external dependencies.
 */

/**
 * Convert kopecks to rubles with optional rounding.
 * @param kopecks - Amount in kopecks (integer)
 * @param decimals - Number of decimal places (default: 2)
 * @returns Amount in rubles
 * 
 * @example
 * kopecksToRub(12345) // 123.45
 * kopecksToRub(12345, 0) // 123
 * kopecksToRub(-500) // -5.00
 */
export function kopecksToRub(kopecks: number, decimals = 2): number {
  if (!Number.isFinite(kopecks)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round((kopecks / 100) * factor) / factor;
}

/**
 * Convert rubles to kopecks.
 * @param rubles - Amount in rubles
 * @returns Amount in kopecks (integer)
 * 
 * @example
 * rubToKopecks(123.45) // 12345
 */
export function rubToKopecks(rubles: number): number {
  if (!Number.isFinite(rubles)) return 0;
  return Math.round(rubles * 100);
}

/**
 * Convert basis points to percent.
 * 1 basis point = 0.01%
 * @param basisPoints - Value in basis points
 * @param decimals - Number of decimal places (default: 2)
 * @returns Percentage value
 * 
 * @example
 * basisPointsToPercent(500) // 5.00
 * basisPointsToPercent(1234) // 12.34
 */
export function basisPointsToPercent(basisPoints: number, decimals = 2): number {
  if (!Number.isFinite(basisPoints)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round((basisPoints / 100) * factor) / factor;
}

/**
 * Convert percent to basis points.
 * @param percent - Percentage value
 * @returns Value in basis points
 * 
 * @example
 * percentToBasisPoints(5.00) // 500
 */
export function percentToBasisPoints(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.round(percent * 100);
}

/**
 * Round a metric to specified decimal places.
 * Handles edge cases (NaN, Infinity).
 * @param value - Value to round
 * @param decimals - Number of decimal places (default: 2)
 * @returns Rounded value or 0 for invalid inputs
 * 
 * @example
 * roundMetric(123.4567) // 123.46
 * roundMetric(NaN) // 0
 * roundMetric(Infinity) // 0
 */
export function roundMetric(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Format a number with thousand separators.
 * @param value - Value to format
 * @param locale - Locale for formatting (default: 'ru-RU')
 * @returns Formatted string
 * 
 * @example
 * formatNumber(1234567.89) // "1 234 567,89"
 */
export function formatNumber(value: number, locale = 'ru-RU'): string {
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString(locale);
}

/**
 * Format currency amount (rubles).
 * @param kopecks - Amount in kopecks
 * @param locale - Locale for formatting (default: 'ru-RU')
 * @returns Formatted currency string
 * 
 * @example
 * formatCurrency(1234567) // "12 345,67 ₽"
 */
export function formatCurrency(kopecks: number, locale = 'ru-RU'): string {
  const rubles = kopecksToRub(kopecks);
  return rubles.toLocaleString(locale, { style: 'currency', currency: 'RUB' });
}

/**
 * Format percentage with % sign.
 * @param value - Percentage value (0-100)
 * @param decimals - Number of decimal places (default: 1)
 * @returns Formatted percentage string
 * 
 * @example
 * formatPercent(12.345) // "12.3%"
 */
export function formatPercent(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '0%';
  return `${roundMetric(value, decimals)}%`;
}
