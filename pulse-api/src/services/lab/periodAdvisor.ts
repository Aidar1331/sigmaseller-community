/**
 * Period advisor — how large a sample does the user need for the hypotheses
 * they want to test? Returns a "badge" to show in the UI before computing
 * anything.
 *
 * Power analysis for Pearson r (approximation via Fisher-z):
 *
 *   Minimum n for detecting |r| = r₀ at two-sided α and power (1−β):
 *     n ≈ 3 + ((z_{α/2} + z_{1−β}) / atanh(r₀))²
 *
 * At α=0.05, β=0.2:  z_{α/2}=1.96, z_{1−β}=0.84 → (1.96+0.84)² = 7.84
 *
 *   r₀ = 0.3  →  n ≈ 85
 *   r₀ = 0.5  →  n ≈ 29
 *   r₀ = 0.7  →  n ≈ 13
 */

import { normalInv } from '../../lib/stat/correlation.js';

export type PeriodBadge = 'green' | 'yellow' | 'red';

export interface PowerEntry {
  r: number;
  minN: number;
  /** true if the requested n meets or exceeds minN */
  achievable: boolean;
}

export interface PeriodAdvice {
  n: number;
  powerByR: PowerEntry[];
  badge: PeriodBadge;
  message: string;
  recommendations: string[];
}

export interface AdvisePeriodOptions {
  /** Significance level (two-sided). Default 0.05. */
  alpha?: number;
  /** Statistical power (1 − β). Default 0.8. */
  power?: number;
  /** Scenarios to evaluate. Default [0.3, 0.5, 0.7]. */
  scenarios?: number[];
}

/**
 * Compute sample-size bands for a period of length `n` days.
 */
export function advisePeriod(n: number, opts: AdvisePeriodOptions = {}): PeriodAdvice {
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  const scenarios = opts.scenarios ?? [0.3, 0.5, 0.7];
  const zAlphaHalf = normalInv(1 - alpha / 2);
  const zBeta = normalInv(power);
  const numer = (zAlphaHalf + zBeta) ** 2;

  const powerByR: PowerEntry[] = scenarios.map(r => {
    const fz = Math.atanh(r);
    const minN = Math.ceil(3 + numer / (fz * fz));
    return { r, minN, achievable: n >= minN };
  });

  const achievable03 = powerByR.find(p => Math.abs(p.r - 0.3) < 1e-9)?.achievable ?? false;
  const achievable05 = powerByR.find(p => Math.abs(p.r - 0.5) < 1e-9)?.achievable ?? false;
  const achievable07 = powerByR.find(p => Math.abs(p.r - 0.7) < 1e-9)?.achievable ?? false;

  let badge: PeriodBadge;
  let message: string;
  const recommendations: string[] = [];

  if (achievable03) {
    badge = 'green';
    message = `n=${n} · связи от |r|≥0.3 улавливаем уверенно.`;
  } else if (achievable05) {
    badge = 'yellow';
    message = `n=${n} · уверенно ловим только |r|≥0.5. Слабые связи могут остаться незамеченными.`;
    recommendations.push('Расширьте период до ~85 дней для детекции слабых связей (|r|≥0.3).');
  } else if (achievable07) {
    badge = 'yellow';
    message = `n=${n} · уверенно различимы только сильные связи |r|≥0.7.`;
    recommendations.push('Расширьте период до ~30 дней для детекции умеренных связей (|r|≥0.5).');
  } else {
    badge = 'red';
    message = `n=${n} · недостаточно даже для сильных связей — результаты будут крайне нестабильны.`;
    recommendations.push('Минимум 14 дней, рекомендуется 30+, оптимум 60 дней и более.');
  }

  // Additional nudges
  if (n < 28) {
    recommendations.push('STL-декомпозиция недельной сезонности требует минимум 28 дней.');
  }
  if (n < 40) {
    recommendations.push('Детекция точек перелома (change-points) требует минимум 40 дней.');
  }
  if (n < 50) {
    recommendations.push('Granger-causality / lag-анализ требуют минимум 50 дней.');
  }

  return { n, powerByR, badge, message, recommendations };
}

/**
 * Days in an inclusive [dateFrom, dateTo] range.
 */
export function countDays(dateFrom: string, dateTo: string): number {
  const a = new Date(dateFrom + 'T00:00:00Z').getTime();
  const b = new Date(dateTo + 'T00:00:00Z').getTime();
  if (b < a) return 0;
  return Math.round((b - a) / (24 * 60 * 60 * 1000)) + 1;
}
