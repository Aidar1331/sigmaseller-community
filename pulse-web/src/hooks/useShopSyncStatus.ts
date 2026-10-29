import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

/**
 * Per-stage freshness for a specific shop, powered by the
 * marketplace_shops_sync_status VIEW (migration 0111).
 *
 * Distinct from useSyncStatus (which hits /wb/:ws/sync/status — a
 * workspace-level "is something currently syncing" signal). This hook
 * feeds <SyncFreshnessBadge/> on dashboard pages: "Pulse / Finance /
 * SEO / Cashflow — обновлено X минут назад".
 */

export type SlaStatus = 'fresh' | 'stale' | 'broken';

export interface ShopSyncStage {
  stage: string;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastTokenExpiredAt: string | null;
  lastErrorMessage: string | null;
  successCount: number;
  failedCount: number;
  ageMinutes: number | null;
  slaMinutes: number;
  slaStatus: SlaStatus;
}

export interface ShopSyncStatusResponse {
  workspaceId: number;
  shopId: number;
  overallStatus: SlaStatus;
  stages: ShopSyncStage[];
}

export function useShopSyncStatus(workspaceId: number | null, shopId: number | null) {
  return useQuery<ShopSyncStatusResponse>({
    queryKey: ['shopSyncStatus', workspaceId, shopId],
    queryFn: () =>
      apiFetch<ShopSyncStatusResponse>(`/wb/${workspaceId}/shops/${shopId}/sync-status`),
    enabled: !!workspaceId && !!shopId,
    refetchInterval: 60_000, // page badge updates once a minute
    staleTime: 30_000,
  });
}

/**
 * Pull the stage matching the prefix. Sync-runs have stage strings like
 * 'refresh:orders-sales:running', 'refresh:finance:running',
 * 'finance-daily:done' etc. We match by substring so the consumer can
 * pass a short name ('orders-sales') and not worry about the exact
 * stage label the runner produced.
 *
 * If multiple stages match (different successful runners for the same
 * stream), prefer the freshest.
 */
export function pickStage(
  stages: ShopSyncStage[] | undefined,
  needle: string,
): ShopSyncStage | undefined {
  if (!stages) return undefined;
  const matches = stages.filter((s) => s.stage.includes(needle));
  if (matches.length === 0) return undefined;
  return matches.reduce((best, cur) => {
    const b = best.lastSuccessAt ? new Date(best.lastSuccessAt).getTime() : 0;
    const c = cur.lastSuccessAt ? new Date(cur.lastSuccessAt).getTime() : 0;
    return c > b ? cur : best;
  });
}
