import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { getWbApiKey as getApiKey } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'salesFunnelBackfill' });

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function wbJson(
  url: string,
  apiKey: string,
  opts: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' },
  attempt = 1
): Promise<any> {
  const headers: Record<string, string> = { Authorization: apiKey };
  let bodyText: string | undefined;
  if (opts.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    bodyText = JSON.stringify(opts.body ?? null);
  }

  const ac = new AbortController();
  const timeoutMs = 30_000;
  const t = setTimeout(() => ac.abort(), timeoutMs);

  const res = await fetch(url, {
    method: opts.method,
    headers,
    body: bodyText,
    signal: ac.signal,
  }).finally(() => clearTimeout(t));

  const text = await res.text();

  if ((res.status === 429 || res.status === 504) && attempt <= 8) {
    const waitMs = Math.min(60_000, 1000 * 2 ** (attempt - 1));
    await sleep(waitMs);
    return wbJson(url, apiKey, opts, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`WB ${opts.method} ${url} failed: ${res.status} ${text.slice(0, 500)}`);
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

type FunnelDaily = {
  openCount: number;
  cartCount: number;
  orderCount: number;
  orderSum: number;
  buyoutCount: number;
  buyoutSum: number;
  addToWishlistCount: number;
};

type Cp = {
  startedAt: string;
  updatedAt: string;
  daysBack: number;
  dateFrom: string;
  dateTo: string;
  nmIdsTotal: number;
  batchSize: number;
  batchIndex: number;
  funnelByDate: Record<string, FunnelDaily>;
  errors: Array<{ batchIndex: number; message: string }>;
};

function ensureDay(rec: Record<string, FunnelDaily>, date: string): FunnelDaily {
  if (!rec[date]) {
    rec[date] = {
      openCount: 0,
      cartCount: 0,
      orderCount: 0,
      orderSum: 0,
      buyoutCount: 0,
      buyoutSum: 0,
      addToWishlistCount: 0,
    };
  }
  return rec[date]!;
}

async function discoverNmIds(apiKey: string, dateFrom: string): Promise<number[]> {
  const nm = new Set<number>();

  const urls = [
    `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${encodeURIComponent(dateFrom)}&flag=0`,
    `https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${encodeURIComponent(dateFrom)}&flag=0`,
  ];

  for (const url of urls) {
    const rows = await wbJson(url, apiKey, { method: 'GET' });
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (typeof row?.nmId === 'number') nm.add(row.nmId);
    }
    // small pause between big list endpoints
    await sleep(500);
  }

  return Array.from(nm).sort((a, b) => a - b);
}

async function main() {
  await mkdir('out', { recursive: true });

  const daysBack = Number.parseInt(process.env.DAYS_BACK || '120', 10);
  const batchSize = Number.parseInt(process.env.BATCH_SIZE || '50', 10);
  const shopIdStr = process.env.SHOP_ID;
  const shopId = shopIdStr ? Number.parseInt(shopIdStr, 10) : undefined;

  const apiKey = await getApiKey();

  const today = new Date();
  const dateTo = isoDate(today);
  const requestedFrom = isoDate(addDays(today, -daysBack));

  const maxLookbackDays = Number.parseInt(process.env.MAX_LOOKBACK_DAYS || '90', 10);
  const minAllowedFrom = isoDate(addDays(today, -maxLookbackDays));
  const dateFrom = requestedFrom < minAllowedFrom ? minAllowedFrom : requestedFrom;

  const checkpointPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-sales-funnel-history-shop${shopId ?? 'all'}-${daysBack}d.checkpoint.json`;

  let cp: Cp | null = null;
  try {
    cp = JSON.parse(await readFile(checkpointPath, 'utf8')) as Cp;
    if (cp.daysBack !== daysBack || cp.dateFrom !== dateFrom || cp.dateTo !== dateTo || cp.batchSize !== batchSize) cp = null;
  } catch {
    // ignore
  }

  let nmIds: number[];
  if (!cp) {
    nmIds = await discoverNmIds(apiKey, dateFrom);
    cp = {
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      daysBack,
      dateFrom,
      dateTo,
      nmIdsTotal: nmIds.length,
      batchSize,
      batchIndex: 0,
      funnelByDate: {},
      errors: [],
    };
    await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');
  } else {
    nmIds = await discoverNmIds(apiKey, dateFrom);
    // If nmIds set changed, we still proceed but clamp by current.
    cp.nmIdsTotal = nmIds.length;
  }

  const periodDays = Number.parseInt(process.env.PERIOD_DAYS || '60', 10);

  logger.info({ daysBack, dateFrom, dateTo, maxLookbackDays, nmIds: nmIds.length, batchSize, periodDays, startBatch: cp.batchIndex }, 'Sales funnel history backfill');

  const totalBatches = Math.ceil(nmIds.length / batchSize);

  // Split long intervals: WB enforces max days per request.
  let periodStart = dateFrom;
  while (periodStart <= dateTo) {
    const s = new Date(periodStart + 'T00:00:00Z');
    const e = addDays(s, periodDays - 1);
    const periodEnd = isoDate(e) > dateTo ? dateTo : isoDate(e);

    logger.info({ periodStart, periodEnd }, 'Processing period');

    for (let b = cp.batchIndex; b < totalBatches; b++) {
      cp.batchIndex = b;
      cp.updatedAt = new Date().toISOString();
      await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');

      const slice = nmIds.slice(b * batchSize, b * batchSize + batchSize);
      logger.info({ batch: `${b + 1}/${totalBatches}`, nmIds: slice.length }, 'Processing batch');

      try {
        const resp = await wbJson(
          'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products/history',
          apiKey,
          {
            method: 'POST',
            body: {
              selectedPeriod: { start: periodStart, end: periodEnd },
              nmIds: slice,
            },
          }
        );

      if (Array.isArray(resp)) {
        for (const product of resp) {
          for (const h of product?.history ?? []) {
            const d = typeof h?.date === 'string' ? h.date.slice(0, 10) : null;
            if (!d) continue;
            if (d < dateFrom || d > dateTo) continue;

            const day = ensureDay(cp.funnelByDate, d);
            day.openCount += typeof h.openCount === 'number' ? h.openCount : 0;
            day.cartCount += typeof h.cartCount === 'number' ? h.cartCount : 0;
            day.orderCount += typeof h.orderCount === 'number' ? h.orderCount : 0;
            day.orderSum += typeof h.orderSum === 'number' ? h.orderSum : 0;
            day.buyoutCount += typeof h.buyoutCount === 'number' ? h.buyoutCount : 0;
            day.buyoutSum += typeof h.buyoutSum === 'number' ? h.buyoutSum : 0;
            day.addToWishlistCount += typeof h.addToWishlistCount === 'number' ? h.addToWishlistCount : 0;
          }
        }
      }
      } catch (e: any) {
        cp.errors.push({ batchIndex: b, message: String(e?.message ?? e).slice(0, 300) });
      }

      cp.updatedAt = new Date().toISOString();
      await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');

      // be kind to limiter
      await sleep(800);
    }

    // reset batch index for next period
    cp.batchIndex = 0;

    const next = addDays(new Date(periodEnd + 'T00:00:00Z'), 1);
    periodStart = isoDate(next);

    // between periods
    await sleep(1200);
  }

  cp.batchIndex = totalBatches;
  cp.updatedAt = new Date().toISOString();
  await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');

  const outPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-sales-funnel-history-${daysBack}d-${dateFrom}_to_${dateTo}.json`;
  await writeFile(
    outPath,
    JSON.stringify(
      {
        daysBack,
        requestedFrom,
        dateFrom,
        dateTo,
        maxLookbackDays,
        funnelByDate: cp.funnelByDate,
        errors: cp.errors,
        nmIdsTotal: nmIds.length,
        finishedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );

  logger.info({ outPath }, 'Wrote output file');
}

main().catch((e) => {
  logger.error({ err: e }, 'salesFunnelBackfill failed');
  process.exitCode = 1;
});
