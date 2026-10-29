import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import type { EventCountsByDate } from '@/types/pulse';

/* ── Query: event counts by date for a specific nmId ── */

export function useEventCounts(
  workspaceId: number,
  dateKeys: string[],
  nmId: number | null,
) {
  const shopId = useWorkspaceStore((s) => s.shopId);
  const start = dateKeys[0] ?? '';
  const end = dateKeys[dateKeys.length - 1] ?? '';

  return useQuery<EventCountsByDate>({
    queryKey: ['eventCounts', workspaceId, shopId, start, end, nmId],
    queryFn: async () => {
      if (!nmId || !start || !end) return {};
      const res = await apiFetch(
        `/events/${workspaceId}/counts?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&nmId=${encodeURIComponent(String(nmId))}`
      );
      return (res.byDate ?? {}) as EventCountsByDate;
    },
    enabled: !!nmId && dateKeys.length > 0,
  });
}

/* ── Query: events for a specific cell (date × nmId) ── */

export function useEventsForCell(
  workspaceId: number,
  date: string | null,
  nmId: number | null,
) {
  const shopId = useWorkspaceStore((s) => s.shopId);
  return useQuery<any[]>({
    queryKey: ['eventsForCell', workspaceId, shopId, date, nmId],
    queryFn: async () => {
      const res = await apiFetch(
        `/events/${workspaceId}?date=${encodeURIComponent(date!)}&nmId=${encodeURIComponent(String(nmId!))}`
      );
      return res.rows ?? [];
    },
    enabled: !!date && !!nmId,
  });
}

/* ── Query: event comments ── */

export function useEventComments(workspaceId: number, eventId: number | null) {
  const shopId = useWorkspaceStore((s) => s.shopId);
  return useQuery<any[]>({
    queryKey: ['eventComments', workspaceId, shopId, eventId],
    queryFn: async () => {
      const res = await apiFetch(`/events/${workspaceId}/${eventId!}/comments`);
      return res.rows ?? [];
    },
    enabled: !!eventId,
  });
}

/* ── Mutation: add event comment ── */

export function useAddEventComment(workspaceId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      eventId,
      body,
      actorUserId,
    }: {
      eventId: number;
      body: string;
      actorUserId: number;
    }) =>
      apiFetch(`/events/${workspaceId}/${eventId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, actorUserId }),
      }),
    onSuccess: (_data, vars) => {
      const currentShopId = useWorkspaceStore.getState().shopId;
      qc.invalidateQueries({ queryKey: ['eventComments', workspaceId, currentShopId, vars.eventId] });
    },
  });
}

/* ── Mutation: create event ── */

export function useCreateEvent(workspaceId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      nmId: number;
      type: 'alert' | 'log' | 'task';
      title: string;
      description?: string;
      occurredAt?: string;
      category?: string;
      severity?: 'info' | 'warn' | 'critical';
      dueAt?: string;
      actorUserId: number;
    }) =>
      apiFetch(`/events/${workspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eventCounts', workspaceId] });
      qc.invalidateQueries({ queryKey: ['eventsForCell', workspaceId] });
    },
  });
}

/* ── Mutation: update event ── */

export function useUpdateEvent(workspaceId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      eventId,
      ...input
    }: {
      eventId: number;
      status?: string;
      title?: string;
      description?: string;
      severity?: string;
      category?: string;
      dueAt?: string | null;
      actorUserId: number;
    }) =>
      apiFetch(`/events/${workspaceId}/${eventId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eventCounts', workspaceId] });
      qc.invalidateQueries({ queryKey: ['eventsForCell', workspaceId] });
    },
  });
}
