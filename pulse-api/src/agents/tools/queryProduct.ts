/**
 * Tool: query_product — Detailed product info.
 * Combines data from wbCards, sales, stocks, funnel, ads.
 */

import { db } from '../../db/client.js';
import {
  wbCards,
  wbStocksCurrent,
  wbFunnelDailyProducts,
  wbAdvDailyProducts,
  wbCogs,
} from '../../db/schema.js';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import { getCurrentPriceInfo } from './priceInfo.js';

interface QueryProductArgs {
  nmId: number;
  from?: string;
  to?: string;
  _workspaceId?: number;
  _shopId?: number;
}

export async function queryProductDetails(args: QueryProductArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const now = new Date();
  const from = args.from ?? new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const to = args.to ?? now.toISOString().slice(0, 10);

  // Card info
  const [card] = await db
    .select()
    .from(wbCards)
    .where(and(eq(wbCards.workspaceId, wsId), ...(shopId ? [eq(wbCards.shopId, shopId)] : []), eq(wbCards.nmId, args.nmId)))
    .limit(1);

  if (!card) return JSON.stringify({ error: `Товар ${args.nmId} не найден в workspace` });

  // Current stock
  const stocks = await db
    .select({
      totalQty: sql<number>`coalesce(sum(${wbStocksCurrent.quantity}), 0)`.mapWith(Number),
      warehouseCount: sql<number>`count(distinct ${wbStocksCurrent.warehouseName})`.mapWith(Number),
    })
    .from(wbStocksCurrent)
    .where(and(eq(wbStocksCurrent.workspaceId, wsId), ...(shopId ? [eq(wbStocksCurrent.shopId, shopId)] : []), eq(wbStocksCurrent.nmId, args.nmId)));

  // Sales + funnel in one query — единый источник (WB Analytics
  // sales-funnel/products). До 2026-06-01 здесь был отдельный запрос к
  // wb_orders_sales_daily_products (Statistics API), но он расходился с
  // WB ЛК и с дашбордом РНП. Теперь все три источника совпадают.
  const funnel = await db
    .select({
      cardOpens: sql<number>`coalesce(sum(${wbFunnelDailyProducts.openCardCount}), 0)`.mapWith(Number),
      addToCart: sql<number>`coalesce(sum(${wbFunnelDailyProducts.addToCartCount}), 0)`.mapWith(Number),
      orders: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderCount}), 0)`.mapWith(Number),
      // *100 — funnel.*Sum в рублях, наружу даём копейки (контракт LLM).
      ordersSum: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderSum}) * 100, 0)`.mapWith(Number),
      buyouts: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutCount}), 0)`.mapWith(Number),
      buyoutsSum: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutSum}) * 100, 0)`.mapWith(Number),
      cancels: sql<number>`coalesce(sum(${wbFunnelDailyProducts.cancelCount}), 0)`.mapWith(Number),
    })
    .from(wbFunnelDailyProducts)
    .where(and(
      eq(wbFunnelDailyProducts.workspaceId, wsId),
      ...(shopId ? [eq(wbFunnelDailyProducts.shopId, shopId)] : []),
      eq(wbFunnelDailyProducts.nmId, args.nmId),
      gte(wbFunnelDailyProducts.date, from),
      lte(wbFunnelDailyProducts.date, to),
    ));

  // Ad spend
  const adv = await db
    .select({
      spendKop: sql<number>`coalesce(sum(${wbAdvDailyProducts.spendKopecks}), 0)`.mapWith(Number),
      views: sql<number>`coalesce(sum(${wbAdvDailyProducts.viewsCount}), 0)`.mapWith(Number),
      clicks: sql<number>`coalesce(sum(${wbAdvDailyProducts.clicksCount}), 0)`.mapWith(Number),
      orders: sql<number>`coalesce(sum(${wbAdvDailyProducts.ordersCount}), 0)`.mapWith(Number),
    })
    .from(wbAdvDailyProducts)
    .where(and(
      eq(wbAdvDailyProducts.workspaceId, wsId),
      ...(shopId ? [eq(wbAdvDailyProducts.shopId, shopId)] : []),
      eq(wbAdvDailyProducts.nmId, args.nmId),
      gte(wbAdvDailyProducts.date, from),
      lte(wbAdvDailyProducts.date, to),
    ));

  // COGS
  const [cogs] = await db
    .select({ cogsKopecks: wbCogs.cogsKopecks })
    .from(wbCogs)
    .where(and(eq(wbCogs.workspaceId, wsId), eq(wbCogs.nmId, args.nmId)))
    .limit(1);

  const f = funnel[0] ?? {};
  const a = adv[0] ?? {};
  const st = stocks[0] ?? {};

  // Текущая цена через единый helper. Возвращает 3 уровня: база, цена
  // кабинета и витрина (с СПП). Без этого AI отвечал на «цена товара»
  // только средним по продажам, юзер видел расхождение со скриншотом ЛК.
  const priceInfo = await getCurrentPriceInfo(wsId, shopId ?? null, args.nmId).catch(() => null);
  const toRub = (kop: number | null | undefined) => (kop == null ? null : Math.round(kop / 100));
  const priceBlock = priceInfo
    ? {
        source: priceInfo.source,
        asOf: priceInfo.asOf,
        basePriceRub: toRub(priceInfo.basePriceKop),
        discountPct: priceInfo.discountPct,
        finalPriceRub: toRub(priceInfo.finalPriceKop),
        showcasePriceRub: toRub(priceInfo.finishedPriceKop),
        labels: {
          basePriceRub: 'до скидки продавца (зачёркнутая)',
          finalPriceRub: 'цена кабинета (после скидки продавца, до СПП)',
          showcasePriceRub: 'цена на витрине (после СПП — что видит покупатель)',
        },
      }
    : null;

  // Штрихкоды (skus) лежат внутри card.raw.sizes[].skus. Это нужно для
  // create_supply / book_supply — WB обязательно требует barcode, и AI
  // раньше просил юзера ввести руками («где найти штрихкод»). Теперь
  // отдаём массив [{ size, barcode }] чтобы tool автоматом выбрал.
  const rawSizes = Array.isArray((card.raw as any)?.sizes) ? (card.raw as any).sizes : [];
  const barcodes: Array<{ size: string | null; barcode: string }> = [];
  for (const sz of rawSizes) {
    const sizeName = sz?.techSize ?? sz?.wbSize ?? null;
    const skus: string[] = Array.isArray(sz?.skus) ? sz.skus : [];
    for (const sku of skus) {
      if (typeof sku === 'string' && sku.length > 0) {
        barcodes.push({ size: sizeName, barcode: sku });
      }
    }
  }

  return JSON.stringify({
    product: {
      nmId: card.nmId,
      vendorCode: card.vendorCode,
      title: card.title,
      brand: card.brandName,
      subjectName: card.subjectName,
      // barcodes: для action_create_supply / action_book_supply_slot.
      // Если массив пуст — карточка без штрихкода (редко, но WB позволяет).
      barcodes,
      primaryBarcode: barcodes[0]?.barcode ?? null,
    },
    period: { from, to },
    // Цены — единый блок из priceInfo (3 уровня: база/кабинет/витрина).
    // Если null → нет данных для этого товара (карточка вне price-list).
    price: priceBlock,
    stock: { qty: st.totalQty ?? 0, warehouses: st.warehouseCount ?? 0 },
    sales: {
      source: 'analytics-funnel',
      ordersCount: f.orders ?? 0,
      ordersRub: f.ordersSum ?? 0,
      salesCount: f.buyouts ?? 0,
      salesRub: f.buyoutsSum ?? 0,
      cancelCount: f.cancels ?? 0,
      buyoutPctNote: 'Источник: WB Analytics (sales-funnel/products) — те же числа, что в WB ЛК и в РНП. Точный когортный % выкупа смотри в funnel.conversionPct ниже.',
    },
    funnel: {
      cardOpens: f.cardOpens ?? 0,
      addToCart: f.addToCart ?? 0,
      orders: f.orders ?? 0,
      buyouts: f.buyouts ?? 0,
      conversionPct: (f.cardOpens ?? 0) > 0 ? +(((f.buyouts ?? 0) / f.cardOpens) * 100).toFixed(2) : 0,
      // cardOpens = «Перешли в карточку» (НЕ показы в выдаче). WB через sales-funnel/products показы как отдельную метрику не отдаёт.
    },
    advertising: {
      spendKop: a.spendKop ?? 0,
      views: a.views ?? 0,
      clicks: a.clicks ?? 0,
      orders: a.orders ?? 0,
      cpc: (a.clicks ?? 0) > 0 ? Math.round((a.spendKop ?? 0) / a.clicks) : 0,
      drrPct: (f.buyoutsSum ?? 0) > 0 ? +(((a.spendKop ?? 0) / (f.buyoutsSum ?? 1)) * 100).toFixed(1) : 0,
    },
    cogs: cogs ? { costKop: cogs.cogsKopecks, currency: 'RUB' } : null,
  });
}
