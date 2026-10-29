import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';

/* ── Query: today's alerts report ── */

export function useAlertsReport(workspaceId: number) {
  const shopId = useWorkspaceStore((s) => s.shopId);
  const today = new Date().toISOString().slice(0, 10);

  return useQuery<any>({
    queryKey: ['alertsReport', workspaceId, shopId, today],
    queryFn: () =>
      apiFetch(
        `/alerts/${workspaceId}/report?date=${today}&status=all&limit=200`
      ),
  });
}

/* ── Mutation: run auto-alerts for today ── */

export function useRunAutoAlerts(workspaceId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await apiFetch(
        `/alerts/${workspaceId}/run?date=${encodeURIComponent(today)}`,
        { method: 'POST' }
      );
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alertsReport', workspaceId] });
    },
  });
}
