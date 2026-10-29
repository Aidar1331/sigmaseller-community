import 'dotenv/config';
import { db } from '../../db/client.js';
import {
  wbOrdersSalesDaily,
  wbOrdersSalesDailyProducts,
  wbOrdersSalesDailyRegions,
  wbOrdersSalesDailyWarehouses,
  wbOrdersSalesDailyProductWarehouses,
  wbOrdersSalesDailyProductRegions,
} from '../../db/schema.js';
import { wbGetJson, getWbApiKey } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'ordersSalesToDb' });

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function dayKeyFromAny(row: any): string | null {
  const v = row?.date || row?.lastChangeDate;
  return typeof v === 'string' ? v.slice(0, 10) : null;
}

function num(v: any): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function normName(v: any): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length ? s : null;
}

function regionNameFromRow(row: any): string | null {
  return (
    normName(row?.regionName) ||
    normName(row?.oblastOkrugName) ||
    normName(row?.oblast) ||
    normName(row?.countryName)
  );
}

async function backfill(daysBack: number, workspaceId: number, shopId: number) {
  const apiKey = await getWbApiKey(workspaceId, shopId);

  // For large date ranges (>30 days), process in chunks to avoid OOM
  const CHUNK_SIZE = 30; // days per chunk
  if (daysBack > CHUNK_SIZE) {
    logger.info({ daysBack, chunkSize: CHUNK_SIZE }, 'Large range - processing in chunks');
    
    for (let offset = 0; offset < daysBack; offset += CHUNK_SIZE) {
      const chunkDays = Math.min(CHUNK_SIZE, daysBack - offset);
      const chunkStart = daysBack - offset - chunkDays;
      
      logger.info({ dayStart: chunkStart + 1, dayEnd: chunkStart + chunkDays }, 'Processing chunk');
      await backfillChunk(chunkDays, chunkStart, workspaceId, shopId, apiKey);
      
      // Allow GC between chunks
      if (global.gc) global.gc();
      await new Promise(r => setTimeout(r, 1000)); // 1s pause between chunks
    }
    return;
  }

  await backfillChunk(daysBack, 0, workspaceId, shopId, apiKey);
}

async function backfillChunk(daysBack: number, offsetDays: number, workspaceId: number, shopId: number, apiKey: string) {
  const today = new Date();
  const dateTo = isoDate(addDays(today, -offsetDays));
  const dateFrom = isoDate(addDays(today, -offsetDays - daysBack));

  logger.info({ daysBack, dateFrom, dateTo }, 'Orders/Sales -> DB');

  // Fetch lists (WB returns all records since dateFrom)
  const ordersUrl = `https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${encodeURIComponent(
    dateFrom
  )}&flag=0`;
  const salesUrl = `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${encodeURIComponent(
    dateFrom
  )}&flag=0`;

  const orders = await wbGetJson(ordersUrl, apiKey, 1, { workspaceId, shopId });
  const sales = await wbGetJson(salesUrl, apiKey, 1, { workspaceId, shopId });

  // Log data size for monitoring
  logger.info({ ordersCount: Array.isArray(orders) ? orders.length : 0, salesCount: Array.isArray(sales) ? sales.length : 0 }, 'Loaded orders/sales');

  const ordersByDate = new Map<
    string,
    { ordersCount: number; ordersRub: number; discountSumBp: number; finishedPriceRub: number }
  >();
  const salesByDate = new Map<string, { salesCount: number; salesRub: number; forPayRub: number }>();

  type DailyProductAgg = {
    date: string;
    nmId: number;
    ordersCount: number;
    salesCount: number;
    salesRub: number;
    forPayRub: number;
    ordersRub: number;
    discountPercentSumBp: number;
    finishedPriceRub: number;
  };
  const byKey = new Map<string, DailyProductAgg>();

  type DailyGroupAgg = {
    date: string;
    name: string;
    ordersCount: number;
    salesCount: number;
    salesRub: number;
    forPayRub: number;
    ordersRub: number;
  };
  const whByKey = new Map<string, DailyGroupAgg>();
  const regionByKey = new Map<string, DailyGroupAgg>();

  // Детализация product + warehouse/region
  type DailyProductGroupAgg = {
    date: string;
    nmId: number;
    name: string;
    ordersCount: number;
    salesCount: number;
    salesRub: number;
    forPayRub: number;
    ordersRub: number;
  };
  const prodWhByKey = new Map<string, DailyProductGroupAgg>();
  const prodRegionByKey = new Map<string, DailyProductGroupAgg>();

  function ensureOrdersDay(day: string) {
    const cur = ordersByDate.get(day) ?? { ordersCount: 0, ordersRub: 0, discountSumBp: 0, finishedPriceRub: 0 };
    ordersByDate.set(day, cur);
    return cur;
  }
  function ensureSalesDay(day: string) {
    const cur = salesByDate.get(day) ?? { salesCount: 0, salesRub: 0, forPayRub: 0 };
    salesByDate.set(day, cur);
    return cur;
  }
  function ensureProd(day: string, nmId: number): DailyProductAgg {
    const key = `${day}|${nmId}`;
    const cur = byKey.get(key) ?? {
      date: day,
      nmId,
      ordersCount: 0,
      salesCount: 0,
      salesRub: 0,
      forPayRub: 0,
      ordersRub: 0,
      discountPercentSumBp: 0,
      finishedPriceRub: 0,
    };
    byKey.set(key, cur);
    return cur;
  }

  function ensureWarehouse(day: string, name: string): DailyGroupAgg {
    const key = `${day}|${name}`;
    const cur = whByKey.get(key) ?? {
      date: day,
      name,
      ordersCount: 0,
      salesCount: 0,
      salesRub: 0,
      forPayRub: 0,
      ordersRub: 0,
    };
    whByKey.set(key, cur);
    return cur;
  }

  function ensureRegion(day: string, name: string): DailyGroupAgg {
    const key = `${day}|${name}`;
    const cur = regionByKey.get(key) ?? {
      date: day,
      name,
      ordersCount: 0,
      salesCount: 0,
      salesRub: 0,
      forPayRub: 0,
      ordersRub: 0,
    };
    regionByKey.set(key, cur);
    return cur;
  }

  function ensureProductWarehouse(day: string, nmId: number, name: string): DailyProductGroupAgg {
    const key = `${day}|${nmId}|${name}`;
    const cur = prodWhByKey.get(key) ?? {
      date: day,
      nmId,
      name,
      ordersCount: 0,
      salesCount: 0,
      salesRub: 0,
      forPayRub: 0,
      ordersRub: 0,
    };
    prodWhByKey.set(key, cur);
    return cur;
  }

  function ensureProductRegion(day: string, nmId: number, name: string): DailyProductGroupAgg {
    const key = `${day}|${nmId}|${name}`;
    const cur = prodRegionByKey.get(key) ?? {
      date: day,
      nmId,
      name,
      ordersCount: 0,
      salesCount: 0,
      salesRub: 0,
      forPayRub: 0,
      ordersRub: 0,
    };
    prodRegionByKey.set(key, cur);
    return cur;
  }

  if (Array.isArray(orders)) {
    for (const row of orders) {
      const day = dayKeyFromAny(row);
      if (!day) continue;
      if (day < dateFrom || day > dateTo) continue;

      // priceWithDisc = price after seller discount, before SPP (matches WB personal cabinet "Заказали на сумму")
      // totalPrice = full retail price before any discounts
      // finishedPrice = final buyer price after all discounts including SPP
      const priceWithDisc =
        (typeof row?.priceWithDisc === 'number' ? row.priceWithDisc : null) ??
        (typeof row?.totalPrice === 'number' ? row.totalPrice : null) ??
        (typeof row?.finishedPrice === 'number' ? row.finishedPrice : null) ??
        0;
      const finishedPrice = typeof row?.finishedPrice === 'number' ? row.finishedPrice : 0;
      const discountPercent = typeof row?.discountPercent === 'number' ? row.discountPercent : 0;

      const o = ensureOrdersDay(day);
      o.ordersCount += 1;
      o.ordersRub += num(priceWithDisc);
      o.discountSumBp += Math.round(num(discountPercent) * 100);
      o.finishedPriceRub += num(finishedPrice);

      const nmId = Number(row?.nmId ?? row?.nmid ?? row?.nmID ?? row?.nm_id);
      if (Number.isFinite(nmId) && nmId > 0) {
        const p = ensureProd(day, nmId);
        p.ordersCount += 1;
        p.ordersRub += num(priceWithDisc);
        p.discountPercentSumBp += Math.round(num(discountPercent) * 100);
        p.finishedPriceRub += num(finishedPrice);
      }

      const warehouseName = normName(row?.warehouseName);
      if (warehouseName) {
        const w = ensureWarehouse(day, warehouseName);
        w.ordersCount += 1;
        w.ordersRub += num(priceWithDisc);
        // Product + warehouse detail
        if (Number.isFinite(nmId) && nmId > 0) {
          const pw = ensureProductWarehouse(day, nmId, warehouseName);
          pw.ordersCount += 1;
          pw.ordersRub += num(priceWithDisc);
        }
      }

      const regionName = regionNameFromRow(row);
      if (regionName) {
        const r = ensureRegion(day, regionName);
        r.ordersCount += 1;
        r.ordersRub += num(priceWithDisc);
        // Product + region detail
        if (Number.isFinite(nmId) && nmId > 0) {
          const pr = ensureProductRegion(day, nmId, regionName);
          pr.ordersCount += 1;
          pr.ordersRub += num(priceWithDisc);
        }
      }
    }
  }

  if (Array.isArray(sales)) {
    for (const row of sales) {
      const day = dayKeyFromAny(row);
      if (!day) continue;
      if (day < dateFrom || day > dateTo) continue;

      const forPay = typeof row?.forPay === 'number' ? row.forPay : 0;
      // FIX: Use priceWithDisc for sales_rub to match Torgstat "Сумма продаж" (retail price)
      const priceWithDisc = typeof row?.priceWithDisc === 'number' ? row.priceWithDisc : 0;
      const amount =
        (typeof row?.priceWithDisc === 'number' ? row.priceWithDisc : null) ??
        (typeof row?.totalPrice === 'number' ? row.totalPrice : null) ??
        (typeof row?.finishedPrice === 'number' ? row.finishedPrice : null) ??
        (typeof row?.forPay === 'number' ? row.forPay : null) ??
        0;

      const s = ensureSalesDay(day);
      s.salesCount += 1;
      s.salesRub += num(amount);
      s.forPayRub += num(forPay);

      const nmId = Number(row?.nmId ?? row?.nmid ?? row?.nmID ?? row?.nm_id);
      if (Number.isFinite(nmId) && nmId > 0) {
        const p = ensureProd(day, nmId);
        p.salesCount += 1;
        p.salesRub += num(amount);
        p.forPayRub += num(forPay);
      }

      const warehouseName = normName(row?.warehouseName);
      if (warehouseName) {
        const w = ensureWarehouse(day, warehouseName);
        w.salesCount += 1;
        w.salesRub += num(amount);
        w.forPayRub += num(forPay);
        // Product + warehouse detail
        if (Number.isFinite(nmId) && nmId > 0) {
          const pw = ensureProductWarehouse(day, nmId, warehouseName);
          pw.salesCount += 1;
          pw.salesRub += num(amount);
          pw.forPayRub += num(forPay);
        }
      }

      const regionName = regionNameFromRow(row);
      if (regionName) {
        const r = ensureRegion(day, regionName);
        r.salesCount += 1;
        r.salesRub += num(amount);
        r.forPayRub += num(forPay);
        // Product + region detail
        if (Number.isFinite(nmId) && nmId > 0) {
          const pr = ensureProductRegion(day, nmId, regionName);
          pr.salesCount += 1;
          pr.salesRub += num(amount);
          pr.forPayRub += num(forPay);
        }
      }
    }
  }

  // Wrap all upserts in a transaction for data consistency
  await db.transaction(async (tx) => {
    // upsert each day — only write rows where WB API returned actual data
    // (skip zero rows to avoid masking API lag as "no orders")
    for (let i = 0; i <= daysBack; i++) {
    const d = isoDate(addDays(today, -i - offsetDays));
    if (d < dateFrom || d > dateTo) continue;

    const o = ordersByDate.get(d);
    const s = salesByDate.get(d);

    // Skip dates where API returned no data at all — don't write zeros
    // This prevents gap detection from thinking data is fresh when API just hasn't caught up
    if (!o && !s) continue;

    const ordersCount = o?.ordersCount ?? 0;
    const salesCount = s?.salesCount ?? 0;
    const salesRub = Math.round((s?.salesRub ?? 0) * 100); // kopecks
    const ordersRub = Math.round((o?.ordersRub ?? 0) * 100); // kopecks
    const discountPercentSumBp = Math.round(o?.discountSumBp ?? 0); // basis points sum
    const finishedPriceRub = Math.round((o?.finishedPriceRub ?? 0) * 100); // kopecks

    await tx
      .insert(wbOrdersSalesDaily)
      .values({
        workspaceId,
        shopId,
        date: d,
        ordersCount,
        salesCount,
        salesRub,
        ordersRub,
        discountPercentSumBp,
        finishedPriceRub,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [wbOrdersSalesDaily.workspaceId, wbOrdersSalesDaily.shopId, wbOrdersSalesDaily.date],
        set: { ordersCount, salesCount, salesRub, ordersRub, discountPercentSumBp, finishedPriceRub, updatedAt: new Date() },
      });
  }

  // upsert per-product rows
  for (const p of byKey.values()) {
    const row = {
      workspaceId,
      shopId,
      date: p.date,
      nmId: p.nmId,
      ordersCount: p.ordersCount,
      salesCount: p.salesCount,
      salesRub: Math.round(p.salesRub * 100),
      forPayRub: Math.round(p.forPayRub * 100),
      ordersRub: Math.round(p.ordersRub * 100),
      discountPercentSumBp: Math.round(p.discountPercentSumBp),
      finishedPriceRub: Math.round(p.finishedPriceRub * 100),
      updatedAt: new Date(),
    };

    await tx
      .insert(wbOrdersSalesDailyProducts)
      .values(row)
      .onConflictDoUpdate({
        target: [wbOrdersSalesDailyProducts.workspaceId, wbOrdersSalesDailyProducts.shopId, wbOrdersSalesDailyProducts.date, wbOrdersSalesDailyProducts.nmId],
        set: { ...row, updatedAt: new Date() },
      });
  }

  // upsert warehouse rows
  for (const w of whByKey.values()) {
    const row = {
      workspaceId,
      shopId,
      date: w.date,
      warehouseName: w.name,
      ordersCount: w.ordersCount,
      salesCount: w.salesCount,
      salesRub: Math.round(w.salesRub * 100),
      forPayRub: Math.round(w.forPayRub * 100),
      ordersRub: Math.round(w.ordersRub * 100),
      updatedAt: new Date(),
    };

    await tx
      .insert(wbOrdersSalesDailyWarehouses)
      .values(row)
      .onConflictDoUpdate({
        target: [
          wbOrdersSalesDailyWarehouses.workspaceId,
          wbOrdersSalesDailyWarehouses.date,
          wbOrdersSalesDailyWarehouses.warehouseName,
        ],
        set: { ...row, updatedAt: new Date() },
      });
  }

  // upsert region rows
  for (const r of regionByKey.values()) {
    const row = {
      workspaceId,
      shopId,
      date: r.date,
      regionName: r.name,
      ordersCount: r.ordersCount,
      salesCount: r.salesCount,
      salesRub: Math.round(r.salesRub * 100),
      forPayRub: Math.round(r.forPayRub * 100),
      ordersRub: Math.round(r.ordersRub * 100),
      updatedAt: new Date(),
    };

    await tx
      .insert(wbOrdersSalesDailyRegions)
      .values(row)
      .onConflictDoUpdate({
        target: [
          wbOrdersSalesDailyRegions.workspaceId,
          wbOrdersSalesDailyRegions.date,
          wbOrdersSalesDailyRegions.regionName,
        ],
        set: { ...row, updatedAt: new Date() },
      });
  }

  // upsert product + warehouse rows
  for (const pw of prodWhByKey.values()) {
    await tx
      .insert(wbOrdersSalesDailyProductWarehouses)
      .values({
        workspaceId,
        shopId,
        date: pw.date,
        nmId: pw.nmId,
        warehouseName: pw.name,
        ordersCount: pw.ordersCount,
        salesCount: pw.salesCount,
        salesRub: Math.round(pw.salesRub * 100),
        forPayRub: Math.round(pw.forPayRub * 100),
        ordersRub: Math.round(pw.ordersRub * 100),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          wbOrdersSalesDailyProductWarehouses.workspaceId,
          wbOrdersSalesDailyProductWarehouses.date,
          wbOrdersSalesDailyProductWarehouses.nmId,
          wbOrdersSalesDailyProductWarehouses.warehouseName,
        ],
        set: {
          shopId,
          ordersCount: pw.ordersCount,
          salesCount: pw.salesCount,
          salesRub: Math.round(pw.salesRub * 100),
          forPayRub: Math.round(pw.forPayRub * 100),
          ordersRub: Math.round(pw.ordersRub * 100),
          updatedAt: new Date(),
        },
      });
  }

  // upsert product + region rows
  for (const pr of prodRegionByKey.values()) {
    await tx
      .insert(wbOrdersSalesDailyProductRegions)
      .values({
        workspaceId,
        shopId,
        date: pr.date,
        nmId: pr.nmId,
        regionName: pr.name,
        ordersCount: pr.ordersCount,
        salesCount: pr.salesCount,
        salesRub: Math.round(pr.salesRub * 100),
        forPayRub: Math.round(pr.forPayRub * 100),
        ordersRub: Math.round(pr.ordersRub * 100),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          wbOrdersSalesDailyProductRegions.workspaceId,
          wbOrdersSalesDailyProductRegions.date,
          wbOrdersSalesDailyProductRegions.nmId,
          wbOrdersSalesDailyProductRegions.regionName,
        ],
        set: {
          shopId,
          ordersCount: pr.ordersCount,
          salesCount: pr.salesCount,
          salesRub: Math.round(pr.salesRub * 100),
          forPayRub: Math.round(pr.forPayRub * 100),
          ordersRub: Math.round(pr.ordersRub * 100),
          updatedAt: new Date(),
        },
      });
  }
  }); // End transaction
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
  
  const daysBack = Number.parseInt(process.env.DAYS_BACK || '120', 10);
  
  logger.info({ workspaceId, shopId: shopId ?? 'default', daysBack }, 'Starting sync');
  
  await backfill(daysBack, workspaceId, shopId);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error({ err: e }, 'ordersSalesToDb failed');
    process.exit(1);
  });
