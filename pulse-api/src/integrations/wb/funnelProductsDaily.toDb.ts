import 'dotenv/config';
import { db } from '../../db/client.js';
import { wbFunnelDaily, wbFunnelDailyProducts } from '../../db/schema.js';
import { getWbApiKey, wbPostJson } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'funnelProductsDaily' });

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Delegates to wbPostJson so per-endpoint Redis quota (per workspace+shop)
 * is enforced. The previous local fetch ignored our rate-limiter, so when
 * multiple shops ran the funnel sync in parallel they each hammered
 * /api/analytics/v3/sales-funnel/products and triggered WB 429.
 */
async function wbJson(
  url: string,
  apiKey: string,
  body: unknown,
  workspaceId: number,
  shopId: number,
): Promise<any> {
  return wbPostJson(url, apiKey, body, 1, { workspaceId, shopId });
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function listDates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; ) {
    out.push(d);
    const dt = new Date(d + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + 1);
    d = isoDate(dt);
  }
  return out;
}

function num(v: any): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

type DailyFunnelTotals = {
  viewCount: number;
  openCardCount: number;
  addToCartCount: number;
  addToWishlistCount: number;
  orderCount: number;
  orderSum: number;
  buyoutCount: number;
  buyoutSum: number;
  cancelCount: number;
  cancelSum: number;

  // derived conversions (from totals) in basis points (x100)
  viewToOpenConversionBp: number;
  openToCartConversionBp: number;
  cartToOrderConversionBp: number;
  buyoutPercentBp: number;

  productsCount: number;
};

type DailyFunnelProduct = {
  nmId: number;
  viewCount: number;
  openCardCount: number;
  addToCartCount: number;
  addToWishlistCount: number;
  orderCount: number;
  orderSum: number;
  buyoutCount: number;
  buyoutSum: number;
  cancelCount: number;
  cancelSum: number;
  buyoutPercentBp: number; // x100
};

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function roundBp(pct: number): number {
  return Math.round(pct * 100);
}

async function fetchDayData(apiKey: string, date: string, limit: number, workspaceId: number, shopId: number): Promise<{ totals: DailyFunnelTotals; products: DailyFunnelProduct[] }> {
  const url = 'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products';
  let offset = 0;
  const t = {
    viewCount: 0,
    openCardCount: 0,
    addToCartCount: 0,
    addToWishlistCount: 0,
    orderCount: 0,
    orderSum: 0,
    buyoutCount: 0,
    buyoutSum: 0,
    cancelCount: 0,
    cancelSum: 0,
    productsCount: 0,
  };

  const byNm = new Map<number, DailyFunnelProduct>();

  while (true) {
    const body = {
      selectedPeriod: { start: date, end: date },
      nmIds: [],
      brandNames: [],
      subjectIds: [],
      tagIds: [],
      skipDeletedNm: false,
      orderBy: { field: 'orderSum', mode: 'desc' },
      limit,
      offset,
    };

    const resp = await wbJson(url, apiKey, body, workspaceId, shopId);
    const products = resp?.data?.products;
    if (!Array.isArray(products) || products.length === 0) break;

    for (const item of products) {
      // API returns nested structure: { product: {...}, statistic: { selected: {...} } }
      const prod = item?.product ?? item;
      const stats = item?.statistic?.selected ?? item;
      
      // Map API field names to our internal names
      const viewCount = num(stats?.openCount ?? stats?.viewCount ?? 0); // API uses openCount for "просмотры карточки"
      const openCardCount = num(stats?.openCount ?? stats?.openCardCount ?? 0);
      const addToCartCount = num(stats?.cartCount ?? stats?.addToCartCount ?? 0);
      const addToWishlistCount = num(stats?.addToWishlist ?? stats?.addToWishlistCount ?? 0);
      const orderCount = num(stats?.orderCount ?? 0);
      const orderSum = num(stats?.orderSum ?? 0);
      const buyoutCount = num(stats?.buyoutCount ?? 0);
      const buyoutSum = num(stats?.buyoutSum ?? 0);
      const cancelCount = num(stats?.cancelCount ?? 0);
      const cancelSum = num(stats?.cancelSum ?? 0);
      
      t.viewCount += viewCount;
      t.openCardCount += openCardCount;
      t.addToCartCount += addToCartCount;
      t.addToWishlistCount += addToWishlistCount;
      t.orderCount += orderCount;
      t.orderSum += orderSum;
      t.buyoutCount += buyoutCount;
      t.buyoutSum += buyoutSum;
      t.cancelCount += cancelCount;
      t.cancelSum += cancelSum;
      t.productsCount += 1;

      const nmId = Number(prod?.nmId ?? prod?.nmid ?? prod?.nmID ?? prod?.nm_id);
      if (Number.isFinite(nmId) && nmId > 0) {
        const cur = byNm.get(nmId) ?? {
          nmId,
          viewCount: 0,
          openCardCount: 0,
          addToCartCount: 0,
          addToWishlistCount: 0,
          orderCount: 0,
          orderSum: 0,
          buyoutCount: 0,
          buyoutSum: 0,
          cancelCount: 0,
          cancelSum: 0,
          buyoutPercentBp: 0,
        };
        cur.viewCount += viewCount;
        cur.openCardCount += openCardCount;
        cur.addToCartCount += addToCartCount;
        cur.addToWishlistCount += addToWishlistCount;
        cur.orderCount += orderCount;
        cur.orderSum += orderSum;
        cur.buyoutCount += buyoutCount;
        cur.buyoutSum += buyoutSum;
        cur.cancelCount += cancelCount;
        cur.cancelSum += cancelSum;
        byNm.set(nmId, cur);
      }
    }

    if (products.length < limit) break;
    offset += limit;
    await sleep(250);
  }

  const viewToOpen = t.viewCount > 0 ? (t.openCardCount / t.viewCount) * 100 : 0;
  const openToCart = t.openCardCount > 0 ? (t.addToCartCount / t.openCardCount) * 100 : 0;
  const cartToOrder = t.addToCartCount > 0 ? (t.orderCount / t.addToCartCount) * 100 : 0;
  const buyoutPct = t.orderCount > 0 ? (t.buyoutCount / t.orderCount) * 100 : 0;

  const products = Array.from(byNm.values()).map((p) => {
    const buyoutPercent = p.orderCount > 0 ? (p.buyoutCount / p.orderCount) * 100 : 0;
    return {
      ...p,
      orderSum: round2(p.orderSum),
      buyoutSum: round2(p.buyoutSum),
      cancelSum: round2(p.cancelSum),
      buyoutPercentBp: roundBp(buyoutPercent),
    };
  });

  const totals: DailyFunnelTotals = {
    ...t,
    orderSum: round2(t.orderSum),
    buyoutSum: round2(t.buyoutSum),
    viewToOpenConversionBp: roundBp(viewToOpen),
    openToCartConversionBp: roundBp(openToCart),
    cartToOrderConversionBp: roundBp(cartToOrder),
    buyoutPercentBp: roundBp(buyoutPct),
  };

  return { totals, products };
}

async function backfill(daysBack: number) {
  const workspaceIdStr = process.env.WORKSPACE_ID;
  if (!workspaceIdStr) {
    throw new Error('WORKSPACE_ID environment variable is required');
  }
  const workspaceId = Number.parseInt(workspaceIdStr, 10);
  if (isNaN(workspaceId) || workspaceId <= 0) {
    throw new Error(`Invalid WORKSPACE_ID: ${workspaceIdStr}`);
  }
  
  const shopIdStr = process.env.SHOP_ID;
  if (!shopIdStr) throw new Error('SHOP_ID environment variable is required');
  const shopId = Number.parseInt(shopIdStr, 10);
  if (isNaN(shopId) || shopId <= 0) {
    throw new Error(`Invalid SHOP_ID: ${shopIdStr}`);
  }
  
  logger.info({ workspaceId, shopId: shopId ?? 'default', daysBack }, 'Starting sync');
  
  const apiKey = await getWbApiKey(workspaceId, shopId);
  const today = new Date();
  const dateTo = isoDate(today);
  const dateFrom = isoDate(addDays(today, -daysBack));

  const limit = Number.parseInt(process.env.LIMIT || '1000', 10);
  const rateDelayMs = Number.parseInt(process.env.RATE_DELAY_MS || '21000', 10);

  const dates = listDates(dateFrom, dateTo);

  logger.info({ daysBack, dateFrom, dateTo, days: dates.length, limit }, 'Funnel(products)->DB');

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i]!;
    logger.info({ progress: `${i + 1}/${dates.length}`, date }, 'Processing day');

    const { totals, products } = await fetchDayData(apiKey, date, limit, workspaceId, shopId);

    await db
      .insert(wbFunnelDaily)
      .values({
        workspaceId,
        shopId,
        date,
        source: 'products',
        viewCount: totals.viewCount,
        openCardCount: totals.openCardCount,
        addToCartCount: totals.addToCartCount,
        addToWishlistCount: totals.addToWishlistCount,
        orderCount: totals.orderCount,
        orderSum: Math.round(totals.orderSum),
        buyoutCount: totals.buyoutCount,
        buyoutSum: Math.round(totals.buyoutSum),
        cancelCount: totals.cancelCount,
        cancelSum: Math.round(totals.cancelSum),
        viewToOpenConversionBp: totals.viewToOpenConversionBp,
        openToCartConversionBp: totals.openToCartConversionBp,
        cartToOrderConversionBp: totals.cartToOrderConversionBp,
        buyoutPercentBp: totals.buyoutPercentBp,
        productsCount: totals.productsCount,
        raw: totals,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [wbFunnelDaily.workspaceId, wbFunnelDaily.shopId, wbFunnelDaily.date, wbFunnelDaily.source],
        set: {
          viewCount: totals.viewCount,
          openCardCount: totals.openCardCount,
          addToCartCount: totals.addToCartCount,
          addToWishlistCount: totals.addToWishlistCount,
          orderCount: totals.orderCount,
          orderSum: Math.round(totals.orderSum),
          buyoutCount: totals.buyoutCount,
          buyoutSum: Math.round(totals.buyoutSum),
          cancelCount: totals.cancelCount,
          cancelSum: Math.round(totals.cancelSum),
          viewToOpenConversionBp: totals.viewToOpenConversionBp,
          openToCartConversionBp: totals.openToCartConversionBp,
          cartToOrderConversionBp: totals.cartToOrderConversionBp,
          buyoutPercentBp: totals.buyoutPercentBp,
          productsCount: totals.productsCount,
          raw: totals,
          updatedAt: new Date(),
        },
      });

    // per-product funnel
    for (const p of products) {
      await db
        .insert(wbFunnelDailyProducts)
        .values({
          workspaceId,
          shopId,
          date,
          nmId: p.nmId,
          viewCount: p.viewCount,
          openCardCount: p.openCardCount,
          addToCartCount: p.addToCartCount,
          addToWishlistCount: p.addToWishlistCount,
          orderCount: p.orderCount,
          orderSum: Math.round(p.orderSum),
          buyoutCount: p.buyoutCount,
          buyoutSum: Math.round(p.buyoutSum),
          cancelCount: p.cancelCount,
          cancelSum: Math.round(p.cancelSum),
          buyoutPercentBp: p.buyoutPercentBp,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [wbFunnelDailyProducts.workspaceId, wbFunnelDailyProducts.shopId, wbFunnelDailyProducts.date, wbFunnelDailyProducts.nmId],
          set: {
            viewCount: p.viewCount,
            openCardCount: p.openCardCount,
            addToCartCount: p.addToCartCount,
            addToWishlistCount: p.addToWishlistCount,
            orderCount: p.orderCount,
            orderSum: Math.round(p.orderSum),
            buyoutCount: p.buyoutCount,
            buyoutSum: Math.round(p.buyoutSum),
            cancelCount: p.cancelCount,
            cancelSum: Math.round(p.cancelSum),
            buyoutPercentBp: p.buyoutPercentBp,
            updatedAt: new Date(),
          },
        });
    }

    if (i + 1 < dates.length) await sleep(rateDelayMs);
  }
}

async function main() {
  const list = (process.env.DAYS_BACK_LIST || '30,60,90,120')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  for (const d of list) {
    await backfill(d);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error({ err: e }, 'funnelProductsDaily failed');
    process.exit(1);
  });
