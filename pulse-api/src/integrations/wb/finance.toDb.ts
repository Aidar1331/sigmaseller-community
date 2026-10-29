import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { db } from '../../db/client.js';
import { wbFinanceDaily, wbFinanceDailyProducts, wbCompensations } from '../../db/schema.js';
import { wbGetJson, getWbApiKey } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'financeToDb' });

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

function pickDate(row: any): string | null {
  // ИСПРАВЛЕНО: используем sale_dt (дата продажи) для соответствия Torgstat
  // rr_dt — дата отчёта, может отличаться от даты продажи на несколько дней
  const d = row?.sale_dt || row?.rr_dt || row?.date_from;
  return typeof d === 'string' ? d.slice(0, 10) : null;
}

// Дата отчёта ВБ — берём date_from самого отчёта (по realizationreport_id),
// это и есть дата, которую xlsx-сводный ВБ использует как «начало отчёта».
// rr_dt у нас в shop совпадает с sale_dt, так что им не пользуемся.
function pickRrDate(row: any): string | null {
  const d = row?.date_from || row?.rr_dt || row?.sale_dt;
  return typeof d === 'string' ? d.slice(0, 10) : null;
}

function num(v: any): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function kopecks(v: any): number {
  return Math.round(num(v) * 100);
}

type Daily = {
  lines: number;
  rrDate: string | null; // Дата отчёта ВБ (rr_dt/date_from), для переключателя в /finance
  retailKopecks: number;
  sppAmountKopecks: number; // СПП (скидка постоянного покупателя) в рублях
  payoutKopecks: number;
  commissionKopecks: number;
  ppvzVwKopecks: number; // Вознаграждение WB (часть комиссии)
  ppvzRewardKopecks: number; // Вознаграждение (КРИТИЧНО для баланса!)
  logisticsKopecks: number;
  returnLogisticsKopecks: number;
  paidAcceptanceKopecks: number;
  storageKopecks: number;
  penaltyKopecks: number;
  otherHoldKopecks: number;
  promotionKopecks: number; // Продвижение (из deduction)
  acquiringKopecks: number;
  additionalPaymentKopecks: number;
  // New fields from WB API v5
  cashbackAmountKopecks: number;
  cashbackDiscountKopecks: number;
  cashbackCommissionChangeKopecks: number;
  sellerPromoDiscountKopecks: number;
  loyaltyDiscountKopecks: number;
  wbDiscountPercent: number;
  installmentCofinancingKopecks: number;
  // Дополнительные поля (могут быть != 0 в других магазинах)
  supplierPromoKopecks: number;
  productDiscountKopecks: number;
  ppvzSppPrcSum: number; // Сумма ppvz_spp_prc для расчёта среднего
  returnsCount: number;
  returnsSumKopecks: number; // Сумма возвратов (retail)
};

type DailyProduct = {
  lines: number;
  saleQty: number; // Количество проданных штук — только строки docType='Продажа' с quantity>0
  rrDate: string | null;
  revenueKopecks: number;
  sppAmountKopecks: number; // СПП в рублях
  incomeFromSalesKopecks: number;
  commissionKopecks: number;
  ppvzVwKopecks: number; // Вознаграждение WB (часть комиссии)
  ppvzRewardKopecks: number; // Вознаграждение (КРИТИЧНО!)
  logisticsKopecks: number;
  returnLogisticsKopecks: number;
  paidAcceptanceKopecks: number;
  storageKopecks: number;
  penaltiesKopecks: number;
  otherHoldKopecks: number;
  promotionKopecks: number; // Продвижение (из deduction)
  acquiringKopecks: number;
  additionalPaymentsKopecks: number;
  // New fields from WB API v5
  cashbackAmountKopecks: number;
  cashbackDiscountKopecks: number;
  cashbackCommissionChangeKopecks: number;
  sellerPromoDiscountKopecks: number;
  loyaltyDiscountKopecks: number;
  wbDiscountPercent: number;
  installmentCofinancingKopecks: number;
  // Дополнительные поля
  supplierPromoKopecks: number;
  productDiscountKopecks: number;
  ppvzSppPrcSum: number;
  returnsCount: number;
  returnsSumKopecks: number; // Сумма возвратов (retail)
};

function ensure(rec: Record<string, Daily>, date: string): Daily {
  if (!rec[date]) {
    rec[date] = {
      lines: 0,
      rrDate: null,
      retailKopecks: 0,
      sppAmountKopecks: 0,
      payoutKopecks: 0,
      commissionKopecks: 0,
      ppvzVwKopecks: 0,
      ppvzRewardKopecks: 0,
      logisticsKopecks: 0,
      returnLogisticsKopecks: 0,
      paidAcceptanceKopecks: 0,
      storageKopecks: 0,
      penaltyKopecks: 0,
      otherHoldKopecks: 0,
      promotionKopecks: 0,
      acquiringKopecks: 0,
      additionalPaymentKopecks: 0,
      cashbackAmountKopecks: 0,
      cashbackDiscountKopecks: 0,
      cashbackCommissionChangeKopecks: 0,
      sellerPromoDiscountKopecks: 0,
      loyaltyDiscountKopecks: 0,
      wbDiscountPercent: 0,
      installmentCofinancingKopecks: 0,
      supplierPromoKopecks: 0,
      productDiscountKopecks: 0,
      ppvzSppPrcSum: 0,
      returnsCount: 0,
      returnsSumKopecks: 0,
    };
  }
  return rec[date]!;
}

function ensureProd(rec: Record<string, DailyProduct>, key: string): DailyProduct {
  if (!rec[key]) {
    rec[key] = {
      lines: 0,
      saleQty: 0,
      rrDate: null,
      revenueKopecks: 0,
      sppAmountKopecks: 0,
      incomeFromSalesKopecks: 0,
      commissionKopecks: 0,
      ppvzVwKopecks: 0,
      ppvzRewardKopecks: 0,
      logisticsKopecks: 0,
      returnLogisticsKopecks: 0,
      paidAcceptanceKopecks: 0,
      storageKopecks: 0,
      penaltiesKopecks: 0,
      otherHoldKopecks: 0,
      promotionKopecks: 0,
      acquiringKopecks: 0,
      additionalPaymentsKopecks: 0,
      cashbackAmountKopecks: 0,
      cashbackDiscountKopecks: 0,
      cashbackCommissionChangeKopecks: 0,
      sellerPromoDiscountKopecks: 0,
      loyaltyDiscountKopecks: 0,
      wbDiscountPercent: 0,
      installmentCofinancingKopecks: 0,
      supplierPromoKopecks: 0,
      productDiscountKopecks: 0,
      ppvzSppPrcSum: 0,
      returnsCount: 0,
      returnsSumKopecks: 0,
    };
  }
  return rec[key]!;
}

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
  if (!shopIdStr) throw new Error('SHOP_ID environment variable is required');
  const shopId = Number.parseInt(shopIdStr, 10);
  if (isNaN(shopId) || shopId <= 0) {
    throw new Error(`Invalid SHOP_ID: ${shopIdStr}`);
  }
  
  const daysBack = Number.parseInt(process.env.DAYS_BACK || '120', 10);
  const windowDays = Number.parseInt(process.env.WINDOW_DAYS || '30', 10);

  logger.info({ workspaceId, shopId: shopId ?? 'default', daysBack }, 'Starting sync');

  const apiKey = await getWbApiKey(workspaceId, shopId);

  const today = new Date();
  const dateTo = isoDate(today);
  const dateFrom = isoDate(addDays(today, -daysBack));

  const windows = listWindows(dateFrom, dateTo, windowDays);

  const checkpointPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-finance-to-db-${shopId ?? 'default'}-${daysBack}d.checkpoint.json`;

  let state: {
    startedAt: string;
    updatedAt: string;
    winIndex: number;
    rrdid: number;
    daily: Record<string, Daily>;
    errors: Array<{ winIndex: number; message: string }>;
  };

  // Чекпойнт хранит прогресс sync'а (winIndex, rrdid). Защита от «стэйл»:
  // если checkpoint обновлялся >24 часов назад — отбрасываем и стартуем
  // с нуля. Без этого после неудачного запуска winIndex остаётся в
  // конечной позиции (например 1 из 1), и все последующие cron-запуски
  // молча скипают окно. Так wb_finance_daily оставалась пустой 4 дня
  // в мае 2026 — обнаружено при diff с xlsx ЛК.
  try {
    const text = await readFile(checkpointPath, 'utf8');
    const loaded = JSON.parse(text) as typeof state;
    const ageMs = Date.now() - new Date(loaded.updatedAt).getTime();
    if (ageMs > 24 * 3600 * 1000) {
      logger.warn({ checkpointPath, ageMs }, 'checkpoint stale > 24h, resetting');
      throw new Error('stale_checkpoint');
    }
    // Если winIndex >= windows.length — checkpoint завершил предыдущий
    // период, для нового запуска (другой dateRange) тоже нужно с нуля.
    if (loaded.winIndex >= windows.length) {
      logger.info({ checkpointPath, savedWinIndex: loaded.winIndex, newWindows: windows.length }, 'checkpoint pointed past current window count, resetting');
      throw new Error('past_window_count');
    }
    state = loaded;
  } catch {
    state = {
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      winIndex: 0,
      rrdid: 0,
      daily: {},
      errors: [],
    };
    await writeFile(checkpointPath, JSON.stringify(state, null, 2), 'utf8');
  }

  logger.info({ daysBack, dateFrom, dateTo, windowDays, windows: windows.length, startWin: state.winIndex }, 'Finance -> DB');

  for (let wi = state.winIndex; wi < windows.length; wi++) {
    const w = windows[wi]!;
    let rrdid = wi === state.winIndex ? state.rrdid : 0;

    logger.info({ window: `${wi + 1}/${windows.length}`, from: w.from, to: w.to, rrdid }, 'Processing window');

    // per-window aggregation for daily product rows (avoid massive checkpoint files)
    const dailyProducts: Record<string, DailyProduct> = {};
    const compensationsToInsert: Array<{ workspaceId: number; shopId: number | null; nmId: number; date: string; operationType: string; amountKopecks: number; description: string; rrdId: number }> = [];

    while (true) {
      const url = `https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod?dateFrom=${encodeURIComponent(
        w.from
      )}&dateTo=${encodeURIComponent(w.to)}&limit=100000&rrdid=${rrdid}&period=daily`;

      let rows: any;
      try {
        rows = await wbGetJson(url, apiKey, 1, { workspaceId, shopId });
      } catch (e: any) {
        state.errors.push({ winIndex: wi, message: String(e?.message ?? e).slice(0, 300) });
        break;
      }

      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const row of rows) {
        const day = pickDate(row);
        if (!day) continue;
        if (day < dateFrom || day > dateTo) continue;

        const nmId = Number(row?.nm_id);
        // Non-product operations (штрафы, хранение общее, коррекции,
        // комиссии за эквайринг, доп.удержания) приходят от WB без nm_id
        // либо с nm_id=0. Раньше мы их полностью пропускали, и в итоге
        // penalty_kopecks / storage_kopecks / acquiring_kopecks в
        // wb_finance_daily всегда были 0 — расхождение с ЛК WB, замеченное
        // пользователем (штраф 5000 ₽ за 10-11.04 не виден).
        // Поэтому: если nm_id отсутствует — продолжаем daily-агрегацию,
        // но пропускаем per-product ветку.
        const hasNmId = Number.isFinite(nmId) && nmId > 0;

        const oper = String(row?.supplier_oper_name ?? '').toLowerCase();
        const isReturn = oper.includes('возврат');
        const isCompensation = oper.includes('возмещение') || oper.includes('компенсац');
        
        // Парсим компенсации
        if (isCompensation) {
          const rrdId = Number(row?.rrd_id);
          if (Number.isFinite(rrdId) && rrdId > 0) {
            const amount = kopecks(row?.ppvz_for_pay) || kopecks(row?.retail_price_withdisc_rub);
            let operType = 'other';
            if (oper.includes('брак') || oper.includes('подмен')) operType = 'damage';
            else if (oper.includes('утер') || oper.includes('потер')) operType = 'loss';
            else if (oper.includes('перевоз') || oper.includes('логист') || oper.includes('склад')) operType = 'logistics';
            
            compensationsToInsert.push({
              workspaceId,
              shopId,
              nmId,
              date: day,
              operationType: operType,
              amountKopecks: amount,
              description: String(row?.supplier_oper_name ?? ''),
              rrdId,
            });
          }
        }
        const qty = typeof row?.quantity === 'number' ? row.quantity : typeof row?.quantity_full === 'number' ? row.quantity_full : 1;

        // overall daily aggregation
        const d = ensure(state.daily, day);
        d.lines += 1;
        // Запоминаем дату отчёта ВБ (берём из строки rr_dt/date_from).
        // Для записей одного sale_dt обычно один rr_dt; если разные —
        // храним последний обнаруженный (приближение).
        const rrDay = pickRrDate(row);
        if (rrDay) d.rrDate = rrDay;

        d.retailKopecks += kopecks(row?.retail_price_withdisc_rub);
        // СПП = retail × ppvz_spp_prc / 100 (Torgstat methodology)
        const retail = num(row?.retail_price_withdisc_rub);
        const sppPrc = num(row?.ppvz_spp_prc);
        d.sppAmountKopecks += Math.round(retail * sppPrc); // sppPrc уже в копейках (0-100 → умножаем)
        d.payoutKopecks += kopecks(row?.ppvz_for_pay);
        d.commissionKopecks += kopecks(row?.ppvz_sales_commission);
        d.ppvzVwKopecks += kopecks(row?.ppvz_vw); // Вознаграждение WB
        d.ppvzRewardKopecks += kopecks(row?.ppvz_reward); // Вознаграждение (КРИТИЧНО для баланса!)

        // logistics
        d.logisticsKopecks += kopecks(row?.delivery_rub);
        d.returnLogisticsKopecks += kopecks(row?.return_amount);
        d.paidAcceptanceKopecks += kopecks(row?.acceptance);

        // fees/penalties
        d.storageKopecks += kopecks(row?.storage_fee);
        d.penaltyKopecks += kopecks(row?.penalty);
        
        // Разделяем deduction на promotion и other_hold
        const deductionAmount = kopecks(row?.deduction);
        const isPromotion = oper.includes('продвижение') || oper.includes('реклам') || oper.includes('маркетинг');
        if (isPromotion) {
          d.promotionKopecks += deductionAmount;
        } else {
          d.otherHoldKopecks += deductionAmount;
        }
        
        d.additionalPaymentKopecks += kopecks(row?.additional_payment);

        // acquiring
        d.acquiringKopecks += kopecks(row?.acquiring_fee); // payment_processing не включаем (Torgstat так же)

        // new WB API v5 fields
        d.cashbackAmountKopecks += kopecks(row?.cashback_amount);
        d.cashbackDiscountKopecks += kopecks(row?.cashback_discount);
        d.cashbackCommissionChangeKopecks += kopecks(row?.cashback_commission_change);
        d.sellerPromoDiscountKopecks += kopecks(row?.seller_promo_discount);
        d.loyaltyDiscountKopecks += kopecks(row?.loyalty_discount);
        d.wbDiscountPercent += num(row?.wibes_wb_discount_percent);
        d.installmentCofinancingKopecks += kopecks(row?.installment_cofinancing_amount);

        // Дополнительные поля (для других магазинов)
        d.supplierPromoKopecks += kopecks(row?.supplier_promo);
        d.productDiscountKopecks += kopecks(row?.product_discount_for_report);
        d.ppvzSppPrcSum += num(row?.ppvz_spp_prc); // Суммируем для расчёта среднего

        if (isReturn && Number.isFinite(qty)) {
          d.returnsCount += Math.max(0, Math.round(qty));
          d.returnsSumKopecks += kopecks(row?.retail_price_withdisc_rub);
        }

        // per-product daily aggregation — only when the row is tied to a
        // specific product. Штрафы/удержания без nm_id уже попали в daily.
        if (!hasNmId) continue;
        const key = `${day}|${nmId}`;
        const p = ensureProd(dailyProducts, key);
        p.lines += 1;
        if (rrDay) p.rrDate = rrDay;
        // sale_qty считаем только для реальных продаж (исключая возвраты,
        // корректировки логистики и хранения — у них docTypeName пуст или ≠ Продажа).
        const docType = String(row?.doc_type_name ?? '');
        const operName = String(row?.supplier_oper_name ?? '');
        if (docType === 'Продажа' && operName === 'Продажа' && Number.isFinite(qty) && qty > 0) {
          p.saleQty += Math.round(qty);
        }
        p.revenueKopecks += kopecks(row?.retail_price_withdisc_rub);
        // СПП для product = revenue × ppvz_spp_prc / 100
        const pRetail = num(row?.retail_price_withdisc_rub);
        const pSppPrc = num(row?.ppvz_spp_prc);
        p.sppAmountKopecks += Math.round(pRetail * pSppPrc);
        p.incomeFromSalesKopecks += kopecks(row?.ppvz_for_pay);
        p.commissionKopecks += kopecks(row?.ppvz_sales_commission);
        p.ppvzVwKopecks += kopecks(row?.ppvz_vw); // Вознаграждение WB
        p.ppvzRewardKopecks += kopecks(row?.ppvz_reward); // Вознаграждение (КРИТИЧНО!)
        p.logisticsKopecks += kopecks(row?.delivery_rub);
        p.returnLogisticsKopecks += kopecks(row?.return_amount);
        p.paidAcceptanceKopecks += kopecks(row?.acceptance);
        p.storageKopecks += kopecks(row?.storage_fee);
        p.penaltiesKopecks += kopecks(row?.penalty);
        // Используем тот же isPromotion что и выше для daily
        if (isPromotion) {
          p.promotionKopecks += deductionAmount;
        } else {
          p.otherHoldKopecks += deductionAmount;
        }
        p.acquiringKopecks += kopecks(row?.acquiring_fee); // payment_processing не включаем
        p.additionalPaymentsKopecks += kopecks(row?.additional_payment);
        // new WB API v5 fields
        p.cashbackAmountKopecks += kopecks(row?.cashback_amount);
        p.cashbackDiscountKopecks += kopecks(row?.cashback_discount);
        p.cashbackCommissionChangeKopecks += kopecks(row?.cashback_commission_change);
        p.sellerPromoDiscountKopecks += kopecks(row?.seller_promo_discount);
        p.loyaltyDiscountKopecks += kopecks(row?.loyalty_discount);
        p.wbDiscountPercent += num(row?.wibes_wb_discount_percent);
        p.installmentCofinancingKopecks += kopecks(row?.installment_cofinancing_amount);
        // Дополнительные поля
        p.supplierPromoKopecks += kopecks(row?.supplier_promo);
        p.productDiscountKopecks += kopecks(row?.product_discount_for_report);
        p.ppvzSppPrcSum += num(row?.ppvz_spp_prc);
        if (isReturn && Number.isFinite(qty)) {
          p.returnsCount += Math.max(0, Math.round(qty));
          p.returnsSumKopecks += kopecks(row?.retail_price_withdisc_rub);
        }

        const next = row?.rrd_id;
        if (typeof next === 'number' && next > rrdid) rrdid = next;
      }

      state.winIndex = wi;
      state.rrdid = rrdid;
      state.updatedAt = new Date().toISOString();
      await writeFile(checkpointPath, JSON.stringify(state, null, 2), 'utf8');

      await sleep(350);
      if (rows.length < 100000) break;
    }

    // Upsert daily products for this window
    try {
      const rows = Object.entries(dailyProducts).map(([k, v]) => {
        const [date, nmIdStr] = k.split('|');
        const nmId = Number(nmIdStr);
        return {
          workspaceId,
          shopId,
          date: date!,
          rrDate: v.rrDate ?? date!,
          saleQty: v.saleQty,
          nmId,
          lines: v.lines,
          revenueKopecks: v.revenueKopecks,
          sppAmountKopecks: v.sppAmountKopecks,
          incomeFromSalesKopecks: v.incomeFromSalesKopecks,
          commissionKopecks: v.commissionKopecks,
          ppvzVwKopecks: v.ppvzVwKopecks,
          logisticsKopecks: v.logisticsKopecks,
          returnLogisticsKopecks: v.returnLogisticsKopecks,
          paidAcceptanceKopecks: v.paidAcceptanceKopecks,
          storageKopecks: v.storageKopecks,
          penaltiesKopecks: v.penaltiesKopecks,
          otherHoldKopecks: v.otherHoldKopecks,
          promotionKopecks: v.promotionKopecks,
          acquiringKopecks: v.acquiringKopecks,
          additionalPaymentsKopecks: v.additionalPaymentsKopecks,
          cashbackAmountKopecks: v.cashbackAmountKopecks,
          cashbackDiscountKopecks: v.cashbackDiscountKopecks,
          cashbackCommissionChangeKopecks: v.cashbackCommissionChangeKopecks,
          sellerPromoDiscountKopecks: v.sellerPromoDiscountKopecks,
          loyaltyDiscountKopecks: v.loyaltyDiscountKopecks,
          wbDiscountPercent: v.wbDiscountPercent,
          installmentCofinancingKopecks: v.installmentCofinancingKopecks,
          returnsCount: v.returnsCount,
          returnsSumKopecks: v.returnsSumKopecks,
          updatedAt: new Date(),
        };
      });

      for (const r of rows) {
        await db
          .insert(wbFinanceDailyProducts)
          .values(r)
          .onConflictDoUpdate({
            target: [wbFinanceDailyProducts.workspaceId, wbFinanceDailyProducts.shopId, wbFinanceDailyProducts.date, wbFinanceDailyProducts.nmId],
            set: { ...r, updatedAt: new Date() },
          });
      }
    } catch (e: any) {
      logger.error({ window: `${wi + 1}/${windows.length}`, error: e?.message ?? e }, 'Failed to upsert finance daily products');
      state.errors.push({ winIndex: wi, message: `upsert failed: ${String(e?.message ?? e).slice(0, 300)}` });
    }

    // Вставляем компенсации (отдельный try/catch — ошибка не должна маскировать products)
    if (compensationsToInsert.length > 0) {
      try {
        logger.info({ count: compensationsToInsert.length }, 'Inserting compensations');
        for (const comp of compensationsToInsert) {
          await db
            .insert(wbCompensations)
            .values(comp)
            .onConflictDoNothing();
        }
      } catch (e: any) {
        logger.error({ window: `${wi + 1}/${windows.length}`, error: e?.message ?? e }, 'Failed to insert compensations');
      }
      compensationsToInsert.length = 0;
    }

    state.winIndex = wi + 1;
    state.rrdid = 0;
    state.updatedAt = new Date().toISOString();
    await writeFile(checkpointPath, JSON.stringify(state, null, 2), 'utf8');

    await sleep(600);
  }

  // Upsert into DB for full day range
  for (let i = 0; i <= daysBack; i++) {
    const dt = addDays(today, -i);
    const day = isoDate(dt);
    if (day < dateFrom || day > dateTo) continue;

    const d: any = state.daily[day] ?? {
      lines: 0,
      rrDate: null,
      retailKopecks: 0,
      payoutKopecks: 0,
      commissionKopecks: 0,
      ppvzVwKopecks: 0,
      logisticsKopecks: 0,
      returnLogisticsKopecks: 0,
      paidAcceptanceKopecks: 0,
      storageKopecks: 0,
      penaltyKopecks: 0,
      otherHoldKopecks: 0,
      acquiringKopecks: 0,
      additionalPaymentKopecks: 0,
      cashbackAmountKopecks: 0,
      cashbackDiscountKopecks: 0,
      cashbackCommissionChangeKopecks: 0,
      sellerPromoDiscountKopecks: 0,
      loyaltyDiscountKopecks: 0,
      wbDiscountPercent: 0,
      installmentCofinancingKopecks: 0,
      returnsCount: 0,
    };

    await db
      .insert(wbFinanceDaily)
      .values({
        workspaceId,
        shopId,
        date: day,
        rrDate: d.rrDate ?? day,
        lines: d.lines,
        retailKopecks: d.retailKopecks,
        sppAmountKopecks: d.sppAmountKopecks,
        payoutKopecks: d.payoutKopecks,
        commissionKopecks: d.commissionKopecks,
        ppvzVwKopecks: d.ppvzVwKopecks ?? 0,
        ppvzRewardKopecks: d.ppvzRewardKopecks ?? 0,
        logisticsKopecks: d.logisticsKopecks,
        returnLogisticsKopecks: d.returnLogisticsKopecks,
        paidAcceptanceKopecks: d.paidAcceptanceKopecks,
        storageKopecks: d.storageKopecks,
        penaltyKopecks: d.penaltyKopecks,
        otherHoldKopecks: d.otherHoldKopecks,
        promotionKopecks: d.promotionKopecks,
        acquiringKopecks: d.acquiringKopecks,
        additionalPaymentKopecks: d.additionalPaymentKopecks,
        cashbackAmountKopecks: d.cashbackAmountKopecks,
        cashbackDiscountKopecks: d.cashbackDiscountKopecks,
        cashbackCommissionChangeKopecks: d.cashbackCommissionChangeKopecks,
        sellerPromoDiscountKopecks: d.sellerPromoDiscountKopecks,
        loyaltyDiscountKopecks: d.loyaltyDiscountKopecks,
        wbDiscountPercent: d.wbDiscountPercent,
        installmentCofinancingKopecks: d.installmentCofinancingKopecks,
        supplierPromoKopecks: d.supplierPromoKopecks,
        productDiscountKopecks: d.productDiscountKopecks,
        ppvzSppPrc: d.lines > 0 ? Math.round(d.ppvzSppPrcSum / d.lines) : 0, // Средний %
        returnsCount: d.returnsCount,
        returnsSumKopecks: d.returnsSumKopecks,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [wbFinanceDaily.workspaceId, wbFinanceDaily.shopId, wbFinanceDaily.date],
        set: {
          lines: d.lines,
          retailKopecks: d.retailKopecks,
          sppAmountKopecks: d.sppAmountKopecks,
          payoutKopecks: d.payoutKopecks,
          commissionKopecks: d.commissionKopecks,
          ppvzVwKopecks: d.ppvzVwKopecks ?? 0,
          ppvzRewardKopecks: d.ppvzRewardKopecks ?? 0,
          logisticsKopecks: d.logisticsKopecks,
          returnLogisticsKopecks: d.returnLogisticsKopecks,
          paidAcceptanceKopecks: d.paidAcceptanceKopecks,
          storageKopecks: d.storageKopecks,
          penaltyKopecks: d.penaltyKopecks,
          otherHoldKopecks: d.otherHoldKopecks,
          promotionKopecks: d.promotionKopecks,
          acquiringKopecks: d.acquiringKopecks,
          additionalPaymentKopecks: d.additionalPaymentKopecks,
          cashbackAmountKopecks: d.cashbackAmountKopecks,
          cashbackDiscountKopecks: d.cashbackDiscountKopecks,
          cashbackCommissionChangeKopecks: d.cashbackCommissionChangeKopecks,
          sellerPromoDiscountKopecks: d.sellerPromoDiscountKopecks,
          loyaltyDiscountKopecks: d.loyaltyDiscountKopecks,
          wbDiscountPercent: d.wbDiscountPercent,
          installmentCofinancingKopecks: d.installmentCofinancingKopecks,
          supplierPromoKopecks: d.supplierPromoKopecks,
          productDiscountKopecks: d.productDiscountKopecks,
          ppvzSppPrc: d.lines > 0 ? Math.round(d.ppvzSppPrcSum / d.lines) : 0,
          returnsCount: d.returnsCount,
          returnsSumKopecks: d.returnsSumKopecks,
          updatedAt: new Date(),
        },
      });
  }

  logger.info('Finance daily upserted');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error({ err: e }, 'financeToDb failed');
    process.exit(1);
  });
