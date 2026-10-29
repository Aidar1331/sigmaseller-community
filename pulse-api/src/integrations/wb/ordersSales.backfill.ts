import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { wbGetJson, getWbApiKey as getApiKey } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'ordersSalesBackfill' });

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

type Daily = { date: string; ordersCount: number; salesCount: number; salesRub: number };

type Cp = {
  startedAt: string;
  updatedAt: string;
  daysBack: number;
  dateTo: string;
  // We page backwards: each step requests dateFrom = cursorFrom
  cursorFrom: string;
  done: boolean;
  ordersByDate: Record<string, number>;
  salesCountByDate: Record<string, number>;
  salesRubByDate: Record<string, number>;
};

function dayKeyFromAny(row: any): string | null {
  const v = row?.date || row?.lastChangeDate;
  if (!v || typeof v !== 'string') return null;
  return v.slice(0, 10);
}

async function main() {
  await mkdir('out', { recursive: true });

  const daysBack = Number.parseInt(process.env.DAYS_BACK || '120', 10);
  const shopIdStr = process.env.SHOP_ID;
  const shopId = shopIdStr ? Number.parseInt(shopIdStr, 10) : undefined;
  const apiKey = await getApiKey();

  const today = new Date();
  const dateTo = isoDate(today);
  const minFrom = isoDate(addDays(today, -daysBack));

  const checkpointPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-orders-sales-backfill-shop${shopId ?? 'all'}-${daysBack}d.checkpoint.json`;

  let cp: Cp | null = null;
  try {
    cp = JSON.parse(await readFile(checkpointPath, 'utf8')) as Cp;
    if (cp.daysBack !== daysBack || cp.dateTo !== dateTo) cp = null;
  } catch {
    // ignore
  }

  if (!cp) {
    cp = {
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      daysBack,
      dateTo,
      cursorFrom: dateTo,
      done: false,
      ordersByDate: {},
      salesCountByDate: {},
      salesRubByDate: {},
    };
  }

  const stepDays = Number.parseInt(process.env.STEP_DAYS || '14', 10);

  logger.info({ daysBack, minFrom, dateTo, stepDays, cursorFrom: cp.cursorFrom }, 'Backfill orders/sales');

  while (!cp.done) {
    const from = cp.cursorFrom;
    if (from < minFrom) {
      cp.done = true;
      break;
    }

    logger.info({ from }, 'Fetching orders/sales');

    // Orders
    {
      const url = `https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${encodeURIComponent(from)}&flag=0`;
      const rows = await wbGetJson(url, apiKey);
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const day = dayKeyFromAny(row);
          if (!day) continue;
          if (day < minFrom || day > dateTo) continue;
          cp.ordersByDate[day] = (cp.ordersByDate[day] ?? 0) + 1;
        }
      }
    }

    // Sales
    {
      const url = `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${encodeURIComponent(from)}&flag=0`;
      const rows = await wbGetJson(url, apiKey);
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const day = dayKeyFromAny(row);
          if (!day) continue;
          if (day < minFrom || day > dateTo) continue;
          cp.salesCountByDate[day] = (cp.salesCountByDate[day] ?? 0) + 1;
          const amount =
            (typeof row?.forPay === 'number' ? row.forPay : null) ??
            (typeof row?.totalPrice === 'number' ? row.totalPrice : null) ??
            (typeof row?.finishedPrice === 'number' ? row.finishedPrice : null) ??
            0;
          cp.salesRubByDate[day] = (cp.salesRubByDate[day] ?? 0) + amount;
        }
      }
    }

    // checkpoint each iteration
    cp.updatedAt = new Date().toISOString();
    await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');

    // move cursor backward
    const d = new Date(from + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - stepDays);
    cp.cursorFrom = isoDate(d);

    // polite delay
    await sleep(600);
  }

  // finalize
  const days = new Set<string>([...Object.keys(cp.ordersByDate), ...Object.keys(cp.salesCountByDate), ...Object.keys(cp.salesRubByDate)]);
  const metrics: Daily[] = Array.from(days)
    .filter((d) => d >= minFrom && d <= dateTo)
    .sort()
    .map((date) => ({
      date,
      ordersCount: cp!.ordersByDate[date] ?? 0,
      salesCount: cp!.salesCountByDate[date] ?? 0,
      salesRub: Math.round(((cp!.salesRubByDate[date] ?? 0) as number) * 100) / 100,
    }));

  const outPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-orders-sales-${daysBack}d-${minFrom}_to_${dateTo}.json`;
  await writeFile(outPath, JSON.stringify({ daysBack, dateFrom: minFrom, dateTo, metrics, finishedAt: new Date().toISOString() }, null, 2), 'utf8');
  logger.info({ outPath }, 'Wrote output file');
}

main().catch((e) => {
  logger.error({ err: e }, 'ordersSalesBackfill failed');
  process.exitCode = 1;
});
