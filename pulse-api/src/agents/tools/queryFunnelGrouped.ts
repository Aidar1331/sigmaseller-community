/**
 * Tool: query_funnel_grouped — категорийная аналитика воронки по бренду,
 * предмету или ярлыку. WB-метод `/api/analytics/v3/sales-funnel/grouped/history`
 * возвращает агрегированные показатели для группы товаров за период.
 *
 * Use cases:
 *  - «Какой бренд растёт, какой проседает?»
 *  - «Категория мужских кроссовок: сколько просмотров → заказов в этом месяце?»
 *  - «По ярлыку Архив — какая воронка?»
 *
 * SAFE: read-only.
 */

import { getFunnelGroupedHistory } from '../../integrations/wb/salesFunnel.api.js';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';

interface QueryFunnelGroupedArgs {
  from: string;
  to: string;
  /** Ровно ОДИН из трёх — иначе WB пересечёт и группа окажется пустой. */
  brandNames?: string[];
  subjectIds?: number[];
  tagIds?: number[];
  /** 'day' (по дням, дефолт) или 'week' (агрегация неделями). */
  aggregationLevel?: 'day' | 'week';
  _workspaceId?: number;
  _shopId?: number;
}

export async function queryFunnelGrouped(args: QueryFunnelGroupedArgs): Promise<string> {
  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  // Валидация: ровно одна группа.
  const groups = [
    args.brandNames?.length ? 'brands' : null,
    args.subjectIds?.length ? 'subjects' : null,
    args.tagIds?.length ? 'tags' : null,
  ].filter(Boolean);
  if (groups.length === 0) {
    return JSON.stringify({
      error: 'Укажите brandNames, subjectIds или tagIds — иначе WB возвращает пустой результат.',
    });
  }
  if (groups.length > 1) {
    return JSON.stringify({
      error: `Укажите ровно одну группировку, не несколько (получено: ${groups.join(', ')}).`,
    });
  }

  try {
    const apiKey = await getWbApiKey(wsId, args._shopId ?? undefined);
    const data = await getFunnelGroupedHistory(apiKey, {
      selectedPeriod: { start: args.from, end: args.to },
      brandNames: args.brandNames,
      subjectIds: args.subjectIds,
      tagIds: args.tagIds,
      aggregationLevel: args.aggregationLevel ?? 'day',
      skipDeletedNm: true,
    });

    // Сводим в компактный вид для LLM: общие тоталы + первые 5 строк истории.
    const summary = (data ?? []).map((g) => {
      const totals = (g.history ?? []).reduce(
        (acc, h) => ({
          views: acc.views + (h.viewCount ?? 0),
          openCard: acc.openCard + (h.openCardCount ?? 0),
          carts: acc.carts + (h.addToCartCount ?? 0),
          orders: acc.orders + (h.orderCount ?? 0),
          ordersRub: acc.ordersRub + (h.orderSumRub ?? 0),
          buyouts: acc.buyouts + (h.buyoutCount ?? 0),
        }),
        { views: 0, openCard: 0, carts: 0, orders: 0, ordersRub: 0, buyouts: 0 },
      );
      const conv = totals.openCard > 0 ? ((totals.orders / totals.openCard) * 100).toFixed(2) : '0';
      const buyoutRate = totals.orders > 0 ? ((totals.buyouts / totals.orders) * 100).toFixed(0) : '0';
      return {
        groupName: g.groupName,
        period: `${args.from} → ${args.to}`,
        ...totals,
        conversionPct: conv,
        buyoutRatePct: buyoutRate,
        dailyPreview: (g.history ?? []).slice(0, 5),
      };
    });

    return JSON.stringify({ ok: true, groupBy: groups[0], data: summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return JSON.stringify({ error: `WB grouped funnel failed: ${msg}` });
  }
}
