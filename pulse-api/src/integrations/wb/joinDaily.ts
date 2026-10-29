import { readFile, writeFile } from 'node:fs/promises';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'joinDaily' });

type OrdersSalesFile = {
  daysBack: number;
  dateFrom: string;
  dateTo: string;
  metrics: Array<{ date: string; ordersCount: number; salesCount: number; salesRub: number }>;
};

type AdvSpendFile = {
  daysBack: number;
  dateFrom: string;
  dateTo: string;
  spendByDate: Record<string, number>;
};

function listDates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; ) {
    out.push(d);
    const dt = new Date(d + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + 1);
    d = dt.toISOString().slice(0, 10);
  }
  return out;
}

async function main() {
  const ordersSalesPath = process.env.ORDERS_SALES_PATH;
  const advSpendPath = process.env.ADV_SPEND_PATH;

  if (!ordersSalesPath || !advSpendPath) {
    throw new Error('Set ORDERS_SALES_PATH and ADV_SPEND_PATH');
  }

  let ordersSales: OrdersSalesFile;
  let adv: AdvSpendFile;
  try {
    ordersSales = JSON.parse(await readFile(ordersSalesPath, 'utf8')) as OrdersSalesFile;
  } catch (e) {
    throw new Error(`Failed to parse ${ordersSalesPath}: ${e instanceof Error ? e.message : e}`);
  }
  try {
    adv = JSON.parse(await readFile(advSpendPath, 'utf8')) as AdvSpendFile;
  } catch (e) {
    throw new Error(`Failed to parse ${advSpendPath}: ${e instanceof Error ? e.message : e}`);
  }

  const from = ordersSales.dateFrom;
  const to = ordersSales.dateTo;

  const osByDate = new Map(ordersSales.metrics.map((m) => [m.date, m] as const));

  const daily = listDates(from, to).map((date) => {
    const os = osByDate.get(date);
    const advSpendRub = adv.spendByDate?.[date] ?? 0;

    return {
      date,
      ordersCount: os?.ordersCount ?? 0,
      salesCount: os?.salesCount ?? 0,
      salesRub: os?.salesRub ?? 0,
      advSpendRub: Math.round(advSpendRub * 100) / 100,
    };
  });

  const outPath = process.env.OUT_PATH || `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-daily-joined-${from}_to_${to}.json`;
  await writeFile(outPath, JSON.stringify({ dateFrom: from, dateTo: to, daily }, null, 2), 'utf8');
  logger.info({ outPath }, 'Wrote output file');
}

main().catch((e) => {
  logger.error({ err: e }, 'joinDaily failed');
  process.exitCode = 1;
});
