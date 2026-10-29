import 'dotenv/config';
import { eq, and, gte, lte, desc, asc, or, sql, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { wbSppWeekly } from '../../db/schema.js';
import { getWbApiKey, wbGetJson } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'sppWeeklyToDb' });

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function weekStart(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7; // 0=Mon
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function weekEnd(startIso: string): string {
  return isoDate(addDays(new Date(startIso + 'T00:00:00Z'), 6));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function sppWeeklyToDb(params: { workspaceId: number; shopId?: number; daysBack: number; period: 'daily' | 'weekly' }) {
  const apiKey = await getWbApiKey(params.workspaceId, params.shopId);
  const today = isoDate(new Date());
  const from = isoDate(addDays(new Date(today + 'T00:00:00Z'), -params.daysBack));

  // compute week buckets covering [from..today]
  const buckets: Array<{ from: string; to: string }> = [];
  let cur = weekStart(from);
  while (cur <= today) {
    const wFrom = cur;
    const wTo = weekEnd(wFrom);
    buckets.push({ from: wFrom < from ? from : wFrom, to: wTo > today ? today : wTo });
    cur = isoDate(addDays(new Date(wFrom + 'T00:00:00Z'), 7));
  }

  logger.info({ workspaceId: params.workspaceId, daysBack: params.daysBack, buckets: buckets.length, from, today }, 'SPP weekly -> DB');

  for (const b of buckets) {
    logger.info({ from: b.from, to: b.to }, 'Processing bucket');

    let rrdid = 0;

    // accumulators by nmId
    const sumPctTimesBase = new Map<number, number>();
    const sumBase = new Map<number, number>();
    const lines = new Map<number, number>();

    while (true) {
      const url = `https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod?dateFrom=${encodeURIComponent(
        b.from
      )}&dateTo=${encodeURIComponent(b.to)}&limit=100000&rrdid=${rrdid}&period=${params.period}`;

      const rows = await wbGetJson(url, apiKey, 1, { workspaceId: params.workspaceId, shopId: params.shopId });
      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const row of rows) {
        const oper = String(row?.supplier_oper_name ?? '');
        if (!oper.includes('Продажа')) continue;

        const nmId = Number(row?.nm_id);
        if (!Number.isFinite(nmId) || nmId <= 0) continue;

        const pct = typeof row?.ppvz_spp_prc === 'number' ? row.ppvz_spp_prc : null;
        const base = typeof row?.retail_price_withdisc_rub === 'number' ? row.retail_price_withdisc_rub : 0;
        if (pct == null || !Number.isFinite(pct) || base <= 0) continue;

        sumPctTimesBase.set(nmId, (sumPctTimesBase.get(nmId) ?? 0) + pct * base);
        sumBase.set(nmId, (sumBase.get(nmId) ?? 0) + base);
        lines.set(nmId, (lines.get(nmId) ?? 0) + 1);

        const next = row?.rrd_id;
        if (typeof next === 'number' && next > rrdid) rrdid = next;
      }

      if (rows.length < 100000) break;
      await sleep(350);
    }

    const nmIds = [...sumBase.keys()];
    logger.info({ nmIdsWithSales: nmIds.length }, 'Bucket nmIds with sales');

    const batch: Array<{
      workspaceId: number;
      dateFrom: string;
      dateTo: string;
      nmId: number;
      sppPctBp: number;
      lines: number;
      updatedAt: Date;
    }> = [];

    for (const nmId of nmIds) {
      const w = sumBase.get(nmId) ?? 0;
      const ws = sumPctTimesBase.get(nmId) ?? 0;
      const avgPct = w > 0 ? ws / w : 0; // percent
      const sppPctBp = Math.round(avgPct * 100); // percent -> basis points

      batch.push({
        workspaceId: params.workspaceId,
        dateFrom: b.from,
        dateTo: b.to,
        nmId,
        sppPctBp,
        lines: lines.get(nmId) ?? 0,
        updatedAt: new Date(),
      });
    }

    const batchSize = 500;
    for (let i = 0; i < batch.length; i += batchSize) {
      const chunk = batch.slice(i, i + batchSize);
      if (chunk.length === 0) continue;
      await db
        .insert(wbSppWeekly)
        .values(chunk)
        .onConflictDoUpdate({
          target: [wbSppWeekly.workspaceId, wbSppWeekly.dateFrom, wbSppWeekly.dateTo, wbSppWeekly.nmId],
          set: {
            sppPctBp: sql`excluded.spp_pct_bp`,
            lines: sql`excluded.lines`,
            updatedAt: new Date(),
          },
        });
    }

    // be kind to 1/min limiter
    await sleep(61_000);
  }
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
  const shopId = shopIdStr ? Number.parseInt(shopIdStr, 10) : undefined;
  if (shopIdStr && (isNaN(shopId!) || shopId! <= 0)) {
    throw new Error(`Invalid SHOP_ID: ${shopIdStr}`);
  }
  const daysBack = Number.parseInt(process.env.DAYS_BACK || '14', 10);
  const period = (process.env.WB_REPORT_PERIOD || 'daily') as 'daily' | 'weekly';

  await sppWeeklyToDb({ workspaceId, shopId, daysBack, period });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error({ err: e }, 'sppWeeklyToDb failed');
    process.exit(1);
  });
