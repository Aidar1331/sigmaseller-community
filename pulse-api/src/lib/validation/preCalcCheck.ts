/**
 * Pre-calculation validation — checks raw data before computeBucketKPIs().
 *
 * Catches data integrity issues early:
 * - Missing data (incomplete sync)
 * - NaN/Infinity in raw fields
 * - Logical impossibilities
 * - Torgstat dependency warnings
 */

export interface PreCalcIssue {
  field: string;
  value: number | string;
  rule: string;
  severity: 'info' | 'warning' | 'error';
}

export interface PreCalcResult {
  ok: boolean;
  issues: PreCalcIssue[];
  dataCompleteness: {
    hasFinance: boolean;
    hasOrders: boolean;
    hasFunnel: boolean;
    hasStocks: boolean;
    hasAdv: boolean;
    hasRetail: boolean;     // Torgstat dependency
    hasCogs: boolean;
  };
}

interface RawDataForCheck {
  // Finance
  payoutKopecks: number;
  retailKopecks: number;
  commissionKopecks: number;
  ppvzVwKopecks: number;
  logisticsKopecks: number;
  storageKopecks: number;
  additionalPaymentKopecks: number;

  // Orders
  ordersCount: number;
  ordersKopecks: number;
  salesCount: number;
  salesKopecks: number;

  // Funnel
  viewCount: number;
  openCardCount: number;
  addToCartCount: number;
  orderCount: number;
  buyoutCount: number;

  // Stock
  stockQty: number;

  // Adv
  advKopecks: number;

  // COGS
  cogsKopecks: number;

  // Meta
  daysInPeriod: number;
}

/**
 * Run pre-calculation checks on raw aggregated data.
 */
export function runPreCalcCheck(raw: RawDataForCheck): PreCalcResult {
  const issues: PreCalcIssue[] = [];

  const check = (
    condition: boolean,
    field: string,
    value: number | string,
    rule: string,
    severity: 'info' | 'warning' | 'error'
  ) => {
    if (condition) {
      issues.push({ field, value, rule, severity });
    }
  };

  // ── Data completeness ──────────────────────────────────────
  const hasFinance = raw.payoutKopecks > 0 || raw.commissionKopecks > 0;
  const hasOrders = raw.ordersCount > 0;
  const hasFunnel = raw.viewCount > 0;
  const hasStocks = raw.stockQty > 0;
  const hasAdv = raw.advKopecks > 0;
  const hasRetail = raw.retailKopecks > 0;
  const hasCogs = raw.cogsKopecks > 0;

  check(!hasFinance && hasOrders, 'finance', 0,
    'Есть заказы, но нет финансовых данных — синхронизация финансов не завершена',
    'warning');

  check(!hasOrders && hasFinance, 'orders', 0,
    'Есть финансовые данные, но нет заказов — синхронизация заказов не завершена',
    'warning');

  check(!hasFunnel && hasOrders, 'funnel', 0,
    'Есть заказы, но нет данных воронки — синхронизация воронки не завершена',
    'info');

  check(!hasRetail && hasFinance, 'retail', 0,
    'Нет retail данных для Торгстат — маржа будет оценочной (от заказов)',
    'warning');

  check(!hasCogs && hasOrders, 'cogs', 0,
    'Себестоимость не загружена — ROCE и полная маржа недоступны',
    'info');

  // ── NaN/Infinity checks ────────────────────────────────────
  const numericFields: Array<[string, number]> = [
    ['payoutKopecks', raw.payoutKopecks],
    ['retailKopecks', raw.retailKopecks],
    ['commissionKopecks', raw.commissionKopecks],
    ['ordersKopecks', raw.ordersKopecks],
    ['salesKopecks', raw.salesKopecks],
    ['advKopecks', raw.advKopecks],
    ['cogsKopecks', raw.cogsKopecks],
    ['logisticsKopecks', raw.logisticsKopecks],
    ['storageKopecks', raw.storageKopecks],
  ];

  for (const [name, val] of numericFields) {
    if (!Number.isFinite(val)) {
      issues.push({
        field: name,
        value: String(val),
        rule: `${name} = ${val} — NaN или Infinity в исходных данных`,
        severity: 'error',
      });
    }
  }

  // ── Logical invariants ─────────────────────────────────────
  check(
    hasRetail && raw.payoutKopecks > raw.retailKopecks * 1.05,
    'payout_vs_retail',
    raw.payoutKopecks,
    `Выплата (${raw.payoutKopecks}) > выручки (${raw.retailKopecks}) — нарушение инварианта payout ≤ retail`,
    'error'
  );

  check(
    raw.salesCount > raw.ordersCount && raw.ordersCount > 0,
    'sales_vs_orders',
    raw.salesCount,
    `Продаж (${raw.salesCount}) больше чем заказов (${raw.ordersCount})`,
    'warning'
  );

  check(
    raw.buyoutCount > raw.orderCount && raw.orderCount > 0,
    'buyout_vs_funnel_orders',
    raw.buyoutCount,
    `Выкупов воронки (${raw.buyoutCount}) больше чем заказов воронки (${raw.orderCount})`,
    'warning'
  );

  check(
    raw.openCardCount > raw.viewCount && raw.viewCount > 0,
    'opens_vs_views',
    raw.openCardCount,
    `Открытий карточки (${raw.openCardCount}) больше чем просмотров (${raw.viewCount})`,
    'error'
  );

  // ── Period consistency ─────────────────────────────────────
  check(
    raw.daysInPeriod <= 0,
    'daysInPeriod',
    raw.daysInPeriod,
    'Период ≤ 0 дней — некорректный диапазон дат',
    'error'
  );

  return {
    ok: issues.filter(i => i.severity === 'error').length === 0,
    issues,
    dataCompleteness: {
      hasFinance,
      hasOrders,
      hasFunnel,
      hasStocks,
      hasAdv,
      hasRetail,
      hasCogs,
    },
  };
}
