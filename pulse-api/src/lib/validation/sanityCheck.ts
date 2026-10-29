/**
 * Output sanity check — validates computed KPIs before sending to API response.
 * Catches unrealistic values that indicate data errors or calculation bugs.
 *
 * Pure functions, no DB/HTTP dependencies.
 */

export type IssueSeverity = 'info' | 'warning' | 'error';

export interface ValidationIssue {
  metric: string;
  value: number;
  rule: string;
  severity: IssueSeverity;
}

export interface SanityCheckResult {
  ok: boolean;
  issues: ValidationIssue[];
}

interface SanityInput {
  // Orders / Sales
  ordersCount?: number;
  salesCount?: number;
  returnsCount?: number;

  // Financial (rubles)
  marginPercent?: number;
  marginRub?: number;
  netProfitRub?: number;
  roiPercent?: number;
  rocePercent?: number;
  profitabilityPercent?: number;
  drrPercent?: number;
  payoutRub?: number;
  retailRub?: number;
  commissionRub?: number;

  // Funnel
  buyoutPercent?: number;
  viewToOpenPercent?: number;
  openToCartPercent?: number;
  cartToOrderPercent?: number;

  // Stock
  turnoverDays?: number;
  stockQty?: number;

  // Ad metrics
  advCtrPercent?: number;
  advCrPercent?: number;

  // Flags
  isMarginEstimated?: boolean;
}

/**
 * Run sanity checks on computed KPI bucket.
 *
 * @param input - Computed metrics to validate
 * @returns Result with ok flag and list of issues
 */
export function runSanityCheck(input: SanityInput): SanityCheckResult {
  const issues: ValidationIssue[] = [];

  const check = (
    condition: boolean,
    metric: string,
    value: number | undefined,
    rule: string,
    severity: IssueSeverity
  ) => {
    if (condition && value !== undefined) {
      issues.push({ metric, value, rule, severity });
    }
  };

  // ── Financial bounds ───────────────────────────────────────
  check(
    input.marginPercent !== undefined && (input.marginPercent < -200 || input.marginPercent > 200),
    'marginPercent', input.marginPercent,
    'Маржинальность вне [-200%, 200%] — возможна ошибка данных',
    'warning'
  );

  check(
    input.drrPercent !== undefined && input.drrPercent > 500,
    'drrPercent', input.drrPercent,
    'ДРР > 500% — расходы на рекламу многократно превышают выручку',
    'warning'
  );

  check(
    input.roiPercent !== undefined && input.roiPercent < -100,
    'roiPercent', input.roiPercent,
    'ROI < -100% — потеря больше вложенного',
    'warning'
  );

  check(
    input.profitabilityPercent !== undefined && (input.profitabilityPercent < -200 || input.profitabilityPercent > 100),
    'profitabilityPercent', input.profitabilityPercent,
    'Рентабельность вне [-200%, 100%]',
    'warning'
  );

  // ── Conversion bounds ──────────────────────────────────────
  check(
    input.buyoutPercent !== undefined && (input.buyoutPercent < 0 || input.buyoutPercent > 100),
    'buyoutPercent', input.buyoutPercent,
    'Выкуп вне [0%, 100%] — невозможное значение',
    'error'
  );

  check(
    input.viewToOpenPercent !== undefined && input.viewToOpenPercent > 100,
    'viewToOpenPercent', input.viewToOpenPercent,
    'Конверсия просмотры→открытия > 100%',
    'error'
  );

  check(
    input.openToCartPercent !== undefined && input.openToCartPercent > 100,
    'openToCartPercent', input.openToCartPercent,
    'Конверсия открытия→корзина > 100%',
    'error'
  );

  check(
    input.cartToOrderPercent !== undefined && input.cartToOrderPercent > 100,
    'cartToOrderPercent', input.cartToOrderPercent,
    'Конверсия корзина→заказ > 100%',
    'error'
  );

  // ── Logical consistency ────────────────────────────────────
  check(
    input.ordersCount !== undefined && input.salesCount !== undefined && input.salesCount > input.ordersCount,
    'salesCount', input.salesCount,
    'Продаж больше чем заказов — невозможно',
    'warning'
  );

  check(
    input.salesCount !== undefined && input.returnsCount !== undefined && input.returnsCount > input.salesCount,
    'returnsCount', input.returnsCount,
    'Возвратов больше чем продаж',
    'warning'
  );

  // ── Stock ──────────────────────────────────────────────────
  check(
    input.turnoverDays !== undefined && input.turnoverDays < 0,
    'turnoverDays', input.turnoverDays,
    'Отрицательная оборачиваемость — ошибка данных',
    'error'
  );

  check(
    input.stockQty !== undefined && input.stockQty < 0,
    'stockQty', input.stockQty,
    'Отрицательный остаток — ошибка данных',
    'error'
  );

  // ── Ad metrics ─────────────────────────────────────────────
  check(
    input.advCtrPercent !== undefined && input.advCtrPercent > 50,
    'advCtrPercent', input.advCtrPercent,
    'CTR > 50% — подозрительно высокая кликабельность',
    'warning'
  );

  check(
    input.advCrPercent !== undefined && input.advCrPercent > 50,
    'advCrPercent', input.advCrPercent,
    'CR > 50% — подозрительно высокая конверсия рекламы',
    'warning'
  );

  // ── Torgstat dependency ────────────────────────────────────
  check(
    input.isMarginEstimated === true,
    'isMarginEstimated', 1,
    'Маржа оценочная — retail данные не загружены, используется fallback',
    'info'
  );

  check(
    input.payoutRub !== undefined && input.retailRub !== undefined && input.retailRub > 0 && input.payoutRub > input.retailRub,
    'payoutRub', input.payoutRub,
    'Выплата > выручки — нарушение инварианта payout ≤ retail',
    'error'
  );

  // ── NaN/Infinity detection ─────────────────────────────────
  const numericFields: [string, number | undefined][] = [
    ['marginPercent', input.marginPercent],
    ['drrPercent', input.drrPercent],
    ['roiPercent', input.roiPercent],
    ['buyoutPercent', input.buyoutPercent],
    ['turnoverDays', input.turnoverDays],
    ['marginRub', input.marginRub],
    ['netProfitRub', input.netProfitRub],
  ];

  for (const [name, val] of numericFields) {
    if (val !== undefined && !Number.isFinite(val)) {
      issues.push({
        metric: name,
        value: val,
        rule: `${name} = ${val} (NaN или Infinity) — ошибка вычислений`,
        severity: 'error',
      });
    }
  }

  return {
    ok: issues.filter(i => i.severity === 'error').length === 0,
    issues,
  };
}
