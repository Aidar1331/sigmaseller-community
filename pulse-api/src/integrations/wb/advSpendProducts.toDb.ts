import 'dotenv/config';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { db } from '../../db/client.js';
import { wbAdvDailyProducts } from '../../db/schema.js';
import { getWbApiKey, wbGetJson, wbPostJson } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'advSpendProducts' });

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Thin GET/POST wrapper that delegates to the shared wbClient helpers
 * (which enforce per-domain RPM and per-endpoint Redis buckets keyed by
 * workspace+shop). The previous local implementation went straight to
 * fetch() and bypassed both — that's why /adv/v1/promotion/count was
 * hitting WB 429s constantly and no rows ever landed in wb_adv_daily_products.
 */
async function wbJson(
  url: string,
  apiKey: string,
  opts: { method: 'GET' | 'POST'; body?: unknown; workspaceId: number; shopId: number },
): Promise<any> {
  if (opts.method === 'POST') {
    return wbPostJson(url, apiKey, opts.body, 1, { workspaceId: opts.workspaceId, shopId: opts.shopId });
  }
  return wbGetJson(url, apiKey, 1, { workspaceId: opts.workspaceId, shopId: opts.shopId });
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

type Cp = {
  startedAt: string;
  updatedAt: string;
  workspaceId: number;
  daysBack: number;
  dateFrom: string;
  dateTo: string;
  activeWithinDays: number;
  advertIdsTotal: number;
  index: number;
  spendKopecksByDateNm: Record<string, number>; // key `${date}|${nmId}`
  advertsByDateNm: Record<string, Set<number> | number[]>; // for checkpoint only
  errors: Array<{ advertId: number; message: string }>;
};

function addSpend(
  m: Map<
    string,
    {
      spendKopecks: number;
      views: number;
      clicks: number;
      atbs: number;
      orders: number;
      sumPriceKopecks: number;
      spendManualKopecks: number;
      viewsManual: number;
      clicksManual: number;
      atbsManual: number;
      ordersManual: number;
      sumPriceManualKopecks: number;
      spendUnifiedKopecks: number;
      viewsUnified: number;
      clicksUnified: number;
      atbsUnified: number;
      ordersUnified: number;
      sumPriceUnifiedKopecks: number;
      advertIds: Set<number>;
    }
  >,
  date: string,
  nmId: number,
  metrics: { spendKopecks: number; views: number; clicks: number; atbs: number; orders: number; sumPriceKopecks: number },
  advertId: number,
  isUnified: boolean
) {
  const key = `${date}|${nmId}`;
  const cur =
    m.get(key) ?? {
      spendKopecks: 0,
      views: 0,
      clicks: 0,
      atbs: 0,
      orders: 0,
      sumPriceKopecks: 0,
      spendManualKopecks: 0,
      viewsManual: 0,
      clicksManual: 0,
      atbsManual: 0,
      ordersManual: 0,
      sumPriceManualKopecks: 0,
      spendUnifiedKopecks: 0,
      viewsUnified: 0,
      clicksUnified: 0,
      atbsUnified: 0,
      ordersUnified: 0,
      sumPriceUnifiedKopecks: 0,
      advertIds: new Set<number>(),
    };
  cur.spendKopecks += metrics.spendKopecks;
  cur.views += metrics.views;
  cur.clicks += metrics.clicks;
  cur.atbs += metrics.atbs;
  cur.orders += metrics.orders;
  cur.sumPriceKopecks += metrics.sumPriceKopecks;

  if (isUnified) {
    cur.spendUnifiedKopecks += metrics.spendKopecks;
    cur.viewsUnified += metrics.views;
    cur.clicksUnified += metrics.clicks;
    cur.atbsUnified += metrics.atbs;
    cur.ordersUnified += metrics.orders;
    cur.sumPriceUnifiedKopecks += metrics.sumPriceKopecks;
  } else {
    cur.spendManualKopecks += metrics.spendKopecks;
    cur.viewsManual += metrics.views;
    cur.clicksManual += metrics.clicks;
    cur.atbsManual += metrics.atbs;
    cur.ordersManual += metrics.orders;
    cur.sumPriceManualKopecks += metrics.sumPriceKopecks;
  }

  cur.advertIds.add(advertId);
  m.set(key, cur);
}

function extractNmSpendFromDay(day: any): Array<{ nmId: number; spendRub: number; views?: number; clicks?: number; atbs?: number; orders?: number; sumPriceRub?: number }> {
  const takeFromArray = (arr: any[]): Array<{ nmId: number; spendRub: number; views?: number; clicks?: number; atbs?: number; orders?: number; sumPriceRub?: number }> => {
    const out: Array<{ nmId: number; spendRub: number; views?: number; clicks?: number; atbs?: number; orders?: number; sumPriceRub?: number }> = [];
    for (const r of arr) {
      const nmId = Number(r?.nmId ?? r?.nmid ?? r?.nmID ?? r?.nm_id);
      const sum = Number(r?.sum ?? r?.spent ?? r?.spend ?? r?.cost ?? r?.cpmSum ?? 0);
      if (!Number.isFinite(nmId) || nmId <= 0) continue;
      if (!Number.isFinite(sum) || sum < 0) continue;
      const views = Number(r?.views ?? 0);
      const clicks = Number(r?.clicks ?? 0);
      const atbs = Number(r?.atbs ?? 0);
      const orders = Number(r?.orders ?? 0);
      const sumPriceRub = Number(r?.sum_price ?? r?.sumPrice ?? r?.sum_price_rub ?? 0);
      out.push({ nmId, spendRub: sum, views, clicks, atbs, orders, sumPriceRub });
    }
    return out;
  };

  // 1) common known keys
  const candidates = [day?.apps, day?.nm, day?.items, day?.products, day?.nms, day?.nmStats, day?.stat, day?.stats];
  for (const arr of candidates) {
    if (!Array.isArray(arr)) continue;
    const out = takeFromArray(arr);
    if (out.length) return out;
  }

  // 2) heuristic: scan nested objects and pick any array that looks like [{nmId, sum}]
  const visited = new Set<any>();
  const found: Array<Array<{ nmId: number; spendRub: number }>> = [];

  const walk = (obj: any, depth: number) => {
    if (!obj || depth > 6) return;
    if (visited.has(obj)) return;
    visited.add(obj);

    if (Array.isArray(obj)) {
      // if this array itself looks like stats rows
      const out = takeFromArray(obj);
      if (out.length) found.push(out);
      // also traverse elements
      for (const el of obj) walk(el, depth + 1);
      return;
    }

    if (typeof obj !== 'object') return;

    for (const v of Object.values(obj)) {
      if (!v) continue;
      if (typeof v === 'object') walk(v, depth + 1);
    }
  };

  walk(day, 0);

  if (!found.length) return [];

  // choose the largest total spend bucket
  found.sort((a, b) => b.reduce((s, x) => s + x.spendRub, 0) - a.reduce((s, x) => s + x.spendRub, 0));
  return found[0]!;
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
  
  const shopIdStr = process.env.SHOP_ID;
  if (!shopIdStr) throw new Error('SHOP_ID environment variable is required');
  const shopId = Number.parseInt(shopIdStr, 10);
  if (isNaN(shopId) || shopId <= 0) {
    throw new Error(`Invalid SHOP_ID: ${shopIdStr}`);
  }
  
  const daysBack = Number.parseInt(process.env.DAYS_BACK || '30', 10);
  const activeWithinDays = Number.parseInt(process.env.ACTIVE_WITHIN_DAYS || '180', 10);

  logger.info({ workspaceId, shopId: shopId ?? 'default', daysBack }, 'Starting sync');

  const apiKey = await getWbApiKey(workspaceId, shopId);

  const today = new Date();
  const dateTo = isoDate(today);
  const dateFrom = isoDate(addDays(today, -daysBack));

  const cutoffMs = activeWithinDays > 0 ? Date.now() - activeWithinDays * 24 * 60 * 60 * 1000 : Number.NEGATIVE_INFINITY;

  const promotions = await wbJson('https://advert-api.wildberries.ru/adv/v1/promotion/count', apiKey, { method: 'GET', workspaceId, shopId });

  // /adv/v3/fullstats: types 8,9 only (not media 5,6)
  // Statuses: 7 (finished), 9 (active), 11 (paused) — all return data with 31-day windows
  const FULLSTATS_STATUSES = new Set([7, 9, 11]);
  const FULLSTATS_TYPES = new Set([8, 9]);

  const advertIds: Array<{ id: number; changeTime?: string }> = [];
  const advertTypeById = new Map<number, number>();
  let skippedByStatus = 0;
  let skippedByType = 0;
  for (const group of promotions?.adverts ?? []) {
    const advertType = typeof group?.type === 'number' ? group.type : null;
    const groupStatus = typeof group?.status === 'number' ? group.status : null;
    if (groupStatus != null && !FULLSTATS_STATUSES.has(groupStatus)) {
      skippedByStatus += (group?.advert_list?.length ?? 0);
      continue;
    }
    if (advertType != null && !FULLSTATS_TYPES.has(advertType)) {
      skippedByType += (group?.advert_list?.length ?? 0);
      continue;
    }
    for (const a of group?.advert_list ?? []) {
      const id = a?.advertId;
      const changeTime = a?.changeTime;
      if (typeof id !== 'number') continue;
      if (advertType != null) advertTypeById.set(id, advertType);
      if (activeWithinDays > 0) {
        if (typeof changeTime !== 'string') continue;
        const t = Date.parse(changeTime);
        if (Number.isFinite(t) && t < cutoffMs) continue;
      }
      advertIds.push({ id, changeTime });
    }
  }
  if (skippedByStatus > 0 || skippedByType > 0) {
    logger.info({ skippedByStatus, skippedByType }, 'Skipped campaigns (non-fullstats status/type)');
  }

  advertIds.sort((a, b) => a.id - b.id);

  const suffix = `-${daysBack}d-${activeWithinDays}dactive-products-shop${shopId ?? 'all'}`;
  const checkpointPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-adv-products-to-db${suffix}.checkpoint.json`;

  let cp: Cp | null = null;
  try {
    cp = JSON.parse(await readFile(checkpointPath, 'utf8')) as Cp;
    if (
      cp.workspaceId !== workspaceId ||
      cp.daysBack !== daysBack ||
      cp.dateFrom !== dateFrom ||
      cp.dateTo !== dateTo ||
      cp.activeWithinDays !== activeWithinDays ||
      cp.advertIdsTotal !== advertIds.length
    ) {
      cp = null;
    }
  } catch {
    // ignore
  }

  if (!cp) {
    cp = {
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceId,
      daysBack,
      dateFrom,
      dateTo,
      activeWithinDays,
      advertIdsTotal: advertIds.length,
      index: 0,
      spendKopecksByDateNm: {},
      advertsByDateNm: {},
      errors: [],
    };
    await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');
  }

  const dates = listDates(dateFrom, dateTo);
  const agg = new Map<
    string,
    {
      spendKopecks: number;
      views: number;
      clicks: number;
      atbs: number;
      orders: number;
      sumPriceKopecks: number;
      spendManualKopecks: number;
      viewsManual: number;
      clicksManual: number;
      atbsManual: number;
      ordersManual: number;
      sumPriceManualKopecks: number;
      spendUnifiedKopecks: number;
      viewsUnified: number;
      clicksUnified: number;
      atbsUnified: number;
      ordersUnified: number;
      sumPriceUnifiedKopecks: number;
      advertIds: Set<number>;
    }
  >();

  // restore partial aggregation from checkpoint
  for (const [k, v] of Object.entries(cp.spendKopecksByDateNm)) {
    const [date, nmIdStr] = k.split('|');
    const nmId = Number(nmIdStr);
    const spendKopecks = Number(v);
    if (!date || !Number.isFinite(nmId) || nmId <= 0) continue;
    const cur =
      agg.get(k) ??
      {
        spendKopecks: 0,
        views: 0,
        clicks: 0,
        atbs: 0,
        orders: 0,
        sumPriceKopecks: 0,
        spendManualKopecks: 0,
        viewsManual: 0,
        clicksManual: 0,
        atbsManual: 0,
        ordersManual: 0,
        sumPriceManualKopecks: 0,
        spendUnifiedKopecks: 0,
        viewsUnified: 0,
        clicksUnified: 0,
        atbsUnified: 0,
        ordersUnified: 0,
        sumPriceUnifiedKopecks: 0,
        advertIds: new Set<number>(),
      };
    cur.spendKopecks += Number.isFinite(spendKopecks) ? spendKopecks : 0;
    agg.set(k, cur);
  }

  logger.info({ daysBack, dateFrom, dateTo, adverts: advertIds.length, startIndex: cp.index }, 'ADV PRODUCTS -> DB');

  const samplesPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-adv-fullstats-day-samples${suffix}.jsonl`;
  let samplesWritten = 0;

  // WB /adv/v3/fullstats: max 50 campaign IDs per request, rate limit 3 req/min (20s interval)
  const BATCH_SIZE = 50;
  const RATE_DELAY_MS = 21_000; // 21s to stay under 3 req/min
  const allIds = advertIds.map(a => a.id);

  // WB /adv/v3/fullstats has a MAX 31-day date range per request.
  // Split the full date range into 31-day windows for correct coverage.
  const MAX_WINDOW_DAYS = 31;
  const dateWindows: Array<{ begin: string; end: string }> = [];
  {
    let winStart = new Date(dateFrom + 'T00:00:00Z');
    const globalEnd = new Date(dateTo + 'T00:00:00Z');
    while (winStart <= globalEnd) {
      const winEnd = new Date(Math.min(winStart.getTime() + (MAX_WINDOW_DAYS - 1) * 86400000, globalEnd.getTime()));
      dateWindows.push({ begin: isoDate(winStart), end: isoDate(winEnd) });
      winStart = addDays(winEnd, 1);
    }
  }
  logger.info({ dateWindows: dateWindows.length, windowDays: MAX_WINDOW_DAYS }, 'Date windows for fullstats');

  for (let i = cp.index; i < allIds.length; i += BATCH_SIZE) {
    const batch = allIds.slice(i, i + BATCH_SIZE);
    const batchIds = batch.join(',');

    logger.info({ batchStart: i, batchEnd: i + batch.length, total: allIds.length, windows: dateWindows.length }, 'Processing batch');

    // Iterate over each 31-day window for this batch
    for (const win of dateWindows) {
      try {
        const stats = await wbJson(`https://advert-api.wildberries.ru/adv/v3/fullstats?ids=${batchIds}&beginDate=${win.begin}&endDate=${win.end}`, apiKey, { method: 'GET', workspaceId, shopId });

        if (Array.isArray(stats)) {
          for (const adv of stats) {
            const advId = adv?.advertId;
            const isUnified = typeof advId === 'number' ? (advertTypeById.get(advId) ?? -1) === 8 : false;
            for (const day of adv?.days ?? []) {
              const d = typeof day?.date === 'string' ? day.date.slice(0, 10) : null;
              if (!d) continue;
              if (d < dateFrom || d > dateTo) continue;

              const byNm = extractNmSpendFromDay(day);
              if (!byNm.length) {
                if (samplesWritten < 8) {
                  const payload = {
                    advertId: advId,
                    date: d,
                    dayKeys: day && typeof day === 'object' ? Object.keys(day).slice(0, 60) : null,
                    day,
                  };
                  await appendFile(samplesPath, JSON.stringify(payload).slice(0, 50_000) + '\n', 'utf8');
                  samplesWritten++;
                }
                continue;
              }

              for (const it of byNm) {
                const k = `${d}|${it.nmId}`;
                const kopecks = Math.round(it.spendRub * 100);
                const views = Number(it.views ?? 0);
                const clicks = Number(it.clicks ?? 0);
                const atbs = Number(it.atbs ?? 0);
                const orders = Number(it.orders ?? 0);
                const sumPriceKopecks = Math.round(Number(it.sumPriceRub ?? 0) * 100);
                addSpend(
                  agg,
                  d,
                  it.nmId,
                  { spendKopecks: kopecks, views, clicks, atbs, orders, sumPriceKopecks },
                  typeof advId === 'number' ? advId : 0,
                  isUnified
                );
                cp.spendKopecksByDateNm[k] = (cp.spendKopecksByDateNm[k] ?? 0) + kopecks;
              }
            }
          }
        }
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (!msg.includes('Invalid Params')) {
          for (const id of batch) cp.errors.push({ advertId: id, message: `window ${win.begin}..${win.end}: ${msg.slice(0, 300)}` });
        }
      }

      // Respect WB rate limit between each window request
      await sleep(RATE_DELAY_MS);
    }

    cp.index = Math.min(i + BATCH_SIZE, allIds.length);
    cp.updatedAt = new Date().toISOString();
    await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');
  }

  // Upsert into DB
  for (const [k, v] of agg.entries()) {
    const [date, nmIdStr] = k.split('|');
    const nmId = Number(nmIdStr);
    if (!date || !Number.isFinite(nmId) || nmId <= 0) continue;

    await db
      .insert(wbAdvDailyProducts)
      .values({
        workspaceId,
        shopId,
        date,
        nmId,
        spendKopecks: Math.max(0, Math.round(v.spendKopecks)),
        viewsCount: Math.max(0, Math.round(v.views)),
        clicksCount: Math.max(0, Math.round(v.clicks)),
        atbsCount: Math.max(0, Math.round(v.atbs)),
        ordersCount: Math.max(0, Math.round(v.orders)),
        sumPriceKopecks: Math.max(0, Math.round(v.sumPriceKopecks)),
        spendManualKopecks: Math.max(0, Math.round(v.spendManualKopecks)),
        viewsManualCount: Math.max(0, Math.round(v.viewsManual)),
        clicksManualCount: Math.max(0, Math.round(v.clicksManual)),
        atbsManualCount: Math.max(0, Math.round(v.atbsManual)),
        ordersManualCount: Math.max(0, Math.round(v.ordersManual)),
        sumPriceManualKopecks: Math.max(0, Math.round(v.sumPriceManualKopecks)),
        spendUnifiedKopecks: Math.max(0, Math.round(v.spendUnifiedKopecks)),
        viewsUnifiedCount: Math.max(0, Math.round(v.viewsUnified)),
        clicksUnifiedCount: Math.max(0, Math.round(v.clicksUnified)),
        atbsUnifiedCount: Math.max(0, Math.round(v.atbsUnified)),
        ordersUnifiedCount: Math.max(0, Math.round(v.ordersUnified)),
        sumPriceUnifiedKopecks: Math.max(0, Math.round(v.sumPriceUnifiedKopecks)),
        advertsCount: v.advertIds.size,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [wbAdvDailyProducts.workspaceId, wbAdvDailyProducts.shopId, wbAdvDailyProducts.date, wbAdvDailyProducts.nmId],
        set: {
          spendKopecks: Math.max(0, Math.round(v.spendKopecks)),
          viewsCount: Math.max(0, Math.round(v.views)),
          clicksCount: Math.max(0, Math.round(v.clicks)),
          atbsCount: Math.max(0, Math.round(v.atbs)),
          ordersCount: Math.max(0, Math.round(v.orders)),
          sumPriceKopecks: Math.max(0, Math.round(v.sumPriceKopecks)),
          spendManualKopecks: Math.max(0, Math.round(v.spendManualKopecks)),
          viewsManualCount: Math.max(0, Math.round(v.viewsManual)),
          clicksManualCount: Math.max(0, Math.round(v.clicksManual)),
          atbsManualCount: Math.max(0, Math.round(v.atbsManual)),
          ordersManualCount: Math.max(0, Math.round(v.ordersManual)),
          sumPriceManualKopecks: Math.max(0, Math.round(v.sumPriceManualKopecks)),
          spendUnifiedKopecks: Math.max(0, Math.round(v.spendUnifiedKopecks)),
          viewsUnifiedCount: Math.max(0, Math.round(v.viewsUnified)),
          clicksUnifiedCount: Math.max(0, Math.round(v.clicksUnified)),
          atbsUnifiedCount: Math.max(0, Math.round(v.atbsUnified)),
          ordersUnifiedCount: Math.max(0, Math.round(v.ordersUnified)),
          sumPriceUnifiedKopecks: Math.max(0, Math.round(v.sumPriceUnifiedKopecks)),
          advertsCount: v.advertIds.size,
          updatedAt: new Date(),
        },
      });
  }

  const outPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-adv-products-to-db${suffix}-${dateFrom}_to_${dateTo}.json`;
  await writeFile(
    outPath,
    JSON.stringify(
      {
        workspaceId,
        daysBack,
        dateFrom,
        dateTo,
        activeWithinDays,
        rows: agg.size,
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

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error({ err: e }, 'advSpendProducts failed');
    process.exit(1);
  });
