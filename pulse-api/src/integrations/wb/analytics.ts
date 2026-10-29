import 'dotenv/config';
import { getWbApiKey, wbPostJson } from './wbClient.js';

export type SalesFunnelSelected = {
  period: { start: string; end: string };
  openCount: number;
  cartCount: number;
  orderCount: number;
  orderSum: number;
  buyoutCount: number;
  buyoutSum: number;
  avgPrice: number;
  conversions?: {
    addToCartPercent?: number;
    cartToOrderPercent?: number;
    buyoutPercent?: number;
  };
} & Record<string, any>;

export async function getSalesFunnelProductsStat(params: {
  start: string;
  end: string;
  nmIds: number[];
  limit?: number;
  offset?: number;
  workspaceId?: number;
  shopId?: number;
}): Promise<
  Array<{
    nmId: number;
    vendorCode?: string;
    subjectId?: number;
    subjectName?: string;
    selected: SalesFunnelSelected;
  }>
> {
  // workspaceId+shopId — обязательны в multi-shop окружении: без них токен
  // подбирается случайно и WB вернёт пустой response для артикулов «не своего»
  // магазина. 2026-05-31: см. фикс A/B-фото.
  const apiKey = await getWbApiKey(params.workspaceId, params.shopId);
  const url = 'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products';

  const body = {
    selectedPeriod: { start: params.start, end: params.end },
    nmIds: params.nmIds,
    brandNames: [],
    subjectIds: [],
    tagIds: [],
    skipDeletedNm: false,
    orderBy: { field: 'orderSum', mode: 'desc' },
    limit: params.limit ?? 100,
    offset: params.offset ?? 0,
  };

  const resp = await wbPostJson<{ data?: { products?: any[] } }>(url, apiKey, body);
  const products = resp?.data?.products;
  if (!Array.isArray(products)) return [];

  return products
    .map((p: any) => ({
      nmId: Number(p?.product?.nmId),
      vendorCode: p?.product?.vendorCode,
      subjectId: p?.product?.subjectId,
      subjectName: p?.product?.subjectName,
      selected: p?.statistic?.selected,
    }))
    .filter((x: any) => Number.isFinite(x.nmId) && x.nmId > 0 && x.selected);
}
