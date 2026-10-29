import 'dotenv/config';
import { wbGetJson, getWbApiKey as getApiKey } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'ordersSalesByNmId' });

// Compare WB Statistics API orders/sales by nmId (article) for a date range.
// Usage:
//   WB_API_KEY=... tsx src/integrations/wb/ordersSales.byNmId.ts
// Env:
//   FROM=YYYY-MM-DD (default: today-14)
//   TO=YYYY-MM-DD (default: today)
//   NMIDS=495710315,150816751

type AnyObj = Record<string, any>;

aSync();

async function aSync() {
  const apiKey = await getApiKey();
  const to = (process.env.TO || new Date().toISOString().slice(0, 10)).trim();
  const from = (process.env.FROM || isoDate(addDays(new Date(to + 'T00:00:00Z'), -13))).trim();
  const nmIds = (process.env.NMIDS || '495710315,150816751')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));

  if (!nmIds.length) throw new Error('NMIDS is empty');

  logger.info({ from, to, nmIds }, 'Starting orders/sales by nmId');

  const ordersUrl = `https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${encodeURIComponent(
    from
  )}&flag=0`;
  const salesUrl = `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${encodeURIComponent(
    from
  )}&flag=0`;

  const [orders, sales] = await Promise.all([wbGetJson(ordersUrl, apiKey), wbGetJson(salesUrl, apiKey)]);
  if (!Array.isArray(orders)) throw new Error('Unexpected orders response (expected array)');
  if (!Array.isArray(sales)) throw new Error('Unexpected sales response (expected array)');

  const days = enumerateDays(from, to);
  const byNmId: Record<
    string,
    {
      daily: Record<string, { ordersCount: number; salesCount: number; salesRub: number; forPayRub: number }>;
      totals: { ordersCount: number; salesCount: number; salesRub: number; forPayRub: number };
      sample: { orderKeys: string[]; saleKeys: string[] };
    }
  > = {};

  for (const id of nmIds) {
    const key = String(id);
    byNmId[key] = {
      daily: Object.fromEntries(days.map((d) => [d, { ordersCount: 0, salesCount: 0, salesRub: 0, forPayRub: 0 }])),
      totals: { ordersCount: 0, salesCount: 0, salesRub: 0, forPayRub: 0 },
      sample: { orderKeys: [], saleKeys: [] },
    };
  }

  // Orders
  for (const row of orders as AnyObj[]) {
    const day = dayKeyFromAny(row);
    if (!day || day < from || day > to) continue;
    const nmId = num(row.nmId ?? row.nmid ?? row.nmID ?? row.nm_id);
    if (!nmId) continue;
    const bucket = byNmId[String(nmId)];
    if (!bucket) continue;

    bucket.daily[day]!.ordersCount += 1;
    bucket.totals.ordersCount += 1;

    if (bucket.sample.orderKeys.length < 12) bucket.sample.orderKeys.push(Object.keys(row).sort().join(','));
  }

  // Sales
  for (const row of sales as AnyObj[]) {
    const day = dayKeyFromAny(row);
    if (!day || day < from || day > to) continue;
    const nmId = num(row.nmId ?? row.nmid ?? row.nmID ?? row.nm_id);
    if (!nmId) continue;
    const bucket = byNmId[String(nmId)];
    if (!bucket) continue;

    bucket.daily[day]!.salesCount += 1;
    bucket.totals.salesCount += 1;

    const forPay = typeof row.forPay === 'number' ? row.forPay : null;
    const totalPrice = typeof row.totalPrice === 'number' ? row.totalPrice : null;
    const finishedPrice = typeof row.finishedPrice === 'number' ? row.finishedPrice : null;

    // Keep both: forPay and "best-effort" salesRub used in current code.
    const salesRub = (forPay ?? totalPrice ?? finishedPrice ?? 0) as number;

    bucket.daily[day]!.salesRub = round2(bucket.daily[day]!.salesRub + salesRub);
    bucket.daily[day]!.forPayRub = round2(bucket.daily[day]!.forPayRub + (forPay ?? 0));
    bucket.totals.salesRub = round2(bucket.totals.salesRub + salesRub);
    bucket.totals.forPayRub = round2(bucket.totals.forPayRub + (forPay ?? 0));

    if (bucket.sample.saleKeys.length < 12) bucket.sample.saleKeys.push(Object.keys(row).sort().join(','));
  }

  logger.info({ byNmId }, 'Orders/sales by nmId result');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function num(v: any): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function dayKeyFromAny(row: AnyObj): string | null {
  const v = row?.date || row?.lastChangeDate || row?.createdAt || row?.updatedAt;
  return typeof v === 'string' ? v.slice(0, 10) : null;
}

function enumerateDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let dt = new Date(from + 'T00:00:00Z'); dt <= new Date(to + 'T00:00:00Z'); ) {
    out.push(dt.toISOString().slice(0, 10));
    dt.setUTCDate(dt.getUTCDate() + 1);
  }
  return out;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

