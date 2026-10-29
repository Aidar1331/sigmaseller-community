import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import type { PlanSummary } from '@/types/pulse';

export function usePlanSummary(
  workspaceId: number,
  periodDays: number,
  tagId: number | null,
) {
  const shopId = useWorkspaceStore((s) => s.shopId);
  return useQuery<PlanSummary | null>({
    queryKey: ['planSummary', workspaceId, shopId, periodDays, tagId],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const from = new Date();
      from.setUTCDate(from.getUTCDate() - periodDays);
      const fromIso = from.toISOString().slice(0, 10);
      const tagQ = tagId ? `&tagId=${encodeURIComponent(String(tagId))}` : '';

      try {
        const [pOrders, pSalesQty, pSalesRub] = await Promise.all([
          apiFetch(
            `/plans/summary?workspaceId=${workspaceId}&start=${fromIso}&end=${today}&metric=orders_qty${tagQ}`
          ),
          apiFetch(
            `/plans/summary?workspaceId=${workspaceId}&start=${fromIso}&end=${today}&metric=sales_qty${tagQ}`
          ),
          apiFetch(
            `/plans/summary?workspaceId=${workspaceId}&start=${fromIso}&end=${today}&metric=sales_rub${tagQ}`
          ),
        ]);

        return {
          start: fromIso,
          end: today,
          ordersQty: Number(pOrders?.sum ?? 0),
          salesQty: Number(pSalesQty?.sum ?? 0),
          salesRub: Number(pSalesRub?.sum ?? 0) / 100,
        };
      } catch (e) {
        console.error('Failed to load plan summary:', e);
        return null;
      }
    },
  });
}
