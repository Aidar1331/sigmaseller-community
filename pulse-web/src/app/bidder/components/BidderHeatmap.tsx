'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { RefreshCw, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';

interface CampaignStats {
  advertId: number;
  days: Array<{
    date: string;
    totals: {
      sum: number;
      views: number;
      clicks: number;
      atbs: number;
      orders: number;
      sum_price: number;
    };
    products?: Array<{
      nmId: number;
      name: string;
      views: number;
      clicks: number;
      orders: number;
      sum: number;
    }>;
  }>;
}

interface Props {
  workspaceId: number;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function getHeatColor(value: number, max: number): string {
  if (max === 0) return 'bg-slate-100';
  const pct = value / max;
  if (pct < 0.2) return 'bg-blue-100 text-blue-700';
  if (pct < 0.4) return 'bg-green-100 text-green-700';
  if (pct < 0.6) return 'bg-yellow-100 text-yellow-700';
  if (pct < 0.8) return 'bg-orange-100 text-orange-700';
  return 'bg-red-100 text-red-700';
}

function getDrrColor(drr: number): string {
  if (drr <= 5) return 'bg-emerald-100 text-emerald-700';
  if (drr <= 10) return 'bg-green-100 text-green-700';
  if (drr <= 15) return 'bg-yellow-100 text-yellow-700';
  if (drr <= 25) return 'bg-orange-100 text-orange-700';
  return 'bg-red-100 text-red-700';
}

export function BidderHeatmap({ workspaceId }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<CampaignStats[]>([]);
  const [view, setView] = useState<'drr' | 'spend' | 'ctr'>('drr');

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ campaigns: CampaignStats[] }>(
        `/bidder/${workspaceId}/campaigns/stats`
      );
      setStats(res.campaigns ?? []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // Aggregate stats by campaign
  const campaignSummaries = stats.map((campaign) => {
    let totalSpend = 0;
    let totalViews = 0;
    let totalClicks = 0;
    let totalOrders = 0;
    let totalRevenue = 0;

    for (const day of campaign.days) {
      totalSpend += day.totals.sum;
      totalViews += day.totals.views;
      totalClicks += day.totals.clicks;
      totalOrders += day.totals.orders;
      totalRevenue += day.totals.sum_price;
    }

    const ctr = totalViews > 0 ? (totalClicks / totalViews) * 100 : 0;
    const drr = totalRevenue > 0 ? (totalSpend / totalRevenue) * 100 : 0;
    const cpc = totalClicks > 0 ? totalSpend / totalClicks : 0;

    return {
      advertId: campaign.advertId,
      totalSpend,
      totalViews,
      totalClicks,
      totalOrders,
      totalRevenue,
      ctr,
      drr,
      cpc,
      days: campaign.days,
    };
  });

  const maxSpend = Math.max(...campaignSummaries.map((c) => c.totalSpend), 1);
  const maxDrr = Math.max(...campaignSummaries.map((c) => c.drr), 1);

  return (
    <Card>
      <div className="p-4 border-b flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Теплокарта ставок</h3>
          <p className="text-xs text-[var(--content-muted)] mt-1">
            Эффективность кампаний за последние 7 дней
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
            <button
              className={cn(
                'px-3 py-1 text-xs rounded-md transition-colors',
                view === 'drr' ? 'bg-white shadow-sm font-medium' : 'text-slate-600 hover:text-slate-900'
              )}
              onClick={() => setView('drr')}
            >
              ДРР
            </button>
            <button
              className={cn(
                'px-3 py-1 text-xs rounded-md transition-colors',
                view === 'spend' ? 'bg-white shadow-sm font-medium' : 'text-slate-600 hover:text-slate-900'
              )}
              onClick={() => setView('spend')}
            >
              Расход
            </button>
            <button
              className={cn(
                'px-3 py-1 text-xs rounded-md transition-colors',
                view === 'ctr' ? 'bg-white shadow-sm font-medium' : 'text-slate-600 hover:text-slate-900'
              )}
              onClick={() => setView('ctr')}
            >
              CTR
            </button>
          </div>
          <Button variant="ghost" size="sm" onClick={loadStats} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-4 text-sm text-red-600 bg-red-50">{error}</div>
      )}

      <div className="p-4">
        {campaignSummaries.length === 0 ? (
          <div className="text-center py-8 text-[var(--content-muted)]">
            {loading ? 'Загрузка...' : 'Нет данных о кампаниях'}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-lg border border-[var(--card-border)] p-3">
                <div className="text-xs text-[var(--content-muted)]">Всего расход</div>
                <div className="text-lg font-semibold mt-1">
                  {formatNumber(campaignSummaries.reduce((s, c) => s + c.totalSpend, 0))} ₽
                </div>
              </div>
              <div className="rounded-lg border border-[var(--card-border)] p-3">
                <div className="text-xs text-[var(--content-muted)]">Средний ДРР</div>
                <div className="text-lg font-semibold mt-1">
                  {(campaignSummaries.reduce((s, c) => s + c.drr, 0) / Math.max(campaignSummaries.length, 1)).toFixed(1)}%
                </div>
              </div>
              <div className="rounded-lg border border-[var(--card-border)] p-3">
                <div className="text-xs text-[var(--content-muted)]">Всего заказов</div>
                <div className="text-lg font-semibold mt-1">
                  {formatNumber(campaignSummaries.reduce((s, c) => s + c.totalOrders, 0))}
                </div>
              </div>
              <div className="rounded-lg border border-[var(--card-border)] p-3">
                <div className="text-xs text-[var(--content-muted)]">Средний CTR</div>
                <div className="text-lg font-semibold mt-1">
                  {(campaignSummaries.reduce((s, c) => s + c.ctr, 0) / Math.max(campaignSummaries.length, 1)).toFixed(2)}%
                </div>
              </div>
            </div>

            {/* Heatmap Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2 font-medium text-[var(--content-muted)]">Кампания</th>
                    {campaignSummaries[0]?.days.map((day) => (
                      <th key={day.date} className="p-2 text-center font-medium text-[var(--content-muted)] text-xs">
                        {new Date(day.date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}
                      </th>
                    ))}
                    <th className="p-2 text-center font-medium text-[var(--content-muted)]">Итого</th>
                  </tr>
                </thead>
                <tbody>
                  {campaignSummaries.map((campaign) => (
                    <tr key={campaign.advertId} className="border-b hover:bg-slate-50">
                      <td className="p-2 font-mono text-xs">{campaign.advertId}</td>
                      {campaign.days.map((day) => {
                        const dayViews = day.totals.views;
                        const dayClicks = day.totals.clicks;
                        const daySpend = day.totals.sum;
                        const dayRevenue = day.totals.sum_price;
                        const dayCtr = dayViews > 0 ? (dayClicks / dayViews) * 100 : 0;
                        const dayDrr = dayRevenue > 0 ? (daySpend / dayRevenue) * 100 : 0;

                        let value: number;
                        let display: string;
                        let colorClass: string;

                        if (view === 'drr') {
                          value = dayDrr;
                          display = dayDrr > 0 ? `${dayDrr.toFixed(0)}%` : '—';
                          colorClass = dayDrr > 0 ? getDrrColor(dayDrr) : 'bg-slate-50';
                        } else if (view === 'spend') {
                          value = daySpend;
                          display = daySpend > 0 ? `${(daySpend / 1000).toFixed(1)}к` : '—';
                          colorClass = getHeatColor(daySpend, maxSpend / 7);
                        } else {
                          value = dayCtr;
                          display = dayCtr > 0 ? `${dayCtr.toFixed(1)}%` : '—';
                          colorClass = dayCtr > 2 ? 'bg-emerald-100 text-emerald-700' :
                                       dayCtr > 1 ? 'bg-green-100 text-green-700' :
                                       dayCtr > 0.5 ? 'bg-yellow-100 text-yellow-700' :
                                       dayCtr > 0 ? 'bg-orange-100 text-orange-700' : 'bg-slate-50';
                        }

                        return (
                          <td
                            key={day.date}
                            className={cn('p-2 text-center text-xs font-medium rounded', colorClass)}
                            title={`Расход: ${daySpend.toFixed(0)}₽, ДРР: ${dayDrr.toFixed(1)}%, CTR: ${dayCtr.toFixed(2)}%`}
                          >
                            {display}
                          </td>
                        );
                      })}
                      <td className="p-2 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {view === 'drr' && (
                            <Badge variant={campaign.drr <= 15 ? 'success' : campaign.drr <= 25 ? 'warning' : 'danger'}>
                              {campaign.drr.toFixed(1)}%
                            </Badge>
                          )}
                          {view === 'spend' && (
                            <span className="font-medium">{formatNumber(campaign.totalSpend)} ₽</span>
                          )}
                          {view === 'ctr' && (
                            <Badge variant={campaign.ctr >= 1 ? 'success' : 'neutral'}>
                              {campaign.ctr.toFixed(2)}%
                            </Badge>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Legend */}
            <div className="flex items-center gap-4 text-xs text-[var(--content-muted)] pt-2 border-t">
              <span className="font-medium">Шкала {view === 'drr' ? 'ДРР' : view === 'spend' ? 'расхода' : 'CTR'}:</span>
              {view === 'drr' ? (
                <>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-100"></span> ≤5%</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-100"></span> 5-10%</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-yellow-100"></span> 10-15%</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-orange-100"></span> 15-25%</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-100"></span> &gt;25%</span>
                </>
              ) : view === 'ctr' ? (
                <>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-100"></span> &gt;2%</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-100"></span> 1-2%</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-yellow-100"></span> 0.5-1%</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-orange-100"></span> &lt;0.5%</span>
                </>
              ) : (
                <>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-100"></span> низкий</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-100"></span> средний</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-yellow-100"></span> выше среднего</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-100"></span> высокий</span>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
