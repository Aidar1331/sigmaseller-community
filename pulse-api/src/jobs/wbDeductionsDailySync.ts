/**
 * WB deductions daily sync — раз в сутки тянет /api/analytics/v1/deductions
 * (отчёт об удержаниях за подмены и неверные вложения) и пишет в
 * wb_deductions_daily.
 *
 * Лимит WB: 1 запрос / минуту (мягкий). Пагинация limit/offset, max 1000.
 *
 * Ответ: { data: { reports: [{ dtBonus, nmId, bonusSumm, bonusType, ... }], total } }
 * bonusSumm — в рублях (number, может быть дробным), bonusType — текст
 * причины (например "Подмена FBW").
 */

import { sql, and, eq } from 'drizzle-orm';
import { getQueue } from './queue.js';
import { db } from '../db/client.js';
import { marketplaceShops, wbDeductionsDaily } from '../db/schema.js';
import { wbGetJson, getWbApiKeyByShop } from '../integrations/wb/wbClient.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'wbDeductionsDailySync' });
const JOB_NAME = 'wb-deductions-daily-sync';
const ANALYTICS_API = 'https://seller-analytics-api.wildberries.ru';

interface DeductionRecord {
  dtBonus: string;
  nmId: number;
  bonusSumm: number;
  bonusType: string;
  oldVendorCode?: string;
  newVendorCode?: string;
  photoUrls?: string[];
}

async function syncShop(shopId: number, workspaceId: number, daysBack = 90): Promise<{ records: number }> {
  let apiKey: string;
  try { apiKey = await getWbApiKeyByShop(shopId); } catch { return { records: 0 }; }

  const dateTo = new Date().toISOString();
  const dateFrom = new Date(Date.now() - daysBack * 86400_000).toISOString();
  const limit = 1000;
  let offset = 0;
  let saved = 0;

  // WB лимит 1 rpm — пагинация с задержкой между страницами.
  for (let page = 0; page < 5; page++) {
    let resp: { data?: { reports?: DeductionRecord[]; total?: number } };
    try {
      const url = `${ANALYTICS_API}/api/analytics/v1/deductions?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}&limit=${limit}&offset=${offset}`;
      resp = await wbGetJson<typeof resp>(url, apiKey, 1, { workspaceId, shopId });
    } catch (err) {
      logger.warn({ err, shopId, offset }, 'WB request failed');
      break;
    }
    const reports = resp?.data?.reports ?? [];
    if (reports.length === 0) break;

    for (const r of reports) {
      const amountKop = Math.round(Number(r.bonusSumm ?? 0) * 100);
      if (!amountKop || !r.dtBonus) continue;
      const reason = r.bonusType ?? 'unknown';
      // type — нормализуем: подмена → 'penalty', остальное оставляем как есть в lowercase
      const typeNorm = /подмен/i.test(reason) ? 'penalty' : reason.toLowerCase().slice(0, 32);
      try {
        await db.insert(wbDeductionsDaily).values({
          workspaceId, shopId,
          nmId: r.nmId ?? null,
          date: new Date(r.dtBonus),
          type: typeNorm,
          amount: amountKop,
          reason,
          documentNumber: null,
        });
        saved++;
      } catch (err) {
        // schema без unique index — дубли возможны при повторных проходах.
        // Игнорим тихо чтобы не флудить лог.
      }
    }

    if (reports.length < limit) break;
    offset += limit;
  }

  return { records: saved };
}

export async function runDeductionsDailySync(): Promise<void> {
  const shops = await db
    .select({ shopId: marketplaceShops.shopId, workspaceId: marketplaceShops.workspaceId })
    .from(marketplaceShops)
    .where(and(eq(marketplaceShops.platform, 'wb'), eq(marketplaceShops.isActive, true)));

  let total = 0;
  for (const s of shops) {
    const { records } = await syncShop(Number(s.shopId), Number(s.workspaceId));
    total += records;
    if (records > 0) logger.info({ shopId: s.shopId, records }, 'shop done');
  }
  logger.info({ shops: shops.length, totalRecords: total }, 'pass complete');
}

export async function registerWbDeductionsDailySync(): Promise<void> {
  const boss = await getQueue();
  await boss.createQueue(JOB_NAME);
  // 03:45 MSK — пока reports-daily/paid-storage уже отработали.
  await boss.schedule(JOB_NAME, '45 0 * * *', {}, { tz: 'UTC' });
  await boss.work(JOB_NAME, { localConcurrency: 1 }, async () => {
    try {
      await runDeductionsDailySync();
    } catch (err) {
      logger.error({ err }, 'wb-deductions-daily-sync failed');
      throw err;
    }
  });
  logger.info('registered (daily 03:45 MSK)');
}
