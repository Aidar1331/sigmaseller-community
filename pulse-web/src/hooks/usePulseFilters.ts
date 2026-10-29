import { useState, useCallback, useMemo, useEffect } from 'react';
import { useDebounce } from './useDebounce';
import { METRIC_MAP, DEFAULT_ENABLED_METRICS } from '@/lib/metricMap';
import { useWorkspaceStore } from '@/store/workspace';

export interface PulseFiltersState {
  // Workspace
  workspaceId: number;
  /** Internal: tracks shopId so filters reset on shop switch */
  _shopId?: number | null;
  // Date range
  dateFrom: string;
  dateTo: string;
  // Display
  groupBy: 'day' | 'week';
  drrBase: 'sales' | 'payout';
  anomalies: 'on' | 'off';
  anomalyThresholdPct: number;
  // Filtering
  tagId: number | null;
  filterVendorCodes: string[];
  filterBrandNames: string[];
  filterSubjectNames: string[];
  filterNmIds: string;
  // Table settings
  enabledMetrics: string[];
  tableView: 'products' | 'metrics';
  tableHeatmap: boolean;
  tableHeatmapMode: 'row' | 'global';
  tableHeatmapIntensity: 'soft' | 'medium' | 'strong';
  tableNumberFormat: 'full' | 'short';
  tableShowUnits: boolean;
  tableDense: boolean;
  productsMetric: string;
  includeAll: boolean;
  productFilter: 'orders' | 'sales' | 'all';
}

export interface PulseFiltersActions {
  setWorkspaceId: (id: number) => void;
  setDateFrom: (date: string) => void;
  setDateTo: (date: string) => void;
  setGroupBy: (v: 'day' | 'week') => void;
  setDrrBase: (v: 'sales' | 'payout') => void;
  setAnomalies: (v: 'on' | 'off') => void;
  setAnomalyThresholdPct: (v: number) => void;
  setTagId: (id: number | null) => void;
  setFilterVendorCodes: (v: string[]) => void;
  setFilterBrandNames: (v: string[]) => void;
  setFilterSubjectNames: (v: string[]) => void;
  setFilterNmIds: (v: string) => void;
  setEnabledMetrics: (v: string[]) => void;
  setTableView: (v: 'products' | 'metrics') => void;
  setTableHeatmap: (v: boolean) => void;
  setTableHeatmapMode: (v: 'row' | 'global') => void;
  setTableHeatmapIntensity: (v: 'soft' | 'medium' | 'strong') => void;
  setTableNumberFormat: (v: 'full' | 'short') => void;
  setTableShowUnits: (v: boolean) => void;
  setTableDense: (v: boolean) => void;
  setProductsMetric: (v: string) => void;
  setIncludeAll: (v: boolean) => void;
  setProductFilter: (v: 'orders' | 'sales' | 'all') => void;
  resetFilters: () => void;
  applyPresetConfig: (config: any) => void;
  buildPresetConfig: () => { pulse: Partial<PulseFiltersState> };
}

export interface UsePulseFiltersResult {
  state: PulseFiltersState;
  actions: PulseFiltersActions;
  // Debounced values for API calls
  debouncedVendorCode: string;
  debouncedBrandName: string;
  debouncedSubjectName: string;
  debouncedNmIds: string;
  debouncedAnomalyThreshold: number;
  // Query string for API
  filterQueryString: string;
}

function getDefaultDateFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0"); return `${y}-${m}-${day}`;
}

function getDefaultDateTo(): string {
  return new Date().toISOString().slice(0, 10);
}

function getDefaultState(workspaceId: number): PulseFiltersState {
  return {
    workspaceId,
    dateFrom: getDefaultDateFrom(),
    dateTo: getDefaultDateTo(),
    groupBy: 'week',
    drrBase: 'sales',
    anomalies: 'on',
    anomalyThresholdPct: 20,
    tagId: null,
    filterVendorCodes: [],
    filterBrandNames: [],
    filterSubjectNames: [],
    filterNmIds: '',
    enabledMetrics: DEFAULT_ENABLED_METRICS,
    tableView: 'products',
    tableHeatmap: false,
    tableHeatmapMode: 'row',
    tableHeatmapIntensity: 'medium',
    tableNumberFormat: 'full',
    tableShowUnits: false,
    tableDense: true,
    productsMetric: 'salesRub',
    includeAll: typeof window !== 'undefined' && localStorage.getItem('pulse-include-all') === 'true',
    productFilter: (typeof window !== 'undefined' && localStorage.getItem('pulse-product-filter') as 'orders' | 'sales' | 'all') || 'orders',
  };
}

export function usePulseFilters(initialWorkspaceId?: number): UsePulseFiltersResult {
  // Get workspace from store if not provided
  const storeWorkspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopId = useWorkspaceStore((s) => s.shopId);
  const workspaceId = initialWorkspaceId ?? storeWorkspaceId ?? 0;

  const [state, setState] = useState<PulseFiltersState>(() => getDefaultState(workspaceId));

  // Sync workspaceId and reset filters when workspace OR shop changes
  // This fixes the bug where tags and filters persisted from old shops
  useEffect(() => {
    if (workspaceId > 0) {
      setState(s => {
        if (s.workspaceId === workspaceId && s._shopId === shopId) return s;
        // Reset all filters when workspace or shop changes to avoid stale data
        return { ...getDefaultState(workspaceId), _shopId: shopId };
      });
    }
  }, [workspaceId, shopId]);

  // Persist includeAll and productFilter to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('pulse-include-all', state.includeAll ? 'true' : 'false');
      localStorage.setItem('pulse-product-filter', state.productFilter);
    }
  }, [state.includeAll, state.productFilter]);

  // Debounced values
  const debouncedVendorCode = useDebounce(state.filterVendorCodes.join(','), 500);
  const debouncedBrandName = useDebounce(state.filterBrandNames.join(','), 500);
  const debouncedSubjectName = useDebounce(state.filterSubjectNames.join(','), 500);
  const debouncedNmIds = useDebounce(state.filterNmIds, 500);
  const debouncedAnomalyThreshold = useDebounce(state.anomalyThresholdPct, 400);

  // Actions
  const setWorkspaceId = useCallback((id: number) => setState(s => ({ ...s, workspaceId: id })), []);
  const setDateFrom = useCallback((date: string) => setState(s => ({ ...s, dateFrom: date })), []);
  const setDateTo = useCallback((date: string) => setState(s => ({ ...s, dateTo: date })), []);
  const setGroupBy = useCallback((v: 'day' | 'week') => setState(s => ({ ...s, groupBy: v })), []);
  const setDrrBase = useCallback((v: 'sales' | 'payout') => setState(s => ({ ...s, drrBase: v })), []);
  const setAnomalies = useCallback((v: 'on' | 'off') => setState(s => ({ ...s, anomalies: v })), []);
  const setAnomalyThresholdPct = useCallback((v: number) => setState(s => ({ ...s, anomalyThresholdPct: v })), []);
  const setTagId = useCallback((id: number | null) => setState(s => ({ ...s, tagId: id })), []);
  const setFilterVendorCodes = useCallback((v: string[]) => setState(s => ({ ...s, filterVendorCodes: v })), []);
  const setFilterBrandNames = useCallback((v: string[]) => setState(s => ({ ...s, filterBrandNames: v })), []);
  const setFilterSubjectNames = useCallback((v: string[]) => setState(s => ({ ...s, filterSubjectNames: v })), []);
  const setFilterNmIds = useCallback((v: string) => setState(s => ({ ...s, filterNmIds: v })), []);
  const setEnabledMetrics = useCallback((v: string[]) => setState(s => ({ ...s, enabledMetrics: v })), []);
  const setTableView = useCallback((v: 'products' | 'metrics') => setState(s => ({ ...s, tableView: v })), []);
  const setTableHeatmap = useCallback((v: boolean) => setState(s => ({ ...s, tableHeatmap: v })), []);
  const setTableHeatmapMode = useCallback((v: 'row' | 'global') => setState(s => ({ ...s, tableHeatmapMode: v })), []);
  const setTableHeatmapIntensity = useCallback((v: 'soft' | 'medium' | 'strong') => setState(s => ({ ...s, tableHeatmapIntensity: v })), []);
  const setTableNumberFormat = useCallback((v: 'full' | 'short') => setState(s => ({ ...s, tableNumberFormat: v })), []);
  const setTableShowUnits = useCallback((v: boolean) => setState(s => ({ ...s, tableShowUnits: v })), []);
  const setTableDense = useCallback((v: boolean) => setState(s => ({ ...s, tableDense: v })), []);
  const setProductsMetric = useCallback((v: string) => setState(s => ({ ...s, productsMetric: v })), []);
  const setIncludeAll = useCallback((v: boolean) => setState(s => ({ ...s, includeAll: v, productFilter: v ? 'all' : 'orders' })), []);
  const setProductFilter = useCallback((v: 'orders' | 'sales' | 'all') => setState(s => ({ ...s, productFilter: v, includeAll: v === 'all' })), []);

  const resetFilters = useCallback(() => {
    setState(s => getDefaultState(s.workspaceId));
  }, []);

  const applyPresetConfig = useCallback((cfg: any) => {
    const p = cfg?.pulse;
    if (!p) return;

    setState(s => {
      const next = { ...s };

      if (typeof p.dateFrom === 'string') next.dateFrom = p.dateFrom;
      if (typeof p.dateTo === 'string') next.dateTo = p.dateTo;
      // Legacy: periodDays → dateFrom/dateTo
      if (typeof p.periodDays === 'number' && !p.dateFrom) {
        const to = new Date();
        const from = new Date();
        from.setDate(from.getDate() - p.periodDays);
        next.dateFrom = from.toISOString().slice(0, 10);
        next.dateTo = to.toISOString().slice(0, 10);
      }

      if (p.groupBy === 'day' || p.groupBy === 'week') next.groupBy = p.groupBy;
      if (p.drrBase === 'sales' || p.drrBase === 'payout') next.drrBase = p.drrBase;
      if (p.anomalies === 'on' || p.anomalies === 'off') next.anomalies = p.anomalies;
      if (typeof p.anomalyThresholdPct === 'number') next.anomalyThresholdPct = p.anomalyThresholdPct;
      if (p.tagId === null) next.tagId = null;
      if (typeof p.tagId === 'number' && Number.isFinite(p.tagId) && p.tagId > 0) next.tagId = p.tagId;

      // Multi-select arrays
      if (Array.isArray(p.filterVendorCodes)) next.filterVendorCodes = p.filterVendorCodes;
      else if (typeof p.filterVendorCode === 'string' && p.filterVendorCode) next.filterVendorCodes = [p.filterVendorCode];
      if (Array.isArray(p.filterBrandNames)) next.filterBrandNames = p.filterBrandNames;
      else if (typeof p.filterBrandName === 'string' && p.filterBrandName) next.filterBrandNames = [p.filterBrandName];
      if (Array.isArray(p.filterSubjectNames)) next.filterSubjectNames = p.filterSubjectNames;
      else if (typeof p.filterSubjectName === 'string' && p.filterSubjectName) next.filterSubjectNames = [p.filterSubjectName];
      if (typeof p.filterNmIds === 'string') next.filterNmIds = p.filterNmIds;

      if (Array.isArray(p.enabledMetrics)) {
        const validMetrics = new Set(Object.keys(METRIC_MAP));
        next.enabledMetrics = p.enabledMetrics.filter((x: string) => validMetrics.has(x));
      }

      if (typeof p.tableDense === 'boolean') next.tableDense = p.tableDense;
      if (typeof p.tableHeatmap === 'boolean') next.tableHeatmap = p.tableHeatmap;
      if (p.tableHeatmapMode === 'row' || p.tableHeatmapMode === 'global') next.tableHeatmapMode = p.tableHeatmapMode;
      if (['soft', 'medium', 'strong'].includes(p.tableHeatmapIntensity)) next.tableHeatmapIntensity = p.tableHeatmapIntensity;
      if (p.tableNumberFormat === 'full' || p.tableNumberFormat === 'short') next.tableNumberFormat = p.tableNumberFormat;
      if (typeof p.tableShowUnits === 'boolean') next.tableShowUnits = p.tableShowUnits;
      if (p.tableView === 'products' || p.tableView === 'metrics') next.tableView = p.tableView;
      if (typeof p.productsMetric === 'string') next.productsMetric = p.productsMetric;
      if (typeof p.includeAll === 'boolean') next.includeAll = p.includeAll;
      if (p.productFilter === 'orders' || p.productFilter === 'sales' || p.productFilter === 'all') next.productFilter = p.productFilter;

      return next;
    });
  }, []);

  const buildPresetConfig = useCallback(() => {
    return {
      pulse: {
        dateFrom: state.dateFrom,
        dateTo: state.dateTo,
        groupBy: state.groupBy,
        drrBase: state.drrBase,
        anomalies: state.anomalies,
        anomalyThresholdPct: state.anomalyThresholdPct,
        tagId: state.tagId,
        filterVendorCodes: state.filterVendorCodes,
        filterBrandNames: state.filterBrandNames,
        filterSubjectNames: state.filterSubjectNames,
        filterNmIds: state.filterNmIds,
        enabledMetrics: state.enabledMetrics,
        tableDense: state.tableDense,
        tableHeatmap: state.tableHeatmap,
        tableHeatmapMode: state.tableHeatmapMode,
        tableHeatmapIntensity: state.tableHeatmapIntensity,
        tableNumberFormat: state.tableNumberFormat,
        tableShowUnits: state.tableShowUnits,
        tableView: state.tableView,
        productsMetric: state.productsMetric,
        includeAll: state.includeAll,
        productFilter: state.productFilter,
      },
    };
  }, [state]);

  // Build filter query string for API
  const filterQueryString = useMemo(() => {
    const parts: string[] = [];
    if (state.tagId) parts.push(`tagId=${encodeURIComponent(String(state.tagId))}`);
    if (debouncedVendorCode) parts.push(`vendorCode=${encodeURIComponent(debouncedVendorCode)}`);
    if (debouncedBrandName) parts.push(`brandName=${encodeURIComponent(debouncedBrandName)}`);
    if (debouncedSubjectName) parts.push(`subjectName=${encodeURIComponent(debouncedSubjectName)}`);
    if (debouncedNmIds) parts.push(`nmIds=${encodeURIComponent(debouncedNmIds)}`);
    return parts.join('&');
  }, [state.tagId, debouncedVendorCode, debouncedBrandName, debouncedSubjectName, debouncedNmIds]);

  const actions: PulseFiltersActions = useMemo(() => ({
    setWorkspaceId,
    setDateFrom,
    setDateTo,
    setGroupBy,
    setDrrBase,
    setAnomalies,
    setAnomalyThresholdPct,
    setTagId,
    setFilterVendorCodes,
    setFilterBrandNames,
    setFilterSubjectNames,
    setFilterNmIds,
    setEnabledMetrics,
    setTableView,
    setTableHeatmap,
    setTableHeatmapMode,
    setTableHeatmapIntensity,
    setTableNumberFormat,
    setTableShowUnits,
    setTableDense,
    setProductsMetric,
    setIncludeAll,
    setProductFilter,
    resetFilters,
    applyPresetConfig,
    buildPresetConfig,
  }), [
    setWorkspaceId, setDateFrom, setDateTo, setGroupBy, setDrrBase, setAnomalies,
    setAnomalyThresholdPct, setTagId, setFilterVendorCodes, setFilterBrandNames,
    setFilterSubjectNames, setFilterNmIds, setEnabledMetrics, setTableView,
    setTableHeatmap, setTableHeatmapMode, setTableHeatmapIntensity, setTableNumberFormat,
    setTableShowUnits, setTableDense, setProductsMetric, setIncludeAll, setProductFilter, resetFilters, applyPresetConfig,
    buildPresetConfig,
  ]);

  return {
    state,
    actions,
    debouncedVendorCode,
    debouncedBrandName,
    debouncedSubjectName,
    debouncedNmIds,
    debouncedAnomalyThreshold,
    filterQueryString,
  };
}
