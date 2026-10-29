import { create } from 'zustand';
import type { PulseFilters } from '@/types/pulse';

const PERIOD_PRESETS = [7, 30, 60, 90, 120] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];
export { PERIOD_PRESETS };

type ProductsMetricKey =
  | 'ordersCount'
  | 'ordersRub'
  | 'salesCount'
  | 'salesRub'
  | 'priceNoSppRub'
  | 'priceWithSppRub'
  | 'sppPercent'
  | 'buyoutCount'
  | 'buyoutSumRub'
  | 'buyoutPercent'
  | 'cancelCount'
  | 'stockQty'
  | 'stockInWayTo'
  | 'stockInWayFrom'
  | 'stockMoneyRub'
  | 'turnoverDays'
  | 'advSpendRub'
  | 'advManualSpendRub'
  | 'advManualDrrPercent'
  | 'advUnifiedSpendRub'
  | 'advUnifiedDrrPercent'
  | 'payoutRub'
  | 'commissionRub'
  | 'logisticsRub'
  | 'returnsCount'
  | 'marginRub'
  | 'marginPercent'
  | 'roiPercent'
  | 'netProfitRub';

interface PulseFiltersState {
  /* ── filter values ── */
  periodDays: PeriodPreset;
  drrBase: 'sales' | 'payout';
  groupBy: 'day' | 'week';
  anomalies: 'on' | 'off';
  anomalyThresholdPct: number;
  tagId: number | null;
  filterVendorCode: string;
  filterBrandName: string;
  filterSubjectName: string;
  filterSubjectId: string;
  filterNmIds: string;
  productsMetric: ProductsMetricKey;

  /* ── enabled metrics for heatmap columns ── */
  enabledMetrics: string[];

  /* ── table UX ── */
  tableView: 'products' | 'metrics';
  tableHeatmap: boolean;
  tableHeatmapMode: 'row' | 'global';
  tableHeatmapIntensity: 'soft' | 'medium' | 'strong';
  tableNumberFormat: 'full' | 'short';
  tableShowUnits: boolean;
  tableDense: boolean;

  /* ── active preset ── */
  presetId: number | null;
  lastSavedPresetConfig: string;

  /* ── setters ── */
  setPeriodDays: (v: PeriodPreset) => void;
  setDrrBase: (v: 'sales' | 'payout') => void;
  setGroupBy: (v: 'day' | 'week') => void;
  setAnomalies: (v: 'on' | 'off') => void;
  setAnomalyThresholdPct: (v: number) => void;
  setTagId: (v: number | null) => void;
  setFilterVendorCode: (v: string) => void;
  setFilterBrandName: (v: string) => void;
  setFilterSubjectName: (v: string) => void;
  setFilterSubjectId: (v: string) => void;
  setFilterNmIds: (v: string) => void;
  setProductsMetric: (v: ProductsMetricKey) => void;
  setEnabledMetrics: (v: string[]) => void;
  setTableView: (v: 'products' | 'metrics') => void;
  setTableHeatmap: (v: boolean) => void;
  setTableHeatmapMode: (v: 'row' | 'global') => void;
  setTableHeatmapIntensity: (v: 'soft' | 'medium' | 'strong') => void;
  setTableNumberFormat: (v: 'full' | 'short') => void;
  setTableShowUnits: (v: boolean) => void;
  setTableDense: (v: boolean) => void;
  setPresetId: (v: number | null) => void;
  setLastSavedPresetConfig: (v: string) => void;

  /** Apply a full config snapshot from a preset */
  applyPresetConfig: (cfg: any) => void;

  /** Build current filter state as a PulseFilters object (needs workspaceId) */
  toPulseFilters: (workspaceId: number) => PulseFilters;
}

const DEFAULT_ENABLED = [
  'orders_count',
  'orders_rub',
  'sales_rub',
  'adv_spend_rub',
  'drr_percent',
  'margin_rub',
  'net_profit_rub',
];

export const usePulseFiltersStore = create<PulseFiltersState>((set, get) => ({
  /* ── defaults ── */
  periodDays: 30,
  drrBase: 'sales',
  // 2026-06-01: дефолт «день» по запросу оператора — это естественный гранулят
  // для оперативки. «Неделя» доступна через тумблер.
  groupBy: 'day',
  anomalies: 'on',
  anomalyThresholdPct: 20,
  tagId: null,
  filterVendorCode: '',
  filterBrandName: '',
  filterSubjectName: '',
  filterSubjectId: '',
  filterNmIds: '',
  productsMetric: 'salesRub',
  enabledMetrics: DEFAULT_ENABLED,
  tableView: 'products',
  tableHeatmap: false,
  tableHeatmapMode: 'row',
  tableHeatmapIntensity: 'medium',
  tableNumberFormat: 'full',
  tableShowUnits: false,
  tableDense: true,
  presetId: null,
  lastSavedPresetConfig: '',

  /* ── setters ── */
  setPeriodDays: (v) => set({ periodDays: v }),
  setDrrBase: (v) => set({ drrBase: v }),
  setGroupBy: (v) => set({ groupBy: v }),
  setAnomalies: (v) => set({ anomalies: v }),
  setAnomalyThresholdPct: (v) => set({ anomalyThresholdPct: v }),
  setTagId: (v) => set({ tagId: v }),
  setFilterVendorCode: (v) => set({ filterVendorCode: v }),
  setFilterBrandName: (v) => set({ filterBrandName: v }),
  setFilterSubjectName: (v) => set({ filterSubjectName: v }),
  setFilterSubjectId: (v) => set({ filterSubjectId: v }),
  setFilterNmIds: (v) => set({ filterNmIds: v }),
  setProductsMetric: (v) => set({ productsMetric: v }),
  setEnabledMetrics: (v) => set({ enabledMetrics: v }),
  setTableView: (v) => set({ tableView: v }),
  setTableHeatmap: (v) => set({ tableHeatmap: v }),
  setTableHeatmapMode: (v) => set({ tableHeatmapMode: v }),
  setTableHeatmapIntensity: (v) => set({ tableHeatmapIntensity: v }),
  setTableNumberFormat: (v) => set({ tableNumberFormat: v }),
  setTableShowUnits: (v) => set({ tableShowUnits: v }),
  setTableDense: (v) => set({ tableDense: v }),
  setPresetId: (v) => set({ presetId: v }),
  setLastSavedPresetConfig: (v) => set({ lastSavedPresetConfig: v }),

  applyPresetConfig: (cfg: any) => {
    if (!cfg || typeof cfg !== 'object') return;
    set((s) => ({
      periodDays: cfg.periodDays ?? s.periodDays,
      drrBase: cfg.drrBase ?? s.drrBase,
      groupBy: cfg.groupBy ?? s.groupBy,
      anomalies: cfg.anomalies ?? s.anomalies,
      anomalyThresholdPct: cfg.anomalyThresholdPct ?? s.anomalyThresholdPct,
      tagId: cfg.tagId ?? s.tagId,
      filterVendorCode: cfg.filterVendorCode ?? s.filterVendorCode,
      filterBrandName: cfg.filterBrandName ?? s.filterBrandName,
      filterSubjectName: cfg.filterSubjectName ?? s.filterSubjectName,
      filterSubjectId: cfg.filterSubjectId ?? s.filterSubjectId,
      filterNmIds: cfg.filterNmIds ?? s.filterNmIds,
      productsMetric: cfg.productsMetric ?? s.productsMetric,
      enabledMetrics: cfg.enabledMetrics ?? s.enabledMetrics,
      tableView: cfg.tableView ?? s.tableView,
      tableHeatmap: cfg.tableHeatmap ?? s.tableHeatmap,
      tableHeatmapMode: cfg.tableHeatmapMode ?? s.tableHeatmapMode,
      tableHeatmapIntensity: cfg.tableHeatmapIntensity ?? s.tableHeatmapIntensity,
      tableNumberFormat: cfg.tableNumberFormat ?? s.tableNumberFormat,
      tableShowUnits: cfg.tableShowUnits ?? s.tableShowUnits,
      tableDense: cfg.tableDense ?? s.tableDense,
    }));
  },

  toPulseFilters: (workspaceId: number): PulseFilters => {
    const s = get();
    return {
      workspaceId,
      periodDays: s.periodDays,
      drrBase: s.drrBase,
      groupBy: s.groupBy,
      anomalies: s.anomalies,
      anomalyThresholdPct: s.anomalyThresholdPct,
      tagId: s.tagId,
      filterVendorCode: s.filterVendorCode,
      filterBrandName: s.filterBrandName,
      filterSubjectName: s.filterSubjectName,
      filterSubjectId: s.filterSubjectId,
      filterNmIds: s.filterNmIds,
      productsMetric: s.productsMetric,
    };
  },
}));
