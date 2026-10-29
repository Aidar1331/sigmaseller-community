/**
 * WB Finance Reports — клиент к новому API.
 * Host: https://finance-api.wildberries.ru
 *
 * Replaces deprecated GET /api/v5/supplier/reportDetailByPeriod (dies 15 июля).
 *
 * Endpoints:
 *   POST /api/finance/v1/sales-reports/list           — список отчётов (= xlsx-сводный)
 *   POST /api/finance/v1/sales-reports/detailed/{id}  — детализация по reportId
 *   POST /api/finance/v1/sales-reports/detailed       — детализация за период
 *
 * Лимит: 1 запрос/мин (Базовый с секретом). Persoнальный/Сервисный тот же.
 */

import { db } from '../../db/client.js';
import { wbFinanceReports, wbFinanceDailyProducts } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getWbApiKey, wbPostJson } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'financeReports' });
const HOST = 'https://finance-api.wildberries.ru';

interface SalesReportListItem {
  reportId: number;
  sellerFinanceName?: string;
  dateFrom: string;
  dateTo: string;
  createDate: string;
  currency: string;
  reportType: number;
  retailAmountSum: string;          // строка → number
  forPaySum: string;
  avgSalePercent?: number;
  deliveryServiceSum: string;
  paidStorageSum: string;
  paidAcceptanceSum: string;
  deductionSum: string;
  penaltySum: string;
  additionalPaymentSum: string;
  cashbackAmountSum: string;
  cashbackDiscountSum: string;
  cashbackCommissionChangeSum: string;
  paymentSchedule: string;
  bankPaymentSum: string;
}

interface SalesReportDetailedItem {
  reportId: number;
  rrdId: number;
  nmId: number;
  docTypeName?: string;
  sellerOperName?: string;
  quantity?: number;
  retailPriceWithDisc?: string;
  retailAmount?: string;
  ppvzSalesCommission?: string;
  forPay?: string;
  deliveryService?: string;
  paidStorage?: string;
  deduction?: string;
  paidAcceptance?: string;
  penalty?: string;
  additionalPayment?: string;
  acquiringFee?: string;
  ppvzReward?: string;
  saleDt?: string;
  rrDate?: string;
  dateFrom?: string;
  dateTo?: string;
  spp?: number;
}

function rubToKop(v: string | number | undefined | null): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

async function postJson<T>(url: string, apiKey: string, body: any): Promise<T | null> {
  // Используем wbPostJson чтобы X-Client-Secret подмешивался автоматом
  // (новый endpoint /sales-reports/list требует ключ с расширенными правами).
  try {
    const r = await wbPostJson<T>(url, apiKey, body);
    return r as any;
  } catch (e: any) {
    // wbPostJson выбрасывает на 204 как ошибку? нет, он вернёт null/undefined
    if (String(e?.message ?? '').includes('204')) return null;
    throw e;
  }
}

/**
 * Fetch list of sales reports for a date range.
 * Возвращает 0..N отчётов. Лимит API 1 req/min.
 */
export async function fetchSalesReportsList(
  apiKey: string,
  dateFrom: string,
  dateTo: string,
  period: 'daily' | 'weekly' = 'daily',
): Promise<SalesReportListItem[]> {
  const all: SalesReportListItem[] = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const res = await postJson<SalesReportListItem[]>(
      `${HOST}/api/finance/v1/sales-reports/list`,
      apiKey,
      { dateFrom, dateTo, limit, offset, period },
    );
    if (!res || res.length === 0) break;
    all.push(...res);
    if (res.length < limit) break;
    offset += limit;
  }
  return all;
}

/**
 * Fetch detailed report rows for a period.
 * Используется для backfill per-product per-report детализации.
 */
export async function fetchSalesReportsDetailed(
  apiKey: string,
  dateFrom: string,
  dateTo: string,
  period: 'daily' | 'weekly' = 'daily',
): Promise<SalesReportDetailedItem[]> {
  const all: SalesReportDetailedItem[] = [];
  let rrdId = 0;
  const limit = 100000;
  while (true) {
    const res = await postJson<SalesReportDetailedItem[]>(
      `${HOST}/api/finance/v1/sales-reports/detailed`,
      apiKey,
      { dateFrom, dateTo, limit, rrdId, period },
    );
    if (!res || res.length === 0) break;
    all.push(...res);
    if (res.length < limit) break;
    const last = res[res.length - 1];
    if (!last?.rrdId) break;
    rrdId = last.rrdId;
  }
  return all;
}

/**
 * Sync reports for a shop into wb_finance_reports.
 * Тянет detailed (per-row) и агрегирует по reportId — это эквивалентно
 * /sales-reports/list, но scope обычно даётся именно на detailed.
 */
export async function syncFinanceReportsForShop(
  workspaceId: number,
  shopId: number,
  dateFrom: string,
  dateTo: string,
): Promise<{ reports: number; rows: number }> {
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) return { reports: 0, rows: 0 };

  let rows: SalesReportDetailedItem[];
  try {
    rows = await fetchSalesReportsDetailed(apiKey, dateFrom, dateTo, 'daily');
  } catch (e: any) {
    logger.error({ err: e?.message, workspaceId, shopId }, 'Failed to fetch sales-reports/detailed');
    return { reports: 0, rows: 0 };
  }

  // Агрегируем строки по reportId — получаем эквивалент /sales-reports/list.
  const agg = new Map<number, {
    reportId: number;
    dateFrom: string;
    dateTo: string;
    createDate: string;
    currency: string;
    reportType: number;
    retailAmountKop: number;
    forPayKop: number;
    deliveryServiceKop: number;
    paidStorageKop: number;
    paidAcceptanceKop: number;
    deductionKop: number;
    penaltyKop: number;
    additionalPaymentKop: number;
  }>();
  for (const r of rows) {
    const rid = Number(r.reportId);
    if (!rid) continue;
    let a = agg.get(rid);
    if (!a) {
      a = {
        reportId: rid,
        dateFrom: (r.dateFrom ?? '').slice(0, 10),
        dateTo: (r.dateTo ?? '').slice(0, 10),
        createDate: ((r as any).createDate ?? r.dateFrom ?? '').slice(0, 10),
        currency: (r as any).currency ?? 'RUB',
        reportType: Number((r as any).reportType ?? 1),
        retailAmountKop: 0, forPayKop: 0, deliveryServiceKop: 0,
        paidStorageKop: 0, paidAcceptanceKop: 0, deductionKop: 0,
        penaltyKop: 0, additionalPaymentKop: 0,
      };
      agg.set(rid, a);
    }
    // ВБ возвращает retailAmount и forPay для строк возврата как
    // ПОЛОЖИТЕЛЬНЫЕ числа. В сводном отчёте ВБ они вычитаются (Продажа −
    // Возврат). Воспроизводим эту логику — иначе Pulse будет завышать.
    const docType = String((r as any).docTypeName ?? '');
    const sign = docType === 'Возврат' ? -1 : 1;
    a.retailAmountKop += sign * rubToKop(r.retailAmount);
    a.forPayKop += sign * rubToKop(r.forPay);
    // Логистика, хранение, штрафы, удержания — суммируются как есть
    // (для возврата они идут отдельной строкой со своим знаком).
    a.deliveryServiceKop += rubToKop(r.deliveryService);
    a.paidStorageKop += rubToKop(r.paidStorage);
    a.paidAcceptanceKop += rubToKop(r.paidAcceptance);
    a.deductionKop += rubToKop(r.deduction);
    a.penaltyKop += rubToKop(r.penalty);
    a.additionalPaymentKop += rubToKop(r.additionalPayment);
  }
  const reports = Array.from(agg.values()).map((a) => ({
    reportId: a.reportId,
    sellerFinanceName: undefined as string | undefined,
    dateFrom: a.dateFrom,
    dateTo: a.dateTo,
    createDate: a.createDate,
    currency: a.currency,
    reportType: a.reportType,
    retailAmountSum: String(a.retailAmountKop / 100),
    forPaySum: String(a.forPayKop / 100),
    deliveryServiceSum: String(a.deliveryServiceKop / 100),
    paidStorageSum: String(a.paidStorageKop / 100),
    paidAcceptanceSum: String(a.paidAcceptanceKop / 100),
    deductionSum: String(a.deductionKop / 100),
    penaltySum: String(a.penaltyKop / 100),
    additionalPaymentSum: String(a.additionalPaymentKop / 100),
    cashbackAmountSum: '0',
    cashbackDiscountSum: '0',
    cashbackCommissionChangeSum: '0',
    paymentSchedule: '0',
    // bankPaymentSum = forPay − logistics − storage − acceptance − deduction − penalty + additional
    bankPaymentSum: String(
      (a.forPayKop - a.deliveryServiceKop - a.paidStorageKop - a.paidAcceptanceKop
        - a.deductionKop - a.penaltyKop + a.additionalPaymentKop) / 100,
    ),
  } as SalesReportListItem));

  const now = new Date();
  for (const r of reports) {
    await db.insert(wbFinanceReports).values({
      workspaceId,
      shopId,
      reportId: r.reportId,
      sellerFinanceName: r.sellerFinanceName ?? null,
      dateFrom: (r.dateFrom ?? '').slice(0, 10),
      dateTo: (r.dateTo ?? '').slice(0, 10),
      createDate: (r.createDate ?? '').slice(0, 10),
      currency: r.currency ?? 'RUB',
      reportType: r.reportType ?? 1,
      retailAmountKopecks: rubToKop(r.retailAmountSum),
      forPayKopecks: rubToKop(r.forPaySum),
      deliveryServiceKopecks: rubToKop(r.deliveryServiceSum),
      paidStorageKopecks: rubToKop(r.paidStorageSum),
      paidAcceptanceKopecks: rubToKop(r.paidAcceptanceSum),
      deductionKopecks: rubToKop(r.deductionSum),
      penaltyKopecks: rubToKop(r.penaltySum),
      additionalPaymentKopecks: rubToKop(r.additionalPaymentSum),
      cashbackAmountKopecks: rubToKop(r.cashbackAmountSum),
      cashbackDiscountKopecks: rubToKop(r.cashbackDiscountSum),
      cashbackCommissionChangeKopecks: rubToKop(r.cashbackCommissionChangeSum),
      paymentScheduleKopecks: rubToKop(r.paymentSchedule),
      bankPaymentKopecks: rubToKop(r.bankPaymentSum),
      avgSalePercent: r.avgSalePercent != null ? String(r.avgSalePercent) : null,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [wbFinanceReports.workspaceId, wbFinanceReports.shopId, wbFinanceReports.reportId],
      set: {
        retailAmountKopecks: rubToKop(r.retailAmountSum),
        forPayKopecks: rubToKop(r.forPaySum),
        deliveryServiceKopecks: rubToKop(r.deliveryServiceSum),
        paidStorageKopecks: rubToKop(r.paidStorageSum),
        paidAcceptanceKopecks: rubToKop(r.paidAcceptanceSum),
        deductionKopecks: rubToKop(r.deductionSum),
        penaltyKopecks: rubToKop(r.penaltySum),
        additionalPaymentKopecks: rubToKop(r.additionalPaymentSum),
        bankPaymentKopecks: rubToKop(r.bankPaymentSum),
        updatedAt: now,
      },
    });
  }

  logger.info({ workspaceId, shopId, count: reports.length }, 'Finance reports synced');
  return { reports: reports.length, rows: reports.length };
}
