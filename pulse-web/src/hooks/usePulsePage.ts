/**
 * Main hook for Pulse page state management.
 * Combines filters, data fetching, presets, and events into a single interface.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { usePulseFilters, type PulseFiltersState, type PulseFiltersActions } from './usePulseFilters';
import { usePresets, useCreatePreset, useUpdatePreset, useDeletePreset, type PulsePreset } from './usePresets';
import { useTags } from './useTags';
import { fetchMetricsCatalog, type Metric, type MetricGroup } from '@/lib/metricsCatalog';
import type { SyncStatus, Overview } from '@/types/pulse';
import { METRIC_MAP } from '@/lib/metricMap';
import { useAuthStore, getUserIdOrNull } from '@/store/auth';
import { useWorkspaceStore } from '@/store/workspace';

export interface SelectedCell {
  date: string;
  nmId: number;
}

export interface UsePulsePageResult {
  // Filters
  filters: PulseFiltersState;
  filterActions: PulseFiltersActions;
  debouncedFilters: {
    vendorCode: string;
    brandName: string;
    subjectName: string;
    nmIds: string;
    anomalyThreshold: number;
  };

  // Data
  overview: Overview | null;
  productsMatrix: any;
  /** Пагинация таблицы товаров. Меняй offset чтобы перелистывать страницы. */
  matrixPage: { offset: number; limit: number };
  setMatrixPage: (next: { offset: number; limit: number }) => void;
  syncStatus: SyncStatus | null;
  catalogGroups: MetricGroup[];
  catalog: Metric[];
  tags: Array<{ tagId: number; name: string; color: string | null }>;
  suggestBrands: string[];
  suggestVendorCodes: string[];
  suggestSubjects: string[];
  suggestNmIds: string[];
  suggestBarcodes: string[];

  // Loading states
  loading: boolean;
  error: string | null;

  // Presets
  presets: PulsePreset[];
  presetId: number | null;
  isDirty: boolean;
  lastSavedPresetConfig: string;
  onSelectPreset: (idStr: string) => void;
  onSavePreset: () => Promise<void>;
  onDeletePreset: (id: number) => Promise<void>;
  createPresetDirect: (name: string) => Promise<void>;
  presetModal: {
    open: boolean;
    name: string;
    description: string;
    setName: (v: string) => void;
    setDescription: (v: string) => void;
    setOpen: (v: boolean) => void;
    create: () => Promise<void>;
  };

  // Table heatmap global bounds
  tableHeatmapGlobal: { min: number; max: number };

  // Settings sidebar
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;

  // Events cell selection
  selectedCell: SelectedCell | null;
  setSelectedCell: (cell: SelectedCell | null) => void;
  eventsNmId: string;
  setEventsNmId: (v: string) => void;

  // Actions
  refresh: () => void;
}

export function usePulsePage(): UsePulsePageResult {
  const router = useRouter();
  const queryClient = useQueryClient();

  // Get workspace ID from workspace store (not deprecated auth store)
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopId = useWorkspaceStore((s) => s.shopId);

  // Filter state
  const {
    state: filters,
    actions: filterActions,
    debouncedVendorCode,
    debouncedBrandName,
    debouncedSubjectName,
    debouncedNmIds,
    debouncedAnomalyThreshold,
    filterQueryString,
  } = usePulseFilters(workspaceId ?? undefined);

  // Use store workspaceId directly (filters.workspaceId lags behind by one tick)
  // Return 0 as guard — queries are disabled when effectiveWorkspaceId <= 0
  const effectiveWorkspaceId = workspaceId ?? 0;

  // Presets
  const presetWorkspaceId = effectiveWorkspaceId;
  const { data: presets = [] } = usePresets(presetWorkspaceId);
  const createPresetMutation = useCreatePreset(presetWorkspaceId);
  const updatePresetMutation = useUpdatePreset(presetWorkspaceId);
  const deletePresetMutation = useDeletePreset(presetWorkspaceId);

  const [presetId, setPresetId] = useState<number | null>(null);
  const [lastSavedPresetConfig, setLastSavedPresetConfig] = useState<string>('');
  const [presetModalOpen, setPresetModalOpen] = useState(false);
  const [presetModalName, setPresetModalName] = useState('');
  const [presetModalDesc, setPresetModalDesc] = useState('');

  // Tags
  const { data: tagsData } = useTags(effectiveWorkspaceId);
  const tags = tagsData ?? [];

  // Catalog
  const [catalogGroups, setCatalogGroups] = useState<MetricGroup[]>([]);
  const [catalog, setCatalog] = useState<Metric[]>([]);

  // Suggestions
  const [suggestBrands, setSuggestBrands] = useState<string[]>([]);
  const [suggestVendorCodes, setSuggestVendorCodes] = useState<string[]>([]);
  const [suggestSubjects, setSuggestSubjects] = useState<string[]>([]);
  const [suggestNmIds, setSuggestNmIds] = useState<string[]>([]);
  const [suggestBarcodes, setSuggestBarcodes] = useState<string[]>([]);

  // UI state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  const [eventsNmId, setEventsNmId] = useState<string>('');

  // Overview query
  const overviewQueryKey = [
    'pulseOverview',
    effectiveWorkspaceId,
    shopId,
    filters.dateFrom,
    filters.dateTo,
    filters.drrBase,
    filters.groupBy,
    filters.anomalies,
    debouncedAnomalyThreshold,
    filterQueryString,
  ];

  const { data: overview, isLoading: overviewLoading, error: overviewError } = useQuery<Overview>({
    queryKey: overviewQueryKey,
    queryFn: async () => {
      const base = `/pulse/${effectiveWorkspaceId}/overview`;
      const params = new URLSearchParams({
        from: filters.dateFrom,
        to: filters.dateTo,
        drrBase: filters.drrBase,
        groupBy: filters.groupBy,
        anomalies: filters.anomalies,
        anomalyThresholdPct: String(debouncedAnomalyThreshold),
      });
      // Add shopId filter if selected
      if (shopId) params.append('shopId', String(shopId));
      if (filterQueryString) {
        filterQueryString.split('&').forEach(part => {
          const [k, v] = part.split('=');
          if (k && v) params.append(k, decodeURIComponent(v));
        });
      }
      return apiFetch(`${base}?${params.toString()}`);
    },
    enabled: effectiveWorkspaceId > 0,
  });

  // Pagination state для таблицы товаров (2026-06-01).
  // KPI-плашки сверху используют kpiTotal — он не зависит от пагинации.
  const [matrixPage, setMatrixPage] = useState<{ offset: number; limit: number }>({ offset: 0, limit: 30 });

  // Reset offset когда меняется фильтр/период/магазин — иначе можно зависнуть
  // на странице, которой больше не существует.
  useEffect(() => {
    setMatrixPage((p) => p.offset === 0 ? p : { ...p, offset: 0 });
  }, [shopId, filters.dateFrom, filters.dateTo, filters.productsMetric, filters.productFilter, filterQueryString, filters.includeAll]);

  // Products matrix query
  const { data: productsMatrix } = useQuery({
    queryKey: ['productsMatrix', effectiveWorkspaceId, shopId, filters.dateFrom, filters.dateTo, filters.groupBy, filters.productsMetric, debouncedAnomalyThreshold, filterQueryString, filters.includeAll, filters.productFilter, matrixPage.offset, matrixPage.limit],
    queryFn: async () => {
      const base = `/pulse/${effectiveWorkspaceId}/products/matrix`;
      const params = new URLSearchParams({
        from: filters.dateFrom,
        to: filters.dateTo,
        groupBy: filters.groupBy,
        metric: filters.productsMetric,
        anomalyThresholdPct: String(debouncedAnomalyThreshold),
        limit: String(matrixPage.limit),
        offset: String(matrixPage.offset),
      });
      // Add shopId filter if selected
      if (shopId) params.append('shopId', String(shopId));
      if (filters.includeAll) params.set('includeAll', 'true');
      params.set('productFilter', filters.productFilter);
      if (filterQueryString) {
        filterQueryString.split('&').forEach(part => {
          const [k, v] = part.split('=');
          if (k && v) params.append(k, decodeURIComponent(v));
        });
      }
      const res = await apiFetch(`${base}?${params.toString()}`);
      return {
        dateKeys: res.dateKeys ?? [],
        metric: res.metric ?? filters.productsMetric,
        rows: res.rows ?? [],
        totalCount: res.totalCount ?? res.rows?.length ?? 0,
        page: res.page ?? { offset: matrixPage.offset, limit: matrixPage.limit, pageSize: res.rows?.length ?? 0 },
        kpiTotal: res.kpiTotal,
      };
    },
    enabled: effectiveWorkspaceId > 0,
    placeholderData: (prev) => prev, // не моргать при перелистывании
  });

  // Sync status query
  const { data: syncStatus } = useQuery<SyncStatus>({
    queryKey: ['syncStatus', effectiveWorkspaceId, shopId],
    queryFn: () => apiFetch(`/wb/${effectiveWorkspaceId}/sync/status`),
    enabled: effectiveWorkspaceId > 0,
  });

  // Check onboarding
  useEffect(() => {
    if (effectiveWorkspaceId <= 0) return;

    let cancelled = false;
    async function checkOnboarding() {
      try {
        const res = await apiFetch(`/onboarding/${effectiveWorkspaceId}/status`) as { status?: string };
        if (!cancelled && res?.status === 'no_shop') {
          router.replace('/onboarding');
        }
      } catch (e) {
        console.error('Onboarding check failed:', e);
      }
    }
    checkOnboarding();
    return () => { cancelled = true; };
  }, [effectiveWorkspaceId, router]);

  // Load catalog
  useEffect(() => {
    fetchMetricsCatalog().then(cat => {
      setCatalogGroups(cat.groups);
      setCatalog(cat.metrics);
    }).catch(() => {});
  }, []);

  // Load distinct values for autocomplete
  useEffect(() => {
    if (effectiveWorkspaceId <= 0) return;

    apiFetch(`/cards/${effectiveWorkspaceId}/distinct`)
      .then((res: any) => {
        setSuggestBrands(res.brands ?? []);
        setSuggestVendorCodes(res.vendorCodes ?? []);
        setSuggestSubjects(res.subjects ?? []);
        setSuggestNmIds((res.nmIds ?? []).map(String));
        setSuggestBarcodes(res.barcodes ?? []);
      })
      .catch(() => {});
  }, [effectiveWorkspaceId]);

  // Preset handling
  const currentPresetConfigFingerprint = useMemo(() => {
    return JSON.stringify(filterActions.buildPresetConfig());
  }, [filterActions]);

  const isDirty = presetId ? currentPresetConfigFingerprint !== lastSavedPresetConfig : false;

  const onSelectPreset = useCallback((idStr: string) => {
    const id = idStr ? Number(idStr) : null;
    setPresetId(id);
    const preset = presets.find(p => p.presetId === id);
    if (preset) {
      filterActions.applyPresetConfig(preset.config);
      setLastSavedPresetConfig(JSON.stringify(preset.config ?? {}));
    } else {
      filterActions.resetFilters();
      setLastSavedPresetConfig('');
    }
  }, [presets, filterActions]);

  const onSavePreset = useCallback(async () => {
    if (!presetId) {
      setPresetModalName('');
      setPresetModalDesc('');
      setPresetModalOpen(true);
      return;
    }
    const cfg = filterActions.buildPresetConfig();
    const actorUserId = getUserIdOrNull();
    await updatePresetMutation.mutateAsync({
      presetId: presetId!,
      actorUserId: actorUserId ?? undefined,
      config: cfg,
    });
    setLastSavedPresetConfig(JSON.stringify(cfg));
  }, [presetId, filterActions, updatePresetMutation]);

  const onDeletePreset = useCallback(async (id: number) => {
    await deletePresetMutation.mutateAsync(id);
    if (presetId === id) {
      setPresetId(null);
      setLastSavedPresetConfig('');
    }
  }, [presetId, deletePresetMutation]);

  const createPresetFromModal = useCallback(async () => {
    const name = presetModalName.trim();
    if (!name) return;
    try {
      const actorUserId = getUserIdOrNull();
      const preset = await createPresetMutation.mutateAsync({
        actorUserId: actorUserId ?? undefined,
        name,
        description: presetModalDesc.trim() || undefined,
        config: filterActions.buildPresetConfig(),
      });
      setPresetId((preset as any).presetId);
      setLastSavedPresetConfig(JSON.stringify((preset as any).config ?? filterActions.buildPresetConfig()));
      setPresetModalOpen(false);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.includes('409') || msg.includes('уже занято') || msg.includes('duplicate')) {
        alert('Фильтр с таким именем уже существует. Выберите другое имя.');
      } else {
        alert(`Ошибка: ${msg}`);
      }
    }
  }, [presetModalName, presetModalDesc, filterActions, createPresetMutation]);

  // Create preset directly with a given name (for inline sidebar creation)
  const createPresetDirect = useCallback(async (name: string) => {
    if (!name.trim()) return;
    try {
      const actorUserId = getUserIdOrNull();
      const preset = await createPresetMutation.mutateAsync({
        actorUserId: actorUserId ?? undefined,
        name: name.trim(),
        config: filterActions.buildPresetConfig(),
      });
      setPresetId((preset as any).presetId);
      setLastSavedPresetConfig(JSON.stringify((preset as any).config ?? filterActions.buildPresetConfig()));
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.includes('409') || msg.includes('уже занято') || msg.includes('duplicate')) {
        alert('Фильтр с таким именем уже существует.');
      } else {
        alert(`Ошибка: ${msg}`);
      }
    }
  }, [filterActions, createPresetMutation]);

  // Table heatmap global bounds
  const tableHeatmapGlobal = useMemo(() => {
    if (!overview) return { min: 0, max: 1 };
    const ids = filters.enabledMetrics.filter(id => id in METRIC_MAP);
    const nums: number[] = [];
    for (const id of ids) {
      const m = METRIC_MAP[id]!;
      for (const s of overview.series) {
        const v = (s as any)[m.seriesKey];
        if (typeof v === 'number' && Number.isFinite(v)) nums.push(v);
      }
    }
    if (!nums.length) return { min: 0, max: 1 };
    const sorted = nums.slice().sort((a, b) => a - b);
    const q = (p: number) => {
      const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
      return sorted[idx]!;
    };
    const min = q(0.05);
    const max = q(0.95);
    return { min, max: max === min ? min + 1 : max };
  }, [overview, filters.enabledMetrics]);

  // Refresh
  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['pulseOverview'] });
    queryClient.invalidateQueries({ queryKey: ['productsMatrix'] });
    queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
    queryClient.invalidateQueries({ queryKey: ['presets'] });
  }, [queryClient]);

  return {
    filters,
    filterActions,
    debouncedFilters: {
      vendorCode: debouncedVendorCode,
      brandName: debouncedBrandName,
      subjectName: debouncedSubjectName,
      nmIds: debouncedNmIds,
      anomalyThreshold: debouncedAnomalyThreshold,
    },

    overview: overview ?? null,
    productsMatrix: productsMatrix ?? null,
    matrixPage,
    setMatrixPage,
    syncStatus: syncStatus ?? null,
    catalogGroups,
    catalog,
    tags,
    suggestBrands,
    suggestVendorCodes,
    suggestSubjects,
    suggestNmIds,
    suggestBarcodes,

    loading: overviewLoading,
    error: overviewError ? String((overviewError as any)?.message ?? overviewError) : null,

    presets,
    presetId,
    isDirty,
    lastSavedPresetConfig,
    onSelectPreset,
    onSavePreset,
    onDeletePreset,
    createPresetDirect,
    presetModal: {
      open: presetModalOpen,
      name: presetModalName,
      description: presetModalDesc,
      setName: setPresetModalName,
      setDescription: setPresetModalDesc,
      setOpen: setPresetModalOpen,
      create: createPresetFromModal,
    },

    tableHeatmapGlobal,

    settingsOpen,
    setSettingsOpen,

    selectedCell,
    setSelectedCell,
    eventsNmId,
    setEventsNmId,

    refresh,
  };
}
