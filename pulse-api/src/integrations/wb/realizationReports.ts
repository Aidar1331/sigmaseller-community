/**
 * WB Realization Reports API
 * Еженедельные отчёты реализации — используются Torgstat
 * 
 * Endpoint: GET https://documents-api.wildberries.ru/api/v1/realization-reports
 */
import { getWbApiKeyByShop } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'realizationReports' });

interface RealizationReport {
  realizationreport_id: number;
  date_from: string;
  date_to: string;
  create_dt: string;
  currency_name: string;
  suppliercontract_code: string | null;
  rrd_id: number;
  gi_id: number;
  subject_name: string;
  nm_id: number;
  brand_name: string;
  sa_name: string;
  ts_name: string;
  barcode: string;
  doc_type_name: string;
  quantity: number;
  retail_price: number;
  retail_amount: number;
  sale_percent: number;
  commission_percent: number;
  office_name: string;
  supplier_oper_name: string;
  order_dt: string;
  sale_dt: string;
  rr_dt: string;
  shk_id: number;
  retail_price_withdisc_rub: number;
  delivery_amount: number;
  return_amount: number;
  delivery_rub: number;
  gi_box_type_name: string;
  product_discount_for_report: number;
  supplier_promo: number;
  rid: number;
  ppvz_spp_prc: number;
  ppvz_kvw_prc_base: number;
  ppvz_kvw_prc: number;
  sup_rating_prc_up: number;
  is_kgvp_v2: number;
  ppvz_sales_commission: number;
  ppvz_for_pay: number;
  ppvz_reward: number;
  acquiring_fee: number;
  acquiring_percent: number;
  acquiring_bank: string;
  ppvz_vw: number;
  ppvz_vw_nds: number;
  penalty: number;
  additional_payment: number;
  storage_fee: number;
  deduction: number;
  acceptance: number;
  srid: string;
}

interface ReportMeta {
  reportId: number;
  dateFrom: string;
  dateTo: string;
}

/**
 * Получить список еженедельных отчётов реализации
 */
export async function getRealizationReportsList(shopId: number): Promise<ReportMeta[]> {
  const apiKey = await getWbApiKeyByShop(shopId);
  
  const url = 'https://documents-api.wildberries.ru/api/v1/realization-reports';
  
  const res = await fetch(url, {
    headers: {
      'Authorization': apiKey,
    },
  });
  
  if (!res.ok) {
    throw new Error(`Failed to get realization reports list: ${res.status}`);
  }
  
  const data = await res.json();
  return data;
}

/**
 * Получить детальный отчёт реализации по ID
 */
export async function getRealizationReport(shopId: number, reportId: number): Promise<RealizationReport[]> {
  const apiKey = await getWbApiKeyByShop(shopId);
  
  const url = `https://documents-api.wildberries.ru/api/v1/realization-reports/${reportId}`;
  
  const res = await fetch(url, {
    headers: {
      'Authorization': apiKey,
    },
  });
  
  if (!res.ok) {
    throw new Error(`Failed to get realization report ${reportId}: ${res.status}`);
  }
  
  const data = await res.json();
  return data;
}

/**
 * Агрегировать данные из отчёта реализации
 */
export function aggregateReport(rows: RealizationReport[]) {
  let commission = 0;
  let logistics = 0;
  let storage = 0;
  let acquiring = 0;
  let penalty = 0;
  let retail = 0;
  let payout = 0;
  
  for (const row of rows) {
    commission += (row.ppvz_sales_commission || 0) + (row.ppvz_vw || 0);
    logistics += row.delivery_rub || 0;
    storage += row.storage_fee || 0;
    acquiring += row.acquiring_fee || 0;
    penalty += row.penalty || 0;
    retail += row.retail_price_withdisc_rub || 0;
    payout += row.ppvz_for_pay || 0;
  }
  
  return {
    commission,
    logistics,
    storage,
    acquiring,
    penalty,
    retail,
    payout,
    rows: rows.length,
  };
}
