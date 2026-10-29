'use client';

import { useCallback, useEffect, useState, useMemo } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import { useShopChange } from '@/hooks/useShopChange';
import { useActiveShop } from '@/hooks/useShopParam';
import {
  MapPin, RefreshCw, Calendar, TrendingUp, ShoppingCart,
  BarChart3, Layers, ArrowUp, ArrowDown, Minus
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatRub, formatNumber } from '@/lib/format';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';

type RegionSummary = {
  regionId: number;
  regionName: string;
  totalOrders: number;
  totalSales: number;
  ordersPercent: string;
  salesPercent: string;
};

type HeatmapData = {
  dates: string[];
  regions: { id: number; name: string }[];
  matrix: Record<number, Record<string, { orders: number; sales: number }>>;
};

type SummaryResponse = {
  workspaceId: number;
  dateFrom: string;
  dateTo: string;
  regions: RegionSummary[];
  totals: {
    orders: number;
    sales: number;
    regionCount: number;
  };
};

export default function RegionsPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const { shopId } = useActiveShop();
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapData | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [filterNmId, setFilterNmId] = useState('');
  const [view, setView] = useState<'table' | 'heatmap'>('table');
  const [sortBy, setSortBy] = useState<'orders' | 'sales'>('orders');
  const [heatmapMetric, setHeatmapMetric] = useState<'orders' | 'sales'>('orders');
  const [error, setError] = useState<string | null>(null);

  // Set default dates (last 30 days)
  useEffect(() => {
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    setDateTo(today.toISOString().slice(0, 10));
    setDateFrom(thirtyDaysAgo.toISOString().slice(0, 10));
  }, []);

  const loadData = useCallback(async () => {
    if (!workspaceId || !dateFrom || !dateTo) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('from', dateFrom);
      params.set('to', dateTo);
      if (filterNmId) params.set('nmId', filterNmId);
      if (shopId) params.set('shopId', String(shopId));

      const [summaryRes, heatmapRes] = await Promise.all([
        apiFetch(`/region-sales/${workspaceId}/summary?${params}`) as Promise<SummaryResponse>,
        apiFetch(`/region-sales/${workspaceId}/heatmap?${params}`) as Promise<HeatmapData>,
      ]);

      setSummary(summaryRes);
      setHeatmap(heatmapRes);
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось загрузить данные по регионам');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, dateFrom, dateTo, filterNmId, shopId]);

  useEffect(() => {
    if (dateFrom && dateTo) {
      loadData();
    }
  }, [loadData, dateFrom, dateTo]);

  useShopChange(loadData);

  const sortedRegions = useMemo(() => {
    if (!summary) return [];
    return [...summary.regions].sort((a, b) => {
      if (sortBy === 'orders') return b.totalOrders - a.totalOrders;
      return b.totalSales - a.totalSales;
    });
  }, [summary, sortBy]);

  const getHeatmapColor = (value: number, max: number) => {
    if (!value || !max) return 'bg-gray-50';
    const intensity = Math.min(value / max, 1);
    if (intensity < 0.2) return 'bg-indigo-50';
    if (intensity < 0.4) return 'bg-indigo-100';
    if (intensity < 0.6) return 'bg-indigo-200';
    if (intensity < 0.8) return 'bg-indigo-300';
    return 'bg-indigo-400';
  };

  const heatmapMax = useMemo(() => {
    if (!heatmap) return 1;
    let max = 1;
    for (const regionKey of Object.keys(heatmap.matrix)) {
      const regionData = heatmap.matrix[Number(regionKey)];
      if (!regionData) continue;
      for (const date of Object.keys(regionData)) {
        const val = regionData[date]?.[heatmapMetric];
        if (val > max) max = val;
      }
    }
    return max;
  }, [heatmap, heatmapMetric]);

  if (workspaceId === null) {
    return (
      <AppShell title="Продажи по регионам">
        <Card className="p-8 text-center text-gray-500">
          Выберите магазин для просмотра аналитики по регионам
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell title="Продажи по регионам">
      <div className="space-y-4">
        <ErrorBanner error={error} onRetry={loadData} onDismiss={() => setError(null)} />

        {/* Summary stats */}
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card className="p-4">
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <MapPin className="h-4 w-4" />
                Регионов
              </div>
              <div className="text-2xl font-bold text-gray-900">{summary.totals.regionCount}</div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <ShoppingCart className="h-4 w-4" />
                Заказов
              </div>
              <div className="text-2xl font-bold text-gray-900">
                {formatNumber(summary.totals.orders)}
              </div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <TrendingUp className="h-4 w-4" />
                Продаж
              </div>
              <div className="text-2xl font-bold text-gray-900">
                {formatRub(summary.totals.sales)} ₽
              </div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Calendar className="h-4 w-4" />
                Период
              </div>
              <div className="text-lg font-medium text-gray-900">
                {new Date(summary.dateFrom).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} — {new Date(summary.dateTo).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
              </div>
            </Card>
          </div>
        )}

        {/* Filters */}
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-gray-500" />
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-36"
              />
              <span className="text-gray-500">—</span>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-36"
              />
            </div>

            <div className="flex items-center gap-2 min-w-[200px]">
              <ProductSearchInput
                workspaceId={workspaceId}
                value={filterNmId}
                onChange={setFilterNmId}
                single
                compact
                placeholder="Все товары"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setView('table')}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  view === 'table'
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-gray-500 hover:bg-gray-100'
                )}
              >
                <BarChart3 className="h-4 w-4" />
                Таблица
              </button>
              <button
                onClick={() => setView('heatmap')}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  view === 'heatmap'
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-gray-500 hover:bg-gray-100'
                )}
              >
                <Layers className="h-4 w-4" />
                Тепловая карта
              </button>
            </div>

            <Button variant="neutral" size="sm" onClick={loadData} loading={loading}>
              <RefreshCw className="h-4 w-4" />
              Обновить
            </Button>
          </div>
        </Card>

        {/* Table view */}
        {view === 'table' && (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                      Регион
                    </th>
                    <th
                      className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700"
                      onClick={() => setSortBy('orders')}
                    >
                      <div className="flex items-center justify-end gap-1">
                        Заказы
                        {sortBy === 'orders' && <ArrowDown className="h-3 w-3" />}
                      </div>
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">
                      % заказов
                    </th>
                    <th
                      className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700"
                      onClick={() => setSortBy('sales')}
                    >
                      <div className="flex items-center justify-end gap-1">
                        Продажи
                        {sortBy === 'sales' && <ArrowDown className="h-3 w-3" />}
                      </div>
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">
                      % продаж
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loading ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                        Загрузка...
                      </td>
                    </tr>
                  ) : sortedRegions.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                        <div>Нет данных за выбранный период.</div>
                        <div className="mt-1 text-xs text-gray-400">
                          Попробуйте расширить даты сверху или подождите 5–10 минут пока подтянутся данные WB.
                        </div>
                      </td>
                    </tr>
                  ) : (
                    sortedRegions.map((region, idx) => (
                      <tr key={region.regionId ?? `region-${idx}`} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex items-center justify-center h-6 w-6 rounded-full bg-gray-100 text-xs font-medium text-gray-600">
                              {idx + 1}
                            </div>
                            <div>
                              <div className="font-medium text-gray-900">{region.regionName}</div>
                              {region.regionId != null && <div className="text-xs text-gray-500">ID: {region.regionId}</div>}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-gray-900">
                          {formatNumber(region.totalOrders)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-indigo-500 rounded-full"
                                style={{ width: `${Math.min(Number(region.ordersPercent), 100)}%` }}
                              />
                            </div>
                            <span className="text-sm text-gray-600 w-12 text-right">
                              {region.ordersPercent}%
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-gray-900">
                          {formatRub(region.totalSales)} ₽
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-green-500 rounded-full"
                                style={{ width: `${Math.min(Number(region.salesPercent), 100)}%` }}
                              />
                            </div>
                            <span className="text-sm text-gray-600 w-12 text-right">
                              {region.salesPercent}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* Heatmap view */}
        {view === 'heatmap' && heatmap && (
          <Card className="p-4">
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-medium text-gray-700">
                Тепловая карта по дням
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setHeatmapMetric('orders')}
                  className={cn(
                    'px-3 py-1.5 rounded text-sm font-medium transition-colors',
                    heatmapMetric === 'orders'
                      ? 'bg-indigo-100 text-indigo-700'
                      : 'text-gray-500 hover:bg-gray-100'
                  )}
                >
                  Заказы
                </button>
                <button
                  onClick={() => setHeatmapMetric('sales')}
                  className={cn(
                    'px-3 py-1.5 rounded text-sm font-medium transition-colors',
                    heatmapMetric === 'sales'
                      ? 'bg-green-100 text-green-700'
                      : 'text-gray-500 hover:bg-gray-100'
                  )}
                >
                  Продажи
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="px-2 py-2 text-left font-medium text-gray-500 sticky left-0 bg-white">
                      Регион
                    </th>
                    {heatmap.dates.map((date) => (
                      <th key={date} className="px-1 py-2 text-center font-medium text-gray-500 min-w-[60px]">
                        {new Date(date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {heatmap.regions.slice(0, 20).map((region, rIdx) => (
                    <tr key={region.id ?? `heatmap-${rIdx}`}>
                      <td className="px-2 py-1.5 font-medium text-gray-900 whitespace-nowrap sticky left-0 bg-white">
                        {region.name}
                      </td>
                      {heatmap.dates.map((date) => {
                        const val = heatmap.matrix[region.id]?.[date]?.[heatmapMetric] || 0;
                        return (
                          <td key={date} className="px-1 py-1">
                            <div
                              className={cn(
                                'h-8 rounded flex items-center justify-center text-xs font-medium transition-colors',
                                getHeatmapColor(val, heatmapMax),
                                val > heatmapMax * 0.6 ? 'text-white' : 'text-gray-700'
                              )}
                              title={`${region.name}: ${val.toLocaleString('ru-RU')} ${heatmapMetric === 'sales' ? '₽' : ''}`}
                            >
                              {val > 0 ? (heatmapMetric === 'sales' ? (val / 1000).toFixed(0) + 'k' : val) : ''}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Legend */}
            <div className="mt-4 flex items-center justify-end gap-2 text-xs text-gray-500">
              <span>Меньше</span>
              <div className="flex gap-0.5">
                <div className="w-6 h-4 bg-indigo-50 rounded" />
                <div className="w-6 h-4 bg-indigo-100 rounded" />
                <div className="w-6 h-4 bg-indigo-200 rounded" />
                <div className="w-6 h-4 bg-indigo-300 rounded" />
                <div className="w-6 h-4 bg-indigo-400 rounded" />
              </div>
              <span>Больше</span>
            </div>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
