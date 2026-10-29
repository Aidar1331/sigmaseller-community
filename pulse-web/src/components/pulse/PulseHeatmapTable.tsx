'use client';

import { formatNumber, formatNumberShort, formatPct, formatRub, formatRubShort } from '@/lib/format';
import { formatDateShort, formatWeekRange } from '@/lib/format';
import { METRIC_MAP } from '@/lib/metricMap';
import type { Overview } from '@/types/pulse';
import { MetricRow } from './MetricRow';
import { Card } from '@/components/ui/Card';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/ToggleGroup';
import { Switch } from '@/components/ui/Switch';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import { Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useState, useCallback, useEffect, useMemo } from 'react';
import { apiFetch } from '@/lib/api';

export type PulseHeatmapTableProps = {
  overview: Overview | null;
  loading: boolean;
  enabledMetrics: string[];
  groupBy: 'day' | 'week';
  onGroupByChange: (v: 'day' | 'week') => void;

  // Table UX
  tableView: 'products' | 'metrics';
  tableHeatmap: boolean;
  tableHeatmapMode: 'row' | 'global';
  tableHeatmapIntensity: 'soft' | 'medium' | 'strong';
  tableHeatmapGlobal: { min: number; max: number };
  tableNumberFormat: 'full' | 'short';
  tableShowUnits: boolean;
  tableDense: boolean;
  productsMetric: string;
  anomalies: 'on' | 'off';

  // Products matrix
  productsMatrix: null | {
    dateKeys: string[];
    metric: string;
    rows: Array<{
      nmId: number;
      title: string | null;
      vendorCode: string | null;
      brandName: string | null;
      mainPhotoUrl: string | null;
      values: number[];
      anomalies: Array<{ low?: boolean; high?: boolean; pctDiff?: number; baseline?: number }>;
    }>;
  };

  // Events
  eventsNmId: string;
  eventCountsByDate: Record<string, { alerts: number; logs: number; tasks: number }>;
  selectedCell: null | { date: string; nmId: number };

  // Table UX callbacks
  onSetTableView: (v: 'products' | 'metrics') => void;
  onSetTableHeatmap: (v: boolean) => void;
  onSetTableHeatmapMode: (v: 'row' | 'global') => void;
  onSetTableHeatmapIntensity: (v: 'soft' | 'medium' | 'strong') => void;
  onSetTableNumberFormat: (v: 'full' | 'short') => void;
  onSetTableShowUnits: (v: boolean) => void;
  onSetTableDense: (v: boolean) => void;
  onSetProductsMetric: (v: string) => void;

  // Drilldown
  workspaceId: number;
  dateFrom: string;
  dateTo: string;
  enabledDrilldownMetrics: string[];

  // Events callbacks
  onSelectCell: (cell: { date: string; nmId: number }) => void;
  onLoadTimeline: (date: string, nmId: number) => void;
  onHoverDate: (date: string, x: number, y: number) => Promise<void>;
  onLeaveHover: () => void;
  onContextMenu: (date: string, x: number, y: number) => void;
};

/* ─── Display labels for Russian UI (state values unchanged) ─── */
const VIEW_LABELS: Record<string, string> = { products: 'Товары', metrics: 'Сводная' };

const INTENSITY_LABELS: Record<string, string> = { soft: 'Мягко', medium: 'Средне', strong: 'Ярко' };
const FORMAT_LABELS: Record<string, string> = { full: 'Полный', short: 'Кратко' };

export function PulseHeatmapTable(props: PulseHeatmapTableProps) {
  const {
    overview,
    loading,
    enabledMetrics,
    groupBy,
    onGroupByChange,
    tableView,
    tableHeatmap,
    tableHeatmapMode,
    tableHeatmapIntensity,
    tableHeatmapGlobal,
    tableNumberFormat,
    tableShowUnits,
    tableDense,
    productsMetric,
    anomalies,
    productsMatrix,
    eventsNmId,
    eventCountsByDate,
    selectedCell,
    onSetTableView,
    onSetTableHeatmap,
    onSetTableHeatmapMode,
    onSetTableHeatmapIntensity,
    onSetTableNumberFormat,
    onSetTableShowUnits,
    onSetTableDense,
    onSetProductsMetric,
    onSelectCell,
    onLoadTimeline,
    onHoverDate,
    onLeaveHover,
    onContextMenu,
  } = props;

  const { workspaceId, dateFrom, dateTo, enabledDrilldownMetrics } = props;

  const nmId = Number.parseInt(eventsNmId.trim(), 10);
  const parsedNmId = Number.isFinite(nmId) && nmId > 0 ? nmId : 0;
  const eventsEnabled = true; // always allow date clicks for events

  return (
    <Card className="mt-6 p-0 overflow-hidden">
      {/* ─── Toolbar ─── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--card-border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--content-text)]">Таблица</span>
          <ToggleGroup type="single" value={groupBy} onValueChange={(v) => v && onGroupByChange(v as 'day' | 'week')}>
            <ToggleGroupItem value="day" className="h-7 text-[11px] px-2.5">День</ToggleGroupItem>
            <ToggleGroupItem value="week" className="h-7 text-[11px] px-2.5">Неделя</ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* View: products / metrics */}
          <ToggleGroup
            type="single"
            value={tableView}
            onValueChange={(v) => v && onSetTableView(v as 'products' | 'metrics')}
          >
            {(['products', 'metrics'] as const).map((v) => (
              <ToggleGroupItem key={v} value={v}>
                {VIEW_LABELS[v]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          {/* Heatmap toggle + settings */}
          <div className="flex items-center gap-1">
            <Switch
              label="Теплокарта"
              checked={tableHeatmap}
              onCheckedChange={onSetTableHeatmap}
            />
            <span className="cursor-help text-[10px] text-[var(--content-muted)]" title="По строке: цвета нормализованы в пределах каждой метрики. По таблице: единая шкала для всех">?</span>
          </div>

          {tableHeatmap && (
            <ToggleGroup
              type="single"
              value={tableHeatmapIntensity}
              onValueChange={(v) => v && onSetTableHeatmapIntensity(v as 'soft' | 'medium' | 'strong')}
            >
              {(['soft', 'medium', 'strong'] as const).map((v) => (
                <ToggleGroupItem key={v} value={v}>
                  {INTENSITY_LABELS[v]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}

          {/* Number format */}
          <ToggleGroup
            type="single"
            value={tableNumberFormat}
            onValueChange={(v) => v && onSetTableNumberFormat(v as 'full' | 'short')}
          >
            {(['full', 'short'] as const).map((v) => (
              <ToggleGroupItem key={v} value={v}>
                {FORMAT_LABELS[v]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <Switch
            label="Единицы"
            checked={tableShowUnits}
            onCheckedChange={onSetTableShowUnits}
          />
        </div>
      </div>

      {/* ─── Table container ─── */}
      <div className="max-h-[70vh] overflow-auto overscroll-contain [touch-action:pan-x_pan-y] [-webkit-overflow-scrolling:touch]">
        {tableView === 'metrics' ? (
          <MetricsTable
            overview={overview}
            loading={loading}
            enabledMetrics={enabledMetrics}
            groupBy={groupBy}
            tableHeatmap={tableHeatmap}
            tableHeatmapMode={tableHeatmapMode}
            tableHeatmapIntensity={tableHeatmapIntensity}
            tableHeatmapGlobal={tableHeatmapGlobal}
            tableNumberFormat={tableNumberFormat}
            tableShowUnits={tableShowUnits}
            tableDense={tableDense}
            anomalies={anomalies}
            eventsEnabled={eventsEnabled}
            eventsNmId={parsedNmId}
            eventCountsByDate={eventCountsByDate}
            selectedCell={selectedCell}
            onSelectCell={onSelectCell}
            onLoadTimeline={onLoadTimeline}
            onHoverDate={onHoverDate}
            onLeaveHover={onLeaveHover}
            onContextMenu={onContextMenu}
          />
        ) : (
          <ProductsTable
            overview={overview}
            loading={loading}
            productsMatrix={productsMatrix}
            productsMetric={productsMetric}
            tableHeatmap={tableHeatmap}
            tableHeatmapIntensity={tableHeatmapIntensity}
            tableNumberFormat={tableNumberFormat}
            tableShowUnits={tableShowUnits}
            tableDense={tableDense}
            anomalies={anomalies}
            workspaceId={workspaceId}
            groupBy={groupBy}
            dateFrom={dateFrom}
            dateTo={dateTo}
            enabledDrilldownMetrics={enabledDrilldownMetrics}
            eventsEnabled={eventsEnabled}
            eventsNmId={parsedNmId}
            eventCountsByDate={eventCountsByDate}
            selectedCell={selectedCell}
            onSelectCell={onSelectCell}
            onLoadTimeline={onLoadTimeline}
          />
        )}
      </div>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Metrics Table (inner)
   ═══════════════════════════════════════════════════════════════════ */

function MetricsTable({
  overview,
  loading,
  enabledMetrics,
  groupBy,
  tableHeatmap,
  tableHeatmapMode,
  tableHeatmapIntensity,
  tableHeatmapGlobal,
  tableNumberFormat,
  tableShowUnits,
  tableDense,
  anomalies,
  eventsEnabled,
  eventsNmId,
  eventCountsByDate,
  selectedCell,
  onSelectCell,
  onLoadTimeline,
  onHoverDate,
  onLeaveHover,
  onContextMenu,
}: {
  overview: Overview | null;
  loading: boolean;
  enabledMetrics: string[];
  groupBy: 'day' | 'week';
  tableHeatmap: boolean;
  tableHeatmapMode: 'row' | 'global';
  tableHeatmapIntensity: 'soft' | 'medium' | 'strong';
  tableHeatmapGlobal: { min: number; max: number };
  tableNumberFormat: 'full' | 'short';
  tableShowUnits: boolean;
  tableDense: boolean;
  anomalies: 'on' | 'off';
  eventsEnabled: boolean;
  eventsNmId: number;
  eventCountsByDate: Record<string, { alerts: number; logs: number; tasks: number }>;
  selectedCell: null | { date: string; nmId: number };
  onSelectCell: (cell: { date: string; nmId: number }) => void;
  onLoadTimeline: (date: string, nmId: number) => void;
  onHoverDate: (date: string, x: number, y: number) => Promise<void>;
  onLeaveHover: () => void;
  onContextMenu: (date: string, x: number, y: number) => void;
}) {
  return (
    <table className="min-w-[900px] sm:min-w-full border-separate border-spacing-0 text-[13px]">
      <thead className="sticky top-0 z-30">
        <tr className="bg-[var(--table-header-bg)]">
          <th className="sticky left-0 top-0 z-40 w-[180px] bg-slate-50 border-b border-r border-[var(--table-border)] shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)] px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-[var(--content-muted)]">
            Метрика
          </th>
          {overview?.series?.map((c) => {
            const isSelected = selectedCell?.date === c.key;
            return (
              <th
                key={c.key}
                className={cn(
                  'border-b border-[var(--table-border)] px-3 py-2.5 text-left text-xs font-medium text-[var(--content-muted)]',
                  eventsEnabled && 'cursor-pointer hover:bg-slate-50',
                  isSelected && 'bg-indigo-50'
                )}
                onClick={() => {
                  if (!eventsEnabled) return;
                  onSelectCell({ date: c.key, nmId: eventsNmId });
                  onLoadTimeline(c.key, eventsNmId);
                }}
                title={eventsEnabled ? 'Клик: события' : undefined}
              >
                <div className="text-center leading-tight">
                  {groupBy === 'week' ? (
                    <div className="text-[10px] font-mono tabular-nums">{formatWeekRange(c.key)}</div>
                  ) : (
                    <>
                      <div className="text-[11px] font-mono tabular-nums">{formatDateShort(c.key).date}</div>
                      <div className="text-[9px] text-[var(--content-muted)] uppercase font-medium">{formatDateShort(c.key).dow}</div>
                    </>
                  )}
                </div>
              </th>
            );
          })}
        </tr>
        <tr className="bg-[var(--table-header-bg)]">
          <th className="sticky left-0 top-0 z-40 w-[180px] bg-slate-50 border-b border-r border-[var(--table-border)] shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)] px-3 py-2.5 text-left text-xs font-medium text-[var(--content-muted)]">События</th>
          {overview?.series?.map((c) => {
            const cnt = eventCountsByDate[c.key];
            const total = (cnt?.alerts ?? 0) + (cnt?.logs ?? 0) + (cnt?.tasks ?? 0);
            return (
              <th
                key={`ev-${c.key}`}
                className={cn(
                  'border-b border-[var(--table-border)] px-3 py-2.5 text-center text-xs font-medium text-[var(--content-muted)]',
                  eventsEnabled && 'cursor-pointer hover:bg-slate-50',
                  selectedCell?.date === c.key && 'bg-indigo-50'
                )}
                onClick={() => {
                  if (!eventsEnabled) return;
                  onSelectCell({ date: c.key, nmId: eventsNmId });
                  onLoadTimeline(c.key, eventsNmId);
                }}
                title={total ? `${cnt?.tasks ?? 0} задач, ${cnt?.alerts ?? 0} алертов, ${cnt?.logs ?? 0} логов` : 'Клик: добавить событие'}
              >
                {total ? (
                  <span className="text-amber-700 font-medium">{total}</span>
                ) : (
                  <span className="text-[var(--content-muted)]">—</span>
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {loading ? (
          <SkeletonRows cols={(overview?.series?.length ?? 0) + 1} />
        ) : overview ? (
          <>
            {enabledMetrics
              .filter((id) => id in METRIC_MAP)
              .map((id) => {
                const m = METRIC_MAP[id]!;
                const series = overview.series.map((s) => (s[m.seriesKey] ?? 0) as number);
                return (
                  <MetricRow
                    key={id}
                    title={m.title}
                    helpText={m.description ?? m.helpText}
                    unit={m.unitLabel ?? ''}
                    table={{
                      heatmap: tableHeatmap,
                      heatmapMode: tableHeatmapMode,
                      heatmapIntensity: tableHeatmapIntensity,
                      heatmapGlobal: tableHeatmapGlobal,
                      numberFormat: tableNumberFormat,
                      showUnits: tableShowUnits,
                      dense: tableDense,
                      anomaliesEnabled: anomalies === 'on',
                    }}
                    format={m.format}
                    series={series}
                    seriesKeys={overview.series.map((s) => s.key)}
                    anomaliesByKey={overview.anomalies.byKey}
                    anomalyMetricName={m.anomalyName}
                    events={{
                      enabled: eventsEnabled,
                      nmId: eventsNmId,
                      selectedDate: selectedCell?.date ?? null,
                      eventCountsByDate: eventCountsByDate,
                      onSelectDate: (date) => {
                        if (!eventsEnabled) return;
                        onSelectCell({ date, nmId: eventsNmId });
                        onLoadTimeline(date, eventsNmId);
                      },
                      onHoverDate: async (date, x, y) => {
                        if (!eventsEnabled) return;
                        await onHoverDate(date, x, y);
                      },
                      onLeaveHover: onLeaveHover,
                      onContextMenu: (date, x, y) => {
                        if (!eventsEnabled) return;
                        onContextMenu(date, x, y);
                      },
                    }}
                  />
                );
              })}
          </>
        ) : (
          <tr>
            <td className="sticky left-0 z-20 bg-white border-r border-[var(--table-border)] shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)] px-4 py-8 text-sm text-[var(--content-muted)]">
              Нет данных
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Products Table (inner)
   ═══════════════════════════════════════════════════════════════════ */

function ProductsTable({
  overview,
  loading,
  productsMatrix,
  productsMetric,
  tableHeatmap,
  tableHeatmapIntensity,
  tableNumberFormat,
  tableShowUnits,
  tableDense,
  anomalies,
  workspaceId,
  groupBy,
  dateFrom,
  dateTo,
  enabledDrilldownMetrics,
  eventsEnabled,
  eventsNmId,
  eventCountsByDate,
  selectedCell,
  onSelectCell,
  onLoadTimeline,
}: {
  overview: Overview | null;
  loading: boolean;
  productsMatrix: PulseHeatmapTableProps['productsMatrix'];
  productsMetric: string;
  tableHeatmap: boolean;
  tableHeatmapIntensity: 'soft' | 'medium' | 'strong';
  tableNumberFormat: 'full' | 'short';
  tableShowUnits: boolean;
  tableDense: boolean;
  anomalies: 'on' | 'off';
  workspaceId: number;
  groupBy: 'day' | 'week';
  dateFrom: string;
  dateTo: string;
  enabledDrilldownMetrics: string[];
  eventsEnabled: boolean;
  eventsNmId: number;
  eventCountsByDate: Record<string, { alerts: number; logs: number; tasks: number }>;
  selectedCell: null | { date: string; nmId: number };
  onSelectCell: (cell: { date: string; nmId: number }) => void;
  onLoadTimeline: (date: string, nmId: number) => void;
}) {
  const [expandedNmId, setExpandedNmId] = useState<number | null>(null);
  const [drilldownData, setDrilldownData] = useState<Record<string, number[]>>({});
  const [drilldownLoading, setDrilldownLoading] = useState(false);

  const selectedNmId = selectedCell?.nmId ?? (eventsNmId > 0 ? eventsNmId : 0);

  // Build drilldown metrics from enabledDrilldownMetrics (via METRIC_MAP)
  // Exclude the primary productsMetric (shown in main row)
  const DRILLDOWN_METRICS = useMemo(() => {
    return enabledDrilldownMetrics
      .filter((id) => id in METRIC_MAP)
      .map((id) => {
        const m = METRIC_MAP[id]!;
        return { key: m.seriesKey, label: m.title, format: m.format as 'int' | 'rub' | 'pct' };
      })
      .filter((m) => m.key !== productsMetric);
  }, [enabledDrilldownMetrics, productsMetric]);

  const loadDrilldown = useCallback(async (nmId: number) => {
    setDrilldownLoading(true);
    setDrilldownData({});
    try {
      if (!DRILLDOWN_METRICS.length) {
        setDrilldownData({});
        return;
      }
      // Все метрики параллельно: запросы быстрые, drilldown — точечный (1 nmId)
      const batchSize = DRILLDOWN_METRICS.length;
      const data: Record<string, number[]> = {};
      const fetchMetric = async (m: { key: string }) => {
        let lastErr: any = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const res = (await apiFetch(
              `/pulse/${workspaceId}/products/matrix?from=${dateFrom}&to=${dateTo}&groupBy=${groupBy}&metric=${m.key}&nmIds=${nmId}&limit=1`
            )) as any;
            const row = res?.rows?.[0];
            return { key: m.key, values: row?.values ?? [] };
          } catch (err) {
            lastErr = err;
            await new Promise((r) => setTimeout(r, 200 * attempt));
          }
        }
        if (lastErr) throw lastErr;
        return { key: m.key, values: [] };
      };

      for (let i = 0; i < DRILLDOWN_METRICS.length; i += batchSize) {
        const batch = DRILLDOWN_METRICS.slice(i, i + batchSize);
        const results = await Promise.allSettled(batch.map(fetchMetric));
        for (const r of results) {
          if (r.status === 'fulfilled') data[r.value.key] = r.value.values;
        }
      }
      setDrilldownData(data);
    } catch (e) {
      console.error('Failed to load drilldown data:', e);
      setDrilldownData({});
    } finally {
      setDrilldownLoading(false);
    }
  }, [workspaceId, dateFrom, dateTo, groupBy, DRILLDOWN_METRICS]);

  const toggleDrilldown = useCallback((nmId: number) => {
    if (expandedNmId === nmId) {
      setExpandedNmId(null);
      return;
    }
    setExpandedNmId(nmId);
  }, [expandedNmId]);

  useEffect(() => {
    if (expandedNmId == null) return;
    loadDrilldown(expandedNmId);
  }, [expandedNmId, loadDrilldown, DRILLDOWN_METRICS]);
  return (
    <table className="min-w-[900px] sm:min-w-full border-separate border-spacing-0 text-[13px]">
      <thead className="sticky top-0 z-30">
        <tr className="bg-[var(--table-header-bg)]">
          <th className="sticky left-0 top-0 z-40 w-[160px] max-w-[160px] md:w-[260px] md:max-w-[260px] bg-slate-50 border-b border-r border-[var(--table-border)] shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)] px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-[var(--content-muted)]">
            Товар
          </th>
          {(productsMatrix?.dateKeys ?? overview?.series?.map((s) => s.key) ?? []).map((k) => {
            const isSelected = selectedCell?.date === k;
            return (
              <th
                key={k}
                className={cn(
                  'border-b border-[var(--table-border)] px-3 py-2.5 text-left text-xs font-medium text-[var(--content-muted)] cursor-pointer hover:bg-slate-50',
                  isSelected && 'bg-indigo-50'
                )}
                onClick={() => {
                  if (!eventsEnabled || !selectedNmId) return;
                  onSelectCell({ date: k, nmId: selectedNmId });
                  onLoadTimeline(k, selectedNmId);
                }}
                title={eventsEnabled ? 'Клик: события' : undefined}
              >
                <div className="text-center leading-tight">
                  {groupBy === 'week' ? (
                    <div className="text-[10px] font-mono tabular-nums">{formatWeekRange(k)}</div>
                  ) : (
                    <>
                      <div className="text-[11px] font-mono tabular-nums">{formatDateShort(k).date}</div>
                      <div className="text-[9px] text-[var(--content-muted)] uppercase font-medium">{formatDateShort(k).dow}</div>
                    </>
                  )}
                </div>
              </th>
            );
          })}
        </tr>
        <tr className="bg-[var(--table-header-bg)]">
          <th className="sticky left-0 top-0 z-40 w-[160px] max-w-[160px] md:w-[260px] md:max-w-[260px] bg-slate-50 border-b border-r border-[var(--table-border)] shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)] px-3 py-2.5 text-left text-xs font-medium text-[var(--content-muted)]">События</th>
          {(productsMatrix?.dateKeys ?? overview?.series?.map((s) => s.key) ?? []).map((k) => {
            const cnt = eventCountsByDate[k];
            const total = (cnt?.alerts ?? 0) + (cnt?.logs ?? 0) + (cnt?.tasks ?? 0);
            const isSelected = selectedCell?.date === k;
            return (
              <th
                key={`ev-${k}`}
                className={cn(
                  'border-b border-[var(--table-border)] px-3 py-2.5 text-center text-xs font-medium text-[var(--content-muted)]',
                  eventsEnabled && 'cursor-pointer hover:bg-slate-50',
                  isSelected && 'bg-indigo-50'
                )}
                onClick={() => {
                  if (!eventsEnabled) return;
                  onSelectCell({ date: k, nmId: selectedNmId });
                  onLoadTimeline(k, selectedNmId);
                }}
                title={total ? `${cnt?.tasks ?? 0} задач, ${cnt?.alerts ?? 0} алертов, ${cnt?.logs ?? 0} логов` : 'Клик: добавить событие'}
              >
                {total ? (
                  <span className="text-amber-700 font-medium">{total}</span>
                ) : (
                  <span className="text-[var(--content-muted)]">—</span>
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {loading ? (
          <SkeletonRows cols={(productsMatrix?.dateKeys?.length ?? overview?.series?.length ?? 0) + 1} />
        ) : productsMatrix && productsMatrix.rows.length ? (
          // H8 (interim): cap heatmap render at 200 rows. Each row is ~30
          // child cells × heatmap calc + ProductRowGroup re-renders, so a
          // 1000-row matrix freezes the tab during sort/scroll. Proper
          // virtualization needs table-row absolute positioning + drilldown
          // height tracking — bigger task. Until then we hard-cap and show
          // a banner, so the user knows to use filters/search.
          (() => {
            const MAX_RENDER = 200;
            const total = productsMatrix.rows.length;
            const truncated = total > MAX_RENDER;
            const renderRows = truncated ? productsMatrix.rows.slice(0, MAX_RENDER) : productsMatrix.rows;
            const colCount = (productsMatrix.dateKeys?.length ?? 0) + 1;
            return (
              <>
                {truncated && (
                  <tr>
                    <td
                      colSpan={colCount}
                      className="bg-amber-50 border-b border-amber-200 px-3 py-2 text-xs text-amber-900"
                    >
                      ⚠ Показаны первые {MAX_RENDER} из {total.toLocaleString('ru-RU')} товаров — сузь период или используй фильтры, чтобы увидеть остальные.
                    </td>
                  </tr>
                )}
                {renderRows.map((r) => {
                  const values = r.values ?? [];
                  const anomaliesArr = r.anomalies ?? [];
                  const nums = values.filter((x) => typeof x === 'number' && Number.isFinite(x)) as number[];
                  const min = nums.length ? Math.min(...nums) : 0;
                  const max = nums.length ? Math.max(...nums) : 1;
                  const span = max - min || 1;
                  const isExpanded = expandedNmId === r.nmId;

                  return (
                    <ProductRowGroup
                      key={r.nmId}
                      r={r}
                      values={values}
                      anomaliesArr={anomaliesArr}
                      min={min}
                      span={span}
                      isExpanded={isExpanded}
                      dateKeys={productsMatrix?.dateKeys ?? []}
                      productsMetric={productsMetric}
                      tableHeatmap={tableHeatmap}
                      tableHeatmapIntensity={tableHeatmapIntensity}
                      tableNumberFormat={tableNumberFormat}
                      tableShowUnits={tableShowUnits}
                      tableDense={tableDense}
                      anomalies={anomalies}
                      drilldownMetrics={DRILLDOWN_METRICS}
                      drilldownData={drilldownData}
                      drilldownLoading={drilldownLoading}
                      selectedDate={selectedCell?.date ?? null}
                      selectedNmId={selectedNmId}
                      eventsEnabled={eventsEnabled}
                      onSelectCell={onSelectCell}
                      onLoadTimeline={onLoadTimeline}
                      onToggle={() => toggleDrilldown(r.nmId)}
                    />
                  );
                })}
              </>
            );
          })()
        ) : (
          <tr>
            <td className="px-4 py-8 text-sm text-[var(--content-muted)]" colSpan={1}>
              Нет данных
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Product Row with drilldown
   ═══════════════════════════════════════════════════════════════════ */

function ProductRowGroup({
  r,
  values,
  anomaliesArr,
  min,
  span,
  isExpanded,
  dateKeys,
  productsMetric,
  tableHeatmap,
  tableHeatmapIntensity,
  tableNumberFormat,
  tableShowUnits,
  tableDense,
  anomalies,
  drilldownMetrics,
  drilldownData,
  drilldownLoading,
  selectedDate,
  selectedNmId,
  eventsEnabled,
  onSelectCell,
  onLoadTimeline,
  onToggle,
}: {
  r: { nmId: number; title: string | null; vendorCode: string | null; brandName: string | null; mainPhotoUrl: string | null };
  values: number[];
  anomaliesArr: Array<{ low?: boolean; high?: boolean; pctDiff?: number; baseline?: number }>;
  min: number;
  span: number;
  isExpanded: boolean;
  dateKeys: string[];
  productsMetric: string;
  tableHeatmap: boolean;
  tableHeatmapIntensity: 'soft' | 'medium' | 'strong';
  tableNumberFormat: 'full' | 'short';
  tableShowUnits: boolean;
  tableDense: boolean;
  anomalies: 'on' | 'off';
  drilldownMetrics: Array<{ key: string; label: string; format: 'int' | 'rub' | 'pct' }>;
  drilldownData: Record<string, number[]>;
  drilldownLoading: boolean;
  selectedDate: string | null;
  selectedNmId: number | null;
  eventsEnabled: boolean;
  onSelectCell: (cell: { date: string; nmId: number }) => void;
  onLoadTimeline: (date: string, nmId: number) => void;
  onToggle: () => void;
}) {
  const isRub = productsMetric.endsWith('Rub');
  const isPct = productsMetric.endsWith('Percent') || productsMetric.endsWith('Pct');

  function fmtValue(v: number, metric: string, withUnits?: boolean): string {
    const mIsRub = metric.endsWith('Rub');
    const mIsPct = metric.endsWith('Percent') || metric.endsWith('Pct');
    let out: string;
    if (mIsRub) out = tableNumberFormat === 'short' ? formatRubShort(v) : formatRub(v);
    else if (mIsPct) out = formatPct(v);
    else out = tableNumberFormat === 'short' ? formatNumberShort(v) : formatNumber(v);
    if (withUnits || tableShowUnits) {
      const unit = mIsRub ? ' \u20BD' : mIsPct ? '%' : metric === 'turnoverDays' ? ' дн' : ' шт';
      if (!mIsPct) out = out + unit; // % already in formatPct
    }
    return out;
  }

  return (
    <>
      {/* Main product row */}
      <tr className={cn('group transition-colors hover:bg-[var(--table-row-hover)]', isExpanded && 'bg-slate-50/50')}>
        {/* Product info cell — sticky */}
        <td
          className={cn(
            'sticky left-0 z-20 w-[160px] max-w-[160px] md:w-[260px] md:max-w-[260px] bg-white text-xs text-[var(--content-text)] border-b border-r border-[var(--table-border)] shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)] cursor-pointer',
            'group-hover:bg-gray-50',
            tableDense ? 'px-2 py-1.5' : 'px-3 py-2.5',
            isExpanded && 'bg-slate-50'
          )}
          onClick={onToggle}
        >
          <div className="flex items-center gap-2">
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--content-muted)]" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--content-muted)]" />
            )}
            {r.mainPhotoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={r.mainPhotoUrl} alt="" className="h-10 w-10 rounded-lg bg-slate-100 object-cover" />
            ) : (
              <div className="h-10 w-10 rounded-lg bg-slate-100 flex items-center justify-center">
                <span className="text-[9px] text-slate-400">нет фото</span>
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold text-[var(--content-text)]">
                {r.title ?? `Товар ${r.nmId}`}
              </div>
              <div className="flex items-center font-mono text-[10px] text-[var(--content-muted)]">
                <NmIdLink nmId={r.nmId} className="text-blue-600 hover:underline">{r.vendorCode ? `арт. ${r.vendorCode}` : `WB ${r.nmId}`}</NmIdLink>
                <CopyNmIdButton nmId={r.nmId} />
              </div>
            </div>
          </div>
        </td>
        {/* Value cells */}
        {values.map((v, idx) => {
          const a = anomalies === 'on' ? anomaliesArr[idx] : null;
          const heatBg = tableHeatmap ? getHeatmapBg(v, min, span, tableHeatmapIntensity) : undefined;
          const ring = a?.high
            ? 'border-2 border-emerald-400 rounded-lg bg-gradient-to-br from-emerald-50/80 to-emerald-100/50'
            : a?.low
              ? 'border-2 border-red-400 rounded-lg bg-gradient-to-br from-red-50/80 to-red-100/50'
              : '';
          const isDateSelected = !!(selectedDate && selectedNmId === r.nmId && dateKeys[idx] === selectedDate);

          const out = fmtValue(v, productsMetric);

          return (
            <td
              key={idx}
              style={heatBg ? { backgroundColor: heatBg } : undefined}
              className={cn(
                'whitespace-nowrap border-b border-[var(--table-border)] text-right font-mono text-xs tabular-nums text-[var(--content-text)]',
                eventsEnabled && 'cursor-pointer hover:bg-indigo-50/40',
                ring,
                isDateSelected && 'ring-2 ring-inset ring-indigo-300 bg-indigo-50/50',
                tableDense ? 'px-2 py-1.5' : 'px-3 py-2.5'
              )}
              onClick={() => {
                if (!eventsEnabled) return;
                const date = dateKeys[idx];
                if (!date) return;
                onSelectCell({ date, nmId: r.nmId });
                onLoadTimeline(date, r.nmId);
              }}
              title={
                a?.high
                  ? `\u0420\u043e\u0441\u0442: +${a.pctDiff ?? '?'}% \u043e\u0442 \u0441\u0440\u0435\u0434\u043d\u0435\u0433\u043e (${a.baseline ?? '\u2014'})`
                  : a?.low
                    ? `\u0421\u043d\u0438\u0436\u0435\u043d\u0438\u0435: ${a.pctDiff ?? '?'}% \u043e\u0442 \u0441\u0440\u0435\u0434\u043d\u0435\u0433\u043e (${a.baseline ?? '\u2014'})`
                    : undefined
              }
            >
              {out}
            </td>
          );
        })}
      </tr>

      {/* Drilldown rows (expanded) */}
      {isExpanded && (
        drilldownLoading ? (
          <tr>
            <td className="sticky left-0 z-20 bg-indigo-100 border-b border-r border-[var(--table-border)] shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)] px-4 py-2 text-[11px] text-[var(--content-muted)]" colSpan={values.length + 1}>
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-indigo-300 border-t-transparent" />
                Загрузка метрик...
              </div>
            </td>
          </tr>
        ) : (
          drilldownMetrics.map((m) => {
            const mValues = drilldownData[m.key] ?? [];
            const series = dateKeys.map((_, idx) => (mValues[idx] ?? 0) as number);
            const mNums = series.filter((x) => typeof x === 'number' && Number.isFinite(x)) as number[];
            const mMin = mNums.length ? Math.min(...mNums) : 0;
            const mMax = mNums.length ? Math.max(...mNums) : 1;
            const mSpan = mMax - mMin || 1;

            return (
              <tr key={m.key} className="bg-indigo-50/20 hover:bg-indigo-50/40 transition-colors">
                <td className={cn(
                  'sticky left-0 z-20 bg-indigo-50 border-b border-r border-[var(--table-border)] shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)] text-[11px] text-[var(--content-muted)] font-medium',
                  tableDense ? 'px-2 py-1 pl-10' : 'px-3 py-1.5 pl-12'
                )}>
                  {m.label}
                </td>
                {series.map((v, idx) => {
                  const heatBg = tableHeatmap ? getHeatmapBg(v, mMin, mSpan, tableHeatmapIntensity) : undefined;
                  const isColSelected = !!(selectedDate && selectedNmId === r.nmId && dateKeys[idx] === selectedDate);
                  return (
                    <td
                      key={idx}
                      style={heatBg ? { backgroundColor: heatBg } : undefined}
                      className={cn(
                        'whitespace-nowrap border-b border-[var(--table-border)] text-right font-mono text-[11px] tabular-nums text-[var(--content-muted)]',
                        isColSelected && 'bg-indigo-50/40',
                        tableDense ? 'px-2 py-1' : 'px-3 py-1.5'
                      )}
                    >
                      {fmtValue(v, m.key)}
                    </td>
                  );
                })}
              </tr>
            );
          })
        )
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Small UI helpers
   ═══════════════════════════════════════════════════════════════════ */

/** Copy nmId to clipboard with visual feedback */
function CopyNmIdButton({ nmId }: { nmId: number }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    const text = String(nmId);
    try {
      // Modern API
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for HTTP or older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  }, [nmId]);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); copy(); }}
      className="ml-1 inline-flex items-center justify-center rounded p-0.5 text-[var(--content-muted)] hover:text-[var(--content-text)] hover:bg-slate-100 transition-colors"
      title={copied ? 'Скопировано!' : `Копировать артикул ${nmId}`}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════ */

/** Heatmap: 7-level gradient (emerald ← slate → red) with row normalization */
function getHeatmapBg(
  value: number,
  min: number,
  span: number,
  intensity: 'soft' | 'medium' | 'strong'
): string {
  const t = Math.max(0, Math.min(1, (value - min) / span)); // 0=min, 1=max
  const alpha = intensity === 'soft' ? 0.08 : intensity === 'strong' ? 0.28 : 0.16;

  // 7 gradient stops: red(0) → red-light(0.17) → orange(0.33) → neutral(0.5) → lime(0.67) → green-light(0.83) → green(1)
  if (t < 0.17) return `rgba(239, 68, 68, ${alpha * 1.4})`; // red-500
  if (t < 0.33) return `rgba(239, 68, 68, ${alpha * 0.7})`; // red-500 lighter
  if (t < 0.42) return `rgba(249, 115, 22, ${alpha * 0.5})`; // orange-500
  if (t < 0.58) return 'transparent'; // neutral zone
  if (t < 0.67) return `rgba(132, 204, 22, ${alpha * 0.5})`; // lime-500
  if (t < 0.83) return `rgba(34, 197, 94, ${alpha * 0.7})`; // green-500
  return `rgba(34, 197, 94, ${alpha * 1.4})`; // green-500 strong
}

/** Skeleton loading rows */
function SkeletonRows({ cols }: { cols: number }) {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j} className="border-b border-[var(--table-border)] px-3 py-3">
              <div className="h-4 animate-pulse rounded bg-slate-100" style={{ width: j === 0 ? '140px' : '60px' }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
