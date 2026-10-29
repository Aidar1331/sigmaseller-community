import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import type { ProductsMatrix, PulseFilters } from '@/types/pulse';

function buildMatrixUrl(f: PulseFilters, page: { offset: number; limit: number }): string {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - f.periodDays);
  const fromIso = from.toISOString().slice(0, 10);

  const parts: string[] = [
    `from=${fromIso}`,
    `to=${today}`,
    `groupBy=${f.groupBy}`,
    `metric=${encodeURIComponent(f.productsMetric)}`,
    `anomalyThresholdPct=${encodeURIComponent(String(f.anomalyThresholdPct))}`,
    `limit=${page.limit}`,
    `offset=${page.offset}`,
    // includeAll=true чтобы запрашивать ВСЕ товары workspace, не только
    // те у кого были выкупы. Иначе на 500+ каталоге KPI заниженный.
    `includeAll=true`,
  ];

  if (f.tagId) parts.push(`tagId=${encodeURIComponent(String(f.tagId))}`);
  if (f.filterVendorCode) parts.push(`vendorCode=${encodeURIComponent(f.filterVendorCode)}`);
  if (f.filterBrandName) parts.push(`brandName=${encodeURIComponent(f.filterBrandName)}`);
  if (f.filterSubjectName) parts.push(`subjectName=${encodeURIComponent(f.filterSubjectName)}`);
  if (f.filterSubjectId) parts.push(`subjectId=${encodeURIComponent(f.filterSubjectId)}`);
  if (f.filterNmIds) parts.push(`nmIds=${encodeURIComponent(f.filterNmIds)}`);

  return `/pulse/${f.workspaceId}/products/matrix?${parts.join('&')}`;
}

export function useProductsMatrix(filters: PulseFilters, page: { offset: number; limit: number } = { offset: 0, limit: 30 }) {
  const shopId = useWorkspaceStore((s) => s.shopId);
  return useQuery<ProductsMatrix>({
    queryKey: ['productsMatrix', filters, page, shopId],
    queryFn: async () => {
      const m = await apiFetch(buildMatrixUrl(filters, page));
      return {
        dateKeys: m.dateKeys ?? [],
        metric: m.metric ?? filters.productsMetric,
        totalCount: m.totalCount,
        page: m.page,
        kpiTotal: m.kpiTotal,
        rows: m.rows ?? [],
      };
    },
    // KPI-плашки не должны мигать при перелистывании страницы — оставляем
    // предыдущее значение пока грузится новое.
    placeholderData: (prev) => prev,
  });
}
