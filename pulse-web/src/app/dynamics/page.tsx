'use client';

import { useShopChange } from '@/hooks/useShopChange';
import { useShopParam } from '@/hooks/useShopParam';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { LabInsightsStrip } from '@/components/lab/LabInsightsStrip';
import { useWorkspaceStore } from '@/store/workspace';
import { formatNumber, formatNumberShort, formatPct, formatRub, formatRubShort } from '@/lib/format';
import { cn } from '@/lib/cn';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { ResponsiveFilterCard } from '@/components/ui/ResponsiveFilterCard';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { Button } from '@/components/ui/Button';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/ToggleGroup';
import { Switch } from '@/components/ui/Switch';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { ExportButton } from '@/components/ui/ExportButton';
import type { ExportColumn } from '@/lib/exportTable';

const DYNAMICS_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'date', label: 'Дата', type: 'date' },
  { key: 'nmId', label: 'Артикул WB', type: 'nmId' },
  { key: 'vendorCode', label: 'Артикул', type: 'text' },
  { key: 'title', label: 'Название', type: 'text' },
  { key: 'ordersCount', label: 'Заказы, шт.', type: 'number' },
  { key: 'salesCount', label: 'Продажи, шт.', type: 'number' },
  { key: 'salesRub', label: 'Выручка', type: 'rub' },
  { key: 'forPayRub', label: 'К перечислению', type: 'rub' },
  { key: 'avgPrice', label: 'Ср. цена', type: 'rub' },
  { key: 'marginRub', label: 'Маржа', type: 'rub' },
  { key: 'marginPercent', label: 'Маржа, %', type: 'pct' },
  { key: 'stockQty', label: 'Остаток', type: 'number' },
  { key: 'advSpendRub', label: 'Расход на рекламу', type: 'rub' },
  { key: 'drrPercent', label: 'ДРР, %', type: 'pct' },
];

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  ChevronDown,
  ChevronRight,
  Settings2,
  X,
  Check,
  Info,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DynamicsRow = {
  date: string;
  nmId: number;
  vendorCode: string | null;
  title: string | null;
  // Orders/Sales
  ordersCount: number;
  salesCount: number;
  salesRub: number;
  forPayRub: number;
  avgPrice: number;
  priceNoSpp?: number;
  sppPercent?: number;
  // Funnel
  funnelOrderCount?: number;
  viewCount?: number;
  openCardCount?: number;
  addToWishlistCount?: number;
  cartCount?: number;
  orderCount?: number;
  orderSumRub?: number;
  buyoutCount?: number;
  buyoutPercent?: number;
  viewToOpenPercent?: number;
  openToCartPercent?: number;
  cartToOrderPercent?: number;
  cancelsCount?: number;
  // Finance
  payoutRub?: number;
  commissionRub?: number;
  logisticsRub?: number;
  storageRub?: number;
  penaltyRub?: number;
  acquiringRub?: number;
  additionalPaymentRub?: number;
  marginRub?: number;
  marginPercent?: number;
  netProfitRub?: number;
  returnsCount?: number;
  // Stocks
  stockQty?: number | null;
  stockInWayTo?: number;
  stockInWayFrom?: number;
  // Ads
  advSpendRub?: number;
  drrPercent?: number;
};

type DynamicsResponse = {
  workspaceId: number;
  start: string;
  end: string;
  rows: DynamicsRow[];
  sync?: { ordersSales?: boolean; funnel?: boolean; finance?: boolean };
};

type EventCounts = { alerts: number; logs: number; tasks: number };

type EventRow = {
  eventId: number;
  nmId?: number | null;
  date: string;
  time?: string | null;
  type: string;
  category?: string | null;
  severity?: string | null;
  status: string;
  title: string;
  description?: string | null;
};

// ---------------------------------------------------------------------------
// 30 Metric definitions (grouped)
// ---------------------------------------------------------------------------

interface MetricDef {
  id: string;
  label: string;
  shortLabel: string;
  group: 'core' | 'advertising' | 'finance' | 'funnel' | 'stock';
  format: 'int' | 'rub' | 'pct';
  color: string;
  dashed?: boolean;
  helpText?: string; // Tooltip с объяснением метрики
  getValue: (r: DynamicsRow, stockDaily?: Record<string, number>) => number;
}

const METRIC_GROUPS = [
  { id: 'core', label: 'Основные' },
  { id: 'advertising', label: 'Реклама' },
  { id: 'finance', label: 'Финансы' },
  { id: 'funnel', label: 'Воронка' },
  { id: 'stock', label: 'Остатки' },
] as const;

const ALL_METRICS: MetricDef[] = [
  // === CORE (7) ===
  { id: 'ordersCount', label: 'Заказы (шт)', shortLabel: 'Заказы', group: 'core', format: 'int', color: '#f97316', helpText: 'Количество всех заказов, включая последующие отмены и возвраты', getValue: (r) => r.ordersCount },
  { id: 'ordersRub', label: 'Заказы (₽)', shortLabel: 'Заказы ₽', group: 'core', format: 'rub', color: '#ea580c', helpText: 'Сумма всех заказов в рублях (до вычета комиссий и возвратов)', getValue: (r) => r.salesRub },
  { id: 'salesCount', label: 'Продажи (шт)', shortLabel: 'Продажи', group: 'core', format: 'int', color: '#22c55e', helpText: 'Количество фактически выкупленных товаров', getValue: (r) => r.salesCount },
  { id: 'salesRub', label: 'Продажи (₽)', shortLabel: 'Продажи ₽', group: 'core', format: 'rub', color: '#16a34a', helpText: 'Сумма к перечислению (после комиссий, логистики, возвратов)', getValue: (r) => r.forPayRub },
  { id: 'priceNoSpp', label: 'Цена без СПП', shortLabel: 'Цена', group: 'core', format: 'rub', color: '#0ea5e9', helpText: 'Цена товара без скидки постоянного покупателя', getValue: (r) => r.priceNoSpp ?? r.avgPrice },
  { id: 'sppPercent', label: 'СПП (%)', shortLabel: 'СПП', group: 'core', format: 'pct', color: '#06b6d4', dashed: true, helpText: 'Скидка постоянного покупателя в процентах', getValue: (r) => r.sppPercent ?? 0 },
  { id: 'returnsCount', label: 'Возвраты (шт)', shortLabel: 'Возвраты', group: 'core', format: 'int', color: '#eab308', helpText: 'Количество отменённых заказов и возвратов', getValue: (r) => r.returnsCount ?? r.cancelsCount ?? 0 },
  
  // === ADVERTISING (4) ===
  { id: 'advSpendRub', label: 'Рекл. расход (₽)', shortLabel: 'Реклама', group: 'advertising', format: 'rub', color: '#ec4899', helpText: 'Общие затраты на рекламу WB', getValue: (r) => r.advSpendRub ?? 0 },
  { id: 'drrPercent', label: 'ДРР (%)', shortLabel: 'ДРР', group: 'advertising', format: 'pct', color: '#ef4444', dashed: true, helpText: 'Доля рекламных расходов: реклама ÷ продажи × 100%', getValue: (r) => r.drrPercent ?? 0 },
  { id: 'advManualRub', label: 'Ручная реклама (₽)', shortLabel: 'Ручная', group: 'advertising', format: 'rub', color: '#f472b6', helpText: 'Затраты на ручные рекламные кампании', getValue: (r) => 0 },
  { id: 'advAutoRub', label: 'Авто реклама (₽)', shortLabel: 'Авто', group: 'advertising', format: 'rub', color: '#db2777', helpText: 'Затраты на автоматические рекламные кампании', getValue: (r) => 0 },
  
  // === FINANCE (9) ===
  { id: 'payoutRub', label: 'Выплата (₽)', shortLabel: 'Выплата', group: 'finance', format: 'rub', color: '#a855f7', getValue: (r) => r.payoutRub ?? r.forPayRub },
  { id: 'commissionRub', label: 'Комиссия (₽)', shortLabel: 'Комиссия', group: 'finance', format: 'rub', color: '#8b5cf6', getValue: (r) => r.commissionRub ?? 0 },
  { id: 'logisticsRub', label: 'Логистика (₽)', shortLabel: 'Логистика', group: 'finance', format: 'rub', color: '#7c3aed', getValue: (r) => r.logisticsRub ?? 0 },
  { id: 'storageRub', label: 'Хранение (₽)', shortLabel: 'Хранение', group: 'finance', format: 'rub', color: '#6366f1', getValue: (r) => r.storageRub ?? 0 },
  { id: 'penaltyRub', label: 'Штрафы (₽)', shortLabel: 'Штрафы', group: 'finance', format: 'rub', color: '#4f46e5', getValue: (r) => r.penaltyRub ?? 0 },
  { id: 'acquiringRub', label: 'Эквайринг (₽)', shortLabel: 'Эквайр.', group: 'finance', format: 'rub', color: '#4338ca', getValue: (r) => r.acquiringRub ?? 0 },
  { id: 'marginRub', label: 'Маржа (₽)', shortLabel: 'Маржа', group: 'finance', format: 'rub', color: '#059669', getValue: (r) => r.marginRub ?? 0 },
  { id: 'marginPercent', label: 'Маржинальность (%)', shortLabel: 'Марж. %', group: 'finance', format: 'pct', color: '#10b981', dashed: true, getValue: (r) => r.marginPercent ?? 0 },
  { id: 'netProfitRub', label: 'Чистая прибыль (₽)', shortLabel: 'Прибыль', group: 'finance', format: 'rub', color: '#047857', getValue: (r) => r.netProfitRub ?? 0 },
  
  // === FUNNEL (7) ===
  { id: 'viewCount', label: 'Просмотры', shortLabel: 'Просм.', group: 'funnel', format: 'int', color: '#64748b', getValue: (r) => r.viewCount ?? 0 },
  { id: 'openCardCount', label: 'Открытия карточки', shortLabel: 'Открытия', group: 'funnel', format: 'int', color: '#475569', getValue: (r) => r.openCardCount ?? 0 },
  { id: 'cartCount', label: 'Корзина', shortLabel: 'Корзина', group: 'funnel', format: 'int', color: '#8b5cf6', getValue: (r) => r.cartCount ?? 0 },
  { id: 'funnelOrderCount', label: 'Заказы (воронка)', shortLabel: 'Заказы В', group: 'funnel', format: 'int', color: '#f97316', getValue: (r) => r.funnelOrderCount ?? r.orderCount ?? 0 },
  { id: 'buyoutCount', label: 'Выкуп (шт)', shortLabel: 'Выкуп', group: 'funnel', format: 'int', color: '#22c55e', getValue: (r) => r.buyoutCount ?? 0 },
  { id: 'buyoutPercent', label: 'Выкуп (%)', shortLabel: 'Выкуп %', group: 'funnel', format: 'pct', color: '#fb923c', dashed: true, getValue: (r) => r.buyoutPercent ?? 0 },
  { id: 'cancelCount', label: 'Отмены (шт)', shortLabel: 'Отмены', group: 'funnel', format: 'int', color: '#ef4444', getValue: (r) => r.cancelsCount ?? 0 },
  
  // === STOCK (3) ===
  { id: 'stockQty', label: 'На складе (шт)', shortLabel: 'Остаток', group: 'stock', format: 'int', color: '#10b981', getValue: (r, sd) => sd ? (sd[`${r.date}|${r.nmId}`] ?? Number(r.stockQty ?? 0)) : Number(r.stockQty ?? 0) },
  { id: 'stockInWayTo', label: 'В пути к клиенту', shortLabel: 'В пути→', group: 'stock', format: 'int', color: '#14b8a6', getValue: (r) => r.stockInWayTo ?? 0 },
  { id: 'stockInWayFrom', label: 'В пути от клиента', shortLabel: 'В пути←', group: 'stock', format: 'int', color: '#0d9488', getValue: (r) => r.stockInWayFrom ?? 0 },
];

const MAX_VISIBLE_METRICS = 6;
const DEFAULT_VISIBLE = new Set(['ordersCount', 'salesRub', 'buyoutPercent', 'stockQty', 'advSpendRub', 'drrPercent']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDate(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function addDays(d: Date, days: number): Date { const x = new Date(d); x.setUTCDate(x.getUTCDate() + days); return x; }

function formatMetricValue(format: 'int' | 'rub' | 'pct', value: number, short = false): string {
  if (format === 'rub') return short ? formatRubShort(value) : formatRub(value);
  if (format === 'pct') return formatPct(value);
  return short ? formatNumberShort(value) : formatNumber(value);
}

/** Heatmap: 7-level gradient with row normalization */
function getHeatmapBg(value: number, min: number, max: number, intensity: 'soft' | 'medium' | 'strong'): string {
  const span = max - min || 1;
  const t = Math.max(0, Math.min(1, (value - min) / span));
  const alpha = intensity === 'soft' ? 0.08 : intensity === 'strong' ? 0.28 : 0.16;

  if (t < 0.17) return `rgba(239, 68, 68, ${alpha * 1.4})`;
  if (t < 0.33) return `rgba(239, 68, 68, ${alpha * 0.7})`;
  if (t < 0.42) return `rgba(249, 115, 22, ${alpha * 0.5})`;
  if (t < 0.58) return 'transparent';
  if (t < 0.67) return `rgba(132, 204, 22, ${alpha * 0.5})`;
  if (t < 0.83) return `rgba(34, 197, 94, ${alpha * 0.7})`;
  return `rgba(34, 197, 94, ${alpha * 1.4})`;
}

function EventDot({ cx, cy, payload, onClick }: any) {
  const total = payload?._eventsTotal ?? 0;
  if (!total || cx == null || cy == null) return null;
  const showNumber = total > 0 && total <= 9;
  return (
    <g onClick={onClick} style={{ cursor: 'pointer' }}>
      <circle cx={cx} cy={cy} r={7} fill="#f59e0b" stroke="#b45309" strokeWidth={1} />
      {showNumber && (
        <text x={cx} y={cy + 3} textAnchor="middle" fontSize="9" fill="#fff" fontWeight="600">
          {total}
        </text>
      )}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function DynamicsPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const setWorkspaceId = useWorkspaceStore((s) => s.setWorkspaceId);
  const shopId = useWorkspaceStore((s) => s.shopId);
  const shopParam = useShopParam();
  const today = useMemo(() => new Date(), []);
  const [end, setEnd] = useState<string>(isoDate(today));
  const [start, setStart] = useState<string>(isoDate(addDays(today, -14)));
  const [nmIds, setNmIds] = useState('');
  const setNmIdsSingle = useCallback((value: string) => {
    const ids = value
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    const last = ids.length ? ids[ids.length - 1] : null;
    setNmIds(last ? String(last) : '');
  }, []);
  // const [mode, setMode] = useState<'count' | 'sum'>('count'); // Removed - not needed
  const [visibleMetrics, setVisibleMetrics] = useState<Set<string>>(DEFAULT_VISIBLE);
  const [settingsOpen, setSettingsOpen] = useState(false);
  
  // Metric presets (saved combinations)
  type MetricPreset = { id: string; name: string; metrics: string[] };
  const [metricPresets, setMetricPresets] = useState<MetricPreset[]>([]);
  const [presetName, setPresetName] = useState('');
  
  // Load presets from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('dynamics_metric_presets');
      if (saved) setMetricPresets(JSON.parse(saved));
    } catch (e) { console.error('Failed to load metric presets:', e); }
  }, []);
  
  // Save preset
  const savePreset = useCallback(() => {
    if (!presetName.trim()) return;
    const newPreset: MetricPreset = {
      id: `preset_${Date.now()}`,
      name: presetName.trim(),
      metrics: Array.from(visibleMetrics),
    };
    const updated = [...metricPresets, newPreset];
    setMetricPresets(updated);
    localStorage.setItem('dynamics_metric_presets', JSON.stringify(updated));
    setPresetName('');
  }, [presetName, visibleMetrics, metricPresets]);
  
  // Load preset
  const loadPreset = useCallback((preset: MetricPreset) => {
    setVisibleMetrics(new Set(preset.metrics));
  }, []);
  
  // Delete preset
  const deletePreset = useCallback((presetId: string) => {
    const updated = metricPresets.filter(p => p.id !== presetId);
    setMetricPresets(updated);
    localStorage.setItem('dynamics_metric_presets', JSON.stringify(updated));
  }, [metricPresets]);
  const [tableHeatmap, setTableHeatmap] = useState(true);
  const [tableHeatmapIntensity, setTableHeatmapIntensity] = useState<'soft' | 'medium' | 'strong'>('medium');

  const visibleMetricList = useMemo(
    () => ALL_METRICS.filter((m) => visibleMetrics.has(m.id)),
    [visibleMetrics]
  );

  // Each metric gets its own Y-axis, alternating left/right
  const axisLayout = useMemo(() => {
    let left = 0;
    let right = 0;
    const axes = visibleMetricList.map((m, idx) => {
      const side = idx % 2 === 0 ? 'left' : 'right';
      if (side === 'left') left += 1; else right += 1;
      return { ...m, side };
    });
    return { axes, leftCount: left, rightCount: right };
  }, [visibleMetricList]);

  const [data, setData] = useState<DynamicsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [stockByNmId, setStockByNmId] = useState<Record<string, { quantity: number; inWayToClient: number; inWayFromClient: number }>>({});
  const [stockDailyByKey, setStockDailyByKey] = useState<Record<string, number>>({});
  const [eventCountsByDate, setEventCountsByDate] = useState<Record<string, EventCounts>>({});
  const [eventsMarkers, setEventsMarkers] = useState(true);
  const [eventsDay, setEventsDay] = useState<string | null>(null);
  const [eventsDayRows, setEventsDayRows] = useState<EventRow[]>([]);
  const [eventsDayLoading, setEventsDayLoading] = useState(false);
  const [eventsDayError, setEventsDayError] = useState<string | null>(null);

  const availableNmIds = useMemo(() => {
    if (!data) return [] as number[];
    return Array.from(new Set(data.rows.map((r) => r.nmId))).sort((a, b) => a - b);
  }, [data]);

  const availableProducts = useMemo(() => {
    if (!data) return [] as Array<{ nmId: number; vendorCode: string | null; title: string | null }>;
    const map = new Map<number, { nmId: number; vendorCode: string | null; title: string | null }>();
    for (const r of data.rows) {
      if (!map.has(r.nmId)) map.set(r.nmId, { nmId: r.nmId, vendorCode: r.vendorCode ?? null, title: r.title ?? null });
    }
    return Array.from(map.values()).sort((a, b) => a.nmId - b.nmId);
  }, [data]);

  const [chartNmId, setChartNmId] = useState<number>(0);

  // Accordion open states
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['funnel']));

  const toggleSection = (id: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const load = useCallback(async () => {
    if (!nmIds.trim() || !workspaceId) {
      setData(null);
      setNotice(null);
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const url = `/dynamics/${workspaceId}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&nmIds=${encodeURIComponent(nmIds)}${shopParam}`;
      const res = (await apiFetch(url)) as DynamicsResponse;
      setData(res);
      const hasSync = !!(res.sync?.ordersSales || res.sync?.funnel || res.sync?.finance);
      if (hasSync) {
        const parts: string[] = [];
        if (res.sync?.ordersSales) parts.push('заказы/продажи');
        if (res.sync?.funnel) parts.push('воронка');
        if (res.sync?.finance) parts.push('финансы');
        setNotice(`Синхронизируются: ${parts.join(', ')} — обновите через 1–2 мин`);
      } else {
        setNotice(null);
      }
      // Stocks
      try {
        const ids = Array.from(new Set((res.rows ?? []).map((r) => r.nmId)));
        const s = (await apiFetch(`/stocks/${workspaceId}/current?nmIds=${encodeURIComponent(ids.join(','))}&refresh=0&noRefresh=1${shopParam}`)) as any;
        const m: Record<string, any> = {};
        for (const r of s?.rows ?? []) m[String(r.nmId)] = { quantity: r.quantity ?? 0, inWayToClient: r.inWayToClient ?? 0, inWayFromClient: r.inWayFromClient ?? 0 };
        setStockByNmId(m);
      } catch (e) { console.error('Failed to load stocks:', e); setStockByNmId({}); }
      try {
        const sd = (await apiFetch(`/stocks/${workspaceId}/daily?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&nmIds=${encodeURIComponent(nmIds)}${shopParam}`)) as any;
        const m: Record<string, number> = {};
        for (const r of sd?.rows ?? []) m[`${r.date}|${r.nmId}`] = r.quantity ?? 0;
        setStockDailyByKey(m);
      } catch (e) { console.error('Failed to load daily stocks:', e); setStockDailyByKey({}); }
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setNotice(null);
    }
    finally { setLoading(false); }
  }, [workspaceId, start, end, nmIds, shopParam]);

  useEffect(() => { load(); }, [load]);
  useShopChange(load);

  useEffect(() => {
    if (!eventsMarkers || !nmIds.trim()) {
      setEventCountsByDate({});
      setEventsDay(null);
      setEventsDayRows([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = (await apiFetch(
          `/events/${workspaceId}/counts?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}${shopParam}`
        )) as { byDate: Record<string, EventCounts> };
        if (!cancelled) setEventCountsByDate(res.byDate ?? {});
      } catch (e) {
        console.error('Failed to load event counts:', e);
        if (!cancelled) setEventCountsByDate({});
      }
    })();
    return () => { cancelled = true; };
  }, [eventsMarkers, nmIds, workspaceId, start, end, shopParam]);

  useEffect(() => {
    setEventsDay(null);
    setEventsDayRows([]);
  }, [workspaceId]);

  useEffect(() => {
    if (availableNmIds.length === 0) return;
    if (!availableNmIds.includes(chartNmId)) setChartNmId(availableNmIds[0]!);
  }, [availableNmIds, chartNmId]);

  useEffect(() => {
    const raw = Number.parseInt(nmIds.trim().split(',')[0] ?? '', 10);
    if (Number.isFinite(raw) && raw > 0) setChartNmId(raw);
  }, [nmIds]);

  const loadEventsForDate = useCallback(async (date: string) => {
    setEventsDay(date);
    setEventsDayLoading(true);
    setEventsDayError(null);
    try {
      const res = (await apiFetch(`/events/${workspaceId}?date=${encodeURIComponent(date)}${shopParam}`)) as { rows: EventRow[] };
      setEventsDayRows(res.rows ?? []);
    } catch (e: any) {
      setEventsDayRows([]);
      setEventsDayError(String(e?.message ?? e));
    } finally {
      setEventsDayLoading(false);
    }
  }, [workspaceId, shopParam]);

  // URL params
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const raw = String(sp.get('nmId') ?? sp.get('nmIds') ?? '').trim();
    if (!raw) return;
    setNmIds(raw);
    const first = Number.parseInt(raw.split(',')[0]!.trim(), 10);
    if (Number.isFinite(first) && first > 0) setChartNmId(first);
  }, []);

  // ---------------------------------------------------------------------------
  // Chart data
  // ---------------------------------------------------------------------------

  const { chartData, maxByMetric } = useMemo(() => {
    if (!data) return { chartData: [] as Record<string, any>[], maxByMetric: {} as Record<string, number> };
    const rows = data.rows
      .filter((r) => r.nmId === chartNmId)
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const rawPoints: Record<string, any>[] = rows.map((r) => {
      // YYYY-MM-DD → «14 мая». Русский формат: число + месяц коротко.
      // До этого: 05-14 (не понятно где день где месяц), 14.05 (читалось
      // как US-формат). Сейчас однозначно.
      const [, mm, dd] = r.date.split('-');
      const monthsShort = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
      const monthIdx = Math.max(0, Math.min(11, Number(mm) - 1));
      const label = `${Number(dd)} ${monthsShort[monthIdx]}`;
      const point: Record<string, any> = { date: label, _fullDate: r.date };
      for (const m of ALL_METRICS) {
        point[m.id] = m.getValue(r, stockDailyByKey);
      }
      const ev = eventCountsByDate[r.date];
      const total = (ev?.alerts ?? 0) + (ev?.logs ?? 0) + (ev?.tasks ?? 0);
      point._events = ev ?? null;
      point._eventsTotal = total;
      point._eventsMark = eventsMarkers && total > 0 ? 0 : null;
      return point;
    });

    const maxMap: Record<string, number> = {};
    for (const m of ALL_METRICS) {
      let mx = 0;
      for (const p of rawPoints) mx = Math.max(mx, Math.abs(p[m.id] ?? 0));
      maxMap[m.id] = mx;
    }

    return { chartData: rawPoints, maxByMetric: maxMap };
  }, [data, chartNmId, stockDailyByKey, eventCountsByDate, eventsMarkers]);

  const metricBounds = useMemo(() => {
    const bounds: Record<string, { min: number; max: number }> = {};
    for (const m of visibleMetricList) {
      let min = Infinity;
      let max = -Infinity;
      for (const point of chartData) {
        const val = point[m.id] as number | undefined;
        if (typeof val === 'number' && Number.isFinite(val)) {
          if (val < min) min = val;
          if (val > max) max = val;
        }
      }
      if (min === Infinity) min = 0;
      if (max === -Infinity) max = 0;
      if (min === max) { min = 0; max = max || 1; }
      bounds[m.id] = { min: Math.min(0, min), max };
    }
    return bounds;
  }, [chartData, visibleMetricList]);

  // ---------------------------------------------------------------------------
  // Table data with heatmap bounds per metric
  // ---------------------------------------------------------------------------

  const tableRows = useMemo(() => {
    if (!data) return [];
    return data.rows
      .filter((r) => r.nmId === chartNmId)
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }, [data, chartNmId]);

  const tableBounds = useMemo(() => {
    const bounds: Record<string, { min: number; max: number }> = {};
    for (const m of visibleMetricList) {
      let min = Infinity;
      let max = -Infinity;
      for (const r of tableRows) {
        const val = m.getValue(r, stockDailyByKey);
        if (Number.isFinite(val)) {
          if (val < min) min = val;
          if (val > max) max = val;
        }
      }
      if (min === Infinity) min = 0;
      if (max === -Infinity) max = 0;
      bounds[m.id] = { min, max };
    }
    return bounds;
  }, [tableRows, visibleMetricList, stockDailyByKey]);

  // ---------------------------------------------------------------------------
  // KPI computations
  // ---------------------------------------------------------------------------

  const kpis = useMemo(() => {
    if (!data || data.rows.length === 0) return null;
    const nmIdForKpi = chartNmId || availableNmIds[0] || 0;
    if (!nmIdForKpi) return null;
    const rows = data.rows.filter((r) => r.nmId === nmIdForKpi);
    if (!rows.length) return null;
    const sum = (fn: (r: DynamicsRow) => number) => rows.reduce((a, r) => a + (Number(fn(r)) || 0), 0);
    const totalOrders = sum((r) => r.ordersCount);
    const totalSales = sum((r) => r.salesCount);
    const totalCancels = sum((r) => r.cancelsCount ?? 0);
    const advTotal = sum((r) => r.advSpendRub ?? 0);
    const salesRubTotal = sum((r) => r.salesRub);
    const viewCount = sum((r) => r.viewCount ?? 0);
    const openCardCount = sum((r) => r.openCardCount ?? 0);
    const wishlistCount = sum((r) => r.addToWishlistCount ?? 0);
    const startD = new Date(`${start}T00:00:00Z`);
    const endD = new Date(`${end}T00:00:00Z`);
    const days = Math.max(1, Math.round((endD.getTime() - startD.getTime()) / 86400000) + 1);
    const denomBuyout = totalSales + totalCancels;
    const buyoutPct = denomBuyout > 0 ? (totalSales / denomBuyout) * 100 : null;
    const cancelPct = denomBuyout > 0 ? (totalCancels / denomBuyout) * 100 : null;
    const drrPct = salesRubTotal > 0 ? (advTotal / salesRubTotal) * 100 : null;
    const stock = stockByNmId[String(chartNmId)] ?? null;
    const salesPerDay = totalSales / days;
    const turnoverDays = stock && salesPerDay > 0 ? stock.quantity / salesPerDay : null;
    const funnelOrders = sum((r) => r.orderCount ?? 0);
    const funnelBuyout = sum((r) => r.buyoutCount ?? 0);
    const avgBuyoutPct = funnelOrders > 0 ? (funnelBuyout / funnelOrders) * 100 : null;
    const avgPrice = rows.length > 0 ? sum((r) => r.avgPrice) / rows.length : null;
    return {
      totalOrders, totalSales, buyoutPct, totalCancels, cancelPct,
      advTotal, drrPct, stock, turnoverDays, avgBuyoutPct, avgPrice,
      viewCount, openCardCount, wishlistCount,
      cart: sum((r) => r.cartCount ?? 0),
      orderSum: sum((r) => r.orderSumRub ?? 0),
      funnelOrders, funnelBuyout, salesRubTotal,
      forPayRub: sum((r) => r.forPayRub),
    };
  }, [data, chartNmId, availableNmIds, start, end, stockByNmId]);

  // ---------------------------------------------------------------------------
  // Format helpers
  // ---------------------------------------------------------------------------

  const fmt = (n: number) => formatNumberShort(n);
  const fmtR = (n: number) => formatRubShort(n);

  function toggleMetric(id: string) {
    setVisibleMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_VISIBLE_METRICS) {
        next.add(id);
      }
      return next;
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (workspaceId === null) {
    return (
      <AppShell title="Лаборатория">
        <div className="p-6">
          <Card className="p-8 text-center text-[var(--content-muted)]">
            Выберите магазин для просмотра аналитики
          </Card>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Лаборатория">
      {/* ═══ METRICS SETTINGS SIDEBAR ═══ */}
      {settingsOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setSettingsOpen(false)} />
          <div className="fixed right-0 top-0 z-50 flex h-full w-[340px] max-w-[90vw] flex-col border-l border-[var(--card-border)] bg-[var(--card-bg)] shadow-xl">
            <div className="flex items-center justify-between border-b border-[var(--card-border)] px-4 py-3">
              <span className="text-sm font-semibold text-[var(--content-text)]">Настройки метрик</span>
              <button onClick={() => setSettingsOpen(false)} className="rounded-md p-1 text-[var(--content-muted)] hover:bg-slate-100">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {/* Save new preset — top of sidebar */}
              <div className="mb-4 rounded-lg border border-[var(--card-border)] p-3">
                <div className="text-xs font-semibold text-[var(--content-text)] mb-2">Сохранить комбинацию</div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    placeholder="Название пресета..."
                    className="flex-1 text-xs px-2 py-1.5 rounded border border-[var(--card-border)] bg-white"
                    onKeyDown={(e) => { if (e.key === 'Enter') savePreset(); }}
                  />
                  <button
                    type="button"
                    onClick={savePreset}
                    disabled={!presetName.trim() || visibleMetrics.size === 0}
                    className="text-xs px-3 py-1.5 rounded bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Сохранить
                  </button>
                </div>
                {metricPresets.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {metricPresets.map((preset) => (
                      <div key={preset.id} className="flex items-center gap-2 text-xs">
                        <button
                          type="button"
                          onClick={() => loadPreset(preset)}
                          className="flex-1 text-left px-2 py-1.5 rounded bg-slate-50 hover:bg-slate-100 text-[var(--content-text)] truncate"
                        >
                          {preset.name}
                          <span className="ml-1 text-[var(--content-muted)]">({preset.metrics.length})</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => deletePreset(preset.id)}
                          className="p-1 rounded text-red-400 hover:text-red-600 hover:bg-red-50"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="mb-4 rounded-lg bg-indigo-50 p-3 text-xs text-indigo-700">
                Выберите до <strong>{MAX_VISIBLE_METRICS}</strong> метрик для графика и таблицы.
                <br />Выбрано: <strong>{visibleMetrics.size}</strong> из {ALL_METRICS.length}
              </div>

              {METRIC_GROUPS.map((group) => {
                const groupMetrics = ALL_METRICS.filter((m) => m.group === group.id);
                return (
                  <div key={group.id} className="mb-4">
                    <div className="mb-2 text-xs font-semibold text-[var(--content-muted)] uppercase tracking-wide">
                      {group.label}
                    </div>
                    <div className="space-y-1">
                      {groupMetrics.map((m) => {
                        const isSelected = visibleMetrics.has(m.id);
                        const isDisabled = !isSelected && visibleMetrics.size >= MAX_VISIBLE_METRICS;
                        return (
                          <button
                            key={m.id}
                            type="button"
                            disabled={isDisabled}
                            onClick={() => toggleMetric(m.id)}
                            className={cn(
                              'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                              isSelected ? 'bg-indigo-50 text-indigo-700' : 'hover:bg-slate-50',
                              isDisabled && 'opacity-40 cursor-not-allowed'
                            )}
                          >
                            <span className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: m.color }} />
                            <span className="flex-1">{m.label}</span>
                            {m.helpText && (
                              <span title={m.helpText} className="text-[var(--content-muted)] hover:text-[var(--content-text)] cursor-help">
                                <Info className="h-3.5 w-3.5" />
                              </span>
                            )}
                            {isSelected && <Check className="h-4 w-4 text-indigo-600" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {/* Quick presets moved to filter bar, save/load moved to top of sidebar */}
            </div>
          </div>
        </>
      )}

      <div className="space-y-4">
        {/* ═══ FILTERS ═══ — на mobile свернётся в trigger + BottomSheet */}
        <ResponsiveFilterCard
          title="Фильтры и метрики"
          summary={`${start} — ${end}${chartNmId > 0 ? ` · товар ${chartNmId}` : ''} · ${visibleMetrics.size} метрик`}
          activeCount={(chartNmId > 0 ? 1 : 0) + (visibleMetrics.size !== ALL_METRICS.length ? 1 : 0)}
        >
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-medium text-[var(--content-muted)]">Период</span>
              <DateRangePicker
                dateFrom={start}
                dateTo={end}
                onDateFromChange={setStart}
                onDateToChange={setEnd}
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] font-medium text-[var(--content-muted)]">Товар</span>
              <ProductSearchInput
                workspaceId={workspaceId}
                className="w-64 min-w-[200px]"
                value={nmIds}
                onChange={setNmIdsSingle}
                placeholder="Поиск по названию / артикулу..."
              />
            </div>

            {availableProducts.length > 1 && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-[var(--content-muted)]">Товар</span>
                <Select value={String(chartNmId)} onValueChange={(v) => setChartNmId(Number(v))}>
                  <SelectTrigger className="w-48 h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableProducts.map((p) => (
                      <SelectItem key={p.nmId} value={String(p.nmId)}>
                        {p.nmId}{p.vendorCode ? ` · ${p.vendorCode}` : ''}{p.title ? ` · ${p.title}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex-1" />

            <Button size="sm" variant="neutral" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="h-4 w-4" />
              Метрики ({visibleMetrics.size}/{MAX_VISIBLE_METRICS})
            </Button>
          </div>

          {/* Row 2: Presets + article for copy */}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--card-border)] pt-3">
            {/* Saved presets as quick buttons */}
            {metricPresets.length > 0 && (
              <>
                <span className="text-[10px] font-medium text-[var(--content-muted)]">Пресеты:</span>
                {metricPresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => loadPreset(preset)}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors"
                  >
                    {preset.name}
                    <span className="text-indigo-400">({preset.metrics.length})</span>
                  </button>
                ))}
                <div className="h-4 w-px bg-gray-200" />
              </>
            )}

            {/* Built-in quick presets */}
            <button type="button" onClick={() => setVisibleMetrics(new Set(['ordersCount', 'salesRub', 'buyoutPercent', 'stockQty', 'advSpendRub', 'drrPercent']))} className="text-xs px-2 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-[var(--content-text)] transition-colors">
              Базовый
            </button>
            <button type="button" onClick={() => setVisibleMetrics(new Set(['ordersCount', 'salesRub', 'advSpendRub', 'drrPercent', 'marginRub', 'netProfitRub']))} className="text-xs px-2 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-[var(--content-text)] transition-colors">
              Финансы
            </button>
            <button type="button" onClick={() => setVisibleMetrics(new Set(['viewCount', 'openCardCount', 'cartCount', 'funnelOrderCount', 'buyoutCount', 'buyoutPercent']))} className="text-xs px-2 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-[var(--content-text)] transition-colors">
              Воронка
            </button>

            <div className="flex-1" />

            {/* Selected product article for copy */}
            {chartNmId > 0 && (() => {
              const prod = availableProducts.find(p => p.nmId === chartNmId);
              return (
                <div className="flex items-center gap-2 text-xs text-[var(--content-muted)]">
                  {prod?.title && <span className="max-w-[200px] truncate">{prod.title}</span>}
                  <button
                    type="button"
                    title="Скопировать артикул WB"
                    onClick={() => {
                      navigator.clipboard.writeText(String(chartNmId));
                    }}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] bg-slate-100 hover:bg-slate-200 text-[var(--content-text)] transition-colors"
                  >
                    {chartNmId}
                    <svg className="h-3 w-3 text-[var(--content-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                  </button>
                  {prod?.vendorCode && (
                    <button
                      type="button"
                      title="Скопировать артикул продавца"
                      onClick={() => {
                        navigator.clipboard.writeText(prod.vendorCode!);
                      }}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] bg-slate-100 hover:bg-slate-200 text-[var(--content-text)] transition-colors"
                    >
                      {prod.vendorCode}
                      <svg className="h-3 w-3 text-[var(--content-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                    </button>
                  )}
                </div>
              );
            })()}
          </div>

          {error && <div className="mt-2 text-xs text-red-500">{error}</div>}
          {!error && notice && <div className="mt-2 text-xs text-blue-600">{notice}</div>}
        </ResponsiveFilterCard>

        {/* ═══ MULTI-METRIC CHART ═══ */}
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-[var(--content-text)]">Мульти-метрик</div>
            <Switch label="События" checked={eventsMarkers} onCheckedChange={setEventsMarkers} />
          </div>

          {!nmIds.trim() ? (
            <div className="flex flex-col items-center justify-center h-[300px] text-sm text-[var(--content-muted)]">
              <div className="text-lg">📊</div>
              <div className="mt-2">Выберите товар для анализа</div>
              <div className="mt-1 text-xs">Введите артикул WB, затем нажмите «Обновить»</div>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center h-[300px]">
              <div className="flex items-center gap-3 text-sm text-[var(--content-muted)]">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-300 border-t-transparent" />
                Загрузка данных...
              </div>
            </div>
          ) : chartData.length === 0 ? (
            <div className="flex items-center justify-center h-[300px] text-sm text-[var(--content-muted)]">
              Нет данных за выбранный период
            </div>
          ) : (
            <div className="flex">
              {/* Left axes */}
              <div className="flex shrink-0" style={{ width: Math.max(60, axisLayout.leftCount * 55) }}>
                {axisLayout.axes.filter(a => a.side === 'left').map((axis) => {
                  const bounds = metricBounds[axis.id] || { min: 0, max: 1 };
                  const ticks = [bounds.max, bounds.max * 0.5, bounds.min];
                  return (
                    <div key={axis.id} className="relative flex h-[310px] pt-1 pb-5" style={{ width: 53 }}>
                      <div 
                        className="flex items-center justify-center"
                        style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontSize: 9, color: axis.color, fontWeight: 500, width: 16 }}
                      >
                        {axis.shortLabel}
                      </div>
                      <div className="flex-1 flex flex-col justify-between text-right pr-1">
                        {ticks.map((val, i) => (
                          <span key={i} style={{ fontSize: 8, color: axis.color }}>
                            {formatMetricValue(axis.format, val, true)}
                          </span>
                        ))}
                      </div>
                      <div className="absolute top-1 bottom-5" style={{ right: 0, width: 1.5, backgroundColor: axis.color, opacity: 0.6 }} />
                    </div>
                  );
                })}
              </div>

              {/* Chart */}
              <div className="flex-1 min-w-0">
                <ResponsiveContainer width="100%" height={340}>
                  <LineChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--table-border)" />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--content-muted)' }} tickLine={false} />
                    {axisLayout.axes.map((axis) => (
                      <YAxis key={axis.id} yAxisId={axis.id} hide domain={['auto', 'auto']} />
                    ))}
                    {eventsMarkers && <YAxis yAxisId="events" hide domain={[0, 1]} />}
                    <Tooltip
                      content={({ payload, label }) => {
                        if (!payload || payload.length === 0) return null;
                        const dataPoint = payload[0]?.payload;
                        const metricsPayload = payload.filter((entry: any) => ALL_METRICS.some((m) => m.id === String(entry.dataKey)));
                        return (
                          <div style={{ backgroundColor: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 'var(--radius-md)', fontSize: 12, padding: '8px 12px' }}>
                            <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--content-text)' }}>{label}</div>
                            {metricsPayload.map((entry: any) => {
                              const metricId = String(entry.dataKey);
                              const realValue = dataPoint?.[metricId] ?? 0;
                              const metricDef = ALL_METRICS.find((m) => m.id === metricId);
                              const formatted = metricDef ? formatMetricValue(metricDef.format, realValue, false) : String(realValue ?? '—');
                              return (
                                <div key={entry.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: entry.color }} />
                                  <span style={{ color: 'var(--content-text)' }}>
                                    {metricDef?.shortLabel ?? metricId}: <strong>{formatted}</strong>
                                  </span>
                                </div>
                              );
                            })}
                            {eventsMarkers && (dataPoint?._eventsTotal ?? 0) > 0 && (
                              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed var(--table-border)' }}>
                                <span style={{ color: 'var(--content-text)' }}>События: <strong>{dataPoint?._eventsTotal ?? 0}</strong></span>
                              </div>
                            )}
                          </div>
                        );
                      }}
                    />
                    {eventsMarkers && (
                      <Line
                        type="monotone"
                        dataKey="_eventsMark"
                        name="События"
                        stroke="transparent"
                        dot={(props) => (
                          <EventDot {...props} onClick={() => {
                            const fullDate = props?.payload?._fullDate as string | undefined;
                            if (!fullDate) return;
                            if (eventsDay === fullDate) { setEventsDay(null); setEventsDayRows([]); return; }
                            loadEventsForDate(fullDate);
                          }} />
                        )}
                        activeDot={false}
                        isAnimationActive={false}
                        connectNulls={false}
                        yAxisId="events"
                      />
                    )}
                    {visibleMetricList.map((m) => (
                      <Line
                        key={m.id}
                        type="monotone"
                        dataKey={m.id}
                        name={m.label}
                        stroke={m.color}
                        strokeWidth={2}
                        strokeDasharray={m.dashed ? '6 3' : undefined}
                        dot={false}
                        isAnimationActive={false}
                        yAxisId={m.id}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Right axes */}
              <div className="flex shrink-0" style={{ width: Math.max(60, axisLayout.rightCount * 55) }}>
                {axisLayout.axes.filter(a => a.side === 'right').map((axis) => {
                  const bounds = metricBounds[axis.id] || { min: 0, max: 1 };
                  const ticks = [bounds.max, bounds.max * 0.5, bounds.min];
                  return (
                    <div key={axis.id} className="relative flex h-[310px] pt-1 pb-5" style={{ width: 53 }}>
                      <div className="absolute top-1 bottom-5" style={{ left: 0, width: 1.5, backgroundColor: axis.color, opacity: 0.6 }} />
                      <div className="flex-1 flex flex-col justify-between text-left pl-1">
                        {ticks.map((val, i) => (
                          <span key={i} style={{ fontSize: 8, color: axis.color }}>
                            {formatMetricValue(axis.format, val, true)}
                          </span>
                        ))}
                      </div>
                      <div 
                        className="flex items-center justify-center"
                        style={{ writingMode: 'vertical-rl', fontSize: 9, color: axis.color, fontWeight: 500, width: 16 }}
                      >
                        {axis.shortLabel}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {eventsDay && (
            <div className="mt-4 rounded-[var(--radius-lg)] border border-indigo-200 bg-gradient-to-br from-indigo-50/50 to-white p-4 shadow-md">
              <div className="flex items-center justify-between gap-2 mb-4">
                <div className="flex items-center gap-3">
                  <div className="text-lg font-semibold text-[var(--content-text)]">📅 События за {eventsDay}</div>
                  <span className="text-xs px-2.5 py-1 rounded-full bg-indigo-100 text-indigo-700 font-medium">{eventsDayRows.length} событий</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => window.open(`/events?date=${eventsDay}`, '_blank')}>
                    + Добавить событие
                  </Button>
                  <Button size="sm" variant="neutral" onClick={() => { setEventsDay(null); setEventsDayRows([]); }}>✕ Закрыть</Button>
                </div>
              </div>
              {eventsDayError && <div className="mb-3 text-sm text-red-500 bg-red-50 p-3 rounded-lg">{eventsDayError}</div>}
              {eventsDayLoading && (
                <div className="flex items-center justify-center py-12 text-sm text-[var(--content-muted)]">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent mr-3" />
                  Загрузка событий…
                </div>
              )}
              {!eventsDayLoading && eventsDayRows.length === 0 && (
                <div className="py-12 text-center">
                  <div className="text-4xl mb-3">📭</div>
                  <div className="text-sm text-[var(--content-muted)]">Нет событий за этот день</div>
                  <Button size="sm" variant="secondary" className="mt-3" onClick={() => window.open(`/events?date=${eventsDay}`, '_blank')}>
                    + Создать первое событие
                  </Button>
                </div>
              )}
              <div className="grid gap-3 md:grid-cols-2 max-h-[70vh] overflow-y-auto pr-1">
                {eventsDayRows.map((ev) => (
                  <div key={ev.eventId} className="rounded-xl border border-[var(--card-border)] bg-white px-4 py-3 hover:shadow-md hover:border-indigo-200 transition-all cursor-pointer" onClick={() => window.open(`/events?eventId=${ev.eventId}`, '_blank')}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-[var(--content-text)] text-sm truncate">
                          {ev.title}
                        </div>
                        {ev.nmId && (
                          <div className="mt-1 text-xs text-[var(--content-muted)]">
                            Артикул: <NmIdLink nmId={ev.nmId} className="font-mono bg-slate-100 px-1 rounded text-blue-600 hover:underline" />
                          </div>
                        )}
                      </div>
                      {ev.time && <div className="text-xs text-[var(--content-muted)] font-mono bg-slate-100 px-1.5 py-0.5 rounded">{ev.time}</div>}
                    </div>
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      <span className={cn(
                        'rounded-full px-2.5 py-0.5 text-xs font-medium',
                        ev.type === 'task' ? 'bg-violet-100 text-violet-700' :
                        ev.type === 'alert' ? 'bg-red-100 text-red-700' :
                        'bg-amber-100 text-amber-700'
                      )}>{ev.type === 'task' ? '📋 Задача' : ev.type === 'alert' ? '🚨 Алерт' : '📝 Событие'}</span>
                      <span className={cn(
                        'rounded-full px-2.5 py-0.5 text-xs',
                        ev.status === 'done' || ev.status === 'resolved' ? 'bg-green-100 text-green-700' :
                        ev.status === 'open' ? 'bg-slate-100 text-slate-700' :
                        'bg-yellow-100 text-yellow-700'
                      )}>{ev.status}</span>
                      {ev.category && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{ev.category}</span>}
                      {ev.severity && <span className={cn(
                        'rounded-full px-2 py-0.5 text-xs',
                        ev.severity === 'critical' ? 'bg-red-100 text-red-700' :
                        ev.severity === 'high' ? 'bg-orange-100 text-orange-700' :
                        'bg-slate-100 text-slate-600'
                      )}>{ev.severity}</span>}
                    </div>
                    {ev.description && (
                      <div className="mt-2 text-xs text-[var(--content-muted)] whitespace-pre-wrap bg-white rounded p-2 border border-slate-100">
                        {ev.description}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Events timeline bar (под графиком). Выравниваем по тем же
              отступам что у графика (axisLayout.left/rightCount * 55, min 60)
              чтобы карточки стояли РОВНО под точками X-оси чарта. Раньше
              был хардкод px-[60px] — при 2+ осях не совпадал. */}
          {eventsMarkers && chartData.length > 0 && Object.keys(eventCountsByDate).length > 0 && (
            <div className="mt-3">
              <div className="flex items-center gap-3 mb-2 flex-wrap" style={{ paddingLeft: Math.max(60, axisLayout.leftCount * 55), paddingRight: Math.max(60, axisLayout.rightCount * 55) }}>
                <div className="text-[11px] font-medium text-[var(--content-muted)]">События по дням</div>
                <div className="flex items-center gap-2 text-[10px] text-[var(--content-muted)]">
                  <span className="inline-flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded bg-red-400"></span>алерт</span>
                  <span className="inline-flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded bg-blue-400"></span>задача</span>
                  <span className="inline-flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded bg-amber-400"></span>лог</span>
                  <span className="text-[var(--content-muted)]">— клик: показать события дня. На графике 🟠 — общий маркер.</span>
                </div>
              </div>
              {/* F-008 (фидбек 2026-06-08): убрали подпись даты в каждой
                  ячейке — она дублировала ось X графика выше и при N≥60 дней
                  раскладка съезжала из-за разной плотности (ось показывает
                  раз в ~4 дня, а строка — каждый день). Теперь это узкая
                  цветная полоса; конкретная дата видна в tooltip, число
                  событий — поверх ячейки. */}
              <div className="flex gap-1" style={{ paddingLeft: Math.max(60, axisLayout.leftCount * 55), paddingRight: Math.max(60, axisLayout.rightCount * 55) }}>
                {chartData.map((point) => {
                  const fullDate = point._fullDate as string | undefined;
                  const ev = fullDate ? eventCountsByDate[fullDate] : null;
                  const total = ev ? (ev.alerts + ev.logs + ev.tasks) : 0;
                  const hasAlerts = ev?.alerts ?? 0;
                  const hasTasks = ev?.tasks ?? 0;
                  const isSelected = eventsDay === fullDate;
                  return (
                    <button
                      key={point.date}
                      type="button"
                      onClick={() => fullDate && total > 0 && loadEventsForDate(fullDate)}
                      className={cn(
                        'flex-1 min-h-[18px] rounded-sm transition-all flex items-center justify-center',
                        total > 0 ? 'cursor-pointer hover:scale-y-110 hover:shadow-md' : 'cursor-default',
                        hasAlerts > 0 ? 'bg-red-400 hover:bg-red-500' : hasTasks > 0 ? 'bg-blue-400 hover:bg-blue-500' : total > 0 ? 'bg-amber-400 hover:bg-amber-500' : 'bg-slate-100',
                        isSelected && 'ring-2 ring-indigo-500 ring-offset-1'
                      )}
                      title={fullDate ? `${fullDate}: ${total} событий (${ev?.tasks ?? 0} задач, ${ev?.alerts ?? 0} алертов, ${ev?.logs ?? 0} логов)` : ''}
                    >
                      {total > 0 && (
                        <span className="text-[10px] text-white font-bold leading-none">{total}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Legend */}
          <div className="mt-3 flex flex-wrap gap-3">
            {visibleMetricList.map((m) => {
              const mx = maxByMetric[m.id] ?? 0;
              const maxLabel = mx > 0 ? ` (max: ${formatMetricValue(m.format, mx, true)})` : '';
              return (
                <div key={m.id} className="flex items-center gap-1.5 text-[11px]">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: m.color }} />
                  <span className="text-[var(--content-text)]">{m.shortLabel}</span>
                  <span className="text-[var(--content-muted)]">{maxLabel}</span>
                </div>
              );
            })}
          </div>
        </Card>

        {/* ═══ ЛАБОРАТОРИЯ ═══ */}
        {workspaceId && shopId && chartNmId > 0 && (
          <LabInsightsStrip
            workspaceId={workspaceId}
            shopId={shopId}
            nmId={chartNmId}
            from={start}
            to={end}
          />
        )}

        {/* ═══ KPI CARDS ═══ — на mobile горизонтальный snap-x */}
        <div className="
          flex gap-2 overflow-x-auto snap-x snap-mandatory pb-1
          -mx-4 px-4 sm:mx-0 sm:px-0 sm:overflow-x-visible
          sm:grid sm:grid-cols-2 md:grid-cols-4 xl:grid-cols-7
          [&>*]:shrink-0 [&>*]:w-[140px] [&>*]:snap-start
          sm:[&>*]:shrink sm:[&>*]:w-auto
        " style={{ scrollbarWidth: 'thin' }}>
          <KPICell label="Заказы" value={kpis ? String(kpis.totalOrders) : '—'} />
          <KPICell label="Продажи" value={kpis ? String(kpis.totalSales) : '—'} />
          <KPICell label="% Выкупа" value={kpis?.buyoutPct != null ? `${Math.round(kpis.buyoutPct)}%` : '—'} />
          <KPICell label="Корзина" value={kpis ? String(kpis.cart) : '—'} />
          <KPICell label="Остаток" value={kpis?.stock ? String(kpis.stock.quantity) : '—'} />
          <KPICell label="Оборачиваемость" value={kpis?.turnoverDays != null ? `${Math.round(kpis.turnoverDays)} дн` : '—'} />
          <KPICell label="Реклама" value={kpis ? fmtR(kpis.advTotal) : '—'} />
          <KPICell label="ДРР" value={kpis?.drrPct != null ? `${Math.round(kpis.drrPct)}%` : '—'} />
          <KPICell label="% Отмен" value={kpis?.cancelPct != null ? `${Math.round(kpis.cancelPct)}%` : '—'} />
          <KPICell label="Сумма продаж" value={kpis ? fmtR(kpis.salesRubTotal) : '—'} />
          <KPICell label="К перечислению" value={kpis ? fmtR(kpis.forPayRub) : '—'} />
          <KPICell label="Средняя цена" value={kpis?.avgPrice != null ? fmtR(kpis.avgPrice) : '—'} />
          <KPICell label="% Выкупа (воронка)" value={kpis?.avgBuyoutPct != null ? `${Math.round(kpis.avgBuyoutPct)}%` : '—'} />
          <KPICell label="Просмотры" value={kpis ? fmt(kpis.viewCount) : '—'} />
        </div>

        {/* ═══ DATA TABLE WITH HEATMAP ═══ */}
        <Card className="overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-[var(--card-border)] px-4 py-3">
            <div className="text-sm font-semibold text-[var(--content-text)]">Таблица данных</div>
            <div className="flex items-center gap-3">
              <ExportButton
                title={`Лаборатория ${start} – ${end}`}
                subtitle={`Период: ${start} – ${end}`}
                columns={DYNAMICS_EXPORT_COLUMNS}
                rows={data?.rows ?? []}
              />
              <Switch label="Теплокарта" checked={tableHeatmap} onCheckedChange={setTableHeatmap} />
              {tableHeatmap && (
                <ToggleGroup type="single" value={tableHeatmapIntensity} onValueChange={(v) => v && setTableHeatmapIntensity(v as any)}>
                  <ToggleGroupItem value="soft" className="h-7 text-[11px] px-2">Мягко</ToggleGroupItem>
                  <ToggleGroupItem value="medium" className="h-7 text-[11px] px-2">Средне</ToggleGroupItem>
                  <ToggleGroupItem value="strong" className="h-7 text-[11px] px-2">Ярко</ToggleGroupItem>
                </ToggleGroup>
              )}
            </div>
          </div>
          <div className="overflow-auto max-h-[60vh]">
            <table className="min-w-full border-collapse text-xs">
              <thead className="bg-[var(--table-header-bg)] sticky top-0 z-10">
                <tr className="text-[var(--content-muted)]">
                  <TH sticky>Дата</TH>
                  {eventsMarkers && <TH align="center">События</TH>}
                  {visibleMetricList.map((m) => (
                    <TH key={m.id} align="right">
                      <div className="flex items-center justify-end gap-1">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: m.color }} />
                        {m.shortLabel}
                      </div>
                    </TH>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r) => {
                  const evCounts = eventCountsByDate[r.date];
                  const evTotal = evCounts ? (evCounts.alerts + evCounts.logs + evCounts.tasks) : 0;
                  return (
                  <tr key={r.date} className="transition-colors hover:bg-[var(--table-row-hover)]">
                    <TD sticky className="font-mono">{r.date}</TD>
                    {eventsMarkers && (
                      <TD align="center" className={cn(evTotal > 0 && 'cursor-pointer hover:bg-indigo-50')} onClick={() => evTotal > 0 && loadEventsForDate(r.date)}>
                        {evTotal > 0 ? (
                          <span className="inline-flex items-center gap-1 text-amber-700">
                            <span className="h-2 w-2 rounded-full bg-amber-500" />
                            {evTotal}
                          </span>
                        ) : (
                          <span className="text-[var(--content-muted)]">—</span>
                        )}
                      </TD>
                    )}
                    {visibleMetricList.map((m) => {
                      const val = m.getValue(r, stockDailyByKey);
                      const bounds = tableBounds[m.id] || { min: 0, max: 1 };
                      const heatBg = tableHeatmap ? getHeatmapBg(val, bounds.min, bounds.max, tableHeatmapIntensity) : undefined;
                      return (
                        <TD key={m.id} align="right" className="font-mono tabular-nums" style={heatBg ? { backgroundColor: heatBg } : undefined}>
                          {formatMetricValue(m.format, val, true)}
                        </TD>
                      );
                    })}
                  </tr>
                )})}
                {tableRows.length === 0 && (
                  <tr>
                    <td className="p-8 text-center text-sm text-[var(--content-muted)]" colSpan={visibleMetricList.length + 1}>
                      {nmIds.trim() ? (
                        <>
                          <div>Нет данных за выбранный период.</div>
                          <div className="mt-1 text-xs text-gray-400">Расширьте даты или проверьте артикул.</div>
                        </>
                      ) : 'Выберите товар для анализа'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {/* ═══ DETAIL ACCORDIONS ═══ */}
        <Accordion id="funnel" title="Воронка" open={openSections.has('funnel')} onToggle={toggleSection}>
          {kpis ? (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <DetailCell label="Просмотры" value={fmt(kpis.viewCount ?? 0)} />
              <DetailCell label="Открытия карточки" value={fmt(kpis.openCardCount ?? 0)} />
              <DetailCell label="В избранное" value={fmt(kpis.wishlistCount ?? 0)} />
              <DetailCell label="Корзина" value={fmt(kpis.cart)} />
              <DetailCell label="Заказы (воронка)" value={fmt(kpis.funnelOrders)} />
              <DetailCell label="Выкуп (воронка)" value={fmt(kpis.funnelBuyout)} />
              <DetailCell label="% Выкупа" value={kpis.avgBuyoutPct != null ? `${Math.round(kpis.avgBuyoutPct)}%` : '—'} />
              <DetailCell label="Сумма заказов" value={fmtR(kpis.orderSum)} />
              <DetailCell label="Отмены" value={fmt(kpis.totalCancels)} />
              <DetailCell label="% Отмен" value={kpis.cancelPct != null ? `${Math.round(kpis.cancelPct)}%` : '—'} />
            </div>
          ) : <EmptyDetail />}
        </Accordion>

        <Accordion id="ads" title="Реклама" open={openSections.has('ads')} onToggle={toggleSection}>
          {kpis ? (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <DetailCell label="Расход" value={fmtR(kpis.advTotal)} />
              <DetailCell label="Продажи" value={fmtR(kpis.salesRubTotal)} />
              <DetailCell label="К перечислению" value={fmtR(kpis.forPayRub)} />
              <DetailCell label="ДРР" value={kpis.drrPct != null ? `${Math.round(kpis.drrPct)}%` : '—'} extra="по продажам" />
            </div>
          ) : <EmptyDetail />}
        </Accordion>

        <Accordion id="stock" title="Остатки" open={openSections.has('stock')} onToggle={toggleSection}>
          {kpis?.stock ? (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <DetailCell label="Текущий остаток" value={fmt(kpis.stock.quantity)} />
              <DetailCell label="В пути к клиенту" value={fmt(kpis.stock.inWayToClient)} />
              <DetailCell label="В пути от клиента" value={fmt(kpis.stock.inWayFromClient)} />
              <DetailCell label="Оборачиваемость" value={kpis.turnoverDays != null ? `${Math.round(kpis.turnoverDays)} дн` : '—'} />
            </div>
          ) : <EmptyDetail />}
        </Accordion>

        <Accordion id="finance" title="Финансы" open={openSections.has('finance')} onToggle={toggleSection}>
          {kpis ? (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <DetailCell label="Сумма продаж" value={fmtR(kpis.salesRubTotal)} />
              <DetailCell label="К перечислению" value={fmtR(kpis.forPayRub)} />
              <DetailCell label="Реклама" value={fmtR(kpis.advTotal)} />
              <DetailCell label="Средняя цена" value={kpis.avgPrice != null ? fmtR(kpis.avgPrice) : '—'} />
            </div>
          ) : <EmptyDetail />}
        </Accordion>
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function KPICell({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-3">
      <div className="text-[10px] font-medium text-[var(--content-muted)]">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold text-[var(--content-text)]">{value}</div>
    </Card>
  );
}

function DetailCell({ label, value, extra }: { label: string; value: string; extra?: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--card-border)] bg-slate-50 p-2.5">
      <div className="text-[10px] font-medium text-[var(--content-muted)]">{label}</div>
      <div className="mt-1 font-mono text-sm text-[var(--content-text)]">{value}</div>
      {extra && <div className="mt-0.5 text-[10px] text-[var(--content-muted)]">{extra}</div>}
    </div>
  );
}

function EmptyDetail() {
  return <div className="text-xs text-[var(--content-muted)] py-2">Нет данных</div>;
}

function Accordion({ id, title, open, onToggle, children }: { id: string; title: string; open: boolean; onToggle: (id: string) => void; children: React.ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <button type="button" onClick={() => onToggle(id)} className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-slate-50">
        <span className="text-sm font-semibold text-[var(--content-text)]">{title}</span>
        {open ? <ChevronDown className="h-4 w-4 text-[var(--content-muted)]" /> : <ChevronRight className="h-4 w-4 text-[var(--content-muted)]" />}
      </button>
      {open && <div className="border-t border-[var(--card-border)] px-4 py-3">{children}</div>}
    </Card>
  );
}

function TH({ children, align = 'left', sticky }: { children: React.ReactNode; align?: 'left' | 'right' | 'center'; sticky?: boolean }) {
  return (
    <th className={cn(
      'border-b border-[var(--table-border)] p-2.5 text-xs font-medium uppercase tracking-wide whitespace-nowrap',
      align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
      sticky && 'sticky left-0 bg-[var(--table-header-bg)] z-20'
    )}>
      {children}
    </th>
  );
}

function TD({ children, className, align = 'left', sticky, style, onClick }: { children: React.ReactNode; className?: string; align?: 'left' | 'right' | 'center'; sticky?: boolean; style?: React.CSSProperties; onClick?: () => void }) {
  return (
    <td 
      className={cn(
        'border-b border-[var(--table-border)] p-2 text-[var(--content-text)] whitespace-nowrap',
        align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
        sticky && 'sticky left-0 bg-[var(--card-bg)] z-10',
        className
      )}
      style={style}
      onClick={onClick}
    >
      {children}
    </td>
  );
}
