/**
 * WB API usage meter — counts requests AND billable "entities" per day.
 *
 * WB started charging cloud services per ENTITY returned (not per request)
 * on 2026-01-01. To see actual spend we record, on every successful WB call,
 * two numbers in Redis: the request count and an entity count (approximated
 * by the size of the response payload — see countEntities()).
 *
 * Storage: two Redis hashes per UTC day, 35-day TTL.
 *   wbusage:req:{YYYY-MM-DD}  field=`{sid}|{host}{path}` → request count
 *   wbusage:ent:{YYYY-MM-DD}  field=`{sid}|{host}{path}` → entity count
 *
 * `sid` is the WB seller-account id (JWT `sid` claim) so we can split cost
 * per shop/seller, matching WB's own billing granularity. Falls back to
 * `global` when no sid is available.
 *
 * Fully fail-safe: any Redis/parse error is swallowed. Recording is
 * fire-and-forget (callers do `void recordWbUsage(...)`) so it adds zero
 * latency to the WB request path.
 */

import { getRedis } from '../../lib/redis.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'wbUsageMeter' });

const TTL_SEC = 35 * 24 * 60 * 60; // keep ~5 weeks of daily breakdowns

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Stable, query-free endpoint label: `host` + `pathname`, no trailing slash. */
function endpointLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return url.slice(0, 200);
  }
}

/**
 * Approximate the number of billable entities in a WB response.
 *
 * WB bills per "entity" (a card, a sale row, a price, ...). We don't know
 * WB's exact internal count, so we approximate by the size of the returned
 * collection — this is the right order of magnitude for cost tracking and
 * lets us spot the heavy endpoints. Heuristics, most-specific first:
 *   - Array            → length
 *   - {data: [...]}    → data.length        (most stats/analytics endpoints)
 *   - {cards: [...]}   → cards.length        (content)
 *   - {feedbacks/questions/orders/sales/stocks/report: [...]} → that length
 *   - any object whose first array-valued field → that length
 *   - otherwise        → 1 (a single-object response still costs ≥1 entity)
 */
export function countEntities(parsed: unknown): number {
  if (parsed == null) return 0;
  if (Array.isArray(parsed)) return parsed.length;
  if (typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const named = ['data', 'cards', 'feedbacks', 'questions', 'orders', 'sales', 'stocks', 'report', 'items', 'result'];
    for (const k of named) {
      const v = obj[k];
      if (Array.isArray(v)) return v.length;
      // nested {data:{cards:[...]}} / {data:{feedbacks:[...]}}
      if (v && typeof v === 'object') {
        for (const vv of Object.values(v as Record<string, unknown>)) {
          if (Array.isArray(vv)) return vv.length;
        }
      }
    }
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) return v.length;
    }
    return 1;
  }
  return 1;
}

/**
 * Record one WB call: +1 request and +entities for (day, sid, endpoint).
 * Fire-and-forget; never throws.
 */
export async function recordWbUsage(url: string, sellerId: string | undefined, entities: number): Promise<void> {
  try {
    const day = todayUtc();
    const field = `${sellerId ?? 'global'}|${endpointLabel(url)}`;
    const redis = getRedis();
    const reqKey = `wbusage:req:${day}`;
    const entKey = `wbusage:ent:${day}`;
    const reqCount = await redis.hincrby(reqKey, field, 1);
    await redis.hincrby(entKey, field, Math.max(0, Math.round(entities)));
    // Prime TTL once, on the first write of the day for each hash.
    if (reqCount === 1) {
      await redis.expire(reqKey, TTL_SEC);
      await redis.expire(entKey, TTL_SEC);
    }
  } catch (err) {
    logger.debug({ err: (err as Error)?.message }, 'recordWbUsage failed (ignored)');
  }
}

export type WbUsageRow = { endpoint: string; sid: string; requests: number; entities: number };

export type WbUsageSummary = {
  day: string;
  totalRequests: number;
  totalEntities: number;
  rows: WbUsageRow[]; // sorted by entities desc
};

/** Read the usage breakdown for a given UTC day (default: today). */
export async function getWbUsage(day = todayUtc()): Promise<WbUsageSummary> {
  const empty: WbUsageSummary = { day, totalRequests: 0, totalEntities: 0, rows: [] };
  try {
    const redis = getRedis();
    const [reqH, entH] = await Promise.all([
      redis.hgetall(`wbusage:req:${day}`),
      redis.hgetall(`wbusage:ent:${day}`),
    ]);
    const fields = new Set([...Object.keys(reqH ?? {}), ...Object.keys(entH ?? {})]);
    const rows: WbUsageRow[] = [];
    let totalRequests = 0;
    let totalEntities = 0;
    for (const f of fields) {
      const [sid, endpoint] = f.split('|', 2);
      const requests = parseInt(reqH?.[f] ?? '0', 10) || 0;
      const entities = parseInt(entH?.[f] ?? '0', 10) || 0;
      totalRequests += requests;
      totalEntities += entities;
      rows.push({ endpoint: endpoint ?? f, sid: sid ?? 'global', requests, entities });
    }
    rows.sort((a, b) => b.entities - a.entities);
    return { day, totalRequests, totalEntities, rows };
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, day }, 'getWbUsage failed');
    return empty;
  }
}
