// Один источник правды для финансовых отчётов ВБ.
// Используется и в /finance/:ws/reports, и в /cashflow/:ws/summary, чтобы
// ДДС копейка-в-копейку совпадал с финансовыми отчётами (которые сами
// совпадают с xlsx «Финансовые отчёты» из ЛК ВБ).
//
// Формулы налога/НДС — те же, что были инлайн в routes/finance.ts:
//   * Для type=2 («По выкупам») adv/cogs/tax/vat не считаем (иначе задвоится с type=1).
//   * НДС берётся ИЗ цены продажи (`retail × pct / (100 + pct)`).
//   * Для УСН Д-Р/ОСНО рекламу из базы налога ПОВТОРНО не вычитаем —
//     она уже сидит в `deduction` (Баланс-списания ВБ).
//   * marginRub считается без вычета `additionalPaymentRub`? Нет: marginRub
//     включает `+additionalPaymentRub` (это доплата нам).

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export type FinanceReportRow = {
  reportId: number;
  sellerFinanceName: string | null;
  dateFrom: string;
  dateTo: string;
  createDate: string;
  reportType: number;
  retailAmountRub: number;
  forPayRub: number;
  deliveryServiceRub: number;
  paidStorageRub: number;
  paidAcceptanceRub: number;
  deductionRub: number;
  penaltyRub: number;
  additionalPaymentRub: number;
  bankPaymentRub: number;
  advRub: number;
  cogsRub: number;
  taxRub: number;
  vatRub: number;
  marginRub: number;
};

export type FinanceReportTotals = {
  retailAmountRub: number;
  forPayRub: number;
  deliveryServiceRub: number;
  paidStorageRub: number;
  paidAcceptanceRub: number;
  deductionRub: number;
  penaltyRub: number;
  additionalPaymentRub: number;
  bankPaymentRub: number;
  advRub: number;
  cogsRub: number;
  taxRub: number;
  vatRub: number;
  marginRub: number;
};

const ZERO_TOTALS: FinanceReportTotals = {
  retailAmountRub: 0,
  forPayRub: 0,
  deliveryServiceRub: 0,
  paidStorageRub: 0,
  paidAcceptanceRub: 0,
  deductionRub: 0,
  penaltyRub: 0,
  additionalPaymentRub: 0,
  bankPaymentRub: 0,
  advRub: 0,
  cogsRub: 0,
  taxRub: 0,
  vatRub: 0,
  marginRub: 0,
};

export async function getFinanceReportsByPeriod(
  workspaceId: number,
  shopId: number | undefined,
  start: string,
  end: string,
): Promise<{ rows: FinanceReportRow[]; totals: FinanceReportTotals }> {
  const reportsRaw = await db.execute(sql`
    SELECT * FROM wb_finance_reports
    WHERE workspace_id = ${workspaceId}
      ${shopId ? sql`AND shop_id = ${shopId}` : sql``}
      AND date_from >= ${start} AND date_from <= ${end}
    ORDER BY date_from DESC
  `);

  // Налоговые настройки магазинов (per-shop налог + НДС)
  const taxRows: any = await db.execute(sql`
    SELECT shop_id, tax_regime, tax_rate, vat_pct
      FROM marketplace_shops
     WHERE workspace_id = ${workspaceId}
  `);
  const taxByShop = new Map<number, { regime: string; ratePct: number; vatPct: number }>();
  for (const t of ((taxRows.rows ?? taxRows) as any[])) {
    const regime = String(t.tax_regime ?? '');
    const rawRate = Number(t.tax_rate);
    const ratePct = Number.isFinite(rawRate) && rawRate > 0
      ? rawRate
      : regime === 'usn6' ? 6 : regime === 'usn15' ? 15 : regime === 'osno' ? 20 : regime === 'ausn8' ? 8 : regime === 'ausn20' ? 20 : 0;
    taxByShop.set(Number(t.shop_id), {
      regime,
      ratePct,
      vatPct: Number(t.vat_pct ?? 0),
    });
  }

  const rows: FinanceReportRow[] = await Promise.all(((reportsRaw.rows ?? []) as any[]).map(async (r: any) => {
    const isPrimary = Number(r.report_type) === 1;

    const advRes = isPrimary ? await db.execute(sql`
      SELECT COALESCE(SUM(upd_sum_kopecks), 0) AS adv_kop
      FROM wb_adv_finance
      WHERE workspace_id = ${workspaceId}
        ${shopId ? sql`AND shop_id = ${shopId}` : sql``}
        AND upd_date BETWEEN ${r.date_from} AND ${r.date_to}
    `) : { rows: [{ adv_kop: 0 }] };
    const cogsRes = isPrimary ? await db.execute(sql`
      SELECT COALESCE(SUM(COALESCE(c.cogs_kopecks, 0) * GREATEST(0, fdp.sale_qty - COALESCE(fdp.returns_count, 0))), 0) AS cogs_kop
      FROM wb_finance_daily_products fdp
      LEFT JOIN wb_cogs c ON c.workspace_id = fdp.workspace_id AND c.nm_id = fdp.nm_id
      WHERE fdp.workspace_id = ${workspaceId}
        ${shopId ? sql`AND fdp.shop_id = ${shopId}` : sql``}
        AND fdp.date BETWEEN ${r.date_from} AND ${r.date_to}
    `) : { rows: [{ cogs_kop: 0 }] };
    const advKop = Number((advRes.rows?.[0] as any)?.adv_kop ?? 0);
    const cogsKop = Number((cogsRes.rows?.[0] as any)?.cogs_kop ?? 0);

    const tax = taxByShop.get(Number(r.shop_id));
    const retailRub = Math.round(Number(r.retail_amount_kopecks) / 100);
    const logRub = Math.round(Number(r.delivery_service_kopecks) / 100);
    const storRub = Math.round(Number(r.paid_storage_kopecks) / 100);
    const accRub = Math.round(Number(r.paid_acceptance_kopecks) / 100);
    const dedRub = Math.round(Number(r.deduction_kopecks) / 100);
    const penRub = Math.round(Number(r.penalty_kopecks) / 100);
    const addRub = Math.round(Number(r.additional_payment_kopecks) / 100);
    const advRub = Math.round(advKop / 100);
    const cogsRub = Math.round(cogsKop / 100);

    let vatRub = 0;
    let taxRub = 0;
    if (isPrimary && tax) {
      vatRub = tax.vatPct > 0 ? Math.round(retailRub * tax.vatPct / (100 + tax.vatPct)) : 0;
      const ratePct = tax.ratePct;
      if (tax.regime === 'usn6' || tax.regime === 'ausn8') {
        taxRub = Math.round(retailRub * ratePct / 100);
      } else {
        const base = retailRub - logRub - storRub - accRub - dedRub - penRub - cogsRub - vatRub;
        taxRub = Math.max(0, Math.round(base * ratePct / 100));
      }
    }
    const marginRub = retailRub - logRub - storRub - accRub - dedRub - penRub + addRub - cogsRub - taxRub - vatRub;

    return {
      reportId: Number(r.report_id),
      sellerFinanceName: r.seller_finance_name,
      dateFrom: r.date_from,
      dateTo: r.date_to,
      createDate: r.create_date,
      reportType: Number(r.report_type),
      retailAmountRub: retailRub,
      forPayRub: Math.round(Number(r.for_pay_kopecks) / 100),
      deliveryServiceRub: logRub,
      paidStorageRub: storRub,
      paidAcceptanceRub: accRub,
      deductionRub: dedRub,
      penaltyRub: penRub,
      additionalPaymentRub: addRub,
      bankPaymentRub: Math.round(Number(r.bank_payment_kopecks) / 100),
      advRub,
      cogsRub,
      taxRub,
      vatRub,
      marginRub,
    };
  }));

  const totals = rows.reduce<FinanceReportTotals>((acc, r) => ({
    retailAmountRub: acc.retailAmountRub + r.retailAmountRub,
    forPayRub: acc.forPayRub + r.forPayRub,
    deliveryServiceRub: acc.deliveryServiceRub + r.deliveryServiceRub,
    paidStorageRub: acc.paidStorageRub + r.paidStorageRub,
    paidAcceptanceRub: acc.paidAcceptanceRub + r.paidAcceptanceRub,
    deductionRub: acc.deductionRub + r.deductionRub,
    penaltyRub: acc.penaltyRub + r.penaltyRub,
    additionalPaymentRub: acc.additionalPaymentRub + r.additionalPaymentRub,
    bankPaymentRub: acc.bankPaymentRub + r.bankPaymentRub,
    advRub: acc.advRub + r.advRub,
    cogsRub: acc.cogsRub + r.cogsRub,
    taxRub: acc.taxRub + r.taxRub,
    vatRub: acc.vatRub + r.vatRub,
    marginRub: acc.marginRub + r.marginRub,
  }), { ...ZERO_TOTALS });

  return { rows, totals };
}
