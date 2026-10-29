import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { db } from '../../db/client.js';
import { wbAdvDaily } from '../../db/schema.js';
import { getWbApiKey, wbGetJson, wbPostJson } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'advSpend' });

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Thin GET/POST wrapper that delegates to shared wbClient helpers so
 * per-endpoint Redis buckets keyed by (workspace, shop) apply. The
 * previous local implementation went straight to fetch() and bypassed
 * our quota tracking — that's why /adv/v1/promotion/count would 429 in
 * bursts when multiple shops ran in parallel.
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
  spendKopecksByDate: Record<string, number>;
  viewsCountByDate: Record<string, number>;
  clicksCountByDate: Record<string, number>;
  atbsCountByDate: Record<string, number>;
  ordersCountByDate: Record<string, number>;
  sumPriceKopecksByDate: Record<string, number>;
  spendManualKopecksByDate: Record<string, number>;
  viewsManualCountByDate: Record<string, number>;
  clicksManualCountByDate: Record<string, number>;
  atbsManualCountByDate: Record<string, number>;
  ordersManualCountByDate: Record<string, number>;
  sumPriceManualKopecksByDate: Record<string, number>;
  spendUnifiedKopecksByDate: Record<string, number>;
  viewsUnifiedCountByDate: Record<string, number>;
  clicksUnifiedCountByDate: Record<string, number>;
  atbsUnifiedCountByDate: Record<string, number>;
  ordersUnifiedCountByDate: Record<string, number>;
  sumPriceUnifiedKopecksByDate: Record<string, number>;
  errors: Array<{ advertId: number; message: string }>;
  skippedInvalidParams?: number;
};

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
  if (!shopIdStr) {
    throw new Error('SHOP_ID environment variable is required');
  }
  const shopId = Number.parseInt(shopIdStr, 10);
  if (isNaN(shopId) || shopId <= 0) {
    throw new Error(`Invalid SHOP_ID: ${shopIdStr}`);
  }
  
  const daysBack = Number.parseInt(process.env.DAYS_BACK || '120', 10);
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

  const advertIds: number[] = [];
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
      advertIds.push(id);
    }
  }
  if (skippedByStatus > 0 || skippedByType > 0) {
    logger.info({ skippedByStatus, skippedByType }, 'Skipped campaigns (non-fullstats status/type)');
  }

  advertIds.sort((a, b) => a - b);

  const suffix = `-${daysBack}d-${activeWithinDays}dactive-shop${shopId ?? 'all'}`;
  const checkpointPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-adv-to-db${suffix}.checkpoint.json`;

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
      spendKopecksByDate: {},
      viewsCountByDate: {},
      clicksCountByDate: {},
      atbsCountByDate: {},
      ordersCountByDate: {},
      sumPriceKopecksByDate: {},
      spendManualKopecksByDate: {},
      viewsManualCountByDate: {},
      clicksManualCountByDate: {},
      atbsManualCountByDate: {},
      ordersManualCountByDate: {},
      sumPriceManualKopecksByDate: {},
      spendUnifiedKopecksByDate: {},
      viewsUnifiedCountByDate: {},
      clicksUnifiedCountByDate: {},
      atbsUnifiedCountByDate: {},
      ordersUnifiedCountByDate: {},
      sumPriceUnifiedKopecksByDate: {},
      errors: [],
    };
    await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');
  }

  const dates = listDates(dateFrom, dateTo);

  logger.info({ daysBack, dateFrom, dateTo, adverts: advertIds.length, startIndex: cp.index }, 'ADV -> DB');

  // WB /adv/v3/fullstats: max 50 campaign IDs per request, rate limit 3 req/min (20s interval)
  const BATCH_SIZE = 50;
  const RATE_DELAY_MS = 21_000; // 21s to stay under 3 req/min

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

  for (let i = cp.index; i < advertIds.length; i += BATCH_SIZE) {
    const batch = advertIds.slice(i, i + BATCH_SIZE);
    const batchIds = batch.join(',');

    logger.info({ batchStart: i, batchEnd: i + batch.length, total: advertIds.length, windows: dateWindows.length }, 'Processing batch');

    // Iterate over each 31-day window for this batch
    for (const win of dateWindows) {
      try {
        const stats = await wbJson(`https://advert-api.wildberries.ru/adv/v3/fullstats?ids=${batchIds}&beginDate=${win.begin}&endDate=${win.end}`, apiKey, { method: 'GET', workspaceId, shopId });

        if (Array.isArray(stats)) {
          for (const adv of stats) {
            const advId = adv?.advertId;
            const advertType = typeof advId === 'number' ? (advertTypeById.get(advId) ?? null) : null;
            const isUnified = advertType === 8;
            for (const day of adv?.days ?? []) {
              const d = typeof day?.date === 'string' ? day.date.slice(0, 10) : null;
              const sumRub = typeof day?.sum === 'number' ? day.sum : 0;
              const views = typeof day?.views === 'number' ? day.views : 0;
              const clicks = typeof day?.clicks === 'number' ? day.clicks : 0;
              const atbs = typeof day?.atbs === 'number' ? day.atbs : 0;
              const orders = typeof day?.orders === 'number' ? day.orders : 0;
              const sumPriceRub = typeof day?.sum_price === 'number' ? day.sum_price : 0;
              if (!d) continue;
              if (d < dateFrom || d > dateTo) continue;
              const k = Math.round(sumRub * 100);
              const sumPriceK = Math.round(sumPriceRub * 100);
              cp.spendKopecksByDate[d] = (cp.spendKopecksByDate[d] ?? 0) + k;
              cp.viewsCountByDate[d] = (cp.viewsCountByDate[d] ?? 0) + Math.round(views);
              cp.clicksCountByDate[d] = (cp.clicksCountByDate[d] ?? 0) + Math.round(clicks);
              cp.atbsCountByDate[d] = (cp.atbsCountByDate[d] ?? 0) + Math.round(atbs);
              cp.ordersCountByDate[d] = (cp.ordersCountByDate[d] ?? 0) + Math.round(orders);
              cp.sumPriceKopecksByDate[d] = (cp.sumPriceKopecksByDate[d] ?? 0) + sumPriceK;

              if (isUnified) {
                cp.spendUnifiedKopecksByDate[d] = (cp.spendUnifiedKopecksByDate[d] ?? 0) + k;
                cp.viewsUnifiedCountByDate[d] = (cp.viewsUnifiedCountByDate[d] ?? 0) + Math.round(views);
                cp.clicksUnifiedCountByDate[d] = (cp.clicksUnifiedCountByDate[d] ?? 0) + Math.round(clicks);
                cp.atbsUnifiedCountByDate[d] = (cp.atbsUnifiedCountByDate[d] ?? 0) + Math.round(atbs);
                cp.ordersUnifiedCountByDate[d] = (cp.ordersUnifiedCountByDate[d] ?? 0) + Math.round(orders);
                cp.sumPriceUnifiedKopecksByDate[d] = (cp.sumPriceUnifiedKopecksByDate[d] ?? 0) + sumPriceK;
              } else {
                cp.spendManualKopecksByDate[d] = (cp.spendManualKopecksByDate[d] ?? 0) + k;
                cp.viewsManualCountByDate[d] = (cp.viewsManualCountByDate[d] ?? 0) + Math.round(views);
                cp.clicksManualCountByDate[d] = (cp.clicksManualCountByDate[d] ?? 0) + Math.round(clicks);
                cp.atbsManualCountByDate[d] = (cp.atbsManualCountByDate[d] ?? 0) + Math.round(atbs);
                cp.ordersManualCountByDate[d] = (cp.ordersManualCountByDate[d] ?? 0) + Math.round(orders);
                cp.sumPriceManualKopecksByDate[d] = (cp.sumPriceManualKopecksByDate[d] ?? 0) + sumPriceK;
              }
            }
          }
        }
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (!msg.includes('Invalid Params')) {
          for (const id of batch) cp.errors.push({ advertId: id, message: `window ${win.begin}..${win.end}: ${msg.slice(0, 400)}` });
        } else {
          cp.skippedInvalidParams = (cp.skippedInvalidParams ?? 0) + batch.length;
          if ((cp.skippedInvalidParams ?? 0) <= 5) {
            console.warn(`[advSpend] Skipped batch ${batchIds.slice(0, 80)}: Invalid Params (${win.begin}..${win.end})`);
          }
        }
      }

      // Respect WB rate limit between each window request
      await sleep(RATE_DELAY_MS);
    }

    cp.index = Math.min(i + BATCH_SIZE, advertIds.length);
    cp.updatedAt = new Date().toISOString();
    await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');
  }

  // Upsert daily spend into DB — only dates that have any data (avoid overwriting with zeros)
  const datesWithData = dates.filter(d =>
    (cp.spendKopecksByDate[d] ?? 0) > 0 ||
    (cp.viewsCountByDate[d] ?? 0) > 0 ||
    (cp.clicksCountByDate[d] ?? 0) > 0
  );
  logger.info({ totalDates: dates.length, datesWithData: datesWithData.length }, 'Writing to DB');

  for (const d of datesWithData) {
    const spendKopecks = cp.spendKopecksByDate[d] ?? 0;
    const viewsCount = cp.viewsCountByDate[d] ?? 0;
    const clicksCount = cp.clicksCountByDate[d] ?? 0;
    const atbsCount = cp.atbsCountByDate[d] ?? 0;
    const ordersCount = cp.ordersCountByDate[d] ?? 0;
    const sumPriceKopecks = cp.sumPriceKopecksByDate[d] ?? 0;

    const spendManualKopecks = cp.spendManualKopecksByDate[d] ?? 0;
    const viewsManualCount = cp.viewsManualCountByDate[d] ?? 0;
    const clicksManualCount = cp.clicksManualCountByDate[d] ?? 0;
    const atbsManualCount = cp.atbsManualCountByDate[d] ?? 0;
    const ordersManualCount = cp.ordersManualCountByDate[d] ?? 0;
    const sumPriceManualKopecks = cp.sumPriceManualKopecksByDate[d] ?? 0;

    const spendUnifiedKopecks = cp.spendUnifiedKopecksByDate[d] ?? 0;
    const viewsUnifiedCount = cp.viewsUnifiedCountByDate[d] ?? 0;
    const clicksUnifiedCount = cp.clicksUnifiedCountByDate[d] ?? 0;
    const atbsUnifiedCount = cp.atbsUnifiedCountByDate[d] ?? 0;
    const ordersUnifiedCount = cp.ordersUnifiedCountByDate[d] ?? 0;
    const sumPriceUnifiedKopecks = cp.sumPriceUnifiedKopecksByDate[d] ?? 0;

    await db
      .insert(wbAdvDaily)
      .values({
        workspaceId,
        shopId,
        date: d,
        spendKopecks,
        viewsCount,
        clicksCount,
        atbsCount,
        ordersCount,
        sumPriceKopecks,
        spendManualKopecks,
        viewsManualCount,
        clicksManualCount,
        atbsManualCount,
        ordersManualCount,
        sumPriceManualKopecks,
        spendUnifiedKopecks,
        viewsUnifiedCount,
        clicksUnifiedCount,
        atbsUnifiedCount,
        ordersUnifiedCount,
        sumPriceUnifiedKopecks,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [wbAdvDaily.workspaceId, wbAdvDaily.shopId, wbAdvDaily.date],
        set: {
          spendKopecks,
          viewsCount,
          clicksCount,
          atbsCount,
          ordersCount,
          sumPriceKopecks,
          spendManualKopecks,
          viewsManualCount,
          clicksManualCount,
          atbsManualCount,
          ordersManualCount,
          sumPriceManualKopecks,
          spendUnifiedKopecks,
          viewsUnifiedCount,
          clicksUnifiedCount,
          atbsUnifiedCount,
          ordersUnifiedCount,
          sumPriceUnifiedKopecks,
          updatedAt: new Date(),
        },
      });
  }

  const outPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-adv-to-db${suffix}-${dateFrom}_to_${dateTo}.json`;
  await writeFile(
    outPath,
    JSON.stringify(
      {
        workspaceId,
        daysBack,
        dateFrom,
        dateTo,
        activeWithinDays,
        spendKopecksByDate: cp.spendKopecksByDate,
        errors: cp.errors,
        advertsTotal: advertIds.length,
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
    logger.error({ err: e }, 'advSpend failed');
    process.exit(1);
  });
