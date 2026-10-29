import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { getWbApiKey as getApiKey } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'advSpendBackfill' });

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
  let body: string | undefined;
  if (opts.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body ?? null);
  }

  const ac = new AbortController();
  const timeoutMs = 30_000;
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const res = await fetch(url, { method: opts.method, headers, body, signal: ac.signal }).finally(() =>
    clearTimeout(t)
  );
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

function buildDates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; ) {
    out.push(d);
    const dt = new Date(d + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + 1);
    d = isoDate(dt);
  }
  return out;
}

type Checkpoint = {
  startedAt: string;
  updatedAt: string;
  daysBack: number;
  dateFrom: string;
  dateTo: string;
  advertIdsTotal: number;
  index: number; // next advert index
  spendByDate: Record<string, number>;
  errors: Array<{ advertId: number; message: string }>;
};

async function main() {
  await mkdir('out', { recursive: true });

  const daysBackList = (process.env.DAYS_BACK_LIST || '14,30,90,120')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  const apiKey = await getApiKey();

  const activeWithinDays = Number.parseInt(process.env.ACTIVE_WITHIN_DAYS || '0', 10);
  const cutoffMs =
    activeWithinDays > 0 ? Date.now() - activeWithinDays * 24 * 60 * 60 * 1000 : Number.NEGATIVE_INFINITY;

  // discover adverts once
  const promotions = await wbJson('https://advert-api.wildberries.ru/adv/v1/promotion/count', apiKey, {
    method: 'GET',
  });
  const advertIds: number[] = [];
  for (const group of promotions?.adverts ?? []) {
    for (const a of group?.advert_list ?? []) {
      const id = a?.advertId;
      const changeTime = a?.changeTime;
      if (typeof id !== 'number') continue;

      if (activeWithinDays > 0 && typeof changeTime === 'string') {
        const t = Date.parse(changeTime);
        if (Number.isFinite(t) && t < cutoffMs) continue;
      } else if (activeWithinDays > 0 && !changeTime) {
        // if we can't evaluate, skip (safer for “active within” filter)
        continue;
      }

      advertIds.push(id);
    }
  }

  // stable order
  advertIds.sort((a, b) => a - b);

  for (const daysBack of daysBackList) {
    const today = new Date();
    const dateTo = isoDate(today);
    const dateFrom = isoDate(addDays(today, -daysBack));

    const shopIdStr = process.env.SHOP_ID;
    const shopId = shopIdStr ? Number.parseInt(shopIdStr, 10) : undefined;
    const suffix = activeWithinDays > 0 ? `-${activeWithinDays}dactive` : '';
    const checkpointPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-adv-spend-backfill-shop${shopId ?? 'all'}-${daysBack}d${suffix}.checkpoint.json`;
    let cp: Checkpoint | null = null;

    try {
      const raw = await readFile(checkpointPath, 'utf8');
      cp = JSON.parse(raw) as Checkpoint;
      // ensure compatible
      if (cp.daysBack !== daysBack || cp.dateFrom !== dateFrom || cp.dateTo !== dateTo) {
        cp = null;
      }
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
        advertIdsTotal: advertIds.length,
        index: 0,
        spendByDate: {},
        errors: [],
      };
    }

    const dates = buildDates(cp.dateFrom, cp.dateTo);

    logger.info({ daysBack, dateFrom: cp.dateFrom, dateTo: cp.dateTo, adverts: advertIds.length, startIndex: cp.index }, 'Backfill adv spend');
    logger.info({ checkpointPath }, 'Checkpoint file');

    for (let i = cp.index; i < advertIds.length; i++) {
      const advertId = advertIds[i]!;

      // pre-checkpoint so we can see progress even if WB hangs
      cp.index = i;
      if (cp.index % 1 === 0) {
        cp.updatedAt = new Date().toISOString();
        await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');
        logger.info({ progress: `${cp.index}/${advertIds.length}`, nextAdvertId: advertId }, 'Progress');
      }

      logger.info({ advertId }, 'Fetching advert stats');

      try {
        const beginDate = dates[0];
        const endDate = dates[dates.length - 1];
        const stats = await wbJson(`https://advert-api.wildberries.ru/adv/v3/fullstats?ids=${advertId}&beginDate=${beginDate}&endDate=${endDate}`, apiKey, {
          method: 'GET',
        });

        if (Array.isArray(stats)) {
          for (const adv of stats) {
            for (const day of adv?.days ?? []) {
              const d = typeof day?.date === 'string' ? day.date.slice(0, 10) : null;
              const sum = typeof day?.sum === 'number' ? day.sum : 0;
              if (!d) continue;
              if (d < cp.dateFrom || d > cp.dateTo) continue;
              cp.spendByDate[d] = (cp.spendByDate[d] ?? 0) + sum;
            }
          }
        }
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        // WB often returns 400 when interval doesn't match campaign; treat as skip
        if (!msg.includes('Invalid Params')) {
          cp.errors.push({ advertId, message: msg.slice(0, 300) });
        }
      }

      cp.index = i + 1;

      // periodic checkpoint
      if (cp.index % 5 === 0 || cp.index === advertIds.length) {
        cp.updatedAt = new Date().toISOString();
        await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');
        logger.info({ progress: `${cp.index}/${advertIds.length}` }, 'Progressed');
      }

      // be kind to limiter
      await sleep(350);
    }

    // finalize file
    const outPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-adv-spend-${daysBack}d${suffix}-${cp.dateFrom}_to_${cp.dateTo}.json`;
    await writeFile(outPath, JSON.stringify({
      daysBack: cp.daysBack,
      dateFrom: cp.dateFrom,
      dateTo: cp.dateTo,
      spendByDate: cp.spendByDate,
      errors: cp.errors,
      advertsTotal: cp.advertIdsTotal,
      finishedAt: new Date().toISOString(),
    }, null, 2), 'utf8');

    logger.info({ outPath }, 'Wrote output file');
  }
}

main().catch((e) => {
  logger.error({ err: e }, 'advSpendBackfill failed');
  process.exitCode = 1;
});
