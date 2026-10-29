'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useWorkspaceStore } from '@/store/workspace';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import { apiFetch } from '@/lib/api';
import { RefreshCw, CheckCircle2, AlertTriangle, Clock } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

const DATA_TYPE_LABELS: Record<string, string> = {
  'orders-sales': 'Заказы',
  'adv': 'Реклама',
  'funnel': 'Воронка',
  'finance': 'Финансы',
  'stocks': 'Остатки',
  'paid-storage': 'Хранение',
  'stocks-history': 'Остатки (история)',
  'spp': 'СПП',
};

function formatShortDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  const thisYear = new Date().getFullYear().toString();
  return y === thisYear ? `${d}.${m}` : `${d}.${m}.${y}`;
}

function calendarSpan(firstDate: string, lastDate: string): number {
  const d1 = new Date(firstDate + 'T00:00:00');
  const d2 = new Date(lastDate + 'T00:00:00');
  return Math.max(1, Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1);
}

function formatRangeText(firstDate: string | null, lastDate: string | null, totalDays: number, type: string): string {
  if (!lastDate || !firstDate) {
    if (type === 'adv') return 'нет рекламы';
    return 'нет данных';
  }
  const from = formatShortDate(firstDate);
  const to = formatShortDate(lastDate);
  const span = calendarSpan(firstDate, lastDate);
  if (from === to) return `${to} (1 дн)`;
  // Показываем количество дней с реальными данными vs календарный span.
  // Раньше писали только span (`104 дн`) — обманчиво если sync догнал
  // только 5 точек из 104. Теперь юзер видит реальное покрытие.
  if (totalDays > 0 && totalDays < span) {
    return `${from} – ${to} (${totalDays} из ${span} дн)`;
  }
  return `${from} – ${to} (${span} дн)`;
}

function formatFullDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

function gapLevel(gapDays: number): 'fresh' | 'stale' | 'old' {
  if (gapDays <= 1) return 'fresh';
  if (gapDays <= 3) return 'stale';
  return 'old';
}

function overallStatusText(worstGap: number, hasData: boolean): string {
  if (!hasData) return 'Нет данных';
  if (worstGap <= 1) return 'Данные актуальны';
  if (worstGap <= 3) return 'Данные немного устарели';
  return 'Данные устарели';
}

type RefreshResult = {
  triggered: string[];
  errors: string[];
  diagnostics?: Record<string, { lastDataDate: string | null; gapDays: number; daysBack: number }>;
};

export function DataFreshnessBar() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopId = useWorkspaceStore((s) => s.shopId);
  const { data: sync } = useSyncStatus(workspaceId ?? 0);
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [result, setResult] = useState<RefreshResult | null>(null);

  // Track how long isSyncing has been true — allow force-refresh after 60s
  const syncingStartRef = useRef<number | null>(null);
  const [syncingDuration, setSyncingDuration] = useState(0);
  const wasSyncingRef = useRef(false);

  useEffect(() => {
    if (sync?.isSyncing) {
      if (!syncingStartRef.current) syncingStartRef.current = Date.now();
      wasSyncingRef.current = true;
      const interval = setInterval(() => {
        setSyncingDuration(Date.now() - (syncingStartRef.current ?? Date.now()));
      }, 5000);
      return () => clearInterval(interval);
    } else {
      // Sync just finished — refresh page data
      if (wasSyncingRef.current) {
        wasSyncingRef.current = false;
        queryClient.invalidateQueries({ queryKey: ['pulseOverview'] });
        queryClient.invalidateQueries({ queryKey: ['productsMatrix'] });
        queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
      }
      syncingStartRef.current = null;
      setSyncingDuration(0);
    }
  }, [sync?.isSyncing, queryClient]);

  const canForceRefresh = sync?.isSyncing && syncingDuration >= 60_000;

  const handleRefresh = useCallback(async () => {
    if (!workspaceId || refreshing) return;
    setRefreshing(true);
    setResult(null);
    try {
      const res = await apiFetch<{ ok: boolean } & RefreshResult>(
        `/wb/${workspaceId}/sync/refresh`,
        { method: 'POST', body: JSON.stringify({ allShops: true }) },
      );
      setResult(res);
      queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['pulseOverview'] });
        queryClient.invalidateQueries({ queryKey: ['productsMatrix'] });
      }, 5000);
    } catch {
      setResult({ triggered: [], errors: ['Ошибка запуска обновления'] });
    } finally {
      setRefreshing(false);
    }
  }, [workspaceId, shopId, refreshing, queryClient]);

  if (!workspaceId || !sync) return null;

  const dataByType = sync.lastDataByType ?? {};
  const entries = Object.entries(DATA_TYPE_LABELS)
    .map(([type, label]) => {
      const info = dataByType[type];
      return {
        type, label,
        firstDate: info?.firstDate ?? null,
        lastDate: info?.lastDate ?? null,
        gapDays: info?.gapDays ?? 999,
        totalDays: info?.totalDays ?? 0,
      };
    });

  const hasAnyData = entries.some(e => e.lastDate !== null);
  // For overall status: exclude types with no activity (adv with no spend)
  // and finance (WB API has natural 2-week delay)
  const relevantEntries = entries.filter(e => {
    if (e.lastDate === null && e.type === 'adv') return false; // no ads = not a problem
    if (e.type === 'finance') return false; // WB finance always delayed, don't count
    return true;
  });
  const worstGap = relevantEntries.length > 0
    ? Math.max(...relevantEntries.map(e => e.gapDays))
    : Math.max(...entries.map(e => e.gapDays));
  const overallLevel = !hasAnyData ? 'old' as const : gapLevel(worstGap);

  const buttonDisabled = refreshing || (sync.isSyncing && !canForceRefresh);

  return (
    <div className="border-b border-gray-200 bg-gray-50 px-4 py-2">
      <div className="mx-auto flex max-w-[1400px] flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-4">
        {/* Overall status */}
        <div className="flex shrink-0 items-center gap-1.5">
          {overallLevel === 'fresh' ? (
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          ) : overallLevel === 'stale' ? (
            <Clock className="h-4 w-4 text-yellow-500" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-red-500" />
          )}
          <span className={`text-xs font-medium ${
            overallLevel === 'fresh' ? 'text-green-700' : overallLevel === 'stale' ? 'text-yellow-700' : 'text-red-700'
          }`}>
            {overallStatusText(worstGap, hasAnyData)}
          </span>
        </div>

        {/* Data freshness per type. На мобиле — горизонтальный скролл,
            на десктопе — обычный wrap. Иначе на узком экране каждая запись
            сжималась в полоску шириной в 2 символа. */}
        <div className="flex min-w-0 flex-1 gap-x-4 gap-y-1 overflow-x-auto sm:flex-wrap sm:overflow-visible -mx-1 px-1">
          {entries.map((e) => {
            const level = gapLevel(e.gapDays);
            const isNoAds = e.type === 'adv' && !e.lastDate;
            const isFinanceDelay = e.type === 'finance' && e.gapDays >= 7 && e.lastDate;
            const dotColor = isNoAds ? 'text-gray-500'
              : isFinanceDelay ? 'text-yellow-500'
              : level === 'fresh' ? 'text-green-700' : level === 'stale' ? 'text-yellow-700' : 'text-red-600';
            const rangeText = formatRangeText(e.firstDate, e.lastDate, e.totalDays, e.type);
            const tooltip = e.lastDate && e.firstDate
              ? `${formatFullDate(e.firstDate)} - ${formatFullDate(e.lastDate)}, ${e.totalDays} дн данных${e.type === 'finance' ? '\nWB отдаёт финансы с задержкой ~2 недели' : ''}`
              : e.type === 'adv' ? 'Нет активных рекламных кампаний' : 'Данные ещё не загружены';
            return (
              <div key={e.type} className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs" title={tooltip}>
                <span className={dotColor}>{'\u2022'}</span>
                <span className="text-gray-600">{e.label}:</span>
                <span className={isNoAds ? 'text-gray-500'
                  : isFinanceDelay ? 'text-yellow-500'
                  : level === 'fresh' ? 'text-green-700' : level === 'stale' ? 'text-yellow-700' : 'text-red-600'}>
                  {rangeText}
                </span>
              </div>
            );
          })}
        </div>

        {/* Sync progress — weighted by typical duration */}
        {sync.isSyncing && sync.run?.stage && (() => {
          const SYNC_STEPS = [
            { key: 'orders-sales', label: 'Заказы', weight: 15 },
            { key: 'campaigns', label: 'Кампании', weight: 2 },
            { key: 'funnel', label: 'Воронка', weight: 30 },
            { key: 'stocks', label: 'Остатки', weight: 3 },
            { key: 'stocks-history', label: 'Остатки (история)', weight: 5 },
            { key: 'paid-storage', label: 'Хранение', weight: 15 },
            { key: 'spp', label: 'СПП', weight: 5 },
            { key: 'supplies', label: 'Поставки', weight: 5 },
            { key: 'adv', label: 'Реклама', weight: 35 },
            { key: 'finance', label: 'Финансы', weight: 15 },
          ];
          const stage = sync.run.stage;
          const currentKey = stage.replace('refresh:', '').split(':')[0];
          // "starting" = pre-first-step, show as preparing
          if (currentKey === 'starting') {
            return (
              <div className="flex shrink-0 items-center gap-2">
                <RefreshCw className="h-3 w-3 animate-spin text-blue-600" />
                <span className="text-xs font-medium text-blue-600">Запуск...</span>
              </div>
            );
          }
          const currentIdx = SYNC_STEPS.findIndex(s => s.key === currentKey);

          // Weighted progress: sum weights of completed steps + half of current
          const totalWeight = SYNC_STEPS.reduce((s, st) => s + st.weight, 0);
          let completedWeight = 0;
          for (let i = 0; i < currentIdx; i++) completedWeight += SYNC_STEPS[i]!.weight;
          const currentWeight = currentIdx >= 0 ? SYNC_STEPS[currentIdx]!.weight * 0.5 : 0;
          const progress = Math.round(((completedWeight + currentWeight) / totalWeight) * 100);

          return (
            <div className="flex shrink-0 items-center gap-2">
              <div className="flex items-center gap-1.5">
                <RefreshCw className="h-3 w-3 animate-spin text-blue-600" />
                <span className="text-xs font-medium text-blue-600">
                  {SYNC_STEPS[currentIdx]?.label ?? currentKey}
                </span>
              </div>
              <div className="h-1.5 w-28 overflow-hidden rounded-full bg-gray-200">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all duration-1000 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="text-[10px] text-gray-500">{progress}%</span>
              {(() => {
                const avgMs = (sync as any).avgSyncDurationMs ?? 0;
                if (!avgMs || !syncingDuration) return null;
                const remaining = Math.max(0, avgMs - syncingDuration);
                const remainingMin = Math.ceil(remaining / 60000);
                if (remainingMin <= 0) return <span className="text-[10px] text-gray-500">завершаем...</span>;
                return <span className="text-[10px] text-gray-500">~{remainingMin} мин</span>;
              })()}
            </div>
          );
        })()}

        {/* Sync done result */}
        {!sync.isSyncing && sync.run?.stage?.includes('done') && sync.run.error && (
          <span className="text-xs text-orange-500" title={sync.run.error}>
            Завершено с ошибкой
          </span>
        )}

        {/* Refresh button — unlocks after 60s of stuck sync */}
        <button
          type="button"
          onClick={handleRefresh}
          disabled={buttonDisabled}
          className="flex shrink-0 items-center justify-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm ring-1 ring-gray-300 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${(refreshing || sync.isSyncing) ? 'animate-spin' : ''}`} />
          {canForceRefresh ? 'Принудительно обновить' : sync.isSyncing ? 'Обновляется...' : 'Обновить данные'}
        </button>
      </div>
    </div>
  );
}
