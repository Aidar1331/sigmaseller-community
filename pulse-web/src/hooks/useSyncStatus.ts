import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { SyncStatus } from '@/types/pulse';

export function useSyncStatus(workspaceId: number) {
  return useQuery<SyncStatus>({
    queryKey: ['syncStatus', workspaceId],
    queryFn: () => apiFetch(`/wb/${workspaceId}/sync/status`),
    enabled: workspaceId > 0,
    // Poll faster during active sync (5s), slower when idle (30s)
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.isSyncing ? 5_000 : 30_000;
    },
  });
}
