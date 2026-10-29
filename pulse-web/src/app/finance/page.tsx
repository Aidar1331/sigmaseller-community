'use client';

import { useShopChange } from '@/hooks/useShopChange';
import { useShopParam } from '@/hooks/useShopParam';

import { useEffect, useMemo, useState } from 'react';
import { useWorkspaceStore } from '@/store/workspace';
import { apiFetch } from '@/lib/api';
import { formatNumber, formatNumberShort, formatRub, formatRubShort } from '@/lib/format';
import { cn } from '@/lib/cn';
import { AppShell } from '@/components/AppShell';
import { SyncFreshnessBadge } from '@/components/SyncFreshnessBadge';
import { Card } from '@/components/ui/Card';
import { ResponsiveFilterCard } from '@/components/ui/ResponsiveFilterCard';
import { Button } from '@/components/ui/Button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/ToggleGroup';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { NmIdLink } from '@/components/ui/NmIdLink';

import { TagFilter, type TagOption } from '@/components/ui/TagFilter';
import { RefreshCw, Receipt, Warehouse, FileText, AlertTriangle, Package, Megaphone } from 'lucide-react';
import { ByProductTab } from '@/components/finance/ByProductTab';
import { ReportsTab } from '@/components/finance/ReportsTab';
import { AdvExpensesTab } from '@/components/finance/AdvExpensesTab';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';
import { DocumentsTab, DeductionsTab, StorageTab } from '@/components/finance';
import { AiAnalyzeButton } from '@/components/ai';
import { ExportButton } from '@/components/ui/ExportButton';
import type { ExportColumn } from '@/lib/exportTable';

type FinanceRow = {
  bucketStart: string;
  bucketEnd: string;
  nmId: number;
  vendorCode: string | null;
  lines: number;
  segments: {
    revenueRub: number;
    incomeFromSalesRub: number;
    commissionRub: number;
    logisticsRub: number;
    returnLogisticsRub: number;
    paidAcceptanceRub: number;
    storageRub: number;
    penaltiesRub: number;
    otherHoldRub: number;
    acquiringRub: number;
    additionalPaymentsRub: number;
    pct?: {
      incomeFromSales: number;
      commission: number;
      logistics: number;
      returnLogistics: number;
      paidAcceptance: number;
      storage: number;
      penalties: number;
      otherHold: number;
      acquiring: number;
      additionalPayments: number;
    };
  };
};

type FinanceResponse = {
  workspaceId: number;
  start: string;
  end: string;
  mergeWeeks: boolean;
  mergeProducts: boolean;
  rows: FinanceRow[];
};

function isoDate(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function addDays(d: Date, days: number): Date { const x = new Date(d); x.setUTCDate(x.getUTCDate() + days); return x; }

const SEGMENTS_LEFT: Array<{ key: keyof FinanceRow['segments']; title: string; color: string }> = [
  { key: 'incomeFromSalesRub', title: 'К перечислению (ppvz_for_pay)', color: '#93C5FD' },
  { key: 'additionalPaymentsRub', title: 'Доп. выплаты', color: '#22D3EE' },
];

const SEGMENTS_RIGHT: Array<{ key: keyof FinanceRow['segments']; title: string; color: string }> = [
  { key: 'commissionRub', title: 'Комиссия', color: '#F59E0B' },
  { key: 'logisticsRub', title: 'Логистика', color: '#7C3AED' },
  { key: 'returnLogisticsRub', title: 'Возвраты (логистика)', color: '#A855F7' },
  { key: 'paidAcceptanceRub', title: 'Платная приёмка', color: '#FCD34D' },
  { key: 'storageRub', title: 'Хранение', color: '#FB7185' },
  { key: 'penaltiesRub', title: 'Штрафы', color: '#F97316' },
  { key: 'otherHoldRub', title: 'Прочие удержания', color: '#EF4444' },
  { key: 'acquiringRub', title: 'Эквайринг', color: '#EAB308' },
];

const selectCls = 'rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-2 py-1 text-sm text-[var(--content-text)] outline-none focus:ring-2 focus:ring-indigo-500/30';

const FINANCE_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'period', label: 'Период', type: 'text' },
  { key: 'nmId', label: 'Артикул WB', type: 'nmId' },
  { key: 'vendorCode', label: 'Артикул продавца', type: 'text' },
  { key: 'revenueRub', label: 'Выручка', type: 'rub' },
  { key: 'incomeFromSalesRub', label: 'К перечислению', type: 'rub' },
  { key: 'commissionRub', label: 'Комиссия', type: 'rub' },
  { key: 'logisticsRub', label: 'Логистика', type: 'rub' },
  { key: 'storageRub', label: 'Хранение', type: 'rub' },
  { key: 'penaltiesRub', label: 'Штрафы', type: 'rub' },
  { key: 'otherHoldRub', label: 'Прочие удержания', type: 'rub' },
  { key: 'acquiringRub', label: 'Эквайринг', type: 'rub' },
  { key: 'additionalPaymentsRub', label: 'Доп. выплаты', type: 'rub' },
];

export default function FinancePage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const setWorkspaceId = useWorkspaceStore((s) => s.setWorkspaceId);
  const shopParam = useShopParam();
  const today = useMemo(() => new Date(), []);
  const [end, setEnd] = useState<string>(isoDate(today));
  const [start, setStart] = useState<string>(isoDate(addDays(today, -30)));
  const [nmId, setNmId] = useState('');
  const [tagId, setTagId] = useState<number | null>(null);
  const [tags, setTags] = useState<TagOption[]>([]);
  const [groupBy, setGroupBy] = useState<'day' | 'week'>('day');
  const [mergeProducts, setMergeProducts] = useState(true);
  const [numberFormat, setNumberFormat] = useState<'full' | 'short'>('short');
  const [data, setData] = useState<FinanceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartNmId, setChartNmId] = useState<number>(0);
  const [hover, setHover] = useState<null | { periodKey: string; segment: string; value: number; pct?: number; x: number; y: number }>(null);
  // 'overview' оставлен в типе для совместимости с inline-блоком ниже;
  // кнопки нет, по умолчанию открывается 'reports'.
  const [activeTab, setActiveTab] = useState<'overview' | 'reports' | 'by_product' | 'adv' | 'deductions' | 'storage' | 'documents'>('reports');
  const [advSpendTotal, setAdvSpendTotal] = useState<number | null>(null);
  const [cogsTotal, setCogsTotal] = useState<number | null>(null);
  // Полный итог по хранению из wb_storage_daily (включает товары без
  // продаж за период — их нет в wb_finance_daily_products). Используется
  // вместо суммирования storageRub по строкам таблицы, чтобы KPI «Хранение»
  // совпадал с тем, что показывает вкладка «Хранение» и WB ЛК.
  const [storageTotalFromDailyRub, setStorageTotalFromDailyRub] = useState<number | null>(null);
  // Shop-level суммы из wb_finance_daily — Прочее/Промо/Штрафы. В
  // products-таблице их нет (приходят без nm_id), без shop-totals KPI
  // показывал 0 там, где у WB ЛК есть суммы (например, 79 659 ₽ за WB
  // Продвижение 31.05). Подменяем KPI снизу.
  const [shopTotals, setShopTotals] = useState<{ otherHoldRub: number; promotionRub: number; penaltyRub: number; storageRub: number } | null>(null);
  const [cogsGap, setCogsGap] = useState<{ withoutCogs: number; total: number; coveragePct: number } | null>(null);

  // Load tags
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch(`/tags/${workspaceId}`)
      .then((res: any) => setTags(res.rows ?? []))
      .catch(() => setTags([]));
  }, [workspaceId]);

  async function load() {
    if (!workspaceId) return;
    setLoading(true); setError(null);
    try {
      const mergeWeeksEffective = groupBy === 'week';
      let url = `/finance/${workspaceId}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&nmIds=${encodeURIComponent(nmId)}&mergeWeeks=${mergeWeeksEffective ? '1' : '0'}&mergeProducts=${mergeProducts ? '1' : '0'}&rounding=standard`;
      if (tagId) url += `&tagId=${encodeURIComponent(String(tagId))}`;
      url += shopParam;
      const res = (await apiFetch(url)) as FinanceResponse;
      setData(res);
    } catch (e: any) { setError(String(e?.message ?? e)); } finally { setLoading(false); }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [start, end, nmId, tagId, groupBy, mergeProducts, workspaceId, shopParam]);
  useShopChange(load);

  // Load additional external costs: advertising spend + COGS totals.
  // Источник — /finance/:ws/summary (период + shopId): adv = wb_adv_finance
  // (= xlsx «История затрат»), cogs = cogs_kopecks × (sale_qty − returns) за период.
  useEffect(() => {
    if (!workspaceId || !start || !end) return;
    const qs = new URLSearchParams({ start, end });
    if (shopParam) qs.set('shopId', shopParam.replace(/^&?shopId=/, ''));
    apiFetch(`/finance/${workspaceId}/summary?${qs.toString()}`)
      .then((res: any) => {
        setAdvSpendTotal(Number(res?.advRub ?? 0) || null);
        setCogsTotal(Number(res?.cogsRub ?? 0) || null);
      })
      .catch(() => {
        setAdvSpendTotal(null);
        setCogsTotal(null);
      });
    // COGS coverage — для индикатора «N SKU без себестоимости»
    apiFetch(`/cogs/${workspaceId}/coverage`)
      .then((res: any) => setCogsGap({
        withoutCogs: Number(res?.withoutCogs ?? 0),
        total: Number(res?.total ?? 0),
        coveragePct: Number(res?.coveragePct ?? 0),
      }))
      .catch(() => setCogsGap(null));
  }, [workspaceId, shopParam, start, end]);

  // Полный итог по хранению из wb_storage_daily (источник истины, см.
  // 2026-06-01: storage_kopecks в finance_daily_products покрывает только
  // товары с продажами).
  useEffect(() => {
    if (!workspaceId || !start || !end) return;
    const qs = new URLSearchParams({ from: start, to: end });
    if (shopParam) {
      qs.set('shopId', shopParam.replace(/^&shopId=/, ''));
    }
    apiFetch(`/finance/${workspaceId}/storage?${qs.toString()}`)
      .then((res: any) => {
        const costKop = Number(res?.totals?.cost ?? 0);
        setStorageTotalFromDailyRub(costKop > 0 ? costKop / 100 : null);
      })
      .catch(() => setStorageTotalFromDailyRub(null));
  }, [workspaceId, start, end, shopParam]);

  // Shop-level суммы из wb_finance_daily (Прочее, Промо, Штрафы). Чтобы
  // KPI совпадал с WB ЛК даже для статей без nm_id.
  useEffect(() => {
    if (!workspaceId || !start || !end) return;
    const qs = new URLSearchParams({ from: start, to: end });
    if (shopParam) {
      qs.set('shopId', shopParam.replace(/^&shopId=/, ''));
    }
    apiFetch(`/finance/${workspaceId}/shop-totals?${qs.toString()}`)
      .then((res: any) => {
        const t = res?.totals;
        if (t) {
          setShopTotals({
            otherHoldRub: Number(t.otherHoldRub ?? 0),
            promotionRub: Number(t.promotionRub ?? 0),
            penaltyRub: Number(t.penaltyRub ?? 0),
            storageRub: Number(t.storageRub ?? 0),
          });
        } else {
          setShopTotals(null);
        }
      })
      .catch(() => setShopTotals(null));
  }, [workspaceId, start, end, shopParam]);


  const periods = useMemo(() => {
    if (!data) return [] as Array<{ key: string; start: string; end: string }>;
    const keys = new Map<string, { start: string; end: string }>();
    for (const r of data.rows) { const k = `${r.bucketStart}→${r.bucketEnd}`; keys.set(k, { start: r.bucketStart, end: r.bucketEnd }); }
    return Array.from(keys.entries()).map(([key, v]) => ({ key, ...v }));
  }, [data]);

  const rowsByPeriod = useMemo(() => {
    const m = new Map<string, FinanceRow>();
    if (!data) return m;
    for (const r of data.rows) { const pk = `${r.bucketStart}→${r.bucketEnd}`; m.set(`${pk}|${r.nmId}`, r); }
    return m;
  }, [data]);

  const availableNmIds = useMemo(() => {
    if (!data) return [] as number[];
    return Array.from(new Set(data.rows.map((r) => r.nmId))).sort((a, b) => a - b);
  }, [data]);

  useEffect(() => {
    if (!data) return;
    if (mergeProducts) { setChartNmId(0); return; }
    if (availableNmIds.length === 0) return;
    if (!availableNmIds.includes(chartNmId)) setChartNmId(availableNmIds[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, mergeProducts, availableNmIds.join(',')]);

  function fmtRub(n: number) { return numberFormat === 'short' ? formatRubShort(n) : formatRub(n); }

  const tableRows = useMemo(() => {
    return (data?.rows ?? []).slice().sort((a, b) => {
      const ak = `${a.bucketStart}→${a.bucketEnd}`;
      const bk = `${b.bucketStart}→${b.bucketEnd}`;
      if (ak !== bk) return ak < bk ? -1 : 1;
      return a.nmId - b.nmId;
    });
  }, [data?.rows]);

  const totals = useMemo(() => {
    if (!data) return null;
    const sum = (key: keyof FinanceRow['segments']) => data.rows.reduce((acc, r) => acc + (Number((r.segments as any)[key] ?? 0) || 0), 0);
    // Хранение: если есть полный итог из wb_storage_daily — используем его.
    const storageRub = storageTotalFromDailyRub != null ? storageTotalFromDailyRub : sum('storageRub');
    // Прочее/Промо/Штрафы — берём из shop-totals, потому что в товарной
    // таблице эти статьи приходят без nm_id и поэтому = 0. Только если
    // shop-totals НЕТ или 0, оставляем сумму по таблице.
    const otherHoldRub = shopTotals && shopTotals.otherHoldRub > 0 ? shopTotals.otherHoldRub : sum('otherHoldRub');
    const promotionRub = shopTotals && shopTotals.promotionRub > 0 ? shopTotals.promotionRub : 0;
    const penaltiesRub = shopTotals && shopTotals.penaltyRub > 0 ? shopTotals.penaltyRub : sum('penaltiesRub');
    return { revenueRub: sum('revenueRub'), incomeFromSalesRub: sum('incomeFromSalesRub'), commissionRub: sum('commissionRub'), logisticsRub: sum('logisticsRub'), returnLogisticsRub: sum('returnLogisticsRub'), paidAcceptanceRub: sum('paidAcceptanceRub'), storageRub, penaltiesRub, otherHoldRub, promotionRub, acquiringRub: sum('acquiringRub'), additionalPaymentsRub: sum('additionalPaymentsRub') };
  }, [data, storageTotalFromDailyRub, shopTotals]);

  function renderChart() {
    if (!data || periods.length === 0) return <div className="text-[11px] text-[var(--content-muted)]">Нет данных</div>;
    const currentNmId = mergeProducts ? 0 : chartNmId;
    const chartTotals: number[] = [];
    for (const p of periods) {
      const r = rowsByPeriod.get(`${p.key}|${currentNmId}`);
      if (!r) continue;
      const left = SEGMENTS_LEFT.reduce((acc, s) => acc + (Number(r.segments[s.key] ?? 0) || 0), 0);
      const right = SEGMENTS_RIGHT.reduce((acc, s) => acc + (Number(r.segments[s.key] ?? 0) || 0), 0);
      chartTotals.push(left, right);
    }
    const max = Math.max(1, ...chartTotals);
    const W = 980; const H = 260;
    const pad = { l: 40, r: 20, t: 10, b: 40 };
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;
    const groupCount = periods.length;
    const groupGap = 24; const columnGap = 10; const cols = 2;
    // F-009: clamp width to >=1 so SVG <rect> never gets a negative `width`
    // attribute (browsers spam DOMException on every render when N > ~28
    // periods, e.g. annual day-level view). The chart degrades to a stripe
    // gracefully — actual fix is virtualization / day-grouping in long ranges,
    // tracked as future work.
    const groupW = Math.max(2, (innerW - groupGap * Math.max(0, groupCount - 1)) / Math.max(1, groupCount));
    const barW = Math.max(1, (groupW - columnGap * (cols - 1)) / cols);
    const y = (v: number) => pad.t + innerH - (v / max) * innerH;

    return (
      <div className="relative">
        {hover ? (
          <div className="pointer-events-none absolute z-50 rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-xs text-[var(--content-text)] shadow-xl" style={{ left: hover.x + 12, top: hover.y + 12 }}>
            <div className="font-medium">{hover.segment}</div>
            <div className="mt-1 font-mono text-[11px]">{fmtRub(hover.value)}</div>
            {hover.pct !== undefined ? <div className="mt-0.5 text-[11px] text-[var(--content-muted)]">{hover.pct}%</div> : null}
            <div className="mt-1 text-[11px] text-[var(--content-muted)]">{hover.periodKey}</div>
          </div>
        ) : null}
        <svg width={W} height={H} className="w-full overflow-visible">
          <line x1={pad.l} y1={pad.t + innerH} x2={pad.l + innerW} y2={pad.t + innerH} stroke="#e2e8f0" />
          <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + innerH} stroke="#e2e8f0" />
          {periods.map((p, gi) => {
            const gx = pad.l + gi * (groupW + groupGap);
            const r = rowsByPeriod.get(`${p.key}|${currentNmId}`);
            if (!r) return null;
            const columns: Array<{ kind: 'left' | 'right'; segs: any; x: number }> = [
              { kind: 'left', segs: SEGMENTS_LEFT, x: gx },
              { kind: 'right', segs: SEGMENTS_RIGHT, x: gx + barW + columnGap },
            ];
            return columns.flatMap((c) => {
              let acc = 0;
              return c.segs.map((s: any) => {
                const key = s.key as keyof FinanceRow['segments'];
                const v = Number((r.segments as any)[key] ?? 0) || 0;
                const y1 = y(acc + v); const h = y(acc) - y1;
                const rect = (
                  <rect key={`${p.key}-${c.kind}-${String(s.key)}`} x={c.x} y={y1} width={barW} height={Math.max(0, h)} fill={s.color}
                    onMouseMove={(ev) => {
                      const pctMap = r.segments.pct || ({} as any);
                      const pctKey = s.key === 'incomeFromSalesRub' ? 'incomeFromSales' : s.key === 'additionalPaymentsRub' ? 'additionalPayments' : s.key === 'commissionRub' ? 'commission' : s.key === 'logisticsRub' ? 'logistics' : s.key === 'returnLogisticsRub' ? 'returnLogistics' : s.key === 'paidAcceptanceRub' ? 'paidAcceptance' : s.key === 'storageRub' ? 'storage' : s.key === 'penaltiesRub' ? 'penalties' : s.key === 'otherHoldRub' ? 'otherHold' : s.key === 'acquiringRub' ? 'acquiring' : undefined;
                      setHover({ periodKey: p.key, segment: s.title, value: v, pct: pctKey ? (pctMap as any)[pctKey] : undefined, x: ev.clientX, y: ev.clientY });
                    }}
                    onMouseLeave={() => setHover(null)}
                  />
                );
                acc += v; return rect;
              });
            });
          })}
          {periods.map((p, gi) => {
            const gx = pad.l + gi * (groupW + groupGap);
            const label = groupBy === 'week' ? `${p.start} – ${p.end}` : p.start;
            const step = periods.length > 20 ? Math.ceil(periods.length / 10) : periods.length > 10 ? 2 : 1;
            if (gi % step !== 0) return null;
            return <text key={`label-${p.key}`} x={gx + groupW / 2} y={H - 18} textAnchor="middle" fontSize={11} fill="#94a3b8">{label}</text>;
          })}
        </svg>
        {data.rows.length > 0 ? <div className="mt-2 text-[11px] text-[var(--content-muted)]">{mergeProducts ? 'Показан сводный график по всем товарам.' : `Показан график для арт. ${currentNmId}.`} Детали — в таблице ниже.</div> : null}
      </div>
    );
  }

  if (workspaceId === null) {
    return (
      <AppShell title="Финансы">
        <div className="p-6">
          <Card className="p-8 text-center text-[var(--content-muted)]">
            Выберите магазин для просмотра финансов
          </Card>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Финансы">
      {/* Per-stream sync freshness for the finance page. See
          plan v2 D2: финансовые данные идут двумя потоками — daily
          aggregate (`finance-daily`) и per-product realization
          (`finance` stage inside refresh). */}
      <div className="flex flex-wrap gap-2 mb-4">
        <SyncFreshnessBadge stage="finance-daily" label="Финансы (ДДС)" />
        <SyncFreshnessBadge stage="finance" label="Финансы (товары)" />
        <SyncFreshnessBadge stage="spp" label="СПП" />
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 mb-4 border-b border-gray-200 pb-3">
        <button
          onClick={() => setActiveTab('reports')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            activeTab === 'reports'
              ? 'bg-indigo-50 text-indigo-700'
              : 'text-gray-500 hover:bg-gray-100'
          )}
        >
          <FileText className="h-4 w-4" />
          Отчёты ВБ
        </button>
        <button
          onClick={() => setActiveTab('by_product')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            activeTab === 'by_product'
              ? 'bg-indigo-50 text-indigo-700'
              : 'text-gray-500 hover:bg-gray-100'
          )}
        >
          <Package className="h-4 w-4" />
          По артикулам
        </button>
        <button
          onClick={() => setActiveTab('adv')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            activeTab === 'adv'
              ? 'bg-indigo-50 text-indigo-700'
              : 'text-gray-500 hover:bg-gray-100'
          )}
        >
          <Megaphone className="h-4 w-4" />
          Реклама
        </button>
        <button
          onClick={() => setActiveTab('deductions')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            activeTab === 'deductions'
              ? 'bg-indigo-50 text-indigo-700'
              : 'text-gray-500 hover:bg-gray-100'
          )}
        >
          <AlertTriangle className="h-4 w-4" />
          Штрафы
        </button>
        <button
          onClick={() => setActiveTab('storage')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            activeTab === 'storage'
              ? 'bg-indigo-50 text-indigo-700'
              : 'text-gray-500 hover:bg-gray-100'
          )}
        >
          <Warehouse className="h-4 w-4" />
          Хранение
        </button>
        <button
          onClick={() => setActiveTab('documents')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            activeTab === 'documents'
              ? 'bg-indigo-50 text-indigo-700'
              : 'text-gray-500 hover:bg-gray-100'
          )}
        >
          <FileText className="h-4 w-4" />
          Документы
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'reports' && (
        <ReportsTab
          workspaceId={workspaceId}
          shopId={shopParam ? Number(new URLSearchParams(shopParam.slice(1)).get('shopId')) || undefined : undefined}
          start={start}
          end={end}
          onDateChange={(s, e) => { setStart(s); setEnd(e); }}
        />
      )}
      {activeTab === 'by_product' && (
        <ByProductTab workspaceId={workspaceId} shopId={shopParam ? Number(new URLSearchParams(shopParam.slice(1)).get('shopId')) || undefined : undefined} start={start} end={end} />
      )}
      {activeTab === 'adv' && (
        <AdvExpensesTab workspaceId={workspaceId} shopId={shopParam ? Number(new URLSearchParams(shopParam.slice(1)).get('shopId')) || undefined : undefined} start={start} end={end} />
      )}
      {activeTab === 'deductions' && (
        <DeductionsTab
          workspaceId={workspaceId!}
          shopId={shopParam ? Number(new URLSearchParams(shopParam.slice(1)).get('shopId')) || undefined : undefined}
          start={start}
          end={end}
        />
      )}
      {activeTab === 'storage' && (
        <StorageTab
          workspaceId={workspaceId!}
          shopId={shopParam ? Number(new URLSearchParams(shopParam.slice(1)).get('shopId')) || undefined : undefined}
          start={start}
          end={end}
        />
      )}
      {activeTab === 'documents' && <DocumentsTab workspaceId={workspaceId} />}

      {activeTab === 'overview' && (
      <>
      {/* Filters — на mobile сворачивается в кнопку + BottomSheet */}
      <ResponsiveFilterCard
        title="Фильтры"
        summary={`${start} — ${end}${tagId ? ` · тег #${tagId}` : ''}${nmId ? ` · артикул ${nmId}` : ''}`}
        activeCount={(tagId ? 1 : 0) + (nmId ? 1 : 0)}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-medium text-[var(--content-text)]">Фильтры</div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-medium text-[var(--content-muted)]">Тег</span>
              <TagFilter
                tags={tags}
                value={tagId}
                onChange={setTagId}
                placeholder="Все товары"
                className="w-40"
                size="sm"
              />
            </div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <label className="block text-xs font-medium text-[var(--content-muted)]">Период</label>
            <div className="mt-1">
              <DateRangePicker
                dateFrom={start}
                dateTo={end}
                onDateFromChange={setStart}
                onDateToChange={setEnd}
              />
            </div>
          </div>
          <div></div>
        </div>

        <div className="mt-3">
          <label className="block text-xs font-medium text-[var(--content-muted)]">Артикулы WB</label>
          <ProductSearchInput
            workspaceId={workspaceId}
            value={nmId}
            onChange={setNmId}
            className="mt-1"
            placeholder="Поиск по названию / артикулу..."
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <ToggleGroup type="single" value={groupBy} onValueChange={(v) => v && setGroupBy(v as 'day' | 'week')}>
            <ToggleGroupItem value="day">День</ToggleGroupItem>
            <ToggleGroupItem value="week">Неделя</ToggleGroupItem>
          </ToggleGroup>

          <label className="flex items-center gap-2 text-xs text-[var(--content-muted)]">
            <input type="checkbox" checked={mergeProducts} onChange={(e) => setMergeProducts(e.target.checked)} className="accent-indigo-600" />
            Объединить товары
          </label>

          <ToggleGroup type="single" value={numberFormat} onValueChange={(v) => v && setNumberFormat(v as 'full' | 'short')}>
            <ToggleGroupItem value="full">Полный</ToggleGroupItem>
            <ToggleGroupItem value="short">Кратко</ToggleGroupItem>
          </ToggleGroup>

          <Button onClick={load} disabled={loading} loading={loading}>
            <RefreshCw className="h-4 w-4" /> {loading ? 'Загрузка…' : 'Обновить'}
          </Button>
          {error ? <div className="text-xs text-red-500">{error}</div> : null}
        </div>
      </ResponsiveFilterCard>

      {/* KPI Cards — крупные плашки с категориями расходов (2026-06-01) */}
      {totals && (() => {
        const wbHoldRub =
          totals.commissionRub + totals.logisticsRub + totals.returnLogisticsRub +
          totals.paidAcceptanceRub + totals.storageRub + totals.acquiringRub + totals.otherHoldRub;
        const netRub = totals.incomeFromSalesRub - totals.penaltiesRub;
        return (
          <div className="mt-6 rounded-xl border bg-white shadow-sm">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-gray-100 rounded-t-xl overflow-hidden">
              <FinKpi label="Выручка"     value={totals.revenueRub}        hint="Сумма продаж" tone="neutral" />
              <FinKpi label="К перечислению" value={totals.incomeFromSalesRub} hint="После комиссии WB" tone="positive" />
              <FinKpi label="Удержания WB"  value={wbHoldRub}                hint="Комиссия + лог. + хран." tone="negative" />
              <FinKpi label="Штрафы"       value={totals.penaltiesRub}      hint={totals.penaltiesRub > 0 ? 'Срочно проверь' : 'нет штрафов'} tone={totals.penaltiesRub > 0 ? 'danger' : 'muted'} />
            </div>
            {/* Расшифровка удержаний — раскрытая снизу */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-gray-100">
              <FinMini label="Комиссия"      value={totals.commissionRub} />
              <FinMini label="Логистика"     value={totals.logisticsRub + totals.returnLogisticsRub} />
              <FinMini label="Хранение"      value={totals.storageRub} hint={totals.storageRub === 0 ? 'Полная сумма — в отдельном отчёте «Хранение»' : undefined} />
              <FinMini label="Приёмка + эквайринг" value={totals.paidAcceptanceRub + totals.acquiringRub} />
            </div>
            {totals.additionalPaymentsRub !== 0 && (
              <div className="px-3 py-2 border-t bg-amber-50/40 text-xs">
                Дополнительные выплаты от WB: <span className="font-medium">{fmtRub(totals.additionalPaymentsRub)} ₽</span>
              </div>
            )}
          </div>
        );
      })()}

      {/* External Costs Card */}
      <Card className="mt-4 p-4 bg-slate-50 border-dashed">
        <div className="text-sm font-medium text-[var(--content-text)] mb-3">Расходы вне маркетплейса</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
          <div>
            <div className="text-xs text-[var(--content-muted)]">Реклама WB</div>
            <div className="mt-1 font-mono text-sm text-amber-700">{advSpendTotal != null ? fmtRub(advSpendTotal) + ' ₽' : '— ₽'}</div>
            <div className="text-[10px] text-[var(--content-muted)]">Расходы на рекламу за период</div>
          </div>
          <div>
            <div className="text-xs text-[var(--content-muted)]">Себестоимость</div>
            <div className="mt-1 font-mono text-sm text-blue-600">{cogsTotal != null ? fmtRub(cogsTotal) + ' ₽' : '— ₽'}</div>
            {cogsGap && cogsGap.withoutCogs > 0 ? (
              <a
                href="/cogs"
                className="mt-1 inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-100"
                title={`${cogsGap.withoutCogs} артикулов без себестоимости из ${cogsGap.total} (покрытие ${cogsGap.coveragePct}%)`}
              >
                ⚠️ {cogsGap.withoutCogs} SKU без себестоимости — заполнить →
              </a>
            ) : (
              <div className="text-[10px] text-[var(--content-muted)]">Из справочника COGS</div>
            )}
          </div>
          <div>
            <div className="text-xs text-[var(--content-muted)]">Налоги (расчёт)</div>
            <div className="mt-1 font-mono text-sm text-orange-700">
              {totals ? fmtRub(Math.max(0, (totals.incomeFromSalesRub - (advSpendTotal ?? 0) - (cogsTotal ?? 0)) * 0.15)) + ' ₽' : '— ₽'}
            </div>
            <div className="text-[10px] text-[var(--content-muted)]">≈15% от прибыли (УСН)</div>
          </div>
        </div>
      </Card>

      {/* Chart nmId selector */}
      {!mergeProducts && availableNmIds.length > 1 ? (
        <div className="mt-4">
          <label className="flex items-center gap-2 text-xs text-[var(--content-muted)]">
            График для артикула
            <select className={selectCls} value={chartNmId} onChange={(e) => setChartNmId(Number(e.target.value) || 0)}>
              {availableNmIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
        </div>
      ) : null}

      {/* Chart */}
      <Card className="mt-6 p-4">{renderChart()}</Card>

      {/* Data Table */}
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium text-[var(--content-text)]">Таблица</div>
          <ExportButton
            title={`Финансы ${start} – ${end}`}
            subtitle={`Магазин · период ${start} – ${end}${mergeProducts ? ' · товары объединены' : ''}`}
            columns={FINANCE_EXPORT_COLUMNS}
            rows={(data?.rows ?? []).map((r) => ({
              period: r.bucketStart === r.bucketEnd ? r.bucketStart : `${r.bucketStart} – ${r.bucketEnd}`,
              nmId: r.nmId,
              vendorCode: r.vendorCode ?? '',
              revenueRub: r.segments.revenueRub,
              incomeFromSalesRub: r.segments.incomeFromSalesRub,
              commissionRub: r.segments.commissionRub,
              logisticsRub: r.segments.logisticsRub,
              storageRub: r.segments.storageRub,
              penaltiesRub: r.segments.penaltiesRub,
              otherHoldRub: r.segments.otherHoldRub,
              acquiringRub: r.segments.acquiringRub,
              additionalPaymentsRub: r.segments.additionalPaymentsRub,
            }))}
          />
        </div>
        <Card className="overflow-hidden p-0">
          <div className="overflow-auto">
            <table className="min-w-[900px] w-full border-collapse text-xs">
              <thead className="bg-[var(--table-header-bg)]">
                <tr className="text-[var(--content-muted)]">
                  <th className="border-b border-[var(--table-border)] p-2.5 text-left text-xs font-medium uppercase tracking-wide">Период</th>
                  <th className="border-b border-[var(--table-border)] p-2.5 text-left text-xs font-medium uppercase tracking-wide">Товар</th>
                  <th className="border-b border-[var(--table-border)] p-2.5 text-right text-xs font-medium uppercase tracking-wide">Выручка</th>
                  <th className="border-b border-[var(--table-border)] p-2.5 text-right text-xs font-medium uppercase tracking-wide">К перечислению</th>
                  <th className="border-b border-[var(--table-border)] p-2.5 text-right text-xs font-medium uppercase tracking-wide">Комиссия</th>
                  <th className="border-b border-[var(--table-border)] p-2.5 text-right text-xs font-medium uppercase tracking-wide">Логистика</th>
                  <th className="border-b border-[var(--table-border)] p-2.5 text-right text-xs font-medium uppercase tracking-wide">Хранение</th>
                  <th className="border-b border-[var(--table-border)] p-2.5 text-right text-xs font-medium uppercase tracking-wide">Штрафы</th>
                  <th className="border-b border-[var(--table-border)] p-2.5 text-right text-xs font-medium uppercase tracking-wide">Прочие</th>
                  <th className="border-b border-[var(--table-border)] p-2.5 text-right text-xs font-medium uppercase tracking-wide">Эквайринг</th>
                  <th className="border-b border-[var(--table-border)] p-2.5 text-right text-xs font-medium uppercase tracking-wide">Доп. выплаты</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r) => (
                  <tr key={`${r.bucketStart}-${r.nmId}`} className="transition-colors hover:bg-[var(--table-row-hover)]">
                    <td className="border-b border-[var(--table-border)] p-2.5 text-[var(--content-muted)]">{r.bucketStart}{r.bucketEnd !== r.bucketStart ? ` → ${r.bucketEnd}` : ''}</td>
                    <td className="border-b border-[var(--table-border)] p-2.5">
                      <div className="flex items-start gap-2 min-w-[260px]">
                        {(r as any).mainPhotoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={(r as any).mainPhotoUrl} alt="" className="w-10 h-10 rounded object-cover bg-gray-100 shrink-0" />
                        ) : (
                          <div className="w-10 h-10 rounded bg-gray-100 shrink-0" />
                        )}
                        <div className="min-w-0">
                          {(r as any).title && (
                            <div className="text-xs text-[var(--content-text)] truncate max-w-[240px]" title={(r as any).title}>{(r as any).title}</div>
                          )}
                          <div className="text-[11px] text-[var(--content-muted)] mt-0.5 flex items-center gap-2">
                            <NmIdLink nmId={r.nmId} />
                            {r.vendorCode && <span>· {r.vendorCode}</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="border-b border-[var(--table-border)] p-2.5 text-right font-mono">{fmtRub(r.segments.revenueRub ?? 0)}</td>
                    <td className="border-b border-[var(--table-border)] p-2.5 text-right font-mono">{fmtRub(r.segments.incomeFromSalesRub ?? 0)}</td>
                    <td className="border-b border-[var(--table-border)] p-2.5 text-right font-mono">{fmtRub(r.segments.commissionRub ?? 0)}</td>
                    <td className="border-b border-[var(--table-border)] p-2.5 text-right font-mono">{fmtRub(r.segments.logisticsRub ?? 0)}</td>
                    <td className="border-b border-[var(--table-border)] p-2.5 text-right font-mono">{fmtRub(r.segments.storageRub ?? 0)}</td>
                    <td className="border-b border-[var(--table-border)] p-2.5 text-right font-mono">{fmtRub(r.segments.penaltiesRub ?? 0)}</td>
                    <td className="border-b border-[var(--table-border)] p-2.5 text-right font-mono">{fmtRub(r.segments.otherHoldRub ?? 0)}</td>
                    <td className="border-b border-[var(--table-border)] p-2.5 text-right font-mono">{fmtRub(r.segments.acquiringRub ?? 0)}</td>
                    <td className="border-b border-[var(--table-border)] p-2.5 text-right font-mono">{fmtRub(r.segments.additionalPaymentsRub ?? 0)}</td>
                  </tr>
                ))}
                {!data || data.rows.length === 0 ? (
                  <tr><td className="p-8 text-center text-sm text-[var(--content-muted)]" colSpan={11}>
                    <div>Нет данных за выбранный период.</div>
                    <div className="mt-1 text-xs text-gray-400">Расширьте даты сверху или сбросьте фильтры.</div>
                  </td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
        <div className="mt-2 text-[11px] text-[var(--content-muted)]">
          Данные берутся с ежедневных отчётов WB.
        </div>
      </div>

      </>
      )}

      {/* AI Analyze Button — доступна на любом табе финансов */}
      <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-30">
        <AiAnalyzeButton
          context={{ page: 'finance', tab: activeTab, dateFrom: start, dateTo: end, shopId: shopParam ? Number(new URLSearchParams(shopParam.slice(1)).get('shopId')) || undefined : undefined }}
          prompt="Проанализируй финансовые данные"
          label="Обсудить с ИИ"
        />
      </div>
    </AppShell>
  );
}

/** Главная KPI-плашка финансового дашборда. */
function FinKpi({ label, value, hint, tone }: {
  label: string;
  value: number;
  hint?: string;
  tone: 'neutral' | 'positive' | 'negative' | 'danger' | 'muted';
}) {
  const toneColor =
    tone === 'positive' ? 'text-emerald-600' :
    tone === 'negative' ? 'text-orange-700' :
    tone === 'danger'   ? 'text-red-600' :
    tone === 'muted'    ? 'text-gray-500' :
                          'text-gray-900';
  const rub = new Intl.NumberFormat('ru-RU').format(Math.round(value)) + ' ₽';
  return (
    <div className="bg-white px-3 py-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-xl font-semibold mt-1 tabular-nums ${toneColor}`}>{rub}</div>
      {hint && <div className="text-[11px] text-gray-400 mt-0.5">{hint}</div>}
    </div>
  );
}

/** Мини-плашка под главным KPI — расшифровка удержаний. */
function FinMini({ label, value, hint }: { label: string; value: number; hint?: string }) {
  const rub = new Intl.NumberFormat('ru-RU').format(Math.round(value)) + ' ₽';
  return (
    <div className="bg-white px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider text-gray-400">{label}</div>
      <div className="text-sm font-medium text-gray-700 mt-0.5 tabular-nums">{rub}</div>
      {hint && <div className="text-[10px] text-amber-700 mt-0.5">{hint}</div>}
    </div>
  );
}
