import 'dotenv/config';
import { db } from '../../db/client.js';
import { wbFbsShipmentsDailyProducts } from '../../db/schema.js';
import { getWbApiKey, wbGetJson } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'fbsShipments' });

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function parseIsoDate(v: any): string | null {
  if (typeof v !== 'string') return null;
  return v.slice(0, 10);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// Marketplace API base
const BASE = 'https://marketplace-api.wildberries.ru';

export async function syncWbFbsShipmentsDailyProducts(opts: { workspaceId: number; shopId?: number; start: string; end: string }) {
  // Pass workspaceId+shopId so getWbApiKey picks the right tenant+магазин
  // token, не первый попавшийся (это вызывало проблему на multi-shop:
  // у operator 3 магазина, ротация A/B-фото шла с токеном «не того» магазина).
  const apiKey = await getWbApiKey(opts.workspaceId, opts.shopId);

  // 1) list supplies with cursor pagination (as used in existing script)
  // GET /api/v3/supplies?limit=100&next=<cursor>
  const supplies: any[] = [];

  let next = 0;
  for (let page = 0; page < 10; page++) {
    const url = `${BASE}/api/v3/supplies?limit=100&next=${encodeURIComponent(String(next))}`;
    let resp: any;
    try {
      resp = await wbGetJson(url, apiKey, 1, { workspaceId: opts.workspaceId });
    } catch (e: any) {
      logger.warn({ page, error: e?.message }, 'fbsShipments: failed to fetch supplies page, stopping pagination');
      break;
    }

    const batch = resp?.supplies;
    if (!Array.isArray(batch) || batch.length === 0) break;
    supplies.push(...batch);

    next = typeof resp?.next === 'number' ? resp.next : Number(resp?.next ?? 0);
    if (!next) break;

    await sleep(250);
  }

  const inWindow = supplies.filter((s) => {
    const dt = parseIsoDate(s?.closedAt) ?? parseIsoDate(s?.createdAt) ?? null;
    if (!dt) return false;
    return dt >= opts.start && dt <= opts.end;
  });

  // 2) For each supply: get orderIds (new API), then resolve them to orders with nmId via /api/v3/orders.
  // Old endpoint /api/v3/supplies/{id}/orders is deprecated/disabled.

  async function getOrderIdsForSupply(supplyId: string): Promise<string[]> {
    const url = `${BASE}/api/marketplace/v3/supplies/${encodeURIComponent(supplyId)}/order-ids`;
    const resp = await wbGetJson<{ orderIds?: any[] }>(url, apiKey, 1, { workspaceId: opts.workspaceId });
    const ids = resp?.orderIds;
    return Array.isArray(ids) ? ids.map((x: any) => String(x)).filter(Boolean) : [];
  }

  async function fetchOrdersIndex(orderIds: Set<string>): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    if (orderIds.size === 0) return out;

    const url = `${BASE}/api/v3/orders`;
    let next = 0;
    for (let page = 0; page < 15; page++) {
      const resp = await wbGetJson<{ orders?: any[]; next?: number }>(
        `${url}?limit=1000&next=${encodeURIComponent(String(next))}`, apiKey, 1, { workspaceId: opts.workspaceId },
      );
      const batch = resp?.orders;
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const o of batch) {
        const id = o?.id;
        if (!id) continue;
        const sid = String(id);
        if (!orderIds.has(sid)) continue;
        out.set(sid, o);
      }
      // stop early if we collected everything
      if (out.size >= orderIds.size) break;

      next = typeof resp?.next === 'number' ? resp.next : Number(resp?.next ?? 0);
      if (!next) break;
      await sleep(150);
    }
    return out;
  }

  const supplyMeta: Array<{ supplyId: string; day: string; orderIds: string[] }> = [];
  const allOrderIds = new Set<string>();

  for (const s of inWindow) {
    const supplyId = String(s?.id ?? s?.supplyId ?? s?.supply_id ?? '');
    if (!supplyId) continue;
    const day = parseIsoDate(s?.closedAt) ?? parseIsoDate(s?.createdAt);
    if (!day) continue;

    let orderIds: string[] = [];
    try {
      orderIds = await getOrderIdsForSupply(supplyId);
    } catch (e: any) {
      logger.warn({ supplyId, error: e?.message }, 'fbsShipments: failed to get orders for supply, skipping');
      continue;
    }

    if (orderIds.length === 0) continue;
    supplyMeta.push({ supplyId, day, orderIds });
    for (const id of orderIds) allOrderIds.add(id);

    await sleep(150);
  }

  const ordersIndex = await fetchOrdersIndex(allOrderIds);

  const byKey = new Map<string, { supplyIds: Set<string>; orders: number; items: number }>();

  for (const s of supplyMeta) {
    for (const oid of s.orderIds) {
      const o = ordersIndex.get(String(oid));
      const nmId = Number(o?.nmId ?? o?.nmid ?? o?.nmID ?? o?.nm_id);
      if (!Number.isFinite(nmId) || nmId <= 0) continue;

      const k = `${s.day}|${nmId}`;
      const cur = byKey.get(k) ?? { supplyIds: new Set<string>(), orders: 0, items: 0 };
      cur.supplyIds.add(s.supplyId);
      cur.orders += 1;
      cur.items += 1;
      byKey.set(k, cur);
    }
  }

  // 3) Upsert
  for (const [k, v] of byKey.entries()) {
    const [date, nmIdStr] = k.split('|');
    const nmId = Number(nmIdStr);

    const row = {
      workspaceId: opts.workspaceId,
      date: date!,
      nmId,
      suppliesCount: v.supplyIds.size,
      ordersCount: v.orders,
      itemsCount: v.items,
      updatedAt: new Date(),
    };

    await db
      .insert(wbFbsShipmentsDailyProducts)
      .values(row)
      .onConflictDoUpdate({
        target: [wbFbsShipmentsDailyProducts.workspaceId, wbFbsShipmentsDailyProducts.date, wbFbsShipmentsDailyProducts.nmId],
        set: { ...row, updatedAt: new Date() },
      });
  }

  return { suppliesScanned: supplies.length, suppliesInWindow: inWindow.length, rows: byKey.size };
}
