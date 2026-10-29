import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { getWbApiKey as getApiKey } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'salesFunnelProductsDailyBackfill' });

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function wbJson(
  url: string,
  apiKey: string,
  body: unknown,
  attempt = 1
): Promise<any> {
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
    // token bucket: back off and retry
    const waitMs = Math.min(90_000, 1000 * 2 ** (attempt - 1));
    await sleep(waitMs);
    return wbJson(url, apiKey, body, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`WB POST ${url} failed: ${res.status} ${text.slice(0, 500)}`);
  }

  return JSON.parse(text);
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

type DailyFunnelTotals = {
  viewCount: number;
  openCardCount: number;
  addToCartCount: number;
  addToWishlistCount: number;
  orderCount: number;
  orderSum: number;
  buyoutCount: number;
  buyoutSum: number;

  // derived conversions (from totals)
  viewToOpenConversion: number;
  openToCartConversion: number;
  cartToOrderConversion: number;
  buyoutPercent: number;

  productsCount: number; // number of product rows included
};

type Checkpoint = {
  startedAt: string;
  updatedAt: string;
  daysBack: number;
  dateFrom: string;
  dateTo: string;
  limit: number;
  nextDateIndex: number;
  daily: Record<string, DailyFunnelTotals>;
  errors: Array<{ date: string; message: string }>;
};

function num(v: any): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function computeConversions(t: Omit<DailyFunnelTotals, 'viewToOpenConversion' | 'openToCartConversion' | 'cartToOrderConversion' | 'buyoutPercent'>) {
  const viewToOpenConversion = t.viewCount > 0 ? (t.openCardCount / t.viewCount) * 100 : 0;
  const openToCartConversion = t.openCardCount > 0 ? (t.addToCartCount / t.openCardCount) * 100 : 0;
  const cartToOrderConversion = t.addToCartCount > 0 ? (t.orderCount / t.addToCartCount) * 100 : 0;
  const buyoutPercent = t.orderCount > 0 ? (t.buyoutCount / t.orderCount) * 100 : 0;
  return {
    viewToOpenConversion: round2(viewToOpenConversion),
    openToCartConversion: round2(openToCartConversion),
    cartToOrderConversion: round2(cartToOrderConversion),
    buyoutPercent: round2(buyoutPercent),
  };
}

async function fetchDayTotals(apiKey: string, date: string, limit: number): Promise<DailyFunnelTotals> {
  const url = 'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products';

  let offset = 0;
  const totalsBase = {
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

  while (true) {
    const body = {
      selectedPeriod: { start: date, end: date },
      pastPeriod: undefined,
      nmIds: [],
      brandNames: [],
      subjectIds: [],
      tagIds: [],
      skipDeletedNm: false,
      orderBy: { field: 'orderSum', mode: 'desc' },
      limit,
      offset,
    };

    const resp = await wbJson(url, apiKey, body);
    const products = resp?.data?.products;
    if (!Array.isArray(products) || products.length === 0) break;

    for (const p of products) {
      totalsBase.viewCount += num(p?.viewCount);
      totalsBase.openCardCount += num(p?.openCardCount);
      totalsBase.addToCartCount += num(p?.addToCartCount);
      totalsBase.addToWishlistCount += num(p?.addToWishlistCount);
      totalsBase.orderCount += num(p?.orderCount);
      totalsBase.orderSum += num(p?.orderSum);
      totalsBase.buyoutCount += num(p?.buyoutCount);
      totalsBase.buyoutSum += num(p?.buyoutSum);
      totalsBase.productsCount += 1;
    }

    if (products.length < limit) break;
    offset += limit;

    // a tiny delay between pages
    await sleep(250);
  }

  const conv = computeConversions(totalsBase);
  return {
    ...totalsBase,
    ...conv,
    orderSum: round2(totalsBase.orderSum),
    buyoutSum: round2(totalsBase.buyoutSum),
  };
}

async function backfill(daysBack: number) {
  await mkdir('out', { recursive: true });

  const apiKey = await getApiKey();
  const today = new Date();
  const dateTo = isoDate(today);
  const dateFrom = isoDate(addDays(today, -daysBack));

  const limit = Number.parseInt(process.env.LIMIT || '1000', 10);
  const rateDelayMs = Number.parseInt(process.env.RATE_DELAY_MS || '21000', 10); // ~3/min
  const shopIdStr = process.env.SHOP_ID;
  const shopId = shopIdStr ? Number.parseInt(shopIdStr, 10) : undefined;

  const dates = listDates(dateFrom, dateTo);
  const checkpointPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-funnel-products-daily-shop${shopId ?? 'all'}-${daysBack}d.checkpoint.json`;

  let cp: Checkpoint | null = null;
  try {
    cp = JSON.parse(await readFile(checkpointPath, 'utf8')) as Checkpoint;
    if (cp.daysBack !== daysBack || cp.dateFrom !== dateFrom || cp.dateTo !== dateTo || cp.limit !== limit) cp = null;
  } catch {
    // ignore
  }

  if (!cp) {
    cp = {
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      daysBack,
      dateFrom,
      dateTo,
      limit,
      nextDateIndex: 0,
      daily: {},
      errors: [],
    };
    await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');
  }

  logger.info({ daysBack, dateFrom, dateTo, daysCount: dates.length, limit, startIndex: cp.nextDateIndex }, 'Funnel(products) daily backfill');

  for (let i = cp.nextDateIndex; i < dates.length; i++) {
    const date = dates[i]!;
    logger.info({ day: `${i + 1}/${dates.length}`, date }, 'Processing day');

    try {
      const totals = await fetchDayTotals(apiKey, date, limit);
      cp.daily[date] = totals;
    } catch (e: any) {
      cp.errors.push({ date, message: String(e?.message ?? e).slice(0, 300) });
    }

    cp.nextDateIndex = i + 1;
    cp.updatedAt = new Date().toISOString();
    await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');

    // respect rate limit
    if (i + 1 < dates.length) await sleep(rateDelayMs);
  }

  const outPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-funnel-products-daily-${daysBack}d-${dateFrom}_to_${dateTo}.json`;
  await writeFile(
    outPath,
    JSON.stringify(
      {
        daysBack,
        dateFrom,
        dateTo,
        daily: cp.daily,
        errors: cp.errors,
        finishedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );

  logger.info({ outPath }, 'Wrote output file');
}

async function main() {
  const list = (process.env.DAYS_BACK_LIST || '30,60,90')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  for (const d of list) {
    await backfill(d);
  }
}

main().catch((e) => {
  logger.error({ err: e }, 'salesFunnelProductsDailyBackfill failed');
  process.exitCode = 1;
});
