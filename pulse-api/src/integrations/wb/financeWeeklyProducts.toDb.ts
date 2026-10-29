import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { wbFinanceWeeklyProducts } from '../../db/schema.js';
import { getWbApiKey, kopecks, wbGetJson } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'financeWeeklyProducts' });

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function listWindows(from: string, to: string, windowDays: number): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  let cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    const wFrom = isoDate(cur);
    const wToDt = addDays(cur, windowDays - 1);
    const wTo = isoDate(wToDt) > to ? to : isoDate(wToDt);
    out.push({ from: wFrom, to: wTo });
    cur = addDays(new Date(wTo + 'T00:00:00Z'), 1);
  }
  return out;
}

type Agg = {
  workspaceId: number;
  shopId: number | null;
  dateFrom: string;
  dateTo: string;
  nmId: number;

  lines: number;
  revenueKopecks: number;
  incomeFromSalesKopecks: number;

  logisticsKopecks: number;
  paidAcceptanceKopecks: number;
  storageKopecks: number;
  penaltiesKopecks: number;
  otherHoldKopecks: number;
  additionalPaymentsKopecks: number;
};

function ensure(map: Map<string, Agg>, workspaceId: number, shopId: number | null, dateFrom: string, dateTo: string, nmId: number): Agg {
  const key = `${workspaceId}|${dateFrom}|${dateTo}|${nmId}`;
  let agg = map.get(key);
  if (!agg) {
    agg = {
      workspaceId,
      shopId,
      dateFrom,
      dateTo,
      nmId,

      lines: 0,
      revenueKopecks: 0,
      incomeFromSalesKopecks: 0,

      logisticsKopecks: 0,
      paidAcceptanceKopecks: 0,
      storageKopecks: 0,
      penaltiesKopecks: 0,
      otherHoldKopecks: 0,
      additionalPaymentsKopecks: 0,
    };
    map.set(key, agg);
  }
  return agg;
}

async function main() {
  await mkdir('out', { recursive: true });

  const workspaceIdStr = process.env.WORKSPACE_ID;
  if (!workspaceIdStr) {
    throw new Error('WORKSPACE_ID environment variable is required');
  }
  const workspaceId = Number.parseInt(workspaceIdStr, 10);
  if (isNaN(workspaceId) || workspaceId <= 0) {
    throw new Error(`Invalid WORKSPACE_ID: ${workspaceIdStr}`);
  }
  const daysBack = Number.parseInt(process.env.DAYS_BACK || '365', 10);
  const windowDays = Number.parseInt(process.env.WINDOW_DAYS || '60', 10);
  const shopIdStr = process.env.SHOP_ID;
  const shopId = shopIdStr ? Number.parseInt(shopIdStr, 10) : null;

  // Pass workspaceId (and shopId when set) so getWbApiKey can look up the
  // right token. Without these arguments the function has nothing to query
  // by and throws "WB_API_KEY is required (workspaceId=n/a, shopId=n/a)" —
  // which is why wb_finance_weekly_products stayed empty in prod.
  const apiKey = await getWbApiKey(workspaceId, shopId ?? undefined);

  const today = new Date();
  const dateTo = isoDate(today);
  const dateFrom = isoDate(addDays(today, -daysBack));

  const windows = listWindows(dateFrom, dateTo, windowDays);
  const checkpointPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-finance-weekly-products-${workspaceId}-shop${shopId ?? 'all'}-${daysBack}d.checkpoint.json`;

  let state: {
    startedAt: string;
    updatedAt: string;
    winIndex: number;
    rrdid: number;
    agg: Record<string, Agg>;
    errors: Array<{ winIndex: number; message: string }>;
  };

  try {
    state = JSON.parse(await readFile(checkpointPath, 'utf8'));
  } catch {
    state = {
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      winIndex: 0,
      rrdid: 0,
      agg: {},
      errors: [],
    };
    await writeFile(checkpointPath, JSON.stringify(state, null, 2), 'utf8');
  }

  logger.info({ workspaceId, daysBack, dateFrom, dateTo, windowDays, windows: windows.length, startWin: state.winIndex }, 'Finance weekly products -> DB');

  const map = new Map<string, Agg>(Object.entries(state.agg).map(([k, v]) => [k, v]));

  for (let wi = state.winIndex; wi < windows.length; wi++) {
    const w = windows[wi]!;
    let rrdid = wi === state.winIndex ? state.rrdid : 0;

    logger.info({ window: `${wi + 1}/${windows.length}`, from: w.from, to: w.to, rrdid }, 'Processing window');

    while (true) {
      const url = `https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod?dateFrom=${encodeURIComponent(
        w.from
      )}&dateTo=${encodeURIComponent(w.to)}&limit=100000&rrdid=${rrdid}&period=daily`;

      let rows: any;
      try {
        rows = await wbGetJson(url, apiKey, 1, { workspaceId, shopId: shopId ?? undefined });
      } catch (e: any) {
        state.errors.push({ winIndex: wi, message: String(e?.message ?? e).slice(0, 300) });
        break;
      }

      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const row of rows) {
        const nmId = Number(row?.nm_id);
        if (!Number.isFinite(nmId) || nmId <= 0) continue;

        const rf = String(row?.date_from ?? '').slice(0, 10);
        const rt = String(row?.date_to ?? '').slice(0, 10);
        if (!rf || !rt) continue;

        const a = ensure(map, workspaceId, shopId, rf, rt, nmId);
        a.lines += 1;

        a.revenueKopecks += kopecks(row?.retail_price_withdisc_rub);
        a.incomeFromSalesKopecks += kopecks(row?.ppvz_for_pay);

        a.logisticsKopecks += kopecks(row?.delivery_rub);
        a.paidAcceptanceKopecks += kopecks(row?.acceptance);
        a.storageKopecks += kopecks(row?.storage_fee);
        a.penaltiesKopecks += kopecks(row?.penalty);
        a.otherHoldKopecks += kopecks(row?.deduction);
        a.additionalPaymentsKopecks += kopecks(row?.additional_payment);

        const next = row?.rrd_id;
        if (typeof next === 'number' && next > rrdid) rrdid = next;
      }

      // checkpoint each page
      state.winIndex = wi;
      state.rrdid = rrdid;
      state.updatedAt = new Date().toISOString();
      state.agg = Object.fromEntries(map.entries());
      await writeFile(checkpointPath, JSON.stringify(state, null, 2), 'utf8');

      if (rows.length < 100000) break;
    }

    // flush this window to DB
    const rowsToUpsert = [...map.values()].filter((r) => r.dateFrom >= w.from && r.dateTo <= w.to);
    if (rowsToUpsert.length) {
      logger.info({ count: rowsToUpsert.length }, 'Upserting aggregated rows');

      // Batch insert with upsert
      const batchSize = 500;
      for (let i = 0; i < rowsToUpsert.length; i += batchSize) {
        const batch = rowsToUpsert.slice(i, i + batchSize);
        await db
          .insert(wbFinanceWeeklyProducts)
          .values(
            batch.map((r) => ({
              workspaceId: r.workspaceId,
              shopId: r.shopId,
              dateFrom: r.dateFrom,
              dateTo: r.dateTo,
              nmId: r.nmId,
              lines: r.lines,
              revenueKopecks: r.revenueKopecks,
              incomeFromSalesKopecks: r.incomeFromSalesKopecks,
              logisticsKopecks: r.logisticsKopecks,
              paidAcceptanceKopecks: r.paidAcceptanceKopecks,
              storageKopecks: r.storageKopecks,
              penaltiesKopecks: r.penaltiesKopecks,
              otherHoldKopecks: r.otherHoldKopecks,
              additionalPaymentsKopecks: r.additionalPaymentsKopecks,
              updatedAt: new Date(),
            }))
          )
          .onConflictDoUpdate({
            target: [
              wbFinanceWeeklyProducts.workspaceId,
              wbFinanceWeeklyProducts.dateFrom,
              wbFinanceWeeklyProducts.dateTo,
              wbFinanceWeeklyProducts.nmId,
            ],
            set: {
              shopId: sql`excluded.shop_id`,
              lines: sql`excluded.lines`,
              revenueKopecks: sql`excluded.revenue_kopecks`,
              incomeFromSalesKopecks: sql`excluded.income_from_sales_kopecks`,
              logisticsKopecks: sql`excluded.logistics_kopecks`,
              paidAcceptanceKopecks: sql`excluded.paid_acceptance_kopecks`,
              storageKopecks: sql`excluded.storage_kopecks`,
              penaltiesKopecks: sql`excluded.penalties_kopecks`,
              otherHoldKopecks: sql`excluded.other_hold_kopecks`,
              additionalPaymentsKopecks: sql`excluded.additional_payments_kopecks`,
              updatedAt: new Date(),
            },
          });
      }
    }
  }

  logger.info('Done');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error({ err: e }, 'financeWeeklyProducts failed');
    process.exit(1);
  });
