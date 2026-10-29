import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { wbGetJson, getWbApiKey as getApiKey } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'financeRealizationBackfill' });

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

type DailyFinance = {
  // counts
  lines: number;

  // money (RUB)
  retailWithDiscRub: number; // retail_price_withdisc_rub
  payoutRub: number; // payout
  commissionRub: number; // retailWithDiscRub - payout? (approx)
  deliveryRub: number; // delivery_rub
  returnDeliveryRub: number; // return_amount
  penaltyRub: number; // penalty
  additionalPaymentRub: number; // additional_payment
  storageFeeRub: number; // storage_fee
};

type Cp = {
  startedAt: string;
  updatedAt: string;
  daysBack: number;
  dateFrom: string;
  dateTo: string;
  windowDays: number;
  winIndex: number;
  rrdid: number;
  daily: Record<string, DailyFinance>;
  errors: Array<{ winIndex: number; message: string }>;
};

function ensureDay(rec: Record<string, DailyFinance>, date: string): DailyFinance {
  if (!rec[date]) {
    rec[date] = {
      lines: 0,
      retailWithDiscRub: 0,
      payoutRub: 0,
      commissionRub: 0,
      deliveryRub: 0,
      returnDeliveryRub: 0,
      penaltyRub: 0,
      additionalPaymentRub: 0,
      storageFeeRub: 0,
    };
  }
  return rec[date]!;
}

function pickDate(row: any): string | null {
  // Prefer sale_dt if present; else date_from/date_to are report period.
  const d = row?.sale_dt || row?.rr_dt || row?.date_from;
  return typeof d === 'string' ? d.slice(0, 10) : null;
}

function num(v: any): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

async function main() {
  await mkdir('out', { recursive: true });

  const daysBack = Number.parseInt(process.env.DAYS_BACK || '120', 10);
  const windowDays = Number.parseInt(process.env.WINDOW_DAYS || '30', 10);
  const shopIdStr = process.env.SHOP_ID;
  const shopId = shopIdStr ? Number.parseInt(shopIdStr, 10) : undefined;

  const apiKey = await getApiKey();

  const today = new Date();
  const dateTo = isoDate(today);
  const dateFrom = isoDate(addDays(today, -daysBack));

  const windows = listWindows(dateFrom, dateTo, windowDays);

  const checkpointPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-finance-realization-shop${shopId ?? 'all'}-${daysBack}d.checkpoint.json`;
  let cp: Cp | null = null;

  try {
    cp = JSON.parse(await readFile(checkpointPath, 'utf8')) as Cp;
    if (cp.daysBack !== daysBack || cp.dateFrom !== dateFrom || cp.dateTo !== dateTo || cp.windowDays !== windowDays) cp = null;
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
      windowDays,
      winIndex: 0,
      rrdid: 0,
      daily: {},
      errors: [],
    };
    await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');
  }

  logger.info({ daysBack, dateFrom, dateTo, windowDays, windows: windows.length, startWin: cp.winIndex, rrdid: cp.rrdid }, 'Finance realization backfill');

  for (let wi = cp.winIndex; wi < windows.length; wi++) {
    const w = windows[wi]!;
    let rrdid = wi === cp.winIndex ? cp.rrdid : 0;

    logger.info({ window: `${wi + 1}/${windows.length}`, from: w.from, to: w.to, startRrdid: rrdid }, 'Processing window');

    while (true) {
      const url = `https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod?dateFrom=${encodeURIComponent(
        w.from
      )}&dateTo=${encodeURIComponent(w.to)}&limit=100000&rrdid=${rrdid}&period=daily`;

      let rows: any;
      try {
        rows = await wbGetJson(url, apiKey);
      } catch (e: any) {
        cp.errors.push({ winIndex: wi, message: String(e?.message ?? e).slice(0, 300) });
        break;
      }

      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const row of rows) {
        const day = pickDate(row);
        if (!day) continue;
        if (day < dateFrom || day > dateTo) continue;

        const d = ensureDay(cp.daily, day);
        d.lines += 1;

        const retailWithDiscRub = num(row?.retail_price_withdisc_rub);
        const payoutRub = num(row?.payout);

        d.retailWithDiscRub += retailWithDiscRub;
        d.payoutRub += payoutRub;

        // Approx commission (WB удержания) as difference where possible
        d.commissionRub += Math.max(0, retailWithDiscRub - payoutRub);

        d.deliveryRub += num(row?.delivery_rub);
        d.returnDeliveryRub += num(row?.return_amount);
        d.penaltyRub += num(row?.penalty);
        d.additionalPaymentRub += num(row?.additional_payment);
        d.storageFeeRub += num(row?.storage_fee);

        const next = row?.rrd_id;
        if (typeof next === 'number' && next > rrdid) rrdid = next;
      }

      // checkpoint each page
      cp.winIndex = wi;
      cp.rrdid = rrdid;
      cp.updatedAt = new Date().toISOString();
      await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');

      // be kind to limiter
      await sleep(350);

      // If less than limit, probably done.
      if (rows.length < 100000) break;

      // Continue from last rrdid
    }

    // move to next window
    cp.winIndex = wi + 1;
    cp.rrdid = 0;
    cp.updatedAt = new Date().toISOString();
    await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');

    await sleep(600);
  }

  const outPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-finance-realization-${daysBack}d-${dateFrom}_to_${dateTo}.json`;
  await writeFile(
    outPath,
    JSON.stringify({ daysBack, dateFrom, dateTo, daily: cp.daily, errors: cp.errors, finishedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );

  logger.info({ outPath }, 'Wrote output file');
}

main().catch((e) => {
  logger.error({ err: e }, 'financeRealizationBackfill failed');
  process.exitCode = 1;
});
