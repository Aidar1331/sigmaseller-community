import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listPresets,
  createPreset,
  updatePreset,
  type PulsePreset,
} from '@/lib/presets';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import { useAuthStore } from '@/store/auth';

export type { PulsePreset };

/* ── Query: list all presets ── */

export function usePresets(workspaceId: number) {
  const shopId = useWorkspaceStore((s) => s.shopId);
  return useQuery<PulsePreset[]>({
    queryKey: ['presets', workspaceId, shopId],
    queryFn: () => listPresets(workspaceId),
    enabled: workspaceId > 0,
  });
}

/* ── Mutation: create preset ── */

export function useCreatePreset(workspaceId: number) {
  const qc = useQueryClient();
  const shopId = useWorkspaceStore((s) => s.shopId);
  const storeUserId = useAuthStore((s) => s.user?.userId ?? null);
  return useMutation({
    mutationFn: (input: {
      actorUserId?: number;
      name: string;
      description?: string;
      config: any;
    }) => {
      // actorUserId: берём из аргумента, иначе из auth-store. Раньше fallback
      // был `?? 0` — backend требует positive int → 400 «Некорректные
      // входные данные» если store ещё не успел загрузить юзера.
      const uid = input.actorUserId ?? storeUserId ?? undefined;
      return createPreset({ workspaceId, ...input, actorUserId: uid as any });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['presets', workspaceId, shopId] });
    },
  });
}

/* ── Mutation: update preset (patch) ── */

export function useUpdatePreset(workspaceId: number) {
  const qc = useQueryClient();
  const shopId = useWorkspaceStore((s) => s.shopId);
  return useMutation({
    mutationFn: ({
      presetId,
      actorUserId,
      ...input
    }: {
      presetId: number;
      actorUserId?: number;
      name?: string;
      description?: string | null;
      config?: any;
      isPinned?: boolean;
      sortOrder?: number;
    }) => updatePreset(presetId, workspaceId, { actorUserId: actorUserId ?? 0, ...input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['presets', workspaceId, shopId] });
    },
  });
}

/* ── Mutation: duplicate preset ── */

export function useDuplicatePreset(workspaceId: number) {
  const qc = useQueryClient();
  const shopId = useWorkspaceStore((s) => s.shopId);
  return useMutation({
    mutationFn: (presetId: number) =>
      apiFetch(`/presets/${presetId}/duplicate?workspaceId=${workspaceId}`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['presets', workspaceId, shopId] });
    },
  });
}

/* ── Mutation: delete preset (soft) ── */

export function useDeletePreset(workspaceId: number) {
  const qc = useQueryClient();
  const shopId = useWorkspaceStore((s) => s.shopId);
  return useMutation({
    mutationFn: (presetId: number) =>
      apiFetch(`/presets/${presetId}?workspaceId=${workspaceId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['presets', workspaceId, shopId] });
    },
  });
}

/* ── Mutation: restore deleted preset ── */

export function useRestorePreset(workspaceId: number) {
  const qc = useQueryClient();
  const shopId = useWorkspaceStore((s) => s.shopId);
  return useMutation({
    mutationFn: (presetId: number) =>
      apiFetch(`/presets/${presetId}/restore?workspaceId=${workspaceId}`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['presets', workspaceId, shopId] });
    },
  });
}
