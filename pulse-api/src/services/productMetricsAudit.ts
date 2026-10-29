/**
 * Product Metrics Audit (Промпт-фича оператора 2026-05-31)
 *
 * AI-аудит товара по МЕТРИКАМ и СОБЫТИЯМ (не по контенту карточки — для этого
 * есть creativeAuditV3).
 *
 * Цель: дать продавцу персональный чек-лист «что не так и что делать» с
 * пунктами как на референсе: 🔻 Падение заказов / 🚚 Логистика / 📉 Реклама /
 * 👁 Видимость / 💰 Цена / 🌱 Органика / 🗓 События.
 *
 * Архитектура:
 *  1) preflightCheck — отказываем для молодых товаров (<14д) / помечаем low-conf
 *  2) collectData — тянем все метрики за `periodDays` (по умолчанию 30) +
 *     сравнения с предыдущим периодом и средним по магазину
 *  3) buildPrompt — формируем структурированный prompt для Claude
 *  4) parseResult — разбираем JSON-ответ LLM в типизированный массив
 *
 * Условия достоверности встроены в промпт: LLM получает явные пороги
 * (≥1000 показов/день для CTR, ≥5 заказов/день для тренда, ≥20 завершённых
 * заказов для выкупа и т.д.) и обязан проставлять confidence: high/medium/low.
 * См. обсуждение методики 2026-05-31 в Telegram-сессии оператора.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { claudeChatJson } from '../integrations/ai/anthropic.js';
import { log as rootLog } from '../lib/logger.js';

const log = rootLog.child({ module: 'product-metrics-audit' });

export type AuditSeverity = 'critical' | 'warning' | 'good' | 'info';
export type AuditConfidence = 'high' | 'medium' | 'low';
export type AuditItemType =
  | 'orders_drop'
  | 'logistics'
  | 'ads'
  | 'visibility'
  | 'ctr_conv'
  | 'price'
  | 'organic'
  | 'events';

export interface AuditItem {
  id: string;
  type: AuditItemType;
  severity: AuditSeverity;
  /** Короткий заголовок (≤30 символов) */
  title: string;
  /** Основной текст пункта (1-3 предложения) */
  message: string;
  /** Конкретное действие (если есть) */
  action?: string;
  /** На чём основан вывод */
  confidence: AuditConfidence;
  /** Размер выборки на которой строится вывод (для прозрачности) */
  sampleSize?: string;
  /** С чем сравниваем */
  comparison?: string;
}

export interface AuditResult {
  /** Артикул товара */
  nmId: number;
  /** Название товара */
  productName: string;
  /** Период анализа в днях */
  periodDays: number;
  /** Pre-flight warning'и (если есть) — например «Товар слишком молодой» */
  preflightWarnings: string[];
  /** Список AI-выводов */
  items: AuditItem[];
  /** Можно ли вообще запускать аудит */
  canAudit: boolean;
  /** Сводка по «здоровью» товара */
  overallSeverity: AuditSeverity;
}

interface CollectedData {
  productName: string;
  category: string;
  daysSinceFirstSeen: number;
  // ── Orders ─────────────────────────────────────────────────
  ordersPeriod: { count: number; revenueRub: number; perDay: number };
  ordersPrevPeriod: { count: number; revenueRub: number; perDay: number };
  ordersDeltaPct: number | null;
  buyoutPct: number | null; // % выкупа
  buyoutsCount: number;
  // ── Funnel ─────────────────────────────────────────────────
  viewsPerDay: number;
  cartConvBp: number | null; // basis points (12.34% = 1234)
  orderConvBp: number | null;
  ctrBp: number | null;
  // ── Ads ────────────────────────────────────────────────────
  adsSpendRub: number;
  adsOrdersCount: number;
  adsRevenueRub: number;
  drrPct: number | null;
  // ── Stocks ─────────────────────────────────────────────────
  stocksTotal: number;     // FBO + FBS
  stocksFbo: number;       // на складах WB (учитывается в оборачиваемости)
  stocksFbs: number;       // на складе продавца (буфер, оборачиваемость продавец регулирует сам)
  daysToStockout: number | null;
  // ── Price ──────────────────────────────────────────────────
  currentPriceRub: number | null;
  priceChangesCount: number;
  // ── Events ─────────────────────────────────────────────────
  recentEvents: Array<{ type: string; date: string; meta?: string }>;
  // ── Workspace baseline (для сравнения) ─────────────────────
  workspaceAvgBuyoutPct: number | null;
  workspaceAvgDrrPct: number | null;
}

/**
 * Главная функция — оркестратор аудита.
 */
export async function runProductMetricsAudit(
  workspaceId: number,
  nmId: number,
  periodDays = 30,
): Promise<AuditResult> {
  log.info({ workspaceId, nmId, periodDays }, 'Starting metrics audit');

  // 1) Pre-flight check — товар существует?
  // Возраст карточки считаем по самой ранней записи sales/orders/funnel —
  // wb_cards.created_at ненадёжен (sync пересоздаёт строку), а первая запись
  // продаж точно говорит «товар уже был на витрине в этот день».
  const cardRow = await db.execute(sql`
    SELECT c.title, c.subject_name,
           COALESCE(EXTRACT(EPOCH FROM (NOW() - (
             SELECT MIN(date)::timestamptz FROM wb_orders_sales_daily_products
             WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
           )))/86400, 0) as days_seen
    FROM wb_cards c
    WHERE c.workspace_id = ${workspaceId} AND c.nm_id = ${nmId}
    LIMIT 1
  `);
  const card = (cardRow as any).rows?.[0];
  if (!card) {
    return {
      nmId,
      productName: `Артикул ${nmId}`,
      periodDays,
      preflightWarnings: ['Карточка товара не найдена в базе. Проверь что артикул правильный и магазин синхронизирован.'],
      items: [],
      canAudit: false,
      overallSeverity: 'info',
    };
  }

  const productName = card.title ?? `Артикул ${nmId}`;
  const category = card.subject_name ?? '—';
  const daysSinceFirstSeen = Math.round(Number(card.days_seen ?? 0));

  const preflightWarnings: string[] = [];
  if (daysSinceFirstSeen < 14) {
    preflightWarnings.push(
      `Товару только ${daysSinceFirstSeen} дн. Тренды и сравнения недостоверны — дай минимум 2 недели наблюдений.`,
    );
  }

  // 2) Сбор данных
  const data = await collectData(workspaceId, nmId, periodDays, productName, category, daysSinceFirstSeen);

  // Если товар совсем новый — отдаём только preflight, без LLM
  if (daysSinceFirstSeen < 7) {
    return {
      nmId,
      productName,
      periodDays,
      preflightWarnings,
      items: [{
        id: 'too-young',
        type: 'events',
        severity: 'info',
        title: 'Подожди ещё',
        message: `Товар на витрине ${daysSinceFirstSeen} дн. Аудит будет иметь смысл после 14+ дней — нужно накопить выборку показов и заказов.`,
        confidence: 'high',
      }],
      canAudit: false,
      overallSeverity: 'info',
    };
  }

  // 3) Промпт + LLM
  const items = await callLlm(workspaceId, data);

  // 4) Overall severity = худший из items
  const overallSeverity: AuditSeverity = items.some((i) => i.severity === 'critical')
    ? 'critical'
    : items.some((i) => i.severity === 'warning')
      ? 'warning'
      : items.some((i) => i.severity === 'good')
        ? 'good'
        : 'info';

  return {
    nmId,
    productName,
    periodDays,
    preflightWarnings,
    items,
    canAudit: true,
    overallSeverity,
  };
}

/**
 * Сбор всех метрик из БД одним блоком запросов.
 */
async function collectData(
  workspaceId: number,
  nmId: number,
  periodDays: number,
  productName: string,
  category: string,
  daysSinceFirstSeen: number,
): Promise<CollectedData> {
  const prevStart = `${periodDays * 2} days`;
  const periodStart = `${periodDays} days`;

  // Замечание про колонки (после реальной проверки схемы 2026-05-31):
  // - wb_orders_sales_daily_products: orders_rub (выручка), orders_count, sales_count, sales_rub
  // - wb_funnel_daily_products: open_card_count, add_to_cart_count, order_count, buyout_count, view_count
  // - wb_adv_daily_products: spend_kopecks, views_count, clicks_count, sum_price_kopecks
  // - wb_stocks_daily: qty, warehouse_id (нужна сумма по последней дате)
  // - wb_prices_history: price, discount
  // - wb_events: type, category, severity, title, description

  // Orders за текущий и предыдущий период
  const ordersRows = await db.execute(sql`
    WITH cur AS (
      SELECT COALESCE(SUM(orders_count), 0) AS cnt,
             COALESCE(SUM(orders_rub), 0) AS rev
      FROM wb_orders_sales_daily_products
      WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
        AND date::date >= CURRENT_DATE - ${sql.raw(`INTERVAL '${periodStart}'`)}
    ),
    prev AS (
      SELECT COALESCE(SUM(orders_count), 0) AS cnt,
             COALESCE(SUM(orders_rub), 0) AS rev
      FROM wb_orders_sales_daily_products
      WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
        AND date::date >= CURRENT_DATE - ${sql.raw(`INTERVAL '${prevStart}'`)}
        AND date::date <  CURRENT_DATE - ${sql.raw(`INTERVAL '${periodStart}'`)}
    )
    SELECT cur.cnt as cur_cnt, cur.rev as cur_rev,
           prev.cnt as prev_cnt, prev.rev as prev_rev
    FROM cur, prev
  `);
  const o = (ordersRows as any).rows?.[0] ?? {};
  const ordersCount = Number(o.cur_cnt ?? 0);
  const ordersRevenue = Number(o.cur_rev ?? 0);
  const prevOrdersCount = Number(o.prev_cnt ?? 0);
  const prevOrdersRev = Number(o.prev_rev ?? 0);

  // Funnel (источник % выкупа и конверсий)
  const funnelRows = await db.execute(sql`
    SELECT COALESCE(SUM(view_count), 0) AS views,
           COALESCE(SUM(open_card_count), 0) AS opens,
           COALESCE(SUM(add_to_cart_count), 0) AS carts,
           COALESCE(SUM(order_count), 0) AS orders,
           COALESCE(SUM(buyout_count), 0) AS buyouts,
           COUNT(DISTINCT date) AS days_with_data
    FROM wb_funnel_daily_products
    WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
      AND date::date >= CURRENT_DATE - ${sql.raw(`INTERVAL '${periodStart}'`)}
  `);
  const f = (funnelRows as any).rows?.[0] ?? {};
  const views = Number(f.views ?? 0);
  const opens = Number(f.opens ?? 0);
  const carts = Number(f.carts ?? 0);
  const fOrders = Number(f.orders ?? 0);
  const buyoutsCount = Number(f.buyouts ?? 0);
  const fDays = Math.max(1, Number(f.days_with_data ?? 1));
  const viewsPerDay = Math.round(views / fDays);
  // Basis points (12.34% = 1234)
  const ctrBp = views > 0 ? Math.round((opens / views) * 10000) : null; // показ → переход в карточку
  const cartConvBp = opens > 0 ? Math.round((carts / opens) * 10000) : null; // переход → корзина
  const orderConvBp = opens > 0 ? Math.round((fOrders / opens) * 10000) : null; // переход → заказ

  // Ads
  const adsRows = await db.execute(sql`
    SELECT COALESCE(SUM(spend_kopecks), 0)/100.0 AS spend_rub,
           COALESCE(SUM(orders_count), 0) AS orders,
           COALESCE(SUM(sum_price_kopecks), 0)/100.0 AS revenue_rub
    FROM wb_adv_daily_products
    WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
      AND date::date >= CURRENT_DATE - ${sql.raw(`INTERVAL '${periodStart}'`)}
  `);
  const a = (adsRows as any).rows?.[0] ?? {};
  const adsSpend = Number(a.spend_rub ?? 0);
  const adsOrders = Number(a.orders ?? 0);
  const adsRevenue = Number(a.revenue_rub ?? 0);
  const drrPct = adsRevenue > 0 ? (adsSpend / adsRevenue) * 100 : null;

  // Stocks — FBO qty по складам ВБ на последнюю дату (источник — Analytics API)
  const stockRows = await db.execute(sql`
    WITH last_date AS (
      SELECT MAX(date) AS d FROM wb_stocks_daily
      WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
    )
    SELECT COALESCE(SUM(qty), 0) AS total
    FROM wb_stocks_daily, last_date
    WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
      AND date = last_date.d
  `);
  const stocksFbo = Number((stockRows as any).rows?.[0]?.total ?? 0);
  // FBS-остатки (склад продавца) — источник wb_stocks_fbs_current. Учитываем,
  // чтобы AI не критиковал товары без FBO-остатков как "залежавшиеся" —
  // продавец сам управляет FBS-поставкой, оборачиваемость там другая логика.
  const fbsRows = await db.execute(sql`
    SELECT COALESCE(SUM(quantity), 0) AS total
    FROM wb_stocks_fbs_current
    WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
  `);
  const stocksFbs = Number((fbsRows as any).rows?.[0]?.total ?? 0);
  const stocksTotal = stocksFbo + stocksFbs;
  const ordersPerDay7 = ordersCount > 0 ? ordersCount / periodDays : 0;
  const daysToStockout = ordersPerDay7 > 0 && stocksTotal > 0
    ? Math.round(stocksTotal / ordersPerDay7)
    : null;

  // Price (последняя цена + кол-во изменений за период)
  const priceRows = await db.execute(sql`
    SELECT price, COUNT(*) OVER () AS changes_cnt
    FROM wb_prices_history
    WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
      AND date >= CURRENT_DATE - ${sql.raw(`INTERVAL '${periodStart}'`)}
    ORDER BY date DESC LIMIT 1
  `);
  const p = (priceRows as any).rows?.[0] ?? {};
  const currentPriceRub = p.price ? Number(p.price) : null;
  const priceChangesCount = Number(p.changes_cnt ?? 0);

  // События за период (wb_events: type, category, title, description)
  const eventRows = await db.execute(sql`
    SELECT type, category, title, description, date::date AS date
    FROM wb_events
    WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
      AND date::date >= CURRENT_DATE - ${sql.raw(`INTERVAL '${periodStart}'`)}
    ORDER BY date DESC LIMIT 15
  `);
  const recentEvents = ((eventRows as any).rows ?? []).map((r: any) => ({
    type: String(r.type ?? 'unknown'),
    date: String(r.date ?? ''),
    meta: r.title ? String(r.title).slice(0, 100) : (r.description ? String(r.description).slice(0, 100) : undefined),
  }));

  // Workspace baseline: средний % выкупа (из funnel) и ДРР (из adv)
  const wsRows = await db.execute(sql`
    WITH ws_funnel AS (
      SELECT SUM(order_count) AS total_orders, SUM(buyout_count) AS total_buyouts
      FROM wb_funnel_daily_products
      WHERE workspace_id = ${workspaceId}
        AND date::date >= CURRENT_DATE - ${sql.raw(`INTERVAL '${periodStart}'`)}
    ),
    ws_ads AS (
      SELECT SUM(spend_kopecks)/100.0 AS total_spend, SUM(sum_price_kopecks)/100.0 AS total_rev
      FROM wb_adv_daily_products
      WHERE workspace_id = ${workspaceId}
        AND date::date >= CURRENT_DATE - ${sql.raw(`INTERVAL '${periodStart}'`)}
    )
    SELECT ws_funnel.total_orders, ws_funnel.total_buyouts,
           ws_ads.total_spend, ws_ads.total_rev
    FROM ws_funnel, ws_ads
  `);
  const ws = (wsRows as any).rows?.[0] ?? {};
  const wsOrders = Number(ws.total_orders ?? 0);
  const wsBuyouts = Number(ws.total_buyouts ?? 0);
  const wsSpend = Number(ws.total_spend ?? 0);
  const wsRev = Number(ws.total_rev ?? 0);
  const workspaceAvgBuyoutPct = wsOrders > 0 ? (wsBuyouts / wsOrders) * 100 : null;
  const workspaceAvgDrrPct = wsRev > 0 ? (wsSpend / wsRev) * 100 : null;

  // Deltas
  const ordersDeltaPct = prevOrdersCount > 0
    ? ((ordersCount - prevOrdersCount) / prevOrdersCount) * 100
    : null;
  // Buyout берём из funnel (там точнее, есть buyout_count vs order_count)
  const buyoutPct = fOrders > 0 ? (buyoutsCount / fOrders) * 100 : null;

  return {
    productName,
    category,
    daysSinceFirstSeen,
    ordersPeriod: {
      count: ordersCount,
      revenueRub: ordersRevenue,
      perDay: Math.round((ordersCount / periodDays) * 10) / 10,
    },
    ordersPrevPeriod: {
      count: prevOrdersCount,
      revenueRub: prevOrdersRev,
      perDay: Math.round((prevOrdersCount / periodDays) * 10) / 10,
    },
    ordersDeltaPct,
    buyoutPct,
    buyoutsCount,
    viewsPerDay,
    cartConvBp,
    orderConvBp,
    ctrBp,
    adsSpendRub: adsSpend,
    adsOrdersCount: adsOrders,
    adsRevenueRub: adsRevenue,
    drrPct,
    stocksTotal,
    stocksFbo,
    stocksFbs,
    daysToStockout,
    currentPriceRub,
    priceChangesCount,
    recentEvents,
    workspaceAvgBuyoutPct,
    workspaceAvgDrrPct,
  };
}

const SYSTEM_PROMPT = `Ты product-аналитик в Sigma Seller — AI-помощнике продавцам Wildberries.

Получаешь данные о товаре за период (метрики, события, сравнения с предыдущим периодом и средним по магазину). Возвращаешь JSON с массивом items — чек-листом «что не так и что делать».

ЖЁСТКИЕ ПРАВИЛА статистической достоверности:
- Если показов <1000/день — нельзя делать выводы о CTR/конверсии (только confidence:"low" + предложить запустить аудит карточки/рекламу для увеличения трафика).
- Если заказов <5/день — нельзя строить тренд динамики (только low). Скачок ±50% при базе 5 заказов = шум.
- Если ДРР рассчитан при выручке с рекламы <50к ₽ за период — confidence:"low".
- Если выкуп считается на <20 завершённых заказов — confidence:"low", не сравнивать с категорией.
- Если товару <14 дней (daysSinceFirstSeen) — никакие тренды не делаем.
- Используй сравнения которые тебе дали (vs предыдущий период, vs средний по магазину). Не выдумывай «по категории» если данных категории нет.

ТИПЫ items (выбирай тип из этого списка, не выдумывай):
- "orders_drop"  — динамика заказов
- "logistics"    — остатки и дни до stock-out. ВАЖНО: остатки бывают двух типов:
                   * FBO (fboQty) — на складах WB, продавец зависит от поставок и оборачиваемости
                   * FBS (fbsQty) — на собственном складе продавца, отгружает сам
                   Если fboQty=0 и fbsQty>0 — это нормальный режим FBS, НЕ пиши про
                   "низкую оборачиваемость" или "залежавшийся товар". Продавец сам
                   контролирует поставку. Алёрт уместен только если общий totalQty
                   близок к 0 при стабильных продажах.
- "ads"          — реклама и ДРР
- "visibility"   — низкий трафик / показы
- "ctr_conv"     — конверсия по воронке
- "price"        — цена и изменения
- "organic"      — органические позиции (если нет данных — не добавляй пункт)
- "events"       — события за период

severity:
- "critical" — острая проблема, надо реагировать сегодня
- "warning"  — есть отклонение, стоит разобраться в течение недели
- "good"     — всё ок, метрика в норме (можно добавить максимум 1-2 таких)
- "info"     — нейтральный контекст / нет данных

confidence: "high"|"medium"|"low" — по правилам выше.

Каждый item:
- title: ≤30 символов, без эмоций
- message: 1-3 предложения, конкретные цифры и сравнения с данными
- action: одна короткая фраза «что делать» (если есть). Без воды.
- sampleSize: на чём посчитано (например «659 заказов за 30д»).
- comparison: с чем сравниваешь (например «vs средн. по магазину 75.6%»).

Верни JSON: { "items": AuditItem[] }, всего 4-7 пунктов. Не пиши воды, не повторяй данные дословно — анализируй.`;

async function callLlm(workspaceId: number, data: CollectedData): Promise<AuditItem[]> {
  const userPayload = {
    product: { name: data.productName, category: data.category, daysSinceFirstSeen: data.daysSinceFirstSeen },
    orders: {
      current: data.ordersPeriod,
      previous: data.ordersPrevPeriod,
      deltaPct: data.ordersDeltaPct,
      buyoutPct: data.buyoutPct,
      buyoutsCount: data.buyoutsCount,
    },
    funnel: {
      viewsPerDay: data.viewsPerDay,
      cartConvPct: data.cartConvBp !== null ? data.cartConvBp / 100 : null,
      orderConvPct: data.orderConvBp !== null ? data.orderConvBp / 100 : null,
    },
    ads: {
      spendRub: data.adsSpendRub,
      ordersCount: data.adsOrdersCount,
      revenueRub: data.adsRevenueRub,
      drrPct: data.drrPct,
    },
    stocks: {
      totalQty: data.stocksTotal,
      fboQty: data.stocksFbo,
      fbsQty: data.stocksFbs,
      daysToStockout: data.daysToStockout,
    },
    price: { currentRub: data.currentPriceRub, changesCount: data.priceChangesCount },
    events: data.recentEvents,
    workspaceBaseline: {
      avgBuyoutPct: data.workspaceAvgBuyoutPct,
      avgDrrPct: data.workspaceAvgDrrPct,
    },
  };

  const result = await claudeChatJson<{ items: AuditItem[] }>(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Данные товара:\n\n${JSON.stringify(userPayload, null, 2)}\n\nДай JSON с items[].` },
    ],
    {
      model: 'claude-sonnet-4-6',
      temperature: 0.2,
      maxTokens: 4096,
      meta: { workspaceId, charge: true, feature: 'product-metrics-audit' },
    },
  );

  const items = result.data?.items ?? [];
  // Normalize id для UI (на случай если LLM не выдал)
  return items.map((it, idx) => ({ ...it, id: it.id ?? `item-${idx}` }));
}
