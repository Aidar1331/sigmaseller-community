'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RefreshCw, TrendingUp, Package, Eye, MousePointer, ShoppingCart,
  Play, Pause, Square, Loader2, Zap, ChevronDown, ChevronRight,
  BarChart3, DollarSign, Target, Percent, Search, ArrowUpDown,
  Wallet, Minus as MinusIcon, Plus, ExternalLink,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { apiFetch } from '@/lib/api';
import { formatNumber, formatRub } from '@/lib/format';
import { cn } from '@/lib/cn';
import { CampaignDetail } from './CampaignDetail';

type Campaign = {
  campaignId: number;
  name: string;
  status: number;
  statusLabel: string;
  type: number;
  paymentType: string;
  dailyBudget: number;
  currentBid: number | null;
  todaySpend: number;
  todayViews: number;
  todayClicks: number;
  todayOrders: number;
  todayDrr: number | null;
  nmIds: number[];
  updatedAt: string;
};

type CampaignsResponse = {
  campaigns: Campaign[];
  total: number;
  statusCounts: {
    active: number;
    paused: number;
    ready: number;
    finished: number;
  };
};

type CampaignStats = {
  ok: boolean;
  error?: string;
  totals: {
    views: number;
    clicks: number;
    orders: number;
    spend: number;
    revenue: number;
    atbs: number;
    ctr: number;
    cpc: number;
    drr: number;
    cr: number;
  };
  days: Array<{
    date: string;
    views: number;
    clicks: number;
    orders: number;
    spend: number;
    revenue: number;
    atbs: number;
    ctr: number;
    cpc: number;
    drr: number;
  }>;
  dateFrom: string;
  dateTo: string;
};

type NormqueryCluster = {
  cluster: number;
  phrase: string;
  count: number;
  views?: number;
  clicks?: number;
  ctr?: number;
  orders?: number;
  sum?: number;
  nmId?: number;
  excluded?: boolean;
};

type Props = {
  workspaceId: number;
};

const statusColors: Record<number, { bg: string; text: string; label: string }> = {
  9: { bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-400', label: 'Активна' },
  11: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-400', label: 'На паузе' },
  4: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400', label: 'Готова' },
  7: { bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-600 dark:text-gray-400', label: 'Завершена' },
  8: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400', label: 'Отменена' },
  [-1]: { bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-500', label: 'Удалена' },
};

export function BidderCampaigns({ workspaceId }: Props) {
  const [data, setData] = useState<CampaignsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [campaignStats, setCampaignStats] = useState<Record<number, CampaignStats | null>>({});
  const [loadingStats, setLoadingStats] = useState<Record<number, boolean>>({});
  const [clusters, setClusters] = useState<Record<number, NormqueryCluster[]>>({});
  const [loadingClusters, setLoadingClusters] = useState<Record<number, boolean>>({});
  const [controlling, setControlling] = useState<Record<number, boolean>>({});
  const [statsPeriod, setStatsPeriod] = useState<'7d' | '14d' | '30d'>('7d');
  const [detailCampaign, setDetailCampaign] = useState<Campaign | null>(null);

  const fetchCampaigns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<CampaignsResponse>(`/bidder/${workspaceId}/campaigns`);
      setData(res);
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось загрузить кампании');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const syncCampaigns = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await apiFetch<{ ok: boolean; synced: number; errors: string[] }>(
        `/bidder/${workspaceId}/campaigns/sync`,
        { method: 'POST' }
      );
      if (!res.ok && res.errors?.length) {
        const errMsg = res.errors.join(', ');
        if (errMsg.includes('401') || errMsg.includes('unauthorized') || errMsg.includes('token')) {
          setError('API-ключ не имеет доступа к рекламному кабинету WB. Убедитесь что ключ имеет права на Продвижение.');
        } else {
          setError(errMsg);
        }
        setSyncing(false);
        return;
      }
      await fetchCampaigns();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось синхронизировать');
    } finally {
      setSyncing(false);
    }
  }, [workspaceId, fetchCampaigns]);

  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  // Auto-sync on first load if no campaigns (once only)
  const autoSynced = useRef(false);
  useEffect(() => {
    if (data && data.campaigns.length === 0 && !syncing && !loading && !autoSynced.current) {
      autoSynced.current = true;
      syncCampaigns();
    }
  }, [data, syncing, loading, syncCampaigns]);

  // Fetch stats for expanded campaign
  const fetchStats = useCallback(async (advertId: number) => {
    setLoadingStats((s) => ({ ...s, [advertId]: true }));
    const days = statsPeriod === '7d' ? 7 : statsPeriod === '14d' ? 14 : 30;
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    try {
      const res = await apiFetch<CampaignStats>(
        `/bidder/${workspaceId}/campaigns/${advertId}/fullstats?from=${from}&to=${to}`
      );
      setCampaignStats((s) => ({ ...s, [advertId]: res }));
    } catch (e: any) {
      setCampaignStats((s) => ({ ...s, [advertId]: null }));
      setError(e?.message ?? `Не удалось загрузить статистику кампании ${advertId}`);
    } finally {
      setLoadingStats((s) => ({ ...s, [advertId]: false }));
    }
  }, [workspaceId, statsPeriod]);

  // Fetch clusters for expanded campaign
  const fetchClusters = useCallback(async (advertId: number) => {
    setLoadingClusters((s) => ({ ...s, [advertId]: true }));
    try {
      const res = await apiFetch<{ clusters: NormqueryCluster[] }>(
        `/bidder/${workspaceId}/campaigns/${advertId}/clusters`
      );
      setClusters((s) => ({ ...s, [advertId]: res.clusters || [] }));
    } catch (e: any) {
      setClusters((s) => ({ ...s, [advertId]: [] }));
      setError(e?.message ?? `Не удалось загрузить кластеры кампании ${advertId}`);
    } finally {
      setLoadingClusters((s) => ({ ...s, [advertId]: false }));
    }
  }, [workspaceId]);

  // Toggle expand
  const handleExpand = (campaignId: number) => {
    if (expandedId === campaignId) {
      setExpandedId(null);
    } else {
      setExpandedId(campaignId);
      if (!campaignStats[campaignId] && !loadingStats[campaignId]) {
        fetchStats(campaignId);
      }
      if (!clusters[campaignId] && !loadingClusters[campaignId]) {
        fetchClusters(campaignId);
      }
    }
  };

  // Refetch stats when period changes
  useEffect(() => {
    if (expandedId && !loadingStats[expandedId]) {
      fetchStats(expandedId);
    }
  }, [statsPeriod]);

  // Campaign control
  const handleStart = async (campaignId: number) => {
    setControlling((s) => ({ ...s, [campaignId]: true }));
    try {
      await apiFetch(`/bidder/${workspaceId}/campaigns/${campaignId}/start`, { method: 'POST' });
      await fetchCampaigns();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось запустить кампанию');
    } finally {
      setControlling((s) => ({ ...s, [campaignId]: false }));
    }
  };

  const handlePause = async (campaignId: number) => {
    setControlling((s) => ({ ...s, [campaignId]: true }));
    try {
      await apiFetch(`/bidder/${workspaceId}/campaigns/${campaignId}/pause`, { method: 'POST' });
      await fetchCampaigns();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось приостановить кампанию');
    } finally {
      setControlling((s) => ({ ...s, [campaignId]: false }));
    }
  };

  const handleStop = async (campaignId: number) => {
    if (!confirm('Завершить кампанию? Это действие необратимо.')) return;
    setControlling((s) => ({ ...s, [campaignId]: true }));
    try {
      await apiFetch(`/bidder/${workspaceId}/campaigns/${campaignId}/stop`, { method: 'POST' });
      await fetchCampaigns();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось завершить кампанию');
    } finally {
      setControlling((s) => ({ ...s, [campaignId]: false }));
    }
  };

  const filteredCampaigns = data?.campaigns.filter(c => {
    if (filter === 'active') return c.status === 9;
    if (filter === 'paused') return c.status === 11;
    return true;
  }) ?? [];

  const StatusBadge = ({ status }: { status: number }) => {
    const config = statusColors[status] || { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Неизвестно' };
    return (
      <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-xs font-medium', config.bg, config.text)}>
        {status === 9 && <Play className="h-3 w-3 mr-1" />}
        {status === 11 && <Pause className="h-3 w-3 mr-1" />}
        {config.label}
      </span>
    );
  };

  const StatCard = ({ icon: Icon, label, value, sub, color }: { icon: any; label: string; value: string; sub?: string; color?: string }) => (
    <div className="bg-muted/30 rounded-lg p-3 flex flex-col">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
        <Icon className={cn('h-3.5 w-3.5', color)} />
        {label}
      </div>
      <div className="text-lg font-bold">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );

  return (
    <Card>
      <div className="p-4 border-b">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold flex items-center gap-2">
              <Zap className="h-5 w-5 text-amber-500" />
              Рекламные кампании WB
            </h3>
            {data && (
              <p className="text-sm text-muted-foreground mt-1">
                Всего: {data.total} ·
                Активных: {data.statusCounts.active} ·
                На паузе: {data.statusCounts.paused}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="neutral" size="sm" onClick={fetchCampaigns} disabled={loading}>
              <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
              Обновить
            </Button>
            <Button variant="primary" size="sm" onClick={syncCampaigns} disabled={syncing}>
              {syncing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Синхронизировать кампании
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex gap-2">
          <Button
            variant={filter === 'all' ? 'primary' : 'neutral'}
            size="sm"
            onClick={() => setFilter('all')}
          >
            Все ({data?.total ?? 0})
          </Button>
          <Button
            variant={filter === 'active' ? 'primary' : 'neutral'}
            size="sm"
            onClick={() => setFilter('active')}
          >
            <Play className="h-3 w-3 mr-1" />
            Активные ({data?.statusCounts.active ?? 0})
          </Button>
          <Button
            variant={filter === 'paused' ? 'primary' : 'neutral'}
            size="sm"
            onClick={() => setFilter('paused')}
          >
            <Pause className="h-3 w-3 mr-1" />
            На паузе ({data?.statusCounts.paused ?? 0})
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 text-sm">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="p-8 text-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
          Загрузка кампаний...
        </div>
      ) : filteredCampaigns.length === 0 ? (
        <div className="p-8 text-center text-muted-foreground">
          <Zap className="h-8 w-8 mx-auto mb-3 opacity-50" />
          <p className="font-medium">Рекламные кампании не найдены</p>
          <p className="text-sm mt-1 mb-4">
            Нажмите «Синхронизировать» для загрузки из Wildberries.
          </p>
          <Button variant="primary" size="sm" onClick={syncCampaigns} disabled={syncing}>
            {syncing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Синхронизировать
          </Button>
        </div>
      ) : (
        <div className="divide-y">
          {filteredCampaigns.map((campaign) => {
            const isExpanded = expandedId === campaign.campaignId;
            const stats = campaignStats[campaign.campaignId];
            const isLoadingStats = loadingStats[campaign.campaignId];
            const campaignClusters = clusters[campaign.campaignId];
            const isLoadingClusters = loadingClusters[campaign.campaignId];
            const isControlling = controlling[campaign.campaignId];
            const canStart = campaign.status === 11 || campaign.status === 4;
            const canPause = campaign.status === 9;
            const canStop = campaign.status === 9 || campaign.status === 11;

            return (
              <div key={campaign.campaignId}>
                {/* Campaign Row */}
                <div
                  className={cn(
                    'flex items-center gap-4 px-4 py-3 cursor-pointer transition-colors',
                    isExpanded ? 'bg-muted/40' : 'hover:bg-muted/20'
                  )}
                  onClick={() => handleExpand(campaign.campaignId)}
                >
                  <div className="flex-shrink-0">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{campaign.name || `Кампания #${campaign.campaignId}`}</div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                      <span>ID: {campaign.campaignId}</span>
                      <span>·</span>
                      <span className="uppercase">{campaign.paymentType || 'cpm'}</span>
                      {campaign.nmIds?.length > 0 && (
                        <>
                          <span>·</span>
                          <span className="inline-flex items-center gap-0.5">
                            <Package className="h-3 w-3" />
                            {campaign.nmIds.length} товаров
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    {campaign.currentBid ? (
                      <div className="text-right">
                        <div className="font-mono text-sm font-medium">
                          {(campaign.currentBid / 100).toFixed(0)} ₽
                        </div>
                        <div className="text-xs text-muted-foreground">ставка</div>
                      </div>
                    ) : null}

                    <StatusBadge status={campaign.status} />

                    {/* Quick controls */}
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      {canStart && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleStart(campaign.campaignId)}
                          disabled={isControlling}
                          title="Запустить"
                        >
                          {isControlling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 text-green-700" />}
                        </Button>
                      )}
                      {canPause && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handlePause(campaign.campaignId)}
                          disabled={isControlling}
                          title="Приостановить"
                        >
                          {isControlling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4 text-amber-700" />}
                        </Button>
                      )}
                      {canStop && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleStop(campaign.campaignId)}
                          disabled={isControlling}
                          title="Завершить"
                        >
                          {isControlling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4 text-red-500" />}
                        </Button>
                      )}
                      <Button
                        variant="neutral"
                        size="sm"
                        onClick={() => setDetailCampaign(campaign)}
                        title="Подробнее"
                      >
                        <ExternalLink className="h-4 w-4 mr-1" />
                        Подробнее
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Expanded Detail View */}
                {isExpanded && (
                  <div className="px-4 pb-4 bg-muted/20 border-t">
                    {/* Period selector */}
                    <div className="flex items-center gap-2 pt-3 mb-3">
                      <BarChart3 className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">Статистика за</span>
                      {(['7d', '14d', '30d'] as const).map((p) => (
                        <button
                          key={p}
                          onClick={() => setStatsPeriod(p)}
                          className={cn(
                            'px-2 py-0.5 rounded text-xs font-medium transition-colors',
                            statsPeriod === p
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted text-muted-foreground hover:bg-muted/80'
                          )}
                        >
                          {p === '7d' ? '7 дней' : p === '14d' ? '14 дней' : '30 дней'}
                        </button>
                      ))}
                    </div>

                    {isLoadingStats ? (
                      <div className="flex items-center justify-center py-6">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        <span className="ml-2 text-sm text-muted-foreground">Загрузка статистики...</span>
                      </div>
                    ) : stats?.ok && stats.totals ? (
                      <>
                        {/* Stats Grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
                          <StatCard
                            icon={Eye}
                            label="Показы"
                            value={formatNumber(stats.totals.views)}
                            color="text-blue-500"
                          />
                          <StatCard
                            icon={MousePointer}
                            label="Клики"
                            value={formatNumber(stats.totals.clicks)}
                            sub={`CTR: ${stats.totals.ctr.toFixed(2)}%`}
                            color="text-purple-500"
                          />
                          <StatCard
                            icon={ShoppingCart}
                            label="Заказы"
                            value={formatNumber(stats.totals.orders)}
                            sub={`CR: ${stats.totals.cr.toFixed(2)}%`}
                            color="text-green-500"
                          />
                          <StatCard
                            icon={DollarSign}
                            label="Расход"
                            value={`${stats.totals.spend.toFixed(0)} ₽`}
                            sub={`CPC: ${stats.totals.cpc.toFixed(0)} ₽`}
                            color="text-red-500"
                          />
                          <StatCard
                            icon={Target}
                            label="ДРР"
                            value={`${stats.totals.drr.toFixed(1)}%`}
                            sub={`Выручка: ${formatNumber(Math.round(stats.totals.revenue))} ₽`}
                            color={stats.totals.drr > 30 ? 'text-red-500' : 'text-green-500'}
                          />
                        </div>

                        {/* Daily Stats Table */}
                        {stats.days.length > 0 && (
                          <div className="mb-4">
                            <h4 className="text-sm font-medium mb-2">По дням</h4>
                            <div className="overflow-x-auto rounded-lg border">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="bg-muted/50 border-b">
                                    <th className="py-2 px-3 text-left font-medium">Дата</th>
                                    <th className="py-2 px-3 text-right font-medium">Показы</th>
                                    <th className="py-2 px-3 text-right font-medium">Клики</th>
                                    <th className="py-2 px-3 text-right font-medium">CTR</th>
                                    <th className="py-2 px-3 text-right font-medium">Заказы</th>
                                    <th className="py-2 px-3 text-right font-medium">Расход</th>
                                    <th className="py-2 px-3 text-right font-medium">CPC</th>
                                    <th className="py-2 px-3 text-right font-medium">Выручка</th>
                                    <th className="py-2 px-3 text-right font-medium">ДРР</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y">
                                  {stats.days.map((day) => (
                                    <tr key={day.date} className="hover:bg-muted/30">
                                      <td className="py-1.5 px-3 font-medium">
                                        {new Date(day.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                                      </td>
                                      <td className="py-1.5 px-3 text-right">{formatNumber(day.views)}</td>
                                      <td className="py-1.5 px-3 text-right">{formatNumber(day.clicks)}</td>
                                      <td className="py-1.5 px-3 text-right">{day.ctr.toFixed(2)}%</td>
                                      <td className="py-1.5 px-3 text-right">{day.orders}</td>
                                      <td className="py-1.5 px-3 text-right">{day.spend.toFixed(0)} ₽</td>
                                      <td className="py-1.5 px-3 text-right">{day.cpc.toFixed(0)} ₽</td>
                                      <td className="py-1.5 px-3 text-right">{day.revenue > 0 ? `${formatNumber(Math.round(day.revenue))} ₽` : '—'}</td>
                                      <td className={cn('py-1.5 px-3 text-right font-medium', day.drr > 30 ? 'text-red-500' : 'text-green-500')}>
                                        {day.drr > 0 ? `${day.drr.toFixed(1)}%` : '—'}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </>
                    ) : stats && !stats.ok ? (
                      <div className="py-4 text-center text-sm text-muted-foreground">
                        {stats.error?.includes('429') || stats.error?.includes('too many')
                          ? 'WB API: превышен лимит запросов. Подождите минуту и попробуйте снова.'
                          : 'Не удалось загрузить статистику. Попробуйте позже.'}
                        <button
                          onClick={() => fetchStats(campaign.campaignId)}
                          className="ml-2 text-primary hover:underline"
                        >
                          Повторить
                        </button>
                      </div>
                    ) : null}

                    {/* Normquery Clusters */}
                    <div>
                      <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                        <Search className="h-4 w-4" />
                        Поисковые запросы
                        {isLoadingClusters && <Loader2 className="h-3 w-3 animate-spin" />}
                      </h4>
                      {campaignClusters && campaignClusters.length > 0 ? (() => {
                        // Deduplicate phrases (same phrase may appear for multiple nmIds)
                        const uniqueActive = [...new Set(campaignClusters.filter(c => !c.excluded && c.phrase).map(c => c.phrase))];
                        const uniqueExcluded = [...new Set(campaignClusters.filter(c => c.excluded && c.phrase).map(c => c.phrase))];
                        const activePhrases = uniqueActive.map((phrase, i) => ({ phrase, cluster: i, count: 0, excluded: false }));
                        const excludedPhrases = uniqueExcluded.map((phrase, i) => ({ phrase, cluster: i, count: 0, excluded: true }));
                        return (
                          <div className="space-y-3">
                            {/* Active phrases */}
                            {activePhrases.length > 0 && (
                              <div>
                                <div className="text-xs font-medium text-green-700 dark:text-green-400 mb-1.5 flex items-center gap-1">
                                  <Plus className="h-3 w-3" />
                                  Активные запросы ({activePhrases.length})
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {activePhrases.map((cluster, i) => (
                                    <span
                                      key={`active-${i}`}
                                      className="inline-flex items-center px-2.5 py-1 rounded-full bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-xs font-medium border border-green-200 dark:border-green-800"
                                    >
                                      {cluster.phrase}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Excluded (minus) phrases */}
                            {excludedPhrases.length > 0 && (
                              <div>
                                <div className="text-xs font-medium text-red-600 dark:text-red-400 mb-1.5 flex items-center gap-1">
                                  <MinusIcon className="h-3 w-3" />
                                  Минус-слова ({excludedPhrases.length})
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {excludedPhrases.map((cluster, i) => (
                                    <span
                                      key={`excluded-${i}`}
                                      className="inline-flex items-center px-2.5 py-1 rounded-full bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-xs border border-red-200 dark:border-red-800"
                                    >
                                      {cluster.phrase}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}

                            {activePhrases.length === 0 && excludedPhrases.length === 0 && (
                              <div className="text-sm text-muted-foreground py-2">
                                Нет фраз с текстом
                              </div>
                            )}
                          </div>
                        );
                      })() : !isLoadingClusters ? (
                        <div className="text-sm text-muted-foreground py-2">
                          Нет поисковых запросов для этой кампании
                        </div>
                      ) : null}
                    </div>

                    {/* Product NmIds */}
                    {campaign.nmIds?.length > 0 && (
                      <div className="mt-3">
                        <h4 className="text-sm font-medium mb-1 flex items-center gap-2">
                          <Package className="h-4 w-4" />
                          Товары ({campaign.nmIds.length})
                        </h4>
                        <div className="flex flex-wrap gap-1">
                          {campaign.nmIds.slice(0, 20).map((nmId) => (
                            <span key={nmId} className="inline-flex items-center px-2 py-0.5 rounded bg-muted text-xs font-mono">
                              <NmIdLink nmId={nmId} />
                            </span>
                          ))}
                          {campaign.nmIds.length > 20 && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded bg-muted text-xs text-muted-foreground">
                              +{campaign.nmIds.length - 20} ещё
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Campaign Detail Modal */}
      {detailCampaign && (
        <CampaignDetail
          workspaceId={workspaceId}
          campaign={detailCampaign}
          onClose={() => setDetailCampaign(null)}
          onUpdate={fetchCampaigns}
        />
      )}
    </Card>
  );
}
