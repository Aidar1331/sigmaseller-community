/**
 * Hook for Pulse events panel state management.
 */

import { useState, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';

export interface EventFilters {
  typeFilter: { alert: boolean; log: boolean; task: boolean };
  statusFilter: { open: boolean; ack: boolean; resolved: boolean; done: boolean };
  search: string;
  categoryFilter: string;
  severityFilter: string;
  tab: 'alerts' | 'tasks' | 'logs';
  category: string;
  severity: string;
  showOverdueOnly: boolean;
  status: { open: boolean; ack: boolean; resolved: boolean; done: boolean };
  quickComment: string;
}

export interface EventModalState {
  open: boolean;
  type: 'alert' | 'log' | 'task';
  date: string;
  time: string;
  category: string;
  severity: 'info' | 'warn' | 'critical';
  dueAt: string;
  title: string;
  description: string;
}

export interface EventEditState {
  open: boolean;
  data: {
    eventId: number;
    date: string;
    time: string;
    category: string;
    severity: string;
    title: string;
    description: string;
    dueAt: string;
  } | null;
}

export interface UsePulseEventsResult {
  // Event counts
  eventCountsByDate: Record<string, { alerts: number; logs: number; tasks: number }>;
  
  // Timeline
  timeline: any[];
  timelineLoading: boolean;
  loadTimeline: (date: string, nmId: number | null) => Promise<void>;
  
  // Selected event
  selectedEventId: number | null;
  selectedEvent: any;
  setSelectedEventId: (id: number | null) => void;
  
  // Event comments
  eventComments: any[];
  eventCommentsLoading: boolean;
  eventCommentDraft: string;
  setEventCommentDraft: (v: string) => void;
  loadEventComments: (eventId: number) => Promise<void>;
  addEventComment: (eventId: number, bodyOverride?: string) => Promise<void>;
  
  // Event actions
  createEvent: () => Promise<void>;
  patchEvent: (eventId: number, patch: any) => Promise<void>;
  deleteEvent: (eventId: number) => Promise<void>;
  setEventStatus: (eventId: number, status: 'open' | 'ack' | 'resolved' | 'done') => Promise<void>;
  
  // Filters
  filters: EventFilters;
  setFilters: {
    setTypeFilter: (v: { alert: boolean; log: boolean; task: boolean }) => void;
    setStatusFilter: (v: { open: boolean; ack: boolean; resolved: boolean; done: boolean }) => void;
    setSearch: (v: string) => void;
    setCategoryFilter: (v: string) => void;
    setSeverityFilter: (v: string) => void;
    setTab: (v: 'alerts' | 'tasks' | 'logs') => void;
    setCategory: (v: string) => void;
    setSeverity: (v: string) => void;
    setShowOverdueOnly: (v: boolean) => void;
    setStatus: (v: { open: boolean; ack: boolean; resolved: boolean; done: boolean }) => void;
    setQuickComment: (v: string) => void;
  };
  
  // Create modal
  createModal: EventModalState;
  setCreateModal: {
    setOpen: (v: boolean) => void;
    setType: (v: 'alert' | 'log' | 'task') => void;
    setDate: (v: string) => void;
    setTime: (v: string) => void;
    setCategory: (v: string) => void;
    setSeverity: (v: 'info' | 'warn' | 'critical') => void;
    setDueAt: (v: string) => void;
    setTitle: (v: string) => void;
    setDescription: (v: string) => void;
    reset: () => void;
  };
  
  // Edit modal
  editModal: EventEditState;
  setEditModal: {
    open: (event: any) => void;
    close: () => void;
    update: (patch: Partial<EventEditState['data']>) => void;
    save: () => Promise<void>;
  };
  
  // Hover tip
  hoverTip: { date: string; nmId: number; x: number; y: number; rows: any[] } | null;
  setHoverTip: (v: { date: string; nmId: number; x: number; y: number; rows: any[] } | null) => void;
  loadEventsForHover: (date: string, nmId: number | null, x: number, y: number) => Promise<void>;
  
  // Context menu
  contextMenu: { x: number; y: number; date: string; nmId: number } | null;
  setContextMenu: (v: { x: number; y: number; date: string; nmId: number } | null) => void;
  
  // Error
  error: string | null;
  clearError: () => void;
}

export function usePulseEvents(
  workspaceId: number,
  selectedCell: { date: string; nmId: number } | null,
  dateKeys: string[]
): UsePulseEventsResult {
  const queryClient = useQueryClient();
  const shopId = useWorkspaceStore((s) => s.shopId);

  // Cache for events by cell
  const [eventsCache, setEventsCache] = useState<Record<string, any[]>>({});
  
  // State
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [eventComments, setEventComments] = useState<any[]>([]);
  const [eventCommentsLoading, setEventCommentsLoading] = useState(false);
  const [eventCommentDraft, setEventCommentDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  
  // Filters
  const [typeFilter, setTypeFilter] = useState({ alert: true, log: true, task: true });
  const [statusFilter, setStatusFilter] = useState({ open: true, ack: true, resolved: true, done: true });
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [tab, setTab] = useState<'alerts' | 'tasks' | 'logs'>('logs');
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('');
  const [showOverdueOnly, setShowOverdueOnly] = useState(false);
  const [status, setStatus] = useState({ open: true, ack: true, resolved: true, done: true });
  const [quickComment, setQuickComment] = useState('взял в работу');
  
  // Create modal
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createModalType, setCreateModalType] = useState<'alert' | 'log' | 'task'>('log');
  const [createModalDate, setCreateModalDate] = useState('');
  const [createModalTime, setCreateModalTime] = useState('');
  const [createModalCategory, setCreateModalCategory] = useState('');
  const [createModalSeverity, setCreateModalSeverity] = useState<'info' | 'warn' | 'critical'>('warn');
  const [createModalDueAt, setCreateModalDueAt] = useState('');
  const [createModalTitle, setCreateModalTitle] = useState('');
  const [createModalDesc, setCreateModalDesc] = useState('');
  
  // Edit modal
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editData, setEditData] = useState<EventEditState['data']>(null);
  
  // Hover/context
  const [hoverTip, setHoverTip] = useState<{ date: string; nmId: number; x: number; y: number; rows: any[] } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; date: string; nmId: number } | null>(null);
  
  // Event counts query
  const nmIdForCounts = selectedCell?.nmId && selectedCell.nmId > 0 ? selectedCell.nmId : null;
  const { data: eventCountsByDate = {} } = useQuery({
    queryKey: ['eventCounts', workspaceId, shopId, dateKeys[0], dateKeys[dateKeys.length - 1], nmIdForCounts],
    queryFn: async () => {
      if (!dateKeys.length) return {};
      const start = dateKeys[0]!;
      const end = dateKeys[dateKeys.length - 1]!;
      const qs = nmIdForCounts ? `&nmId=${encodeURIComponent(String(nmIdForCounts))}` : '';
      const res = await apiFetch(`/events/${workspaceId}/counts?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}${qs}`);
      return res.byDate ?? {};
    },
    enabled: dateKeys.length > 0,
  });
  
  // Load events for a cell (with caching)
  const loadEventsForCell = useCallback(async (date: string, nmId: number | null): Promise<any[]> => {
    const keyPart = nmId && nmId > 0 ? String(nmId) : 'all';
    const cacheKey = `${date}|${keyPart}`;
    if (eventsCache[cacheKey]) return eventsCache[cacheKey]!;
    
    const qs = nmId && nmId > 0 ? `&nmId=${encodeURIComponent(String(nmId))}` : '';
    const res = await apiFetch(`/events/${workspaceId}?date=${encodeURIComponent(date)}${qs}`);
    const rows = res.rows ?? [];
    setEventsCache(prev => ({ ...prev, [cacheKey]: rows }));
    return rows;
  }, [workspaceId, eventsCache]);
  
  // Load timeline
  const loadTimeline = useCallback(async (date: string, nmId: number | null) => {
    setTimelineLoading(true);
    setError(null);
    try {
      const rows = await loadEventsForCell(date, nmId);
      setTimeline(rows);
      setSelectedEventId(null);
      setEventComments([]);
    } catch (e: any) {
      setTimeline([]);
      setError(String(e?.message ?? e));
    } finally {
      setTimelineLoading(false);
    }
  }, [loadEventsForCell]);
  
  // Load event comments
  const loadEventComments = useCallback(async (eventId: number) => {
    setEventCommentsLoading(true);
    try {
      const res = await apiFetch(`/events/${workspaceId}/${eventId}/comments`);
      setEventComments(res.rows ?? []);
    } catch (e) {
      console.error('Failed to load event comments:', e);
      setEventComments([]);
    } finally {
      setEventCommentsLoading(false);
    }
  }, [workspaceId]);
  
  // Add event comment
  const addEventComment = useCallback(async (eventId: number, bodyOverride?: string) => {
    const body = (bodyOverride ?? eventCommentDraft).trim();
    if (!body) return;
    try {
      await apiFetch(`/events/${workspaceId}/${eventId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!bodyOverride) setEventCommentDraft('');
      await loadEventComments(eventId);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, [workspaceId, eventCommentDraft, loadEventComments]);
  
  // Invalidate cache for current cell
  const invalidateCellCache = useCallback(() => {
    if (!selectedCell) return;
    const keyPart = selectedCell.nmId && selectedCell.nmId > 0 ? selectedCell.nmId : 'all';
    const cacheKey = `${selectedCell.date}|${keyPart}`;
    setEventsCache(prev => {
      const copy = { ...prev };
      delete copy[cacheKey];
      return copy;
    });
  }, [selectedCell]);
  
  // Create event
  const createEvent = useCallback(async () => {
    if (!selectedCell) return;
    const eventDate = createModalDate || selectedCell.date;
    if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      setError('Укажите дату в формате ГГГГ-ММ-ДД');
      return;
    }
    if (!createModalTitle.trim()) {
      setError('Введите заголовок');
      return;
    }
    setError(null);
    try {
      await apiFetch(`/events/${workspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nmId: selectedCell.nmId > 0 ? selectedCell.nmId : undefined,
          date: eventDate,
          time: createModalTime || undefined,
          type: createModalType,
          category: createModalCategory || undefined,
          severity: createModalType === 'alert' ? createModalSeverity : undefined,
          title: createModalTitle,
          description: createModalDesc || '',
          dueAt: createModalType === 'task' && createModalDueAt ? new Date(createModalDueAt).toISOString() : undefined,
        }),
      });
      setCreateModalOpen(false);
      // Reset form
      setCreateModalDate('');
      setCreateModalTitle('');
      setCreateModalDesc('');
      setCreateModalTime('');
      setCreateModalCategory('');
      setCreateModalDueAt('');
      // Reload
      invalidateCellCache();
      await loadTimeline(selectedCell.date, selectedCell.nmId);
      queryClient.invalidateQueries({ queryKey: ['eventCounts'] });
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, [
    selectedCell, workspaceId, createModalDate, createModalTime, createModalType,
    createModalCategory, createModalSeverity, createModalDueAt, createModalTitle,
    createModalDesc, invalidateCellCache, loadTimeline, queryClient
  ]);
  
  // Patch event
  const patchEvent = useCallback(async (eventId: number, patch: any) => {
    try {
      await apiFetch(`/events/${workspaceId}/${eventId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (selectedCell) {
        invalidateCellCache();
        await loadTimeline(selectedCell.date, selectedCell.nmId);
      }
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, [workspaceId, selectedCell, invalidateCellCache, loadTimeline]);
  
  // Delete event
  const deleteEvent = useCallback(async (eventId: number) => {
    if (!confirm('Удалить событие?')) return;
    try {
      await apiFetch(`/events/${workspaceId}/${eventId}`, { method: 'DELETE' });
      if (selectedCell) {
        invalidateCellCache();
        await loadTimeline(selectedCell.date, selectedCell.nmId);
      }
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, [workspaceId, selectedCell, invalidateCellCache, loadTimeline]);
  
  // Set event status
  const setEventStatus = useCallback(async (eventId: number, newStatus: 'open' | 'ack' | 'resolved' | 'done') => {
    try {
      await apiFetch(`/events/${workspaceId}/${eventId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (selectedCell) {
        invalidateCellCache();
        await loadTimeline(selectedCell.date, selectedCell.nmId);
      }
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, [workspaceId, selectedCell, invalidateCellCache, loadTimeline]);
  
  // Load events for hover
  const loadEventsForHover = useCallback(async (date: string, nmId: number | null, x: number, y: number) => {
    try {
      const rows = await loadEventsForCell(date, nmId);
      setHoverTip({ date, nmId: nmId ?? 0, x, y, rows });
    } catch (e) {
      console.error('Failed to load hover events:', e);
      setHoverTip({ date, nmId: nmId ?? 0, x, y, rows: [] });
    }
  }, [loadEventsForCell]);
  
  // Selected event
  const selectedEvent = useMemo(() => {
    if (!selectedEventId) return null;
    return timeline.find(x => x.eventId === selectedEventId) ?? null;
  }, [selectedEventId, timeline]);
  
  return {
    eventCountsByDate,
    
    timeline,
    timelineLoading,
    loadTimeline,
    
    selectedEventId,
    selectedEvent,
    setSelectedEventId,
    
    eventComments,
    eventCommentsLoading,
    eventCommentDraft,
    setEventCommentDraft,
    loadEventComments,
    addEventComment,
    
    createEvent,
    patchEvent,
    deleteEvent,
    setEventStatus,
    
    filters: {
      typeFilter,
      statusFilter,
      search,
      categoryFilter,
      severityFilter,
      tab,
      category,
      severity,
      showOverdueOnly,
      status,
      quickComment,
    },
    setFilters: {
      setTypeFilter,
      setStatusFilter,
      setSearch,
      setCategoryFilter,
      setSeverityFilter,
      setTab,
      setCategory,
      setSeverity,
      setShowOverdueOnly,
      setStatus,
      setQuickComment,
    },
    
    createModal: {
      open: createModalOpen,
      type: createModalType,
      date: createModalDate,
      time: createModalTime,
      category: createModalCategory,
      severity: createModalSeverity,
      dueAt: createModalDueAt,
      title: createModalTitle,
      description: createModalDesc,
    },
    setCreateModal: {
      setOpen: setCreateModalOpen,
      setType: setCreateModalType,
      setDate: setCreateModalDate,
      setTime: setCreateModalTime,
      setCategory: setCreateModalCategory,
      setSeverity: setCreateModalSeverity,
      setDueAt: setCreateModalDueAt,
      setTitle: setCreateModalTitle,
      setDescription: setCreateModalDesc,
      reset: () => {
        setCreateModalDate('');
        setCreateModalTime('');
        setCreateModalCategory('');
        setCreateModalDueAt('');
        setCreateModalTitle('');
        setCreateModalDesc('');
      },
    },
    
    editModal: {
      open: editModalOpen,
      data: editData,
    },
    setEditModal: {
      open: (event: any) => {
        setEditData({
          eventId: event.eventId,
          date: event.date ?? '',
          time: event.time ?? '',
          category: event.category ?? '',
          severity: event.severity ?? '',
          title: event.title ?? '',
          description: event.description ?? '',
          dueAt: event.dueAt ? String(event.dueAt).slice(0, 16) : '',
        });
        setEditModalOpen(true);
      },
      close: () => setEditModalOpen(false),
      update: (patch) => setEditData(prev => prev ? { ...prev, ...patch } : prev),
      save: async () => {
        if (!editData) return;
        await patchEvent(editData.eventId, {
          date: editData.date || undefined,
          time: editData.time || null,
          category: editData.category || null,
          severity: editData.severity || null,
          title: editData.title || undefined,
          description: editData.description || null,
          dueAt: editData.dueAt ? new Date(editData.dueAt).toISOString() : null,
        });
        setEditModalOpen(false);
        setEditData(null);
      },
    },
    
    hoverTip,
    setHoverTip,
    loadEventsForHover,
    
    contextMenu,
    setContextMenu,
    
    error,
    clearError: () => setError(null),
  };
}
