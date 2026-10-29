import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import type { Overview, PulseFilters } from '@/types/pulse';

/**
 * Build the query-string for the overview endpoint from filter state.
 */
function buildOverviewUrl(f: PulseFilters): string {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - f.periodDays);
  const fromIso = from.toISOString().slice(0, 10);

  const parts: string[] = [
    `from=${fromIso}`,
    `to=${today}`,
    `drrBase=${f.drrBase}`,
    `groupBy=${f.groupBy}`,
    `anomalies=${f.anomalies}`,
    `anomalyThresholdPct=${f.anomalyThresholdPct}`,
  ];

  if (f.tagId) parts.push(`tagId=${encodeURIComponent(String(f.tagId))}`);
  if (f.filterVendorCode) parts.push(`vendorCode=${encodeURIComponent(f.filterVendorCode)}`);
  if (f.filterBrandName) parts.push(`brandName=${encodeURIComponent(f.filterBrandName)}`);
  if (f.filterSubjectName) parts.push(`subjectName=${encodeURIComponent(f.filterSubjectName)}`);
  if (f.filterSubjectId) parts.push(`subjectId=${encodeURIComponent(f.filterSubjectId)}`);
  if (f.filterNmIds) parts.push(`nmIds=${encodeURIComponent(f.filterNmIds)}`);

  return `/pulse/${f.workspaceId}/overview?${parts.join('&')}`;
}

export function usePulseOverview(filters: PulseFilters) {
  const shopId = useWorkspaceStore((s) => s.shopId);
  return useQuery<Overview>({
    queryKey: ['pulseOverview', filters, shopId],
    queryFn: () => apiFetch(buildOverviewUrl(filters)),
  });
}
