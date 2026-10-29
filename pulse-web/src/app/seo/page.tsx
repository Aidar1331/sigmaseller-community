'use client';

import { useShopChange } from '@/hooks/useShopChange';

import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  RefreshCw,
  Plus,
  Trash2,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Search,
  ChevronDown,
  ChevronUp,
  Bell,
  Settings,
  Sparkles,
} from 'lucide-react';
import { SeoSettings } from './components/SeoSettings';
import { SearchQueriesTable } from './components/SearchQueriesTable';
import { AppShell } from '@/components/AppShell';
import { SyncFreshnessBadge } from '@/components/SyncFreshnessBadge';
import { Sparkline } from '@/components/pulse/Sparkline';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { Badge } from '@/components/ui/Badge';
import { apiFetch, csrfHeaders } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { JamPaywall, isJamError } from '@/components/JamPaywall';
import { formatNumber } from '@/lib/format';
import { useWorkspaceStore } from '@/store/workspace';
import { RateLimitBadge, CompetitorAnalysis, AlertSettings } from '@/components/seo';
import { KeywordSuggestions } from '@/components/agents/KeywordSuggestions';
import { Users, BellRing } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PositionData = {
  nmId: number;
  position: number | null;
  page: number | null;
  isPromo: boolean;
  cpm: number | null;
  checkedAt: string;
};

type Keyword = {
  keywordId: number;
  workspaceId: number;
  shopId: number | null;
  keyword: string;
  isActive: boolean;
  alertThreshold: number | null;
  lastCheckedAt: string | null;
  createdAt: string;
  nmIds: number[];
  latestPositions?: PositionData[];
  // sparkline: best position per day за 14 дней (для mini-chart в таблице)
  sparkline?: Array<{ d: string; p: number | null }>;
};

type Alert = {
  alertId: number;
  keywordId: number;
  keyword: string;
  nmId: number;
  previousPosition: number | null;
  currentPosition: number | null;
  alertType: 'dropped' | 'recovered' | 'lost';
  isRead: boolean;
  createdAt: string;
};

type DashboardData = {
  totalKeywords: number;
  activeKeywords: number;
  unreadAlerts: number;
  checksLast24h: number;
  // Helium-10-style KPI
  inTop10?: number;
  inTop50?: number;
  deltaTop10?: number;
  deltaTop50?: number;
  gainingThisWeek?: number;
  droppingThisWeek?: number;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SeoPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopId = useWorkspaceStore((s) => s.shopId);

  // State
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jamRequired, setJamRequired] = useState(false);
  const [checking, setChecking] = useState<number | null>(null);

  // Tab state
  const [tab, setTab] = useState<'list' | 'heatmap' | 'competitors' | 'alerts' | 'queries'>('list');
  const [heatmapData, setHeatmapData] = useState<{
    keywords: Array<{ keywordId: number; keyword: string; nmId: number | null }>;
    dates: string[];
    data: Record<number, Record<string, { position: number | null; page: number | null }>>;
  } | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(false);

  // New keyword form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newKeyword, setNewKeyword] = useState('');
  const [newNmIds, setNewNmIds] = useState('');
  const [newThreshold, setNewThreshold] = useState('100');

  // Expanded keyword for history
  const [expandedKeyword, setExpandedKeyword] = useState<number | null>(null);
  const [history, setHistory] = useState<PositionData[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Settings panel
  const [showSettings, setShowSettings] = useState(false);

  // Fetch data
  const fetchData = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    const shopQs = shopId ? `&shopId=${shopId}` : '';
    try {
      const [kw, dash, al] = await Promise.all([
        apiFetch<Keyword[]>(`/seo/${workspaceId}/keywords?includeLatest=true${shopQs}`),
        apiFetch<DashboardData>(`/seo/${workspaceId}/dashboard${shopId ? `?shopId=${shopId}` : ''}`),
        apiFetch<Alert[]>(`/seo/${workspaceId}/alerts?unreadOnly=true&limit=20${shopQs}`),
      ]);
      setKeywords(kw);
      setDashboard(dash);
      setAlerts(al);
    } catch (err: any) {
      console.error('Failed to fetch SEO data:', err);
      if (isJamError(err)) {
        setJamRequired(true);
        setError(null);
      } else {
        setError(err?.message ?? 'Не удалось загрузить данные');
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceId, shopId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);
  useShopChange(fetchData);

  // «Обновить»: триггерит SEO-sync на бэкенде (throttled 10 мин) и сразу
  // перечитывает данные из БД. Прямой fetch вместо apiFetch — чтобы НЕ было
  // auto-retry на 429 (иначе кнопка «залипает» на ~12 сек).
  const [refreshNotice, setRefreshNotice] = useState<{ kind: 'info' | 'warn' | 'err'; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const handleRefreshClick = useCallback(async () => {
    if (!workspaceId || refreshing) return;
    setRefreshing(true);
    setRefreshNotice({ kind: 'info', text: 'Запускаем обновление…' });

    try {
      const token = (await import('@/store/auth')).useAuthStore.getState().token;
      const res = await fetch(`/api/proxy/seo/${workspaceId}/refresh`, {
        method: 'POST',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...csrfHeaders() },
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setRefreshNotice({
          kind: 'info',
          text: body.message ?? 'Запущено. Свежие данные появятся через 5–10 мин.',
        });
      } else if (res.status === 429) {
        setRefreshNotice({
          kind: 'warn',
          text: body.message ?? 'Обновление запускалось недавно — показываю последние данные.',
        });
      } else {
        setRefreshNotice({
          kind: 'err',
          text: body.message ?? `Ошибка ${res.status}`,
        });
      }
    } catch (err) {
      setRefreshNotice({ kind: 'err', text: (err as Error).message ?? 'Ошибка сети' });
    }

    await fetchData();
    setRefreshing(false);
    // info/warn держим 5 минут (бэк ещё работает), err — 8 сек.
    const decay = refreshNotice?.kind === 'err' ? 8000 : 5 * 60_000;
    setTimeout(() => setRefreshNotice((prev) => (prev?.kind === 'err' ? null : prev)), 8000);
    setTimeout(() => setRefreshNotice(null), decay);
  }, [workspaceId, refreshing, refreshNotice?.kind, fetchData]);

  // «Проанализировать» — on-demand запуск SEO-агента (Claude).
  // Отвязан от /refresh сознательно: агент стоит AI-токенов, его не
  // нужно дёргать каждый раз при скачивании сырых данных. Бэкендный
  // дедуп 48h (в самом runner'е) + HTTP 429 от роутера если уже идёт.
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeNotice, setAnalyzeNotice] = useState<{ kind: 'info' | 'warn' | 'err'; text: string } | null>(null);
  const handleAnalyzeClick = useCallback(async () => {
    if (!workspaceId || analyzing) return;
    setAnalyzing(true);
    setAnalyzeNotice({ kind: 'info', text: 'Запускаем анализ…' });
    try {
      const res = await fetch(`/api/proxy/seo/${workspaceId}/agent-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setAnalyzeNotice({
          kind: 'info',
          text: body.message ?? 'Анализ запущен. Рекомендации появятся через 1-3 минуты.',
        });
      } else if (res.status === 429) {
        setAnalyzeNotice({
          kind: 'warn',
          text: body.message ?? 'Анализ уже идёт.',
        });
      } else {
        setAnalyzeNotice({ kind: 'err', text: body.message ?? `Ошибка ${res.status}` });
      }
    } catch (err) {
      setAnalyzeNotice({ kind: 'err', text: (err as Error).message ?? 'Ошибка сети' });
    }
    setAnalyzing(false);
    // Decays same as refresh notice.
    setTimeout(() => setAnalyzeNotice(null), 3 * 60_000);
  }, [workspaceId, analyzing]);

  // Load heatmap data
  const loadHeatmap = useCallback(async () => {
    if (!workspaceId) return;
    setHeatmapLoading(true);
    try {
      const data = await apiFetch<typeof heatmapData>(`/seo/${workspaceId}/heatmap`);
      setHeatmapData(data);
    } catch (e) {
      console.error('Failed to load heatmap:', e);
    }
    setHeatmapLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    if (tab === 'heatmap' && !heatmapData) {
      loadHeatmap();
    }
  }, [tab, heatmapData, loadHeatmap]);

  // Add keyword
  const handleAddKeyword = async () => {
    if (!workspaceId || !newKeyword.trim() || !newNmIds.trim()) return;

    const nmIds = newNmIds
      .split(/[,\s]+/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n > 0);

    if (nmIds.length === 0) return;

    const threshold = Math.min(1000, Math.max(1, parseInt(newThreshold, 10) || 100));

    try {
      await apiFetch(`/seo/${workspaceId}/keywords`, {
        method: 'POST',
        body: JSON.stringify({
          keyword: newKeyword.trim(),
          nmIds,
          alertThreshold: threshold,
        }),
      });
      setNewKeyword('');
      setNewNmIds('');
      setShowAddForm(false);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось добавить запрос');
    }
  };

  // Delete keyword
  const handleDeleteKeyword = async (keywordId: number) => {
    if (!workspaceId) return;
    if (!confirm('Удалить это ключевое слово?')) return;

    try {
      await apiFetch(`/seo/${workspaceId}/keywords/${keywordId}`, {
        method: 'DELETE',
      });
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось удалить запрос');
    }
  };

  // Check positions manually (full check with competitors)
  const handleCheckPositions = async (keywordId: number) => {
    if (!workspaceId) return;
    setChecking(keywordId);
    try {
      await apiFetch(`/seo/${workspaceId}/keywords/${keywordId}/check-full`, {
        method: 'POST',
        body: JSON.stringify({ saveCompetitors: true }),
      });
      fetchData();
    } catch (err: any) {
      console.error('Failed to check positions:', err);
      if (err?.status === 429) {
        setError('Превышен лимит запросов. Попробуйте позже.');
      } else {
        setError(err?.message ?? 'Не удалось проверить позиции. Попробуйте позже.');
      }
    } finally {
      setChecking(null);
    }
  };

  // Fetch history for expanded keyword
  const handleExpandKeyword = async (keywordId: number) => {
    if (expandedKeyword === keywordId) {
      setExpandedKeyword(null);
      return;
    }

    setExpandedKeyword(keywordId);
    setHistoryLoading(true);
    try {
      const result = await apiFetch<{ snapshots: PositionData[] }>(
        `/seo/${workspaceId}/keywords/${keywordId}/history?limit=50`
      );
      setHistory(result.snapshots);
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось загрузить историю');
    } finally {
      setHistoryLoading(false);
    }
  };

  // Mark alerts as read
  const handleMarkAlertsRead = async () => {
    if (!workspaceId || alerts.length === 0) return;
    try {
      await apiFetch(`/seo/${workspaceId}/alerts/mark-read`, {
        method: 'POST',
        body: JSON.stringify({ alertIds: alerts.map((a) => a.alertId) }),
      });
      setAlerts([]);
      fetchData();
    } catch (err) {
      console.error('Failed to mark alerts read:', err);
    }
  };

  // Position badge
  const PositionBadge = ({ position, isPromo }: { position: number | null; isPromo?: boolean }) => {
    if (position === null) {
      return <Badge variant="danger">Не найден</Badge>;
    }
    if (position <= 10) {
      return (
        <Badge variant="success" className="tabular-nums">
          {position} {isPromo && '🔥'}
        </Badge>
      );
    }
    if (position <= 50) {
      return (
        <Badge variant="warning" className="tabular-nums">
          {position} {isPromo && '🔥'}
        </Badge>
      );
    }
    return (
      <Badge variant="neutral" className="tabular-nums">
        {position} {isPromo && '🔥'}
      </Badge>
    );
  };

  if (!workspaceId) {
    return (
      <AppShell>
        <div className="p-8 text-center text-muted-foreground">
          Выберите магазин для просмотра SEO позиций
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="SEO позиции">
      <div className="space-y-4">
        {/* SEO sync freshness — search-queries sync hits the Jam-gated
            seller-analytics-api; badge goes red when the shop lacks
            Jam subscription (surfaces through token_expired/failed). */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <SyncFreshnessBadge stage="search-queries" label="Поисковые запросы" />
            <SyncFreshnessBadge stage="seo-positions" label="Позиции" />
          </div>
          <div className="flex items-center gap-2">
            <RateLimitBadge workspaceId={workspaceId} />
            <Button variant="neutral" onClick={() => setShowSettings(!showSettings)}>
              <Settings className="mr-2 h-4 w-4" />
              Настройки
            </Button>
            {(refreshing || refreshNotice?.kind === 'warn' || refreshNotice?.kind === 'info') && (
              <div className="flex items-center gap-2" title={refreshNotice?.text ?? 'SEO-обновление идёт в фоне, ~5–10 мин'}>
                <div className="flex items-center gap-1.5">
                  <RefreshCw className="h-3 w-3 animate-spin text-blue-600" />
                  <span className="text-xs font-medium text-blue-600">SEO</span>
                </div>
                <div className="h-1.5 w-28 overflow-hidden rounded-full bg-gray-200">
                  <div className="h-full w-full rounded-full bg-blue-500 animate-pulse" />
                </div>
                <span className="text-[10px] text-gray-500">
                  {refreshNotice?.kind === 'warn' ? 'идёт' : '~5–10 мин'}
                </span>
              </div>
            )}
            <Button
              variant="neutral"
              onClick={handleRefreshClick}
              disabled={refreshing || loading || !workspaceId || refreshNotice?.kind === 'warn' || refreshNotice?.kind === 'info'}
              title={refreshNotice?.text ?? 'Запустить синхронизацию с WB (поиск + позиции) и перечитать данные'}
            >
              <RefreshCw className={cn('mr-2 h-4 w-4', (refreshing || loading || refreshNotice?.kind === 'warn' || refreshNotice?.kind === 'info') && 'animate-spin')} />
              {(refreshing || refreshNotice?.kind === 'warn' || refreshNotice?.kind === 'info') ? 'Обновляется...' : 'Обновить'}
            </Button>
            {/* Отдельная кнопка — запуск SEO-агента. Даёт AI-рекомендации
                по свежим данным. Стоит AI-токенов, поэтому кнопка явная. */}
            <Button
              variant="neutral"
              onClick={handleAnalyzeClick}
              disabled={analyzing || !workspaceId || analyzeNotice?.kind === 'info' || analyzeNotice?.kind === 'warn'}
              title={analyzeNotice?.text ?? 'Анализ Claude по свежим SEO-данным. 1-3 минуты, списывает AI-токены.'}
            >
              <Sparkles className={cn('mr-2 h-4 w-4', (analyzing || analyzeNotice?.kind === 'info' || analyzeNotice?.kind === 'warn') && 'animate-pulse')} />
              {(analyzing || analyzeNotice?.kind === 'info') ? 'Анализирую…' : analyzeNotice?.kind === 'warn' ? 'Идёт анализ' : 'Проанализировать'}
            </Button>
            <Button onClick={() => setShowAddForm(!showAddForm)}>
              <Plus className="mr-2 h-4 w-4" />
              Добавить
            </Button>
          </div>
        </div>

        {/* Jam Paywall (search-queries требует подписку «Джем» в ЛК WB) */}
        {jamRequired && (
          <JamPaywall feature="SEO позиции" message="Для доступа к отчёту по поисковым запросам требуется подписка «Джем» в личном кабинете WB." />
        )}

        {/* Error Banner */}
        <ErrorBanner error={error} onRetry={fetchData} onDismiss={() => setError(null)} />

        {/* Settings Panel */}
        {showSettings && workspaceId && (
          <SeoSettings workspaceId={workspaceId} onClose={() => setShowSettings(false)} />
        )}

        {/* Dashboard Cards — Helium-10-style: top-10/top-50 + week trend */}
        {dashboard && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KpiCard
              label="В топ-10"
              value={dashboard.inTop10 ?? 0}
              delta={dashboard.deltaTop10}
              hint="Ключей с лучшим артикулом в топ-10"
            />
            <KpiCard
              label="В топ-50"
              value={dashboard.inTop50 ?? 0}
              delta={dashboard.deltaTop50}
              hint="Ключей с лучшим артикулом в топ-50"
            />
            <KpiCard
              label="↑ Растут за неделю"
              value={dashboard.gainingThisWeek ?? 0}
              positive
              hint="Ключей у которых лучшая позиция улучшилась за 7 дней"
            />
            <KpiCard
              label="↓ Падают за неделю"
              value={dashboard.droppingThisWeek ?? 0}
              negative
              hint="Ключей у которых лучшая позиция ухудшилась за 7 дней"
            />
          </div>
        )}

        {/* Alerts */}
        {alerts.length > 0 && (
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-orange-500" />
                Последние алерты
              </h3>
              <Button variant="ghost" size="sm" onClick={handleMarkAlertsRead}>
                Отметить прочитанными
              </Button>
            </div>
            <div className="space-y-2">
              {alerts.map((alert) => (
                <div
                  key={alert.alertId}
                  className={cn(
                    'flex items-center justify-between p-2 rounded text-sm',
                    alert.alertType === 'dropped' && 'bg-red-50 dark:bg-red-950',
                    alert.alertType === 'recovered' && 'bg-green-50 dark:bg-green-950',
                    alert.alertType === 'lost' && 'bg-orange-50 dark:bg-orange-950'
                  )}
                >
                  <div className="flex items-center gap-2">
                    {alert.alertType === 'dropped' && <TrendingDown className="h-4 w-4 text-red-500" />}
                    {alert.alertType === 'recovered' && <TrendingUp className="h-4 w-4 text-green-500" />}
                    {alert.alertType === 'lost' && <AlertTriangle className="h-4 w-4 text-orange-500" />}
                    <span className="font-medium">&quot;{alert.keyword}&quot;</span>
                    <span className="text-muted-foreground">Артикул: {alert.nmId}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span>
                      {alert.previousPosition ?? '?'} → {alert.currentPosition ?? 'нет'}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(alert.createdAt).toLocaleString('ru')}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Add Keyword Form */}
        {showAddForm && (
          <Card className="p-4">
            <h3 className="font-semibold mb-3">Добавить ключевое слово</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:gap-4">
              <div>
                <label className="text-sm text-muted-foreground">Ключевое слово</label>
                <Input
                  value={newKeyword}
                  onChange={(e) => setNewKeyword(e.target.value)}
                  placeholder="платье летнее"
                />
              </div>
              <div className="col-span-1">
                <label className="text-sm text-muted-foreground">Товары для отслеживания</label>
                <ProductSearchInput
                  workspaceId={workspaceId}
                  value={newNmIds}
                  onChange={setNewNmIds}
                  placeholder="Поиск товаров..."
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Порог алерта (1–1000)</label>
                <Input
                  type="number"
                  min={1}
                  max={1000}
                  value={newThreshold}
                  onChange={(e) => setNewThreshold(e.target.value)}
                  placeholder="100"
                />
              </div>
              <div className="flex items-end">
                <Button onClick={handleAddKeyword} disabled={!newKeyword.trim() || !newNmIds.trim()}>
                  Добавить
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Tabs */}
        <div className="flex gap-1 border-b mb-4">
          <button
            onClick={() => setTab('list')}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === 'list' ? 'border-indigo-500 text-indigo-700' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            📋 Список
          </button>
          <button
            onClick={() => setTab('queries')}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === 'queries' ? 'border-indigo-500 text-indigo-700' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            🔍 Поисковые запросы
          </button>
          <button
            onClick={() => setTab('heatmap')}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === 'heatmap' ? 'border-indigo-500 text-indigo-700' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            🗺️ Теплокарта
          </button>
          <button
            onClick={() => setTab('competitors')}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === 'competitors' ? 'border-indigo-500 text-indigo-700' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            👥 Конкуренты
          </button>
          <button
            onClick={() => setTab('alerts')}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === 'alerts' ? 'border-indigo-500 text-indigo-700' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            🔔 Алерты
          </button>
        </div>

        {/* Heatmap Tab */}
        {tab === 'heatmap' && (
          <Card className="p-4">
            {heatmapLoading ? (
              <div className="text-center py-8 text-muted-foreground">Загрузка...</div>
            ) : !heatmapData || heatmapData.keywords.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                Нет данных. Добавьте ключевые слова и дождитесь проверки.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b">
                      <th className="p-2 text-left sticky left-0 bg-white dark:bg-gray-900 z-10 min-w-[180px]">Ключевое слово</th>
                      {heatmapData.dates.map((date) => (
                        <th key={date} className="p-2 text-center min-w-[50px]">
                          {new Date(date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {heatmapData.keywords.map((kw, idx) => {
                      const positions = heatmapData.data[kw.keywordId] || {};
                      return (
                        <tr key={`${kw.keywordId}-${idx}`} className="border-b hover:bg-slate-50">
                          <td className="p-2 font-medium sticky left-0 bg-white dark:bg-gray-900 z-10 truncate max-w-[180px]" title={kw.keyword}>
                            {kw.keyword}
                          </td>
                          {heatmapData.dates.map((date) => {
                            const pos = positions[date];
                            const position = pos?.position;
                            const bgColor = position === null || position === undefined
                              ? 'bg-gray-100'
                              : position <= 10
                                ? 'bg-green-100 text-green-800'
                                : position <= 50
                                  ? 'bg-yellow-100 text-yellow-800'
                                  : position <= 100
                                    ? 'bg-orange-100 text-orange-800'
                                    : 'bg-red-100 text-red-800';
                            return (
                              <td key={date} className={cn('p-2 text-center tabular-nums font-medium', bgColor)}>
                                {position ?? '—'}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {/* Keywords Table */}
        {tab === 'list' && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-sm text-muted-foreground">
                  <th className="p-3">Ключевое слово</th>
                  <th className="p-3">Товары</th>
                  <th className="p-3">Позиции</th>
                  <th className="p-3">Тренд 14д</th>
                  <th className="p-3">Последняя проверка</th>
                  <th className="p-3">Действия</th>
                </tr>
              </thead>
              <tbody>
                {loading && keywords.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-muted-foreground">
                      Загрузка...
                    </td>
                  </tr>
                )}
                {!loading && keywords.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center">
                      <div className="text-muted-foreground mb-3">Нет ключевых слов</div>
                      <div className="text-xs text-gray-500 max-w-md mx-auto space-y-1 text-left">
                        <p className="font-medium text-gray-500">Как начать:</p>
                        <p>1. Введите артикул товара и ключевое слово в форме выше</p>
                        <p>2. Система будет автоматически проверять позицию товара в поиске WB</p>
                        <p>3. На вкладке <b>Тепловая карта</b> вы увидите историю позиций</p>
                        <p>4. Настройте алерты для уведомления об изменениях позиций</p>
                      </div>
                    </td>
                  </tr>
                )}
                {keywords.map((kw, idx) => (
                  <Fragment key={`${kw.keywordId}-${idx}`}>
                    <tr
                      className={cn(
                        'border-b hover:bg-muted/50 cursor-pointer',
                        !kw.isActive && 'opacity-50'
                      )}
                      onClick={() => handleExpandKeyword(kw.keywordId)}
                    >
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          {expandedKeyword === kw.keywordId ? (
                            <ChevronUp className="h-4 w-4" />
                          ) : (
                            <ChevronDown className="h-4 w-4" />
                          )}
                          <Search className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{kw.keyword}</span>
                        </div>
                      </td>
                      <td className="p-3">
                        <span className="text-sm text-muted-foreground">
                          {kw.nmIds.length} товар(ов)
                        </span>
                      </td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-1">
                          {kw.latestPositions?.slice(0, 5).map((p) => (
                            <PositionBadge key={p.nmId} position={p.position} isPromo={p.isPromo} />
                          ))}
                          {(kw.latestPositions?.length ?? 0) > 5 && (
                            <Badge variant="neutral">+{(kw.latestPositions?.length ?? 0) - 5}</Badge>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        {(() => {
                          // Sparkline: best position per day (last 14d). Меньшая
                          // позиция = выше в выдаче = «лучше». Поэтому
                          // инвертируем (51 - p), чтобы линия росла вверх когда
                          // позиция улучшается. Цвет: green если за период
                          // позиция улучшилась, red если ухудшилась.
                          const sp = kw.sparkline ?? [];
                          const vals = sp.map((s) => s.p).filter((p): p is number => p != null);
                          if (vals.length < 2) {
                            return <span className="text-xs text-gray-400">мало данных</span>;
                          }
                          const inverted = vals.map((p) => Math.max(0, 51 - Math.min(p, 51)));
                          const first = vals[0]!;
                          const last = vals[vals.length - 1]!;
                          const color = last < first ? '#10b981' : last > first ? '#ef4444' : '#6b7280';
                          return <Sparkline values={inverted} color={color} width={100} height={24} />;
                        })()}
                      </td>
                      <td className="p-3 text-sm text-muted-foreground">
                        {kw.lastCheckedAt
                          ? new Date(kw.lastCheckedAt).toLocaleString('ru')
                          : 'Не проверялось'}
                      </td>
                      <td className="p-3">
                        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleCheckPositions(kw.keywordId)}
                            disabled={checking === kw.keywordId}
                          >
                            <RefreshCw
                              className={cn('h-4 w-4', checking === kw.keywordId && 'animate-spin')}
                            />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteKeyword(kw.keywordId)}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {/* Expanded History */}
                    {expandedKeyword === kw.keywordId && (
                      <tr>
                        <td colSpan={6} className="p-4 bg-muted/30">
                          {historyLoading ? (
                            <div className="text-center text-muted-foreground">Загрузка истории...</div>
                          ) : history.length === 0 ? (
                            <div className="text-center text-muted-foreground">Нет данных истории</div>
                          ) : (
                            <div className="space-y-2">
                              <h4 className="font-medium mb-2">История позиций</h4>
                              <div className="overflow-x-auto">
                                <div className="min-w-[480px]">
                                  <div className="grid grid-cols-5 gap-2 text-sm">
                                    <div className="font-medium">Дата</div>
                                    <div className="font-medium">Артикул</div>
                                    <div className="font-medium">Позиция</div>
                                    <div className="font-medium">Страница</div>
                                    <div className="font-medium">Промо</div>
                                  </div>
                                  {history.slice(0, 20).map((h, i) => (
                                    <div key={i} className="grid grid-cols-5 gap-2 text-sm border-t pt-1">
                                  <div>{new Date(h.checkedAt).toLocaleString('ru')}</div>
                                  <div><NmIdLink nmId={h.nmId} /></div>
                                  <div>
                                    <PositionBadge position={h.position} />
                                  </div>
                                  <div>{h.page ?? '-'}</div>
                                  <div>{h.isPromo ? '🔥 Да' : 'Нет'}</div>
                                </div>
                              ))}
                                </div>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        )}

        {/* Competitors Tab */}
        {tab === 'competitors' && (
          <CompetitorAnalysis workspaceId={workspaceId} />
        )}

        {/* Alert Settings Tab */}
        {tab === 'alerts' && (
          <AlertSettings workspaceId={workspaceId} />
        )}

        {/* Search Queries Tab */}
        {tab === 'queries' && (
          <>
            <KeywordSuggestions workspaceId={workspaceId} shopId={shopId} onAdded={fetchData} />
            <Card className="p-6">
              <SearchQueriesTable workspaceId={workspaceId} />
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}

// ── KPI card компонент для SEO (Helium-10-style) ─────────────────────────────
// Показывает label + крупное число + дельту относительно прошлой недели.
// `positive` — раскрашивает само число в зелёный (для метрик «больше = лучше»).
// `negative` — в красный (для метрик «больше = хуже»).
function KpiCard({
  label,
  value,
  delta,
  positive,
  negative,
  hint,
}: {
  label: string;
  value: number;
  delta?: number;
  positive?: boolean;
  negative?: boolean;
  hint?: string;
}) {
  const valueColor = positive ? 'text-emerald-700' : negative ? 'text-red-600' : 'text-gray-900';
  let deltaNode: React.ReactNode = null;
  if (typeof delta === 'number' && delta !== 0) {
    const isPositiveTrend = delta > 0;
    // Для счётчиков «В топ-10» и «В топ-50» positive=undefined: рост значения = хорошо.
    // Для «↓ Падают» — negative=true: рост значения = плохо.
    const goodDirection = negative ? !isPositiveTrend : isPositiveTrend;
    const cls = goodDirection ? 'text-emerald-700' : 'text-red-600';
    deltaNode = (
      <span className={cn('text-xs font-medium ml-2', cls)} title={hint}>
        {isPositiveTrend ? '+' : ''}{delta}
      </span>
    );
  }
  return (
    <Card className="p-4" title={hint}>
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="flex items-baseline">
        <div className={cn('text-2xl font-bold', valueColor)}>{formatNumber(value)}</div>
        {deltaNode}
      </div>
    </Card>
  );
}
