/**
 * WB advertising finance sync — раз в сутки тянет /adv/v1/upd по всем
 * активным шопам и наполняет wb_adv_finance + wb_adv_finance_daily.
 *
 * Эндпоинт отдаёт фактические списания (УПД-номера) с разбивкой по
 * источнику оплаты (Баланс / Счёт / Бонусы / Кэшбэк). Это нужно для
 * корректной маржи: «Прочие удержания» в еженедельном отчёте включает
 * списания с Баланса (но не со Счёта), поэтому без этих данных смета
 * рекламы расходится.
 */

import { sql, and, eq } from 'drizzle-orm';
import { getQueue } from './queue.js';
import { db } from '../db/client.js';
import { marketplaceShops, wbAdvFinance, wbAdvFinanceDaily } from '../db/schema.js';
import { wbGetJson, getWbApiKeyByShop } from '../integrations/wb/wbClient.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'wbAdvFinanceSync' });
const JOB_NAME = 'wb-adv-finance-sync';
const ADVERT_API = 'https://advert-api.wildberries.ru';

interface UpdRecord {
  updNum: number;
  updTime: string | null;
  updSum: number;
  advertId: number;
  campName: string;
  advertType: number;
  paymentType: string;
  advertStatus: number;
}

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function addDays(d: Date, days: number): Date { const x = new Date(d); x.setUTCDate(x.getUTCDate() + days); return x; }

function normalizePaymentType(ru: string): 'balance' | 'account' | 'bonus' | 'cashback' | 'other' {
  switch (ru) {
    case 'Баланс': return 'balance';
    case 'Счёт': case 'Счет': return 'account';
    case 'Бонусы': return 'bonus';
    case 'Кэшбэк': return 'cashback';
    default: return 'other';
  }
}

async function syncShop(shopId: number, workspaceId: number, daysBack = 90): Promise<{ records: number }> {
  let apiKey: string;
  try { apiKey = await getWbApiKeyByShop(shopId); } catch { return { records: 0 }; }

  const today = new Date();
  const dateTo = isoDate(today);
  const dateFrom = isoDate(addDays(today, -daysBack));

  // WB ограничение: максимум 31 день за запрос. Чанкуем.
  let currentFrom = new Date(dateFrom + 'T00:00:00Z');
  const endDate = new Date(dateTo + 'T00:00:00Z');
  const allRecords: UpdRecord[] = [];

  while (currentFrom <= endDate) {
    const chunkTo = new Date(Math.min(currentFrom.getTime() + 30 * 86400_000, endDate.getTime()));
    const fromStr = isoDate(currentFrom);
    const toStr = isoDate(chunkTo);
    try {
      const url = `${ADVERT_API}/adv/v1/upd?from=${fromStr}&to=${toStr}`;
      const records = await wbGetJson<UpdRecord[]>(url, apiKey, 1, { workspaceId, shopId });
      if (Array.isArray(records)) allRecords.push(...records);
    } catch (err) {
      logger.warn({ err, shopId, fromStr, toStr }, 'chunk failed');
    }
    currentFrom = addDays(chunkTo, 1);
  }

  // Upsert detail rows + aggregate daily
  const dailyAgg = new Map<string, { balance: number; account: number; bonus: number; cashback: number; total: number; transactions: number; advertIds: Set<number> }>();
  let saved = 0;
  for (const rec of allRecords) {
    if (!rec.updTime) continue;
    const updDate = rec.updTime.slice(0, 10);
    const sumKopecks = Math.round(rec.updSum * 100);
    try {
      await db
        .insert(wbAdvFinance)
        .values({
          workspaceId, shopId, updNum: rec.updNum, updTime: new Date(rec.updTime), updDate,
          updSumKopecks: sumKopecks, advertId: rec.advertId, campName: rec.campName,
          advertType: rec.advertType, advertStatus: rec.advertStatus, paymentType: rec.paymentType,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [wbAdvFinance.workspaceId, wbAdvFinance.updNum, wbAdvFinance.advertId, wbAdvFinance.updTime, wbAdvFinance.updSumKopecks],
          set: {
            shopId, updDate,
            campName: rec.campName, advertType: rec.advertType, advertStatus: rec.advertStatus,
            paymentType: rec.paymentType, updatedAt: new Date(),
          },
        });
      saved++;
    } catch (err) {
      logger.warn({ err, advertId: rec.advertId }, 'insert failed');
    }

    const agg = dailyAgg.get(updDate) ?? { balance: 0, account: 0, bonus: 0, cashback: 0, total: 0, transactions: 0, advertIds: new Set<number>() };
    const kind = normalizePaymentType(rec.paymentType);
    if (kind === 'balance') agg.balance += sumKopecks;
    else if (kind === 'account') agg.account += sumKopecks;
    else if (kind === 'bonus') agg.bonus += sumKopecks;
    else if (kind === 'cashback') agg.cashback += sumKopecks;
    agg.total += sumKopecks;
    agg.transactions++;
    agg.advertIds.add(rec.advertId);
    dailyAgg.set(updDate, agg);
  }

  for (const [date, agg] of dailyAgg.entries()) {
    await db
      .insert(wbAdvFinanceDaily)
      .values({
        workspaceId, shopId, date,
        balanceKopecks: agg.balance, accountKopecks: agg.account,
        bonusKopecks: agg.bonus, cashbackKopecks: agg.cashback,
        totalKopecks: agg.total, transactionsCount: agg.transactions,
        advertsCount: agg.advertIds.size, updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [wbAdvFinanceDaily.workspaceId, wbAdvFinanceDaily.date],
        set: {
          shopId, balanceKopecks: agg.balance, accountKopecks: agg.account,
          bonusKopecks: agg.bonus, cashbackKopecks: agg.cashback,
          totalKopecks: agg.total, transactionsCount: agg.transactions,
          advertsCount: agg.advertIds.size, updatedAt: new Date(),
        },
      });
  }

  return { records: saved };
}

export async function runAdvFinanceSync(): Promise<void> {
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

export async function registerWbAdvFinanceSync(): Promise<void> {
  const boss = await getQueue();
  await boss.createQueue(JOB_NAME);
  // Каждые 3 часа в :15 (UTC). WB Partner API публикует УПД с задержкой,
  // частый sync ловит «опоздавшие» списания за текущий день. оператор поймал
  // 2026-06-03: на /plan «Реклама: 2 июня» = 2.9 К, в ЛК ВБ = 7 К; после
  // ручного синка стало 7.4 К. Раньше cron был раз в сутки (02:30 MSK).
  // Cost-cap 2026-06-18: every 6h instead of every 3h (WB bills per entity).
  await boss.schedule(JOB_NAME, '30 */6 * * *', {}, { tz: 'UTC' });
  await boss.work(JOB_NAME, { localConcurrency: 1 }, async () => {
    try {
      await runAdvFinanceSync();
    } catch (err) {
      logger.error({ err }, 'wb-adv-finance-sync failed');
      throw err;
    }
  });
  logger.info('registered (daily 02:30 MSK)');
}
