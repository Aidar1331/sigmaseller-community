/**
 * Anomaly detection utilities.
 * Detect unusual spikes or drops in time series data.
 * 
 * Uses median + threshold approach for robustness against outliers.
 */

/**
 * Calculate median of an array.
 * 
 * @param values - Array of numbers
 * @returns Median value
 * 
 * @example
 * median([1, 2, 3, 4, 5]) // 3
 * median([1, 2, 3, 4]) // 2.5
 * median([]) // 0
 */
export function median(values: number[]): number {
  if (!values.length) return 0;
  
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Calculate Median Absolute Deviation (MAD).
 * More robust than standard deviation for anomaly detection.
 * 
 * @param values - Array of numbers
 * @returns MAD value
 */
export function mad(values: number[]): number {
  if (values.length < 2) return 0;
  
  const med = median(values);
  const deviations = values.map(v => Math.abs(v - med));
  return median(deviations);
}

/**
 * Detected anomaly.
 */
export interface Anomaly {
  /** Index in the series */
  index: number;
  /** Date/key if provided */
  key?: string;
  /** Actual value */
  value: number;
  /** Expected value (median of window) */
  expected: number;
  /** Deviation from expected (%) */
  deviationPercent: number;
  /** Type of anomaly */
  type: 'spike' | 'drop';
}

/**
 * Configuration for anomaly detection.
 */
export interface AnomalyConfig {
  /** Size of rolling window for calculating baseline (default: 7) */
  windowSize?: number;
  /** Threshold percentage for anomaly (default: 20) */
  thresholdPercent?: number;
  /** Minimum absolute value to consider (ignore small variations) */
  minAbsoluteValue?: number;
  /** Keys/dates for each value (optional) */
  keys?: string[];
}

/**
 * Detect anomalies in a time series.
 * Uses rolling median and threshold comparison.
 * 
 * @param values - Array of values (chronological order)
 * @param config - Detection configuration
 * @returns Array of detected anomalies
 * 
 * @example
 * detectAnomalies([10, 11, 10, 50, 12, 11]) // [{index: 3, type: 'spike', ...}]
 * detectAnomalies([100, 98, 102, 20, 99]) // [{index: 3, type: 'drop', ...}]
 */
export function detectAnomalies(
  values: number[],
  config: AnomalyConfig = {}
): Anomaly[] {
  const {
    windowSize = 7,
    thresholdPercent = 20,
    minAbsoluteValue = 0,
    keys,
  } = config;
  
  const anomalies: Anomaly[] = [];
  
  // Need at least windowSize + 1 values
  if (values.length < windowSize + 1) return anomalies;
  
  for (let i = windowSize; i < values.length; i++) {
    // Get window before current point
    const window = values.slice(i - windowSize, i);
    const windowMedian = median(window);
    const currentValue = values[i];
    
    // Skip if median is 0 (avoid division by zero)
    if (windowMedian === 0) continue;
    
    // Skip if value is below minimum threshold
    if (Math.abs(currentValue) < minAbsoluteValue && Math.abs(windowMedian) < minAbsoluteValue) {
      continue;
    }
    
    // Calculate deviation
    const deviation = ((currentValue - windowMedian) / windowMedian) * 100;
    
    // Check if anomaly
    if (Math.abs(deviation) >= thresholdPercent) {
      anomalies.push({
        index: i,
        key: keys?.[i],
        value: currentValue,
        expected: windowMedian,
        deviationPercent: deviation,
        type: deviation > 0 ? 'spike' : 'drop',
      });
    }
  }
  
  return anomalies;
}

/**
 * Detect anomalies in a keyed series (e.g., date → value).
 * 
 * @param series - Object with keys and values
 * @param config - Detection configuration
 * @returns Array of detected anomalies
 */
export function detectAnomaliesInSeries(
  series: Record<string, number>,
  config: AnomalyConfig = {}
): Anomaly[] {
  const sortedKeys = Object.keys(series).sort();
  const values = sortedKeys.map(k => series[k]);
  
  return detectAnomalies(values, { ...config, keys: sortedKeys });
}

/**
 * Check if a single value is anomalous compared to historical data.
 * 
 * @param currentValue - Value to check
 * @param historicalValues - Historical values (oldest first)
 * @param thresholdPercent - Threshold for anomaly (default: 20)
 * @returns Anomaly info or null
 */
export function checkForAnomaly(
  currentValue: number,
  historicalValues: number[],
  thresholdPercent = 20
): { type: 'spike' | 'drop'; deviationPercent: number } | null {
  if (historicalValues.length === 0) return null;
  
  const expected = median(historicalValues);
  if (expected === 0) return null;
  
  const deviation = ((currentValue - expected) / expected) * 100;
  
  if (Math.abs(deviation) >= thresholdPercent) {
    return {
      type: deviation > 0 ? 'spike' : 'drop',
      deviationPercent: deviation,
    };
  }
  
  return null;
}

/**
 * Classify anomaly severity.
 * 
 * @param deviationPercent - Absolute deviation percentage
 * @returns Severity level
 */
export function classifyAnomalySeverity(
  deviationPercent: number
): 'minor' | 'moderate' | 'significant' | 'severe' {
  const absDeviation = Math.abs(deviationPercent);
  
  if (absDeviation < 30) return 'minor';
  if (absDeviation < 50) return 'moderate';
  if (absDeviation < 100) return 'significant';
  return 'severe';
}
