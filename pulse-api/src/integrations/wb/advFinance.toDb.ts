/**
 * WB Advertising Finance Sync
 * Загружает фактические списания на рекламу из /adv/v1/upd
 * 
 * Источники списания:
 * - Баланс — взаимозачёт (неттинг), попадает в "Прочие удержания" еженедельного отчёта
 * - Счёт — ручное пополнение, НЕ попадает в еженедельные отчёты
 * - Бонусы — бонусные средства
 * - Кэшбэк — кэшбэк
 * 
 * Rate limit: 1 req/sec, burst 5
 */

import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { db } from '../../db/client.js';
import { wbAdvFinance, wbAdvFinanceDaily } from '../../db/schema.js';
import { getWbApiKey, wbGetJson } from './wbClient.js';
import log from '../../lib/logger.js';
import { sql } from 'drizzle-orm';

const logger = log.child({ module: 'advFinance' });

const ADVERT_API = 'https://advert-api.wildberries.ru';

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Delegates to wbGetJson so per-endpoint Redis quota (per workspace+shop)
 * is enforced. The previous local fetch bypassed our rate-limiter, so
 * multiple shops piling into /adv/v1/upd would trigger WB 429 cascades.
 */
async function wbJson(
  url: string,
  apiKey: string,
  workspaceId: number,
  shopId: number | undefined,
): Promise<any> {
  try {
    return await wbGetJson(url, apiKey, 1, { workspaceId, shopId });
  } catch (e: any) {
    if (typeof e?.message === 'string' && e.message.includes('returned')) return [];
    throw e;
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

// Структура ответа /adv/v1/upd
interface UpdRecord {
  updNum: number;
  updTime: string | null;
  updSum: number; // в рублях
  advertId: number;
  campName: string;
  advertType: number;
  paymentType: string; // "Баланс" | "Бонусы" | "Счёт" | "Кэшбэк"
  advertStatus: number;
}

// Маппинг русских названий на английские ключи
function normalizePaymentType(ru: string): string {
  const map: Record<string, string> = {
    'Баланс': 'balance',
    'Счёт': 'account',
    'Счет': 'account',
    'Бонусы': 'bonus',
    'Кэшбэк': 'cashback',
  };
  return map[ru] || ru.toLowerCase();
}

type Checkpoint = {
  startedAt: string;
  updatedAt: string;
  workspaceId: number;
  daysBack: number;
  dateFrom: string;
  dateTo: string;
  loadedRecords: number;
  errors: string[];
};

async function main() {
  await mkdir('out', { recursive: true });

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

  // Max 31 день за запрос по API
  const daysBack = Math.min(Number.parseInt(process.env.DAYS_BACK || '90', 10), 365);

  logger.info({ workspaceId, shopId: shopId ?? 'default', daysBack }, 'Starting adv finance sync');

  const apiKey = await getWbApiKey(workspaceId, shopId);

  const today = new Date();
  const dateTo = isoDate(today);
  const dateFrom = isoDate(addDays(today, -daysBack));

  const suffix = `-shop${shopId ?? 'all'}-${daysBack}d`;
  const checkpointPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-adv-finance${suffix}.checkpoint.json`;

  let cp: Checkpoint = {
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspaceId,
    daysBack,
    dateFrom,
    dateTo,
    loadedRecords: 0,
    errors: [],
  };

  // Загружаем данные чанками по 31 день (лимит API)
  const allRecords: UpdRecord[] = [];
  let currentFrom = new Date(dateFrom + 'T00:00:00Z');
  const endDate = new Date(dateTo + 'T00:00:00Z');

  while (currentFrom <= endDate) {
    const chunkTo = new Date(Math.min(currentFrom.getTime() + 30 * 24 * 60 * 60 * 1000, endDate.getTime()));
    const fromStr = isoDate(currentFrom);
    const toStr = isoDate(chunkTo);

    logger.info({ from: fromStr, to: toStr }, 'Fetching chunk');

    try {
      const url = `${ADVERT_API}/adv/v1/upd?from=${fromStr}&to=${toStr}`;
      const records = await wbJson(url, apiKey, workspaceId, shopId) as UpdRecord[];

      if (Array.isArray(records)) {
        allRecords.push(...records);
        logger.info({ from: fromStr, to: toStr, count: records.length }, 'Chunk loaded');
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      cp.errors.push(`${fromStr}-${toStr}: ${msg}`);
      logger.error({ from: fromStr, to: toStr, error: msg }, 'Chunk failed');
    }

    // Rate limit: 1 req/sec
    await sleep(1100);

    // Следующий чанк
    currentFrom = addDays(chunkTo, 1);
  }

  logger.info({ totalRecords: allRecords.length }, 'All chunks loaded');

  // Агрегация по дням и источникам
  const dailyAgg = new Map<string, {
    balance: number;
    account: number;
    bonus: number;
    cashback: number;
    total: number;
    transactions: number;
    advertIds: Set<number>;
  }>();

  // Сохраняем записи в БД
  for (const rec of allRecords) {
    // Извлекаем дату из updTime или используем текущую
    let updDate: string;
    if (rec.updTime) {
      updDate = rec.updTime.slice(0, 10);
    } else {
      // Если updTime null, пропускаем (редкий случай)
      logger.warn({ advertId: rec.advertId, updNum: rec.updNum }, 'Skipping record with null updTime');
      continue;
    }

    const sumKopecks = Math.round(rec.updSum * 100);
    const paymentTypeNorm = normalizePaymentType(rec.paymentType);

    // Upsert в детальную таблицу
    try {
      await db
        .insert(wbAdvFinance)
        .values({
          workspaceId,
          shopId: shopId ?? null,
          updNum: rec.updNum,
          updTime: rec.updTime ? new Date(rec.updTime) : null,
          updDate,
          updSumKopecks: sumKopecks,
          advertId: rec.advertId,
          campName: rec.campName,
          advertType: rec.advertType,
          advertStatus: rec.advertStatus,
          paymentType: rec.paymentType,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [wbAdvFinance.workspaceId, wbAdvFinance.updNum, wbAdvFinance.advertId, wbAdvFinance.updTime, wbAdvFinance.updSumKopecks],
          set: {
            shopId: shopId ?? null,
            updDate,
            campName: rec.campName,
            advertType: rec.advertType,
            advertStatus: rec.advertStatus,
            paymentType: rec.paymentType,
            updatedAt: new Date(),
          },
        });

      cp.loadedRecords++;
    } catch (e: any) {
      logger.error({ advertId: rec.advertId, error: e.message }, 'Failed to insert record');
    }

    // Агрегируем для daily таблицы
    const agg = dailyAgg.get(updDate) ?? {
      balance: 0,
      account: 0,
      bonus: 0,
      cashback: 0,
      total: 0,
      transactions: 0,
      advertIds: new Set<number>(),
    };

    switch (paymentTypeNorm) {
      case 'balance':
        agg.balance += sumKopecks;
        break;
      case 'account':
        agg.account += sumKopecks;
        break;
      case 'bonus':
        agg.bonus += sumKopecks;
        break;
      case 'cashback':
        agg.cashback += sumKopecks;
        break;
    }
    agg.total += sumKopecks;
    agg.transactions++;
    agg.advertIds.add(rec.advertId);
    dailyAgg.set(updDate, agg);
  }

  // Сохраняем агрегаты по дням
  for (const [date, agg] of dailyAgg.entries()) {
    await db
      .insert(wbAdvFinanceDaily)
      .values({
        workspaceId,
        shopId: shopId ?? null,
        date,
        balanceKopecks: agg.balance,
        accountKopecks: agg.account,
        bonusKopecks: agg.bonus,
        cashbackKopecks: agg.cashback,
        totalKopecks: agg.total,
        transactionsCount: agg.transactions,
        advertsCount: agg.advertIds.size,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [wbAdvFinanceDaily.workspaceId, wbAdvFinanceDaily.date],
        set: {
          shopId: shopId ?? null,
          balanceKopecks: agg.balance,
          accountKopecks: agg.account,
          bonusKopecks: agg.bonus,
          cashbackKopecks: agg.cashback,
          totalKopecks: agg.total,
          transactionsCount: agg.transactions,
          advertsCount: agg.advertIds.size,
          updatedAt: new Date(),
        },
      });
  }

  cp.updatedAt = new Date().toISOString();
  await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');

  // Финальный отчёт
  const summary = {
    workspaceId,
    daysBack,
    dateFrom,
    dateTo,
    totalRecords: allRecords.length,
    savedRecords: cp.loadedRecords,
    dailyRows: dailyAgg.size,
    byPaymentType: {
      balance: allRecords.filter(r => normalizePaymentType(r.paymentType) === 'balance').length,
      account: allRecords.filter(r => normalizePaymentType(r.paymentType) === 'account').length,
      bonus: allRecords.filter(r => normalizePaymentType(r.paymentType) === 'bonus').length,
      cashback: allRecords.filter(r => normalizePaymentType(r.paymentType) === 'cashback').length,
    },
    errors: cp.errors,
    finishedAt: new Date().toISOString(),
  };

  const outPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-adv-finance${suffix}-${dateFrom}_to_${dateTo}.json`;
  await writeFile(outPath, JSON.stringify(summary, null, 2), 'utf8');

  logger.info(summary, 'Adv finance sync completed');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error({ err: e }, 'advFinance failed');
    process.exit(1);
  });
