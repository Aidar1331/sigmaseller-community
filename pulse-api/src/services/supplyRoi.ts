/**
 * ROI калькулятор для FBW/FBS поставок (Промпт #2, 2026-05-31).
 *
 * Считает ROI/маржу/окупаемость до того, как селлер потратился на
 * поставку. Покрывает 7 слагаемых затрат: COGS, логистика селлера,
 * комиссия WB, приёмка, хранение, эквайринг, налог УСН.
 *
 * Источники данных и нюансы (по результатам реального аудита БД):
 *   - per-nm financial разбивка живёт в wb_finance_daily_products только
 *     для ws=1, 12 (партнёрский ключ). У остальных fallback на shop-level
 *     usrednit'd commission. confidence в этом случае ≤ 'medium'.
 *   - commission_kopecks хранится отрицательным (списания) → ABS().
 *   - storage_kopecks в wb_finance_daily_products почти всегда 0 (WB
 *     списывает редкими крупными суммами через отчёт). Реальные дневные
 *     начисления — в wb_storage_daily.cost (integer, в копейках).
 *   - acceptance_cost в wb_supplies кеше везде NULL → берём live из
 *     WB Tariffs через getSupplyDates() в момент расчёта.
 *   - COGS заполнен только у нескольких nmId — главный edge case.
 *
 * Возвращает SupplyRoiResult с разбивкой и список warnings, который
 * AI-чат и UI должны показать пользователю.
 */

import { sql, eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { wbCogs, cashflowSettings } from '../db/schema.js';
import { log as rootLog } from '../lib/logger.js';

const log = rootLog.child({ module: 'supplyRoi' });

// ── Типы ────────────────────────────────────────────────────────────────────

export type SupplyRoiCosts = {
  cogs: number;
  sellerLogistics: number;
  wbCommission: number;
  acceptance: number;
  storage: number;
  acquiring: number;
  tax: number;
  total: number;
};

export type SupplyRoiResult = {
  revenueKopForecast: number;
  costsKop: SupplyRoiCosts;
  /** Прибыль / выручка, в процентах */
  marginPct: number;
  /** (Прибыль / затраты) × 100% */
  roiPct: number;
  /** Сколько дней до полного возврата вложений */
  paybackDays: number;
  /** Сколько дней займёт оборачиваемость партии */
  turnoverDays: number;
  /** Уверенность в прогнозе: high требует полные данные; low — много fallback'ов */
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
};

export type ComputeSupplyRoiOpts = {
  /** Дата поставки (для приёмки и сезонности). По умолчанию — сегодня. */
  plannedDate?: Date;
  /** shopId — нужен для shop-level fallback при отсутствии per-nm finance. */
  shopId?: number;
  /** Acceptance cost за единицу в копейках. Если не передан — fallback 0. */
  acceptanceCostPerUnitKop?: number;
};

// ── Константы ──────────────────────────────────────────────────────────────

const DEFAULT_BUYOUT_RATE = 0.85; // 85% — рынок-средний выкуп если нет данных
const DEFAULT_COMMISSION_SHARE = 0.05; // 5% — если нет ни per-nm, ни shop-level
const SELLER_LOGISTICS_FALLBACK_PCT = 0.012; // 1.2% от revenue если нет в COGS
const ACQUIRING_PCT = 0.01; // 1% эквайринг
const TURNOVER_CAP_DAYS = 60;
const MIN_ORDERS_PER_DAY = 0.1; // floor для slow-moving SKU

// ── Главная функция ────────────────────────────────────────────────────────

export async function computeSupplyRoi(
  workspaceId: number,
  nmId: number,
  qty: number,
  warehouseId: number,
  opts: ComputeSupplyRoiOpts = {},
): Promise<SupplyRoiResult> {
  const warnings: string[] = [];
  let confidence: 'high' | 'medium' | 'low' = 'high';

  // 1) Заказы — среднее за 30д
  const ordersRow = await db.execute(sql`
    SELECT
      AVG(orders_count)::float8 AS avg_orders,
      SUM(orders_rub)::bigint AS total_revenue_kop,
      SUM(orders_count)::bigint AS total_orders
    FROM wb_orders_sales_daily_products
    WHERE workspace_id = ${workspaceId}
      AND nm_id = ${nmId}
      AND date >= TO_CHAR(CURRENT_DATE - INTERVAL '30 days', 'YYYY-MM-DD')
  `);
  const ord = (ordersRow as any).rows?.[0] ?? {};
  let avgOrdersPerDay = Number(ord.avg_orders ?? 0);
  const totalOrders = Number(ord.total_orders ?? 0);
  const totalRevenueKop = Number(ord.total_revenue_kop ?? 0);

  if (avgOrdersPerDay <= 0 || totalOrders === 0) {
    warnings.push('Нет данных о продажах за 30 дней — точный прогноз невозможен');
    confidence = 'low';
    avgOrdersPerDay = MIN_ORDERS_PER_DAY;
  } else if (avgOrdersPerDay < 1) {
    warnings.push('Низкая оборачиваемость (<1 заказ/день) — ROI оценочный');
    if (confidence === 'high') confidence = 'medium';
    avgOrdersPerDay = Math.max(avgOrdersPerDay, MIN_ORDERS_PER_DAY);
  }

  // Средний revenue за заказ (включает скидку) — копейки
  const avgRevenuePerOrderKop = totalOrders > 0
    ? Math.round(totalRevenueKop / totalOrders)
    : 0;
  if (avgRevenuePerOrderKop === 0) {
    warnings.push('Нет данных о цене продажи');
    return emptyResult(warnings);
  }

  // 2) Возвраты → buyout rate
  const returnsRow = await db.execute(sql`
    SELECT COUNT(*)::int AS returns_cnt
    FROM wb_returns
    WHERE workspace_id = ${workspaceId}
      AND nm_id = ${nmId}
      AND created_at >= NOW() - INTERVAL '30 days'
  `);
  const returnsCnt = Number((returnsRow as any).rows?.[0]?.returns_cnt ?? 0);
  const buyoutRate = totalOrders > 0
    ? Math.max(0.6, 1 - returnsCnt / Math.max(1, totalOrders))
    : DEFAULT_BUYOUT_RATE;

  // 3) Оборачиваемость партии и forecast revenue
  const turnoverDays = Math.min(TURNOVER_CAP_DAYS, Math.max(1, qty / avgOrdersPerDay));
  const revenueKopForecast = Math.round(
    avgOrdersPerDay * avgRevenuePerOrderKop * buyoutRate * turnoverDays,
  );

  // 4) COGS и логистика селлера
  const cogs = await db
    .select()
    .from(wbCogs)
    .where(and(eq(wbCogs.workspaceId, workspaceId), eq(wbCogs.nmId, nmId)))
    .limit(1);
  const cogsRow = cogs[0];
  let cogsKop = 0;
  let sellerLogisticsKop = 0;
  if (!cogsRow || cogsRow.cogsKopecks === 0) {
    warnings.push('COGS не заполнен — точный ROI невозможен. Заполни себестоимость в /cogs.');
    confidence = 'low';
  } else {
    cogsKop = cogsRow.cogsKopecks * qty;
  }
  const sellerLogisticsPerUnit = cogsRow?.logisticsPerUnitKop ?? 0;
  if (sellerLogisticsPerUnit > 0) {
    sellerLogisticsKop = sellerLogisticsPerUnit * qty;
  } else {
    // Fallback: 1.2% от revenue
    sellerLogisticsKop = Math.round(revenueKopForecast * SELLER_LOGISTICS_FALLBACK_PCT);
    if (confidence === 'high') confidence = 'medium';
  }

  // 5) Комиссия WB — per-nm если есть (ws=1, 12), иначе shop-level
  const wbCommissionKop = await computeWbCommission(workspaceId, nmId, revenueKopForecast, warnings);
  if (wbCommissionKop.fellBack && confidence === 'high') confidence = 'medium';

  // 6) Приёмка — берём из opts (live из supplies/client.ts)
  const acceptanceCostKop = (opts.acceptanceCostPerUnitKop ?? 0) * qty;

  // 7) Хранение — wb_storage_daily.cost (integer, копейки) × turnoverDays
  const storageRow = await db.execute(sql`
    SELECT AVG(cost)::float8 AS avg_storage_kop
    FROM wb_storage_daily
    WHERE workspace_id = ${workspaceId}
      AND nm_id = ${nmId}
      AND date >= NOW() - INTERVAL '14 days'
  `);
  const avgStorageKopPerDay = Number((storageRow as any).rows?.[0]?.avg_storage_kop ?? 0);
  const storageKop = Math.round(avgStorageKopPerDay * qty * turnoverDays);

  // 8) Эквайринг
  const acquiringKop = Math.round(revenueKopForecast * ACQUIRING_PCT);

  // 9) Налог
  const settingsRow = await db
    .select()
    .from(cashflowSettings)
    .where(eq(cashflowSettings.workspaceId, workspaceId))
    .limit(1);
  const taxRateBp = settingsRow[0]?.taxRateBp ?? 600;
  const taxKop = Math.round((revenueKopForecast * taxRateBp) / 10_000);

  // 10) Промо-период в горизонте.
  // wb_events.date — text (YYYY-MM-DD), поэтому сравниваем как text/date.
  // Любая ошибка (e.g. отсутствие категории/таблицы) — не блокирует ROI.
  try {
    const promoRow = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt
      FROM wb_events
      WHERE workspace_id = ${workspaceId}
        AND category = 'promo'
        AND date::date >= CURRENT_DATE
        AND date::date <= CURRENT_DATE + ${Math.ceil(turnoverDays)}::int
    `);
    const promoCnt = Number((promoRow as any).rows?.[0]?.cnt ?? 0);
    if (promoCnt > 0) {
      warnings.push('В горизонте есть промо — реальный revenue может отличаться');
      if (confidence === 'high') confidence = 'medium';
    }
  } catch (e) {
    log.debug({ err: (e as any)?.message }, 'promo check skipped');
  }

  // ── Итог ────────────────────────────────────────────────────────────────
  const costsKop: SupplyRoiCosts = {
    cogs: cogsKop,
    sellerLogistics: sellerLogisticsKop,
    wbCommission: wbCommissionKop.kop,
    acceptance: acceptanceCostKop,
    storage: storageKop,
    acquiring: acquiringKop,
    tax: taxKop,
    total: cogsKop + sellerLogisticsKop + wbCommissionKop.kop + acceptanceCostKop
      + storageKop + acquiringKop + taxKop,
  };

  const marginPct = revenueKopForecast > 0
    ? Math.round(((revenueKopForecast - costsKop.total) / revenueKopForecast) * 100)
    : 0;
  const roiPct = costsKop.total > 0
    ? Math.round(((revenueKopForecast - costsKop.total) / costsKop.total) * 100)
    : 0;
  const paybackDays = avgOrdersPerDay > 0 && revenueKopForecast > 0
    ? Math.round(costsKop.total / (revenueKopForecast / turnoverDays))
    : 999;

  return {
    revenueKopForecast,
    costsKop,
    marginPct,
    roiPct,
    paybackDays,
    turnoverDays: Math.round(turnoverDays),
    confidence,
    warnings,
  };
}

// ── Хелперы ────────────────────────────────────────────────────────────────

async function computeWbCommission(
  workspaceId: number,
  nmId: number,
  revenueKopForecast: number,
  warnings: string[],
): Promise<{ kop: number; fellBack: boolean }> {
  // Сначала пытаемся per-nm (ws=1, ws=12 имеют партнёрский ключ → подробная финразбивка)
  const perNm = await db.execute(sql`
    SELECT AVG(ABS(commission_kopecks)::float8 / NULLIF(revenue_kopecks, 0))::float8 AS share
    FROM wb_finance_daily_products
    WHERE workspace_id = ${workspaceId}
      AND nm_id = ${nmId}
      AND date >= TO_CHAR(CURRENT_DATE - INTERVAL '30 days', 'YYYY-MM-DD')
      AND revenue_kopecks > 0
  `);
  let share = Number((perNm as any).rows?.[0]?.share ?? 0);
  if (share > 0) {
    return { kop: Math.round(revenueKopForecast * share), fellBack: false };
  }

  // Fallback на shop-level из wb_finance_daily
  const shopLevel = await db.execute(sql`
    SELECT AVG(ABS(commission_kopecks)::float8 / NULLIF(revenue_kopecks, 0))::float8 AS share
    FROM wb_finance_daily
    WHERE workspace_id = ${workspaceId}
      AND date >= TO_CHAR(CURRENT_DATE - INTERVAL '30 days', 'YYYY-MM-DD')
      AND revenue_kopecks > 0
  `);
  share = Number((shopLevel as any).rows?.[0]?.share ?? 0);
  if (share > 0) {
    warnings.push('Комиссия WB усреднена по магазину (нет per-nm данных)');
    return { kop: Math.round(revenueKopForecast * share), fellBack: true };
  }

  // Совсем нет данных — берём дефолт
  warnings.push('Нет данных о комиссии WB, используется средняя 5%');
  return { kop: Math.round(revenueKopForecast * DEFAULT_COMMISSION_SHARE), fellBack: true };
}

function emptyResult(warnings: string[]): SupplyRoiResult {
  return {
    revenueKopForecast: 0,
    costsKop: {
      cogs: 0, sellerLogistics: 0, wbCommission: 0, acceptance: 0,
      storage: 0, acquiring: 0, tax: 0, total: 0,
    },
    marginPct: 0, roiPct: 0, paybackDays: 999, turnoverDays: 0,
    confidence: 'low', warnings,
  };
}

// ── Утилита: форматирование для AI-чата ────────────────────────────────────

export function formatSupplyRoiForChat(result: SupplyRoiResult): string {
  const rub = (kop: number) => `${(kop / 100).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
  const c = result.costsKop;
  const lines = [
    `📊 ROI прогноз поставки`,
    ``,
    `Выручка (за ~${result.turnoverDays}д): ${rub(result.revenueKopForecast)}`,
    `Затраты всего:           ${rub(c.total)}`,
    `  ├─ Себестоимость:      ${rub(c.cogs)}`,
    `  ├─ Логистика селлера:  ${rub(c.sellerLogistics)}`,
    `  ├─ Комиссия WB:        ${rub(c.wbCommission)}`,
    `  ├─ Приёмка:            ${rub(c.acceptance)}`,
    `  ├─ Хранение:           ${rub(c.storage)}`,
    `  ├─ Эквайринг:          ${rub(c.acquiring)}`,
    `  └─ Налог:              ${rub(c.tax)}`,
    ``,
    `Маржа: ${result.marginPct}%  |  ROI: ${result.roiPct}%  |  Окупаемость: ${result.paybackDays}д`,
    `Уверенность: ${result.confidence}`,
  ];
  if (result.warnings.length > 0) {
    lines.push(``);
    for (const w of result.warnings) {
      lines.push(`⚠️ ${w}`);
    }
  }
  return lines.join('\n');
}
