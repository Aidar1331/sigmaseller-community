import 'dotenv/config';
import { getWbApiKey } from './wbClient.js';

export type WbDailyMetric = {
  date: string; // YYYY-MM-DD
  ordersCount?: number;
  salesCount?: number;
  salesRub?: number;
  advSpendRub?: number;
};

type AnyObj = Record<string, any>;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function wbRequestJson(
  url: string,
  apiKey: string,
  opts: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' },
  attempt = 1
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: apiKey,
  };

  let bodyText: string | undefined;
  if (opts.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    bodyText = JSON.stringify(opts.body ?? null);
  }

  const res = await fetch(url, {
    method: opts.method,
    headers,
    body: bodyText,
  });
  const text = await res.text();

  if (res.status === 429 && attempt <= 6) {
    // WB has strict per-seller global limit. Backoff and retry.
    const waitMs = Math.min(30_000, 1000 * 2 ** (attempt - 1));
    await sleep(waitMs);
    return wbRequestJson(url, apiKey, opts, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`WB ${opts.method} ${url} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

function dayKeyFromAny(row: AnyObj): string | null {
  // WB statistics rows usually contain `date` (sales) or `lastChangeDate` (orders)
  const v = row.date || row.lastChangeDate || row.createdAt || row.updatedAt;
  if (!v || typeof v !== 'string') return null;
  // normalize to YYYY-MM-DD
  return v.slice(0, 10);
}

export async function fetchWbOrdersByDate(dateFrom: string, apiKey: string): Promise<Map<string, number>> {
  // Statistics API
  const url = `https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${encodeURIComponent(
    dateFrom
  )}&flag=0`;
  const data = (await wbRequestJson(url, apiKey, { method: 'GET' })) as unknown;
  if (!Array.isArray(data)) throw new Error('Unexpected orders response (expected array)');

  const m = new Map<string, number>();
  for (const row of data as AnyObj[]) {
    const day = dayKeyFromAny(row);
    if (!day) continue;
    if (day < dateFrom) continue;
    m.set(day, (m.get(day) ?? 0) + 1);
  }
  return m;
}

export async function fetchWbSalesByDate(dateFrom: string, apiKey: string): Promise<{ count: Map<string, number>; rub: Map<string, number> }> {
  const url = `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${encodeURIComponent(
    dateFrom
  )}&flag=0`;
  const data = (await wbRequestJson(url, apiKey, { method: 'GET' })) as unknown;
  if (!Array.isArray(data)) throw new Error('Unexpected sales response (expected array)');

  const count = new Map<string, number>();
  const rub = new Map<string, number>();

  for (const row of data as AnyObj[]) {
    const day = dayKeyFromAny(row);
    if (!day) continue;
    if (day < dateFrom) continue;

    count.set(day, (count.get(day) ?? 0) + 1);

    // WB sales rows usually have `forPay` (amount to pay) and/or `totalPrice`.
    const amount =
      (typeof row.forPay === 'number' ? row.forPay : null) ??
      (typeof row.totalPrice === 'number' ? row.totalPrice : null) ??
      (typeof row.finishedPrice === 'number' ? row.finishedPrice : null) ??
      0;
    rub.set(day, (rub.get(day) ?? 0) + amount);
  }

  return { count, rub };
}

export async function fetchWbAdvSpendByDate(dateFrom: string, dateTo: string, apiKey: string): Promise<Map<string, number>> {
  // 1) Get all adverts (ids)
  const promotions = (await wbRequestJson('https://advert-api.wildberries.ru/adv/v1/promotion/count', apiKey, {
    method: 'GET',
  })) as any;

  const advertIds: number[] = [];
  for (const group of promotions?.adverts ?? []) {
    for (const a of group?.advert_list ?? []) {
      if (typeof a?.advertId === 'number') advertIds.push(a.advertId);
    }
  }

  // Build date list inclusive
  const dates: string[] = [];
  for (let d = dateFrom; d <= dateTo; ) {
    dates.push(d);
    const dt = new Date(d + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + 1);
    d = dt.toISOString().slice(0, 10);
  }

  const spend = new Map<string, number>();

  // 2) Query fullstats per advert (slower but more robust; WB can 400 some adverts for a given interval)
  for (const id of advertIds) {
    try {
      const beginDate = dates[0];
      const endDate = dates[dates.length - 1];
      const stats = (await wbRequestJson(`https://advert-api.wildberries.ru/adv/v3/fullstats?ids=${id}&beginDate=${beginDate}&endDate=${endDate}`, apiKey, {
        method: 'GET',
      })) as any;

      if (!Array.isArray(stats)) continue;
      for (const adv of stats) {
        for (const day of adv?.days ?? []) {
          const date = typeof day?.date === 'string' ? day.date.slice(0, 10) : null;
          const sum = typeof day?.sum === 'number' ? day.sum : 0;
          if (!date) continue;
          if (date < dateFrom || date > dateTo) continue;
          spend.set(date, (spend.get(date) ?? 0) + sum);
        }
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes('Invalid Params')) {
        // no stats for this advert in the interval
      } else {
        throw e;
      }
    }

    // be kind to the global limiter
    await sleep(350);
  }

  return spend;
}

export async function buildDailyMetrics(daysBack: number): Promise<WbDailyMetric[]> {
  const apiKey = await getWbApiKey();
  const today = new Date();
  const from = isoDate(addDays(today, -daysBack));

  // Do sequentially to reduce chances of hitting the global limiter.
  const orders = await fetchWbOrdersByDate(from, apiKey);
  const sales = await fetchWbSalesByDate(from, apiKey);
  const advSpend = await fetchWbAdvSpendByDate(from, isoDate(today), apiKey);

  // Create union of all days in range and all days we saw.
  const days = new Set<string>();
  for (let i = 0; i <= daysBack; i++) days.add(isoDate(addDays(today, -i)));
  for (const d of orders.keys()) days.add(d);
  for (const d of sales.count.keys()) days.add(d);

  const list = Array.from(days)
    .sort()
    .map((date) => ({
      date,
      ordersCount: orders.get(date) ?? 0,
      salesCount: sales.count.get(date) ?? 0,
      salesRub: Math.round((sales.rub.get(date) ?? 0) * 100) / 100,
      advSpendRub: Math.round((advSpend.get(date) ?? 0) * 100) / 100,
    }));

  return list;
}
