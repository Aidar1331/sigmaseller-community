import 'dotenv/config';
import { db } from '../../db/client.js';
import { wbFunnelDaily } from '../../db/schema.js';
import { getWbApiKey as getApiKey } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'funnelHistory7d' });

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function roundBp(pct: number): number {
  // percent -> basis points (x100)
  return Math.round(pct * 100);
}

function num(v: any): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

async function wbPost(url: string, apiKey: string, body: unknown, attempt = 1): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30_000);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ac.signal,
  }).finally(() => clearTimeout(t));

  const text = await res.text();
  if (res.status === 429 && attempt <= 10) {
    const ra = Number(res.headers.get('retry-after') ?? '0');
    const wait = ra > 0 ? Math.min(120_000, ra * 1000) : Math.min(60_000, 1000 * 2 ** (attempt - 1));
    await sleep(wait);
    return wbPost(url, apiKey, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`WB POST ${url} failed: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function discoverNmIds(apiKey: string, dateFrom: string): Promise<number[]> {
  const nm = new Set<number>();
  for (const url of [
    `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${encodeURIComponent(dateFrom)}&flag=0`,
    `https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${encodeURIComponent(dateFrom)}&flag=0`,
  ]) {
    const res = await fetch(url, { headers: { Authorization: apiKey } });
    const arr = await res.json();
    if (Array.isArray(arr)) {
      for (const row of arr) if (typeof row?.nmId === 'number') nm.add(row.nmId);
    }
    await sleep(400);
  }
  return Array.from(nm).sort((a, b) => a - b);
}

async function main() {
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

  const apiKey = await getApiKey(workspaceId, shopId);

  const end = isoDate(new Date());
  const start = isoDate(addDays(new Date(end + 'T00:00:00Z'), -7));

  const nmIds = await discoverNmIds(apiKey, start);
  const batches: number[][] = [];
  for (let i = 0; i < nmIds.length; i += 20) batches.push(nmIds.slice(i, i + 20));

  const byDate = new Map<string, any>();

  for (const slice of batches) {
    const resp = await wbPost(
      'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products/history',
      apiKey,
      { selectedPeriod: { start, end }, nmIds: slice, aggregationLevel: 'day', skipDeletedNm: false }
    );

    for (const p of resp ?? []) {
      for (const h of p?.history ?? []) {
        const d = typeof h?.date === 'string' ? h.date.slice(0, 10) : null;
        if (!d) continue;
        const cur = byDate.get(d) ?? {
          viewCount: 0,
          openCardCount: 0,
          addToCartCount: 0,
          addToWishlistCount: 0,
          orderCount: 0,
          orderSum: 0,
          buyoutCount: 0,
          buyoutSum: 0,
          productsCount: 0,
        };
        cur.viewCount += num(h?.openCount) ? 0 : 0; // history doesn't include views; keep 0
        cur.openCardCount += num(h?.openCount);
        cur.addToCartCount += num(h?.cartCount);
        cur.addToWishlistCount += num(h?.addToWishlistCount);
        cur.orderCount += num(h?.orderCount);
        cur.orderSum += num(h?.orderSum);
        cur.buyoutCount += num(h?.buyoutCount);
        cur.buyoutSum += num(h?.buyoutSum);
        cur.productsCount += 1;
        byDate.set(d, cur);
      }
    }

    await sleep(1000);
  }

  for (const [date, t] of byDate.entries()) {
    const viewToOpen = t.viewCount > 0 ? (t.openCardCount / t.viewCount) * 100 : 0;
    const openToCart = t.openCardCount > 0 ? (t.addToCartCount / t.openCardCount) * 100 : 0;
    const cartToOrder = t.addToCartCount > 0 ? (t.orderCount / t.addToCartCount) * 100 : 0;
    const buyoutPct = t.orderCount > 0 ? (t.buyoutCount / t.orderCount) * 100 : 0;

    await db
      .insert(wbFunnelDaily)
      .values({
        workspaceId,
        shopId,
        date,
        source: 'history',
        viewCount: t.viewCount,
        openCardCount: t.openCardCount,
        addToCartCount: t.addToCartCount,
        addToWishlistCount: t.addToWishlistCount,
        orderCount: t.orderCount,
        orderSum: Math.round(t.orderSum),
        buyoutCount: t.buyoutCount,
        buyoutSum: Math.round(t.buyoutSum),
        viewToOpenConversionBp: roundBp(viewToOpen),
        openToCartConversionBp: roundBp(openToCart),
        cartToOrderConversionBp: roundBp(cartToOrder),
        buyoutPercentBp: roundBp(buyoutPct),
        productsCount: t.productsCount,
        raw: t,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [wbFunnelDaily.workspaceId, wbFunnelDaily.shopId, wbFunnelDaily.date, wbFunnelDaily.source],
        set: {
          openCardCount: t.openCardCount,
          addToCartCount: t.addToCartCount,
          addToWishlistCount: t.addToWishlistCount,
          orderCount: t.orderCount,
          orderSum: Math.round(t.orderSum),
          buyoutCount: t.buyoutCount,
          buyoutSum: Math.round(t.buyoutSum),
          viewToOpenConversionBp: roundBp(viewToOpen),
          openToCartConversionBp: roundBp(openToCart),
          cartToOrderConversionBp: roundBp(cartToOrder),
          buyoutPercentBp: roundBp(buyoutPct),
          productsCount: t.productsCount,
          raw: t,
          updatedAt: new Date(),
        },
      });
  }

  logger.info({ days: byDate.size }, 'Upserted funnel history days');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error({ err: e }, 'funnelHistory7d failed');
    process.exit(1);
  });
