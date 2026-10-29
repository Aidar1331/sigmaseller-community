/**
 * Winsorization utilities.
 * Limit extreme values to reduce the impact of outliers.
 */

/**
 * Winsorize an array of values.
 * Replaces extreme values with percentile boundaries.
 * 
 * @param values - Array of numbers
 * @param lowerPercentile - Lower bound percentile (default: 5)
 * @param upperPercentile - Upper bound percentile (default: 95)
 * @returns Winsorized array
 * 
 * @example
 * winsorize([1, 2, 3, 100, 5, 6, 7, 8, 9, 10]) 
 * // Extreme value 100 replaced with 95th percentile
 */
export function winsorize(
  values: number[],
  lowerPercentile = 5,
  upperPercentile = 95
): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [...values];
  
  const sorted = [...values].sort((a, b) => a - b);
  
  // Calculate percentile indices
  const lowerIndex = Math.floor((lowerPercentile / 100) * (sorted.length - 1));
  const upperIndex = Math.ceil((upperPercentile / 100) * (sorted.length - 1));
  
  const lowerBound = sorted[lowerIndex];
  const upperBound = sorted[upperIndex];
  
  // Replace values outside bounds
  return values.map(v => {
    if (v < lowerBound) return lowerBound;
    if (v > upperBound) return upperBound;
    return v;
  });
}

/**
 * Calculate percentile value from sorted array.
 * 
 * @param sortedValues - Sorted array of numbers
 * @param percentile - Percentile (0-100)
 * @returns Value at percentile
 */
export function percentileValue(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  if (percentile <= 0) return sortedValues[0];
  if (percentile >= 100) return sortedValues[sortedValues.length - 1];
  
  const index = (percentile / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  
  if (lower === upper) return sortedValues[lower];
  
  // Linear interpolation
  const fraction = index - lower;
  return sortedValues[lower] + fraction * (sortedValues[upper] - sortedValues[lower]);
}

/**
 * Get percentile boundaries for a dataset.
 * 
 * @param values - Array of numbers
 * @param lowerPercentile - Lower percentile (default: 5)
 * @param upperPercentile - Upper percentile (default: 95)
 * @returns Boundary values
 */
export function getPercentileBounds(
  values: number[],
  lowerPercentile = 5,
  upperPercentile = 95
): { lower: number; upper: number } {
  if (values.length === 0) return { lower: 0, upper: 0 };
  
  const sorted = [...values].sort((a, b) => a - b);
  
  return {
    lower: percentileValue(sorted, lowerPercentile),
    upper: percentileValue(sorted, upperPercentile),
  };
}

/**
 * Clip a single value to bounds.
 * 
 * @param value - Value to clip
 * @param min - Minimum bound
 * @param max - Maximum bound
 * @returns Clipped value
 * 
 * @example
 * clip(150, 0, 100) // 100
 * clip(-10, 0, 100) // 0
 * clip(50, 0, 100) // 50
 */
export function clip(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Calculate trimmed mean (mean excluding extreme values).
 * 
 * @param values - Array of numbers
 * @param trimPercent - Percentage to trim from each end (default: 10)
 * @returns Trimmed mean
 * 
 * @example
 * trimmedMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]) 
 * // Excludes 1 and 100, returns mean of middle values
 */
export function trimmedMean(values: number[], trimPercent = 10): number {
  if (values.length === 0) return 0;
  if (values.length <= 2) {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
  
  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor((trimPercent / 100) * sorted.length);
  
  // Ensure we keep at least one value
  const start = Math.min(trimCount, Math.floor(sorted.length / 2) - 1);
  const end = Math.max(sorted.length - trimCount, Math.ceil(sorted.length / 2) + 1);
  
  const trimmed = sorted.slice(start, end);
  
  if (trimmed.length === 0) return sorted[Math.floor(sorted.length / 2)];
  
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}
