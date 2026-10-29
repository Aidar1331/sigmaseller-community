'use client';

import { useShopChange } from '@/hooks/useShopChange';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Warehouse, MapPin, ChevronDown, ChevronRight } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatNumber, formatPct, formatRub } from '@/lib/format';
import { useWorkspaceStore } from '@/store/workspace';
import { TagFilter, type TagOption } from '@/components/ui/TagFilter';

import { ProductSearchInput } from '@/components/ui/ProductSearchInput';
import { SupplyRecommendations } from '@/components/agents/SupplyRecommendations';
import { ExportButton } from '@/components/ui/ExportButton';
import type { ExportColumn } from '@/lib/exportTable';

const WAREHOUSE_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'warehouseName', label: 'Склад', type: 'text' },
  { key: 'ordersCount', label: 'Заказы, шт.', type: 'number' },
  { key: 'ordersRub', label: 'Выручка', type: 'rub' },
  { key: 'salesCount', label: 'Продажи, шт.', type: 'number' },
  { key: 'salesRub', label: 'Продажи, ₽', type: 'rub' },
  { key: 'forPayRub', label: 'К перечислению', type: 'rub' },
  { key: 'stockQty', label: 'Остаток, шт.', type: 'number' },
  { key: 'stockCostRub', label: 'Стоимость остатка', type: 'rub' },
  { key: 'daysOfStock', label: 'Дней хватит', type: 'number' },
  { key: 'sharePercent', label: 'Доля, %', type: 'pct' },
];

const REGION_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'regionName', label: 'Регион', type: 'text' },
  { key: 'cluster', label: 'Кластер', type: 'text' },
  { key: 'ordersCount', label: 'Заказы, шт.', type: 'number' },
  { key: 'ordersRub', label: 'Выручка', type: 'rub' },
  { key: 'salesCount', label: 'Продажи, шт.', type: 'number' },
  { key: 'salesRub', label: 'Продажи, ₽', type: 'rub' },
  { key: 'sharePercent', label: 'Доля, %', type: 'pct' },
  { key: 'benchmark', label: 'Бенчмарк', type: 'number' },
  { key: 'potential', label: 'Потенциал', type: 'number' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WarehouseRow = {
  warehouseName: string;
  ordersCount: number;
  ordersRub: number;
  salesCount: number;
  salesRub: number;
  forPayRub: number;
  stockQty: number;
  stockCostRub: number;
  daysOfStock: number | null;
  sharePercent: number;
};

type RegionRow = {
  regionName: string;
  ordersCount: number;
  ordersRub: number;
  salesCount: number;
  salesRub: number;
  forPayRub: number;
  sharePercent: number;
  cluster?: string;
  benchmark?: number;
  potential?: number;
};

type Response = {
  workspaceId: number;
  from: string;
  to: string;
  totalOrdersCount: number;
  totalOrdersRub: number;
  warehouses: WarehouseRow[];
  regions: RegionRow[];
};

type WarehouseProductRow = {
  nmId: number;
  vendorCode: string | null;
  title: string | null;
  ordersCount: number;
  salesCount: number;
  stockQty: number;
  buyoutPct: number;
};

function isoDate(d: Date): string {
  // Используем локальное время, не UTC (иначе в MSK сдвигает на день назад)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

const QUICK_PERIODS = [14, 30, 60, 90] as const;

function formatDays(v: number | null) {
  if (v === null || !Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(v);
}

export default function WarehousesAnalyticsPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopId = useWorkspaceStore((s) => s.shopId);

  const today = useMemo(() => isoDate(new Date()), []);
  const defaultFrom = useMemo(() => isoDate(addDays(new Date(), -30)), []);

  const [dateFrom, setDateFrom] = useState(defaultFrom);
  const [dateTo, setDateTo] = useState(today);
  const [tagId, setTagId] = useState<number | null>(null);
  const [tags, setTags] = useState<TagOption[]>([]);
  const [nmId, setNmId] = useState<string>('');
  const [view, setView] = useState<'warehouses' | 'regions'>('warehouses');

  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Warehouse expansion
  const [expandedWarehouse, setExpandedWarehouse] = useState<string | null>(null);
  const [warehouseProducts, setWarehouseProducts] = useState<WarehouseProductRow[]>([]);
  const [warehouseProductsLoading, setWarehouseProductsLoading] = useState(false);

  // Region expansion for product details
  const [expandedRegion, setExpandedRegion] = useState<string | null>(null);
  const [regionProducts, setRegionProducts] = useState<WarehouseProductRow[]>([]);
  const [regionProductsLoading, setRegionProductsLoading] = useState(false);

  const loadRegionProducts = useCallback(async (regionName: string) => {
    if (!workspaceId) return;
    setRegionProductsLoading(true);
    try {
      const shopQs = shopId ? `&shopId=${shopId}` : '';
      const res: any = await apiFetch(
        `/analytics/${workspaceId}/regions/${encodeURIComponent(regionName)}/products?from=${dateFrom}&to=${dateTo}${shopQs}`
      );
      setRegionProducts(res.products ?? res.rows ?? []);
    } catch (e) {
      console.error('Failed to load region products:', e);
      setRegionProducts([]);
    } finally {
      setRegionProductsLoading(false);
    }
  }, [workspaceId, dateFrom, dateTo, shopId]);

  // Load tags
  useEffect(() => {
    apiFetch(`/tags/${workspaceId}`)
      .then((res: any) => setTags(res.rows ?? []))
      .catch(() => setTags([]));
  }, [workspaceId]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set('from', dateFrom);
      qs.set('to', dateTo);
      if (tagId) qs.set('tagId', String(tagId));
      const nmIdNum = Number.parseInt(nmId.trim(), 10);
      if (Number.isFinite(nmIdNum) && nmIdNum > 0) qs.set('nmId', String(nmIdNum));
      if (shopId) qs.set('shopId', String(shopId));
      const res = (await apiFetch(`/analytics/${workspaceId}/warehouses?${qs.toString()}`)) as Response;
      setData(res);
    } catch (e: any) {
      setData(null);
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, dateFrom, dateTo, tagId, nmId, shopId]);

  useEffect(() => {
    loadData();
  }, [loadData]);
  useShopChange(loadData);

  // Load products for expanded warehouse
  const loadWarehouseProducts = useCallback(async (warehouseName: string) => {
    if (expandedWarehouse === warehouseName) {
      setExpandedWarehouse(null);
      setWarehouseProducts([]);
      return;
    }
    setExpandedWarehouse(warehouseName);
    setWarehouseProductsLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set('from', dateFrom);
      qs.set('to', dateTo);
      if (shopId) qs.set('shopId', String(shopId));
      const res = await apiFetch(
        `/analytics/${workspaceId}/warehouses/${encodeURIComponent(warehouseName)}/products?${qs.toString()}`
      ) as { rows: WarehouseProductRow[] };
      setWarehouseProducts(res.rows ?? []);
    } catch (e) {
      console.error('Failed to load warehouse products:', e);
      setWarehouseProducts([]);
    } finally {
      setWarehouseProductsLoading(false);
    }
  }, [workspaceId, dateFrom, dateTo, expandedWarehouse, shopId]);

  function handleQuick(days: number) {
    const end = new Date();
    const start = addDays(end, -days);
    setDateFrom(isoDate(start));
    setDateTo(isoDate(end));
  }

  const warehouses = data?.warehouses ?? [];
  const regions = data?.regions ?? [];

  const totalOrdersCount = data?.totalOrdersCount ?? 0;
  const totalOrdersRub = data?.totalOrdersRub ?? 0;
  const totalStockCost = warehouses.reduce((sum, w) => sum + w.stockCostRub, 0);
  const totalStockQty = warehouses.reduce((sum, w) => sum + w.stockQty, 0);

  if (workspaceId === null) {
    return (
      <AppShell title="Склады и регионы">
        <div className="p-6">
          <Card className="p-8 text-center text-[var(--content-muted)]">
            Выберите магазин для просмотра аналитики
          </Card>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Склады и регионы">
      <div className="p-6 space-y-6">
        {/* AI Supply recommendations — показываем здесь, это ближе к остаткам/складам */}
        <SupplyRecommendations workspaceId={workspaceId} shopId={shopId} />

        {/* Filters */}
        <Card className="p-5">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[var(--content-muted)]">Тег</label>
              <TagFilter
                tags={tags}
                value={tagId}
                onChange={setTagId}
                placeholder="Все теги"
                className="w-44"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[var(--content-muted)]">Товар</label>
              <ProductSearchInput
                workspaceId={workspaceId}
                value={nmId}
                onChange={setNmId}
                placeholder="Поиск товара..."
                single
                className="w-56"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[var(--content-muted)]">Период</label>
              <div className="flex items-center gap-2">
                <DateRangePicker
                  dateFrom={dateFrom}
                  dateTo={dateTo}
                  onDateFromChange={setDateFrom}
                  onDateToChange={setDateTo}
                />
                <div className="flex items-center gap-1">
                  {QUICK_PERIODS.map((days) => (
                    <button
                      key={days}
                      type="button"
                      onClick={() => handleQuick(days)}
                      className="h-9 rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 text-sm text-[var(--content-muted)] hover:bg-slate-50 hover:text-[var(--content-text)] transition-colors"
                    >
                      {days}д
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="ml-auto">
              <Button variant="neutral" onClick={loadData} loading={loading}>
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                Обновить
              </Button>
            </div>
          </div>

          {error && (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">
              {error}
            </div>
          )}
        </Card>

        {/* Summary Cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="p-5">
            <div className="text-sm text-[var(--content-muted)]">Заказы</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(totalOrdersCount)}</div>
            <div className="mt-1 text-xs text-[var(--content-subtle)]">за период</div>
          </Card>
          <Card className="p-5">
            <div className="text-sm text-[var(--content-muted)]">Выручка заказов</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{formatRub(totalOrdersRub / 100)} ₽</div>
            <div className="mt-1 text-xs text-[var(--content-subtle)]">за период</div>
          </Card>
          <Card className="p-5">
            <div className="text-sm text-[var(--content-muted)]">Остатки</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(totalStockQty)}</div>
            <div className="mt-1 text-xs text-[var(--content-subtle)]">единиц на складах</div>
          </Card>
          <Card className="p-5">
            <div className="text-sm text-[var(--content-muted)]">Средний выкуп</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {(() => {
                if (!data?.warehouses?.length) return '—';
                const totalOrders = data.warehouses.reduce((a, w) => a + w.ordersCount, 0);
                const totalSales = data.warehouses.reduce((a, w) => a + w.salesCount, 0);
                return totalOrders > 0 ? formatPct((totalSales / totalOrders) * 100) : '0';
              })()}%
            </div>
            <div className="mt-1 text-xs text-[var(--content-subtle)]">процент выкупов</div>
          </Card>
        </div>

        {/* Data Table */}
        <Card className="p-5">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--bg-subtle)]">
              <button
                type="button"
                onClick={() => setView('warehouses')}
                className={cn(
                  'flex items-center gap-2 h-9 rounded-md px-4 text-sm font-medium transition-all',
                  view === 'warehouses'
                    ? 'bg-white text-[var(--content-text)] shadow-sm'
                    : 'text-[var(--content-muted)] hover:text-[var(--content-text)]'
                )}
              >
                <Warehouse className="h-4 w-4" />
                По складам
              </button>
              <button
                type="button"
                onClick={() => setView('regions')}
                className={cn(
                  'flex items-center gap-2 h-9 rounded-md px-4 text-sm font-medium transition-all',
                  view === 'regions'
                    ? 'bg-white text-[var(--content-text)] shadow-sm'
                    : 'text-[var(--content-muted)] hover:text-[var(--content-text)]'
                )}
              >
                <MapPin className="h-4 w-4" />
                По регионам
              </button>
            </div>
            
            <div className="flex items-center gap-3">
              <div className="text-sm text-[var(--content-muted)]">
                {view === 'warehouses' ? `${warehouses.length} складов` : `${regions.length} регионов`}
              </div>
              <ExportButton
                title={view === 'warehouses' ? `Склады ${dateFrom} – ${dateTo}` : `Регионы ${dateFrom} – ${dateTo}`}
                subtitle={`Период: ${dateFrom} – ${dateTo}`}
                columns={view === 'warehouses' ? WAREHOUSE_EXPORT_COLUMNS : REGION_EXPORT_COLUMNS}
                rows={view === 'warehouses' ? warehouses : regions}
              />
            </div>
          </div>

          {view === 'warehouses' ? (
            <div className="overflow-auto -mx-5 px-5">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--card-border)] text-[var(--content-muted)]">
                    <th className="py-3 pr-4 text-left font-medium">Склад</th>
                    <th className="py-3 px-4 text-right font-medium">Заказы</th>
                    <th className="py-3 px-4 text-right font-medium">Выручка</th>
                    <th className="py-3 px-4 text-right font-medium">% выкупа</th>
                    <th className="py-3 px-4 text-right font-medium">Доля</th>
                    <th className="py-3 px-4 text-right font-medium">Остаток</th>
                    <th className="py-3 px-4 text-right font-medium">Стоимость</th>
                    <th className="py-3 pl-4 text-right font-medium">Дней запаса</th>
                  </tr>
                </thead>
                <tbody>
                  {warehouses.map((row) => {
                    const isExpanded = expandedWarehouse === row.warehouseName;
                    const buyoutPct = Math.min(row.ordersCount > 0 ? (row.salesCount / row.ordersCount) * 100 : 0, 100);
                    return (
                      <React.Fragment key={row.warehouseName}>
                        <tr 
                          className="border-b border-[var(--card-border)] hover:bg-[var(--bg-subtle)] transition-colors cursor-pointer"
                          onClick={() => loadWarehouseProducts(row.warehouseName)}
                        >
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-2">
                              {isExpanded ? <ChevronDown className="h-4 w-4 text-gray-500" /> : <ChevronRight className="h-4 w-4 text-gray-500" />}
                              <span className="font-medium text-[var(--content-text)]">{row.warehouseName}</span>
                            </div>
                          </td>
                          <td className="py-3 px-4 text-right tabular-nums">{formatNumber(row.ordersCount)}</td>
                          <td className="py-3 px-4 text-right tabular-nums">{formatRub(row.ordersRub / 100)} ₽</td>
                          <td className="py-3 px-4 text-right tabular-nums">
                            <span className={cn(
                              buyoutPct >= 70 && 'text-emerald-600',
                              buyoutPct >= 50 && buyoutPct < 70 && 'text-amber-500',
                              buyoutPct < 50 && 'text-rose-500'
                            )}>
                              {formatPct(buyoutPct)}%
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <div className="w-16 h-1.5 rounded-full bg-[var(--bg-muted)] overflow-hidden">
                                <div 
                                  className="h-full rounded-full bg-indigo-500" 
                                  style={{ width: `${Math.min(100, row.sharePercent)}%` }}
                                />
                              </div>
                              <span className="tabular-nums text-[var(--content-muted)] w-12 text-right">{formatPct(row.sharePercent)}%</span>
                            </div>
                          </td>
                          <td className="py-3 px-4 text-right tabular-nums">{formatNumber(row.stockQty)}</td>
                          <td className="py-3 px-4 text-right tabular-nums">{formatRub(row.stockCostRub)} ₽</td>
                          <td className="py-3 pl-4 text-right">
                            <span className={cn(
                              'tabular-nums',
                              row.daysOfStock !== null && row.daysOfStock < 7 && 'text-rose-500 font-medium',
                              row.daysOfStock !== null && row.daysOfStock >= 7 && row.daysOfStock < 14 && 'text-amber-500',
                              row.daysOfStock !== null && row.daysOfStock >= 14 && 'text-emerald-600'
                            )}>
                              {formatDays(row.daysOfStock)}
                            </span>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={8} className="bg-slate-50 p-4">
                              {warehouseProductsLoading ? (
                                <div className="text-sm text-gray-500">Загрузка товаров...</div>
                              ) : warehouseProducts.length === 0 ? (
                                <div className="text-sm text-gray-500">Нет товаров</div>
                              ) : (
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-gray-500">
                                      <th className="py-1 text-left">Артикул</th>
                                      <th className="py-1 text-left">Товар</th>
                                      <th className="py-1 text-right">Заказы</th>
                                      <th className="py-1 text-right">Продажи</th>
                                      <th className="py-1 text-right">% выкупа</th>
                                      <th className="py-1 text-right">Остаток</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {warehouseProducts.slice(0, 20).map((p) => (
                                      <tr key={p.nmId} className="border-t border-gray-100">
                                        <td className="py-1.5 font-mono text-gray-600"><NmIdLink nmId={p.nmId} /></td>
                                        <td className="py-1.5 text-gray-700 truncate max-w-[200px]">{p.vendorCode || p.title || '—'}</td>
                                        <td className="py-1.5 text-right tabular-nums">{p.ordersCount}</td>
                                        <td className="py-1.5 text-right tabular-nums">{p.salesCount}</td>
                                        <td className="py-1.5 text-right tabular-nums">
                                          <span className={cn(
                                            p.buyoutPct >= 70 && 'text-emerald-600',
                                            p.buyoutPct >= 50 && p.buyoutPct < 70 && 'text-amber-500',
                                            p.buyoutPct < 50 && 'text-rose-500'
                                          )}>
                                            {formatPct(p.buyoutPct)}%
                                          </span>
                                        </td>
                                        <td className="py-1.5 text-right tabular-nums">{p.stockQty}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                              {warehouseProducts.length > 20 && (
                                <div className="mt-2 text-xs text-gray-500">...и ещё {warehouseProducts.length - 20} товаров</div>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>

              {!loading && warehouses.length === 0 && (
                <div className="py-12 text-center text-[var(--content-muted)]">
                  <Warehouse className="h-10 w-10 mx-auto mb-3 opacity-40" />
                  <div className="text-sm">Нет данных по складам за выбранный период</div>
                  <div className="mt-1 text-xs text-gray-400">Расширьте даты сверху или подождите 5–10 минут пока подтянутся данные WB.</div>
                </div>
              )}
            </div>
          ) : (
            <div className="overflow-auto -mx-5 px-5">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--card-border)] text-[var(--content-muted)]">
                    <th className="py-3 pr-4 text-left font-medium">Регион</th>
                    <th className="py-3 px-4 text-left font-medium">Кластер</th>
                    <th className="py-3 px-4 text-right font-medium">Заказы</th>
                    <th className="py-3 px-4 text-right font-medium">Выручка</th>
                    <th className="py-3 px-4 text-right font-medium">Доля</th>
                    <th className="py-3 px-4 text-right font-medium" title="Бенчмарк кластера по рынку WB">Бенчмарк</th>
                    <th className="py-3 pl-4 text-right font-medium" title="Фактическая доля − Бенчмарк. Положительный = перевыполнение, отрицательный = потенциал роста">Потенциал</th>
                  </tr>
                </thead>
                <tbody>
                  {regions.map((row) => {
                    const potential = row.potential ?? 0;
                    const benchmark = row.benchmark ?? 0;
                    const isExpanded = expandedRegion === row.regionName;
                    return (
                    <React.Fragment key={row.regionName}>
                    <tr
                      className="border-b border-[var(--card-border)] hover:bg-[var(--bg-subtle)] transition-colors cursor-pointer"
                      onClick={() => {
                        if (isExpanded) {
                          setExpandedRegion(null);
                          setRegionProducts([]);
                        } else {
                          setExpandedRegion(row.regionName);
                          loadRegionProducts(row.regionName);
                        }
                      }}
                    >
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          {isExpanded ? <ChevronDown className="h-4 w-4 text-[var(--content-muted)]" /> : <ChevronRight className="h-4 w-4 text-[var(--content-muted)]" />}
                          <span className="font-medium text-[var(--content-text)]">{row.regionName}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-left">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200">
                          {row.cluster ?? '—'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums">{formatNumber(row.ordersCount)}</td>
                      <td className="py-3 px-4 text-right tabular-nums">{formatRub(row.ordersRub / 100)} ₽</td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-20 h-1.5 rounded-full bg-[var(--bg-muted)] overflow-hidden">
                            <div
                              className="h-full rounded-full bg-indigo-500"
                              style={{ width: `${Math.min(100, row.sharePercent)}%` }}
                            />
                          </div>
                          <span className="tabular-nums text-[var(--content-muted)] w-12 text-right">{formatPct(row.sharePercent)}%</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums text-[var(--content-muted)]">
                        {benchmark > 0 ? `${benchmark}%` : '—'}
                      </td>
                      <td className="py-3 pl-4 text-right" title={`Факт ${formatPct(row.sharePercent)}% − Бенчмарк ${benchmark}%`}>
                        <span className={cn(
                          'tabular-nums font-medium',
                          potential > 2 && 'text-emerald-600',
                          potential >= -2 && potential <= 2 && 'text-[var(--content-muted)]',
                          potential < -2 && 'text-amber-500',
                        )}>
                          {potential > 0 ? '+' : ''}{formatPct(potential)}%
                        </span>
                        {potential < -2 && (
                          <div className="text-[10px] text-amber-500 mt-0.5">рост возможен</div>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={7} className="p-0">
                          <div className="bg-[var(--bg-subtle)] px-8 py-3 border-b border-[var(--card-border)]">
                            {regionProductsLoading ? (
                              <div className="flex items-center gap-2 py-4 text-sm text-[var(--content-muted)]">
                                <RefreshCw className="h-4 w-4 animate-spin" /> Загрузка товаров...
                              </div>
                            ) : regionProducts.length === 0 ? (
                              <div className="py-4 text-sm text-[var(--content-muted)]">
                                Нет данных по товарам для этого региона.
                                <span className="block text-xs text-gray-400 mt-1">Расширьте период или попробуйте другой регион.</span>
                              </div>
                            ) : (
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-[var(--content-muted)]">
                                    <th className="py-1.5 text-left font-medium">Артикул</th>
                                    <th className="py-1.5 text-left font-medium">Название</th>
                                    <th className="py-1.5 text-right font-medium">Заказы</th>
                                    <th className="py-1.5 text-right font-medium">Продажи</th>
                                    <th className="py-1.5 text-right font-medium">Остаток</th>
                                    <th className="py-1.5 text-right font-medium">% выкупа</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {regionProducts.slice(0, 20).map((p) => (
                                    <tr key={p.nmId} className="border-t border-[var(--card-border)]/50">
                                      <td className="py-1.5 font-mono"><NmIdLink nmId={p.nmId}>{p.vendorCode || p.nmId}</NmIdLink></td>
                                      <td className="py-1.5 truncate max-w-[200px]">{p.title || '—'}</td>
                                      <td className="py-1.5 text-right tabular-nums">{formatNumber(p.ordersCount)}</td>
                                      <td className="py-1.5 text-right tabular-nums">{formatNumber(p.salesCount)}</td>
                                      <td className="py-1.5 text-right tabular-nums">{formatNumber(p.stockQty)}</td>
                                      <td className="py-1.5 text-right tabular-nums">
                                        {p.buyoutPct != null ? `${formatPct(p.buyoutPct)}%` : '—'}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                    );
                  })}
                </tbody>
              </table>

              {!loading && regions.length === 0 && (
                <div className="py-12 text-center text-[var(--content-muted)]">
                  <MapPin className="h-10 w-10 mx-auto mb-3 opacity-40" />
                  <div className="text-sm">Нет данных по регионам за выбранный период</div>
                  <div className="mt-1 text-xs text-gray-400">Расширьте даты или проверьте магазин/склад.</div>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
