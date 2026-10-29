import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import type { Tag } from '@/types/pulse';

/* ── Query: workspace tags ── */

export function useTags(workspaceId: number) {
  const shopId = useWorkspaceStore((s) => s.shopId);
  return useQuery<Tag[]>({
    queryKey: ['tags', workspaceId, shopId],
    queryFn: async () => {
      const res = await apiFetch(`/tags/${workspaceId}`);
      return (res.rows ?? []) as Tag[];
    },
    enabled: workspaceId > 0,
  });
}

/* ── Query: tags for a specific product ── */

export function useProductTags(workspaceId: number, nmId: number | null) {
  return useQuery<Tag[]>({
    queryKey: ['productTags', workspaceId, nmId],
    queryFn: async () => {
      if (!nmId) return [];
      const res = await apiFetch(
        `/tags/${workspaceId}/products?nmIds=${encodeURIComponent(String(nmId))}`
      );
      return (res.byNmId?.[String(nmId)] ?? []) as Tag[];
    },
    enabled: !!nmId,
  });
}

/* ── Mutation: assign tag to product ── */

export function useAssignTag(workspaceId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      nmId,
      tagId,
    }: {
      nmId: number;
      tagId: number;
    }) =>
      apiFetch(`/tags/${workspaceId}/products/${nmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagId }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['productTags', workspaceId, vars.nmId] });
    },
  });
}

/* ── Mutation: remove tag from product ── */

export function useRemoveTag(workspaceId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      nmId,
      tagId,
    }: {
      nmId: number;
      tagId: number;
    }) =>
      apiFetch(`/tags/${workspaceId}/products/${nmId}/${tagId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['productTags', workspaceId, vars.nmId] });
    },
  });
}
