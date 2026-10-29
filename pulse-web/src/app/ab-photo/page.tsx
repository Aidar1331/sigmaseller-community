'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { useWorkspaceStore } from '@/store/workspace';
import { useShopChange } from '@/hooks/useShopChange';
import { useShopParam, useActiveShop } from '@/hooks/useShopParam';
import {
  Plus, Play, Pause, CheckCircle, CheckCircle2, Image, Upload, Clock,
  ArrowLeftRight, Trophy, TrendingUp, BarChart2, Settings,
  RefreshCw, Trash2, Eye, Pencil,
} from 'lucide-react';
import { WinnerReport } from '@/components/ab-photo/WinnerReport';
import { AbPhotoTimeline } from '@/components/ab-photo/AbPhotoTimeline';
import { PhotoUploader } from '@/components/ab-photo/PhotoUploader';

type TestType = 'photos' | 'title' | 'description' | 'characteristics' | 'mixed';

type VariantContent = {
  photos: string[];
  title: string;
  description: string;
};

type ABTest = {
  testId: number;
  nmId: number;
  name: string | null;
  status: 'running' | 'paused' | 'completed';
  periodDays: number;
  rotationMinutes: number;
  goal: 'orders' | 'ctr' | 'revenue';
  currentVariant: 'A' | 'B';
  winnerVariant: 'A' | 'B' | null;
  autoRotate: boolean;
  compareAdsSeparately: boolean;
  lastRotatedAt: string | null;
  startedAt: string;
  createdAt: string;
  lastSyncError: string | null;
  lastSyncErrorAt: string | null;
  testType: TestType;
};

type VariantPayload = {
  photos: string[];
  title?: string | null;
  description?: string | null;
  label: string;
};

type TestDetails = ABTest & {
  variantA: VariantPayload;
  variantB: VariantPayload;
};

type TabKey = TestType | 'archived';
const TABS: Array<{ key: TabKey; label: string; description: string }> = [
  { key: 'photos', label: 'Фото', description: 'Тестируйте разные фото и находите лучшие для конверсии' },
  { key: 'title', label: 'Название', description: 'Сравнивайте формулировки названия товара' },
  { key: 'description', label: 'Описание', description: 'Тестируйте разные тексты описания' },
  { key: 'archived', label: 'Архив', description: 'Завершённые и отложенные тесты — не мешают активным' },
];

type Phase = {
  phaseId: number;
  variant: string;
  startedAt: string;
  endedAt: string | null;
};

type VariantStats = {
  viewCount: number;
  openCardCount: number;
  orderCount: number;
  revenueKopecks: number;
  ctrOpen: number | null;
  ctrOrder: number | null;
};

type AbForecast = {
  testDays: number;
  monthlyOrders: number;
  priceRubAvg: number;
  monthlyRevenueRub: number;
};

type Metrics = {
  totals: {
    A: { views: number; orders: number; ordersRub: number; ctr: number; conversion: number };
    B: { views: number; orders: number; ordersRub: number; ctr: number; conversion: number };
  };
  delta: {
    orders: number;
    ordersRub: number;
    ctr: number;
    conversion: number;
  };
};

const ROTATION_PRESETS = [
  { label: '20 минут', value: 20 },
  { label: '1 час', value: 60 },
  { label: '6 часов', value: 360 },
  { label: '1 день', value: 1440 },
  { label: '3 дня', value: 4320 },
  { label: '7 дней', value: 10080 },
];

export default function ABPhotoPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopParam = useShopParam();
  const { shopId } = useActiveShop();
  const [tests, setTests] = useState<ABTest[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>('photos');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTest, setSelectedTest] = useState<TestDetails | null>(null);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [stats, setStats] = useState<Record<string, VariantStats> | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [nextRotationAt, setNextRotationAt] = useState<string | null>(null);
  const [winner, setWinner] = useState<string | null>(null);
  const [systemWinnerCtr, setSystemWinnerCtr] = useState<string | null>(null);
  const [realWinnerOrders, setRealWinnerOrders] = useState<string | null>(null);
  const [significance, setSignificance] = useState<{ pValue: number | null; confidencePct: number | null; significant: boolean } | null>(null);
  const [pairwiseSignificance, setPairwiseSignificance] = useState<Record<string, { pValue: number | null; confidencePct: number | null; significant: boolean }>>({});
  const [forecast, setForecast] = useState<Record<string, AbForecast> | null>(null);
  const [variants, setVariants] = useState<Array<{ label: string; photos: string[] }>>([]);

  // Pending изменения «Настройки теста» — применяются только по кнопке
  // «Сохранить». До этого селекты и чекбоксы обновляют только локальный draft,
  // на сервер ничего не уходит (фидбек 2026-06-08: «добавь кнопку сохранить»).
  const [settingsDraft, setSettingsDraft] = useState<{
    rotationMinutes: number;
    goal: 'orders' | 'ctr' | 'revenue';
    autoRotate: boolean;
    compareAdsSeparately: boolean;
  } | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSavedAt, setSettingsSavedAt] = useState<number | null>(null);

  // Create test
  const [showCreate, setShowCreate] = useState(false);
  const [newTest, setNewTest] = useState({
    nmId: '',
    rotationMinutes: 20, // 20 мин — частая ротация, максимум проходов при коротком тесте
    goal: 'orders' as const,
    autoRotate: true,
    compareAdsSeparately: true,
  });
  const [creating, setCreating] = useState(false);

  // Variant content (photos + optional text overrides). Per-variant state
  // is kept flat for simplicity — backend accepts photos|title|description
  // independently, so empty strings are stripped on submit.
  // Массив вариантов создаваемого теста (2–5). Лейблы A..E присваиваются
  // по индексу. Раньше было жёсткое A/B — теперь UI динамический.
  // Имя `newVariants` чтобы не конфликтовать с `variants` для деталей теста.
  const [newVariants, setNewVariants] = useState<VariantContent[]>([
    { photos: [], title: '', description: '' },
    { photos: [], title: '', description: '' },
  ]);
  const variantLabels = ['A', 'B', 'C', 'D', 'E'] as const;
  const [showTextFields, setShowTextFields] = useState(false);

  const loadTests = useCallback(async () => {
    if (!workspaceId) return; // Guard: wait for workspace
    setLoading(true);
    setError(null);
    try {
      const archivedQs = `&archived=${activeTab === 'archived' ? '1' : '0'}`;
      const res = (await apiFetch(`/ab-photo/${workspaceId}?limit=50${shopParam}${archivedQs}`)) as { rows: ABTest[] };
      setTests(res.rows ?? []);
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось загрузить тесты');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, shopParam, activeTab]);

  const loadTestDetails = useCallback(async (testId: number) => {
    const shopQs = shopParam ? `?${shopParam.slice(1)}` : '';
    const res = (await apiFetch(`/ab-photo/${workspaceId}/${testId}${shopQs}`)) as {
      test: TestDetails;
      testType: TestType;
      phases: Phase[];
      stats: Record<string, VariantStats>;
      variants: Array<{ label: string; photos: string[]; title?: string | null; description?: string | null }>;
      nextRotationAt: string | null;
      winner: string | null;
      systemWinnerCtr: string | null;
      realWinnerOrders: string | null;
      significance: { pValue: number | null; confidencePct: number | null; significant: boolean } | null;
      pairwiseSignificance: Record<string, { pValue: number | null; confidencePct: number | null; significant: boolean }>;
      forecast: Record<string, AbForecast>;
    };
    setSelectedTest({ ...res.test, testType: res.testType });
    setSettingsDraft({
      rotationMinutes: res.test.rotationMinutes,
      goal: (res.test.goal as 'orders' | 'ctr' | 'revenue') ?? 'orders',
      autoRotate: !!res.test.autoRotate,
      compareAdsSeparately: !!(res.test as any).compareAdsSeparately,
    });
    setSettingsSavedAt(null);
    setPhases(res.phases ?? []);
    setStats(res.stats);
    setVariants(res.variants ?? []);
    setNextRotationAt(res.nextRotationAt);
    setWinner(res.winner);
    setSystemWinnerCtr(res.systemWinnerCtr);
    setRealWinnerOrders(res.realWinnerOrders);
    setSignificance(res.significance ?? null);
    setPairwiseSignificance(res.pairwiseSignificance ?? {});
    setForecast(res.forecast ?? null);

    // Note: /metrics endpoint больше не используется — блок «Сравнение метрик»
    // переведён на `stats` от /ab-photo/:ws/:testId, где числа уже разнесены
    // пропорционально доле времени активности варианта. См. фидбек 2026-06-08.
    setMetrics(null);
  }, [workspaceId, shopParam]);

  useEffect(() => {
    loadTests();
  }, [loadTests]);

  useShopChange(() => {
    setSelectedTest(null);
    setPhases([]);
    setStats(null);
    setMetrics(null);
    setWinner(null);
    setSystemWinnerCtr(null);
    setRealWinnerOrders(null);
    setSignificance(null);
    setPairwiseSignificance({});
    setForecast(null);
    setVariants([]);
    loadTests();
  });

  const onCreate = async () => {
    const nmId = Number.parseInt(newTest.nmId, 10);
    if (!Number.isFinite(nmId) || nmId <= 0) return;

    setCreating(true);
    try {
      // Собираем payload variants[] из текущего массива. Лейблы A..E по индексу.
      // Для каждого варианта оставляем только то поле, что соответствует
      // активной вкладке — backend требует «один тест = один тип».
      const buildVariant = (label: string, v: VariantContent) => {
        const base: any = { label };
        if (activeTab === 'photos') base.photos = v.photos;
        else if (activeTab === 'title') base.title = v.title.trim();
        else if (activeTab === 'description') base.description = v.description.trim();
        return base;
      };
      const variantsPayload = newVariants.map((v, i) => buildVariant(variantLabels[i], v));
      const res = (await apiFetch(`/ab-photo/${workspaceId}`, {
        method: 'POST',
        body: JSON.stringify({
          nmId,
          rotationMinutes: newTest.rotationMinutes,
          goal: newTest.goal,
          autoRotate: newTest.autoRotate,
          compareAdsSeparately: newTest.compareAdsSeparately,
          testType: activeTab === 'mixed' ? 'photos' : activeTab,
          variants: variantsPayload,
          ...(shopId ? { shopId } : {}),
        }),
        headers: { 'Content-Type': 'application/json' },
      })) as { test: ABTest };

      setShowCreate(false);
      setNewTest({ nmId: '', rotationMinutes: 20, goal: 'orders', autoRotate: true, compareAdsSeparately: true });
      setNewVariants([
        { photos: [], title: '', description: '' },
        { photos: [], title: '', description: '' },
      ]);
      setShowTextFields(false);
      loadTests();
    } finally {
      setCreating(false);
    }
  };

  const onSwitch = async (testId: number, variant: 'A' | 'B') => {
    const shopQs = shopParam ? `?${shopParam.slice(1)}` : '';
    await apiFetch(`/ab-photo/${workspaceId}/${testId}/switch${shopQs}`, {
      method: 'POST',
      body: JSON.stringify({ variant, ...(shopId ? { shopId } : {}) }),
      headers: { 'Content-Type': 'application/json' },
    });
    loadTestDetails(testId);
    loadTests();
  };

  const onPause = async (testId: number) => {
    const shopQs = shopParam ? `?${shopParam.slice(1)}` : '';
    await apiFetch(`/ab-photo/${workspaceId}/${testId}/pause${shopQs}`, { method: 'POST' });
    loadTestDetails(testId);
    loadTests();
  };

  const onResume = async (testId: number) => {
    const shopQs = shopParam ? `?${shopParam.slice(1)}` : '';
    await apiFetch(`/ab-photo/${workspaceId}/${testId}/resume${shopQs}`, { method: 'POST' });
    loadTestDetails(testId);
    loadTests();
  };

  const onComplete = async (testId: number) => {
    const shopQs = shopParam ? `?${shopParam.slice(1)}` : '';
    const res = (await apiFetch(`/ab-photo/${workspaceId}/${testId}/complete${shopQs}`, { method: 'POST' })) as {
      winner: 'A' | 'B' | null;
      stats: any;
    };
    loadTestDetails(testId);
    loadTests();
  };

  const onArchive = async (testId: number) => {
    if (!confirm('Отправить тест в архив? Активные и завершённые тесты в архиве не видны в основном списке, но сохраняются.')) return;
    const shopQs = shopParam ? `?${shopParam.slice(1)}` : '';
    await apiFetch(`/ab-photo/${workspaceId}/${testId}/archive${shopQs}`, { method: 'POST' });
    if (selectedTest?.testId === testId) setSelectedTest(null);
    loadTests();
  };

  const onUnarchive = async (testId: number) => {
    const shopQs = shopParam ? `?${shopParam.slice(1)}` : '';
    await apiFetch(`/ab-photo/${workspaceId}/${testId}/unarchive${shopQs}`, { method: 'POST' });
    loadTests();
  };

  const onDelete = async (testId: number) => {
    if (!confirm('Удалить тест? Это удалит сам тест, все его фазы и метрики. Операция необратима.')) return;
    const shopQs = shopParam ? `?${shopParam.slice(1)}` : '';
    await apiFetch(`/ab-photo/${workspaceId}/${testId}${shopQs}`, { method: 'DELETE' });
    if (selectedTest?.testId === testId) setSelectedTest(null);
    loadTests();
  };

  const onUpdateSettings = async (testId: number, settings: Partial<ABTest>) => {
    const shopQs = shopParam ? `?${shopParam.slice(1)}` : '';
    await apiFetch(`/ab-photo/${workspaceId}/${testId}/settings${shopQs}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...settings, ...(shopId ? { shopId } : {}) }),
      headers: { 'Content-Type': 'application/json' },
    });
    loadTestDetails(testId);
  };

  // Сохраняем все изменения настроек одной PATCH-операцией. Появилось
  // после фидбека 2026-06-08 — раньше каждый чекбокс/селект мгновенно уходил
  // на сервер, не было понимания «вступили ли изменения в силу».
  const onSaveSettings = async () => {
    if (!selectedTest || !settingsDraft) return;
    setSavingSettings(true);
    try {
      await onUpdateSettings(selectedTest.testId, settingsDraft);
      setSettingsSavedAt(Date.now());
      // Скрыть «вступили в силу» через 4 секунды
      setTimeout(() => setSettingsSavedAt((v) => (v && Date.now() - v >= 3900 ? null : v)), 4000);
    } catch (e) {
      console.error('save settings', e);
    } finally {
      setSavingSettings(false);
    }
  };

  // Есть ли несохранённые изменения?
  const settingsDirty = (() => {
    if (!selectedTest || !settingsDraft) return false;
    return (
      settingsDraft.rotationMinutes !== selectedTest.rotationMinutes ||
      settingsDraft.goal !== selectedTest.goal ||
      settingsDraft.autoRotate !== selectedTest.autoRotate ||
      settingsDraft.compareAdsSeparately !== (selectedTest as any).compareAdsSeparately
    );
  })();

  const formatRotation = (minutes: number) => {
    if (minutes < 60) return `${minutes} мин`;
    if (minutes < 1440) return `${Math.round(minutes / 60)} ч`;
    return `${Math.round(minutes / 1440)} дн`;
  };

  const formatTimeUntil = (date: string) => {
    const diff = new Date(date).getTime() - Date.now();
    if (diff < 0) return 'сейчас';
    const mins = Math.round(diff / 60000);
    if (mins < 60) return `${mins} мин`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} ч`;
    return `${Math.round(hours / 24)} дн`;
  };

  /**
   * Renders the content of one variant in the details view. The shape depends
   * on the test type: thumbnails for photos, formatted text for title /
   * description. Falls back to "(не задано)" when the variant has no content
   * for the active type — happens for legacy tests or empty B-variants.
   */
  const renderVariantContent = (variant: VariantPayload | undefined, label: string, type: TestType) => {
    if (!variant) return <div className="text-sm text-gray-400 italic">(нет данных)</div>;
    if (type === 'title') {
      return variant.title
        ? <div className="text-base font-medium text-gray-900 whitespace-pre-wrap break-words">{variant.title}</div>
        : <div className="text-sm text-gray-400 italic">(пусто)</div>;
    }
    if (type === 'description') {
      return variant.description
        ? <div className="text-sm text-gray-800 whitespace-pre-wrap break-words max-h-60 overflow-y-auto">{variant.description}</div>
        : <div className="text-sm text-gray-400 italic">(пусто)</div>;
    }
    return renderPhotoGrid(variant.photos ?? [], label);
  };

  const renderPhotoGrid = (photos: string[], variant: string) => (
    <div className="grid grid-cols-2 gap-2">
      {photos.slice(0, 4).map((url, i) => (
        <div key={i} className="aspect-square bg-gray-100 rounded-lg overflow-hidden">
          <img src={url} alt={`${variant}-${i}`} className="w-full h-full object-cover" />
        </div>
      ))}
      {photos.length === 0 && (
        <div className="col-span-2 aspect-video bg-gray-100 rounded-lg flex items-center justify-center text-gray-500">
          <Image className="h-8 w-8" />
        </div>
      )}
    </div>
  );

  const renderMetricComparison = (label: string, valueA: number, valueB: number, format: (v: number) => string, higherIsBetter = true) => {
    const diff = valueB - valueA;
    const pctDiff = valueA > 0 ? (diff / valueA) * 100 : 0;
    const winner = higherIsBetter ? (valueB > valueA ? 'B' : valueA > valueB ? 'A' : null) : (valueB < valueA ? 'B' : valueA < valueB ? 'A' : null);

    return (
      <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
        <span className="text-sm text-gray-600">{label}</span>
        <div className="flex items-center gap-4">
          <span className={cn('text-sm font-medium', winner === 'A' && 'text-green-700')}>
            {format(valueA)}
          </span>
          <span className={cn(
            'text-xs px-1.5 py-0.5 rounded',
            pctDiff > 0 && higherIsBetter ? 'bg-green-100 text-green-700' :
            pctDiff < 0 && higherIsBetter ? 'bg-red-100 text-red-700' :
            'bg-gray-100 text-gray-500'
          )}>
            {pctDiff > 0 ? '+' : ''}{pctDiff.toFixed(1)}%
          </span>
          <span className={cn('text-sm font-medium', winner === 'B' && 'text-green-700')}>
            {format(valueB)}
          </span>
        </div>
      </div>
    );
  };

  const currentTab = TABS.find((t) => t.key === activeTab) ?? TABS[0];
  const visibleTests = activeTab === 'archived'
    ? tests // на этом табе бэкенд уже отдал только архивные
    : tests.filter((t) => (t.testType ?? 'photos') === activeTab);
  const canCreate = activeTab !== 'characteristics' && activeTab !== 'archived';

  return (
    <AppShell title="A/B тесты">
      <div className="space-y-4">
        {/* Error Banner */}
        <ErrorBanner error={error} onRetry={loadTests} onDismiss={() => setError(null)} />

        {/* Tabs — switch between the four test types. Each type holds its own
            list of tests; characteristics is a placeholder for now. */}
        <Card className="p-0 overflow-hidden">
          <div className="flex border-b border-gray-200 overflow-x-auto">
            {TABS.map((tab) => {
              const count = tests.filter((t) => (t.testType ?? 'photos') === tab.key).length;
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => { setActiveTab(tab.key); setSelectedTest(null); }}
                  className={cn(
                    'px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap',
                    active
                      ? 'border-indigo-600 text-indigo-700'
                      : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50',
                  )}
                >
                  {tab.label}
                  {count > 0 && (
                    <span className={cn(
                      'ml-2 text-xs px-1.5 py-0.5 rounded-full',
                      active ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600',
                    )}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between p-4">
            <div>
              <h2 className="text-lg font-medium">A/B тест — {currentTab.label.toLowerCase()}</h2>
              <p className="text-sm text-gray-500 mt-0.5">{currentTab.description}</p>
            </div>
            {canCreate && (
              <Button variant="primary" onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4" />
                Новый тест
              </Button>
            )}
          </div>
        </Card>

        {/* Characteristics — placeholder until WB subject metadata is wired up */}
        {activeTab === 'characteristics' && (
          <Card className="p-8 text-center text-gray-500">
            <Settings className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <div className="text-sm">
              Тесты характеристик скоро будут доступны. Сейчас можно тестировать фото, название и описание.
            </div>
          </Card>
        )}

        {/* Tests grid */}
        {activeTab !== 'characteristics' && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {visibleTests.map((test) => {
            const nextRotationAt = test.status === 'running' && test.autoRotate && test.lastRotatedAt
              ? new Date(new Date(test.lastRotatedAt).getTime() + test.rotationMinutes * 60_000)
              : null;
            const minsToNext = nextRotationAt
              ? Math.round((nextRotationAt.getTime() - Date.now()) / 60_000)
              : null;
            const createdLabel = test.createdAt
              ? new Date(test.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
              : null;
            return (
            <Card
              key={test.testId}
              className={cn(
                'p-4 cursor-pointer hover:shadow-md transition-shadow',
                selectedTest?.testId === test.testId && 'ring-2 ring-indigo-500'
              )}
              onClick={() => loadTestDetails(test.testId)}
            >
              <div className="flex items-center justify-between mb-3">
                <Badge
                  variant={test.status === 'running' ? 'success' : test.status === 'completed' ? 'info' : 'warning'}
                >
                  {test.status === 'running' ? '▶ Активен' : test.status === 'completed' ? '✓ Завершён' : '⏸ Пауза'}
                </Badge>
                <span className="text-xs text-gray-500">#{test.testId}</span>
              </div>

              <div className="text-sm font-semibold mb-1 truncate inline-flex items-center gap-1.5">
                <span>{test.name?.trim() || `Тест #${test.testId}`}</span>
                <Pencil className="h-3 w-3 text-gray-300" />
              </div>
              <div className="text-xs text-gray-500 mb-2">Артикул: <NmIdLink nmId={test.nmId} /></div>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500 mb-2">
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatRotation(test.rotationMinutes)}
                </span>
                <span>·</span>
                <span>Текущий: <span className="font-medium text-gray-700">{test.currentVariant}</span></span>
                <span>·</span>
                <Badge variant={test.autoRotate ? 'success' : 'neutral'} size="sm">
                  Авто: {test.autoRotate ? 'ВКЛ' : 'ВЫКЛ'}
                </Badge>
              </div>

              {test.status === 'running' && test.autoRotate && minsToNext !== null && (
                <div className="text-xs text-indigo-700 bg-indigo-50 rounded px-2 py-1 mb-2">
                  {minsToNext <= 0
                    ? 'Следующая ротация в ближайшие 5 минут'
                    : `Следующая ротация через ~${minsToNext} мин`}
                </div>
              )}

              {createdLabel && (
                <div className="text-[11px] text-gray-400">Создан {createdLabel}</div>
              )}

              {test.lastSyncError && (
                <div className="mt-2 text-xs bg-red-50 text-red-700 border border-red-200 rounded px-2 py-1">
                  ⚠️ WB отверг последнюю замену фото. Скорее всего у токена нет
                  scope «Контент-write» — обнови ключ в /shops.
                </div>
              )}

              {test.winnerVariant && (
                <div className="mt-2 flex items-center gap-2 text-sm text-green-700 bg-green-50 rounded-lg px-2 py-1">
                  <Trophy className="h-4 w-4" />
                  Победитель: Вариант {test.winnerVariant}
                </div>
              )}
            </Card>
            );
          })}

          {!loading && visibleTests.length === 0 && (
            <Card className="p-8 text-center text-gray-500 col-span-full">
              <Image className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <div>Нет тестов в этой вкладке</div>
              <div className="text-sm mt-1">Создайте первый A/B тест — {currentTab.label.toLowerCase()}</div>
            </Card>
          )}
        </div>
        )}

        {/* Test details */}
        {selectedTest && (
          <Card className="p-6">
            {selectedTest.lastSyncError && (
              <div className="mb-4 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                <span className="text-lg leading-none">⚠️</span>
                <div>
                  <div className="font-medium">WB отверг последнюю замену фото.</div>
                  <div className="text-xs mt-1">
                    Скорее всего у WB Partner-токена нет scope «Контент-write».
                    Зайди в seller.wildberries.ru → Настройки → Доступ к API,
                    пересоздай токен с галкой «Контент», и обнови ключ в /shops.
                    {selectedTest.lastSyncErrorAt && (
                      <span className="text-red-600/70"> · {new Date(selectedTest.lastSyncErrorAt).toLocaleString('ru-RU')}</span>
                    )}
                  </div>
                </div>
              </div>
            )}
            <div className="flex items-center justify-between mb-6">
              <div className="flex-1 min-w-0">
                <TestNameEditor
                  testId={selectedTest.testId}
                  workspaceId={workspaceId ?? 0}
                  shopParam={shopParam ?? ''}
                  initialName={selectedTest.name ?? ''}
                  onSaved={(name) => {
                    setSelectedTest({ ...selectedTest, name });
                    setTests(prev => prev.map(t => t.testId === selectedTest.testId ? { ...t, name } : t));
                  }}
                />
                <div className="text-sm text-gray-500">
                  Артикул: <NmIdLink nmId={selectedTest.nmId} />
                  {selectedTest.createdAt && (
                    <span className="ml-2 text-xs text-gray-400">
                      · создан {new Date(selectedTest.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {selectedTest.status === 'running' ? (
                  <Button variant="neutral" size="sm" onClick={() => onPause(selectedTest.testId)}>
                    <Pause className="h-4 w-4" />
                    Пауза
                  </Button>
                ) : selectedTest.status === 'paused' ? (
                  <Button variant="neutral" size="sm" onClick={() => onResume(selectedTest.testId)}>
                    <Play className="h-4 w-4" />
                    Продолжить
                  </Button>
                ) : null}
                {selectedTest.status !== 'completed' && (
                  <Button variant="success" size="sm" onClick={() => onComplete(selectedTest.testId)}>
                    <CheckCircle className="h-4 w-4" />
                    Завершить
                  </Button>
                )}
                {(selectedTest as any).archivedAt ? (
                  <Button variant="neutral" size="sm" onClick={() => onUnarchive(selectedTest.testId)}>
                    <RefreshCw className="h-4 w-4" />
                    Из архива
                  </Button>
                ) : (
                  <Button variant="neutral" size="sm" onClick={() => onArchive(selectedTest.testId)}>
                    <Eye className="h-4 w-4" />
                    В архив
                  </Button>
                )}
                <Button variant="danger" size="sm" onClick={() => onDelete(selectedTest.testId)}>
                  <Trash2 className="h-4 w-4" />
                  Удалить
                </Button>
              </div>
            </div>

            {/* N-вариантный отчёт. Показываем когда есть победитель и хотя бы у двух
                вариантов есть данные — иначе сравнивать не с чем. */}
            {(() => {
              if (!stats || !winner || !forecast) return null;
              const labels = variants.length > 0 ? variants.map((v) => v.label) : Object.keys(stats);
              const withData = labels.filter((l) => (stats[l]?.viewCount ?? 0) > 0);
              if (withData.length < 2) return null;
              const photoByVariant: Record<string, string | null> = {};
              for (const l of labels) {
                const fromVariants = variants.find((v) => v.label === l)?.photos?.[0] ?? null;
                const fromLegacy = (selectedTest as any)?.[`variant${l}`]?.photos?.[0] ?? null;
                photoByVariant[l] = fromVariants ?? fromLegacy ?? null;
              }
              return (
                <WinnerReport
                  winner={winner}
                  labels={labels}
                  photoByVariant={photoByVariant}
                  stats={stats}
                  forecast={forecast}
                  significance={significance}
                  pairwiseSignificance={pairwiseSignificance}
                  systemWinnerCtr={systemWinnerCtr}
                  realWinnerOrders={realWinnerOrders}
                />
              );
            })()}

            {/* Variants comparison */}
            <div className="grid md:grid-cols-2 gap-6 mb-6">
              {/* Variant A */}
              <div className={cn(
                'rounded-lg border-2 p-4',
                selectedTest.currentVariant === 'A' ? 'border-blue-500 bg-blue-50' : 'border-gray-200',
                selectedTest.winnerVariant === 'A' && 'border-green-500 bg-green-50'
              )}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Badge variant={selectedTest.currentVariant === 'A' ? 'info' : 'neutral'}>
                      Вариант A
                    </Badge>
                    {selectedTest.winnerVariant === 'A' && (
                      <Trophy className="h-4 w-4 text-green-500" />
                    )}
                  </div>
                  {selectedTest.status === 'running' && selectedTest.currentVariant !== 'A' && (
                    <Button variant="neutral" size="sm" onClick={() => onSwitch(selectedTest.testId, 'A')}>
                      <ArrowLeftRight className="h-4 w-4" />
                      Переключить
                    </Button>
                  )}
                </div>
                {renderVariantContent(selectedTest.variantA, 'A', selectedTest.testType ?? 'photos')}
                {stats && (
                  <div className="mt-3 text-xs text-gray-500 space-y-1">
                    <div>Заказы: {stats.A.orderCount}</div>
                    <div>Конверсия: {stats.A.ctrOrder ? (stats.A.ctrOrder * 100).toFixed(2) : '—'}%</div>
                  </div>
                )}
              </div>

              {/* Variant B */}
              <div className={cn(
                'rounded-lg border-2 p-4',
                selectedTest.currentVariant === 'B' ? 'border-orange-500 bg-orange-50' : 'border-gray-200',
                selectedTest.winnerVariant === 'B' && 'border-green-500 bg-green-50'
              )}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Badge variant={selectedTest.currentVariant === 'B' ? 'warning' : 'neutral'}>
                      Вариант B
                    </Badge>
                    {selectedTest.winnerVariant === 'B' && (
                      <Trophy className="h-4 w-4 text-green-500" />
                    )}
                  </div>
                  {selectedTest.status === 'running' && selectedTest.currentVariant !== 'B' && (
                    <Button variant="neutral" size="sm" onClick={() => onSwitch(selectedTest.testId, 'B')}>
                      <ArrowLeftRight className="h-4 w-4" />
                      Переключить
                    </Button>
                  )}
                </div>
                {renderVariantContent(selectedTest.variantB, 'B', selectedTest.testType ?? 'photos')}
                {stats && (
                  <div className="mt-3 text-xs text-gray-500 space-y-1">
                    <div>Заказы: {stats.B.orderCount}</div>
                    <div>Конверсия: {stats.B.ctrOrder ? (stats.B.ctrOrder * 100).toFixed(2) : '—'}%</div>
                  </div>
                )}
              </div>
            </div>

            {/* Metrics comparison — источник `stats` от /ab-photo/:ws/:testId.
                Раньше брали из /metrics, который агрегирует `ab_photo_metrics`
                полные дневные числа БЕЗ пропорционального деления — обе
                колонки показывали одинаково (фидбек 2026-06-08). */}
            {stats && (() => {
              const sA = stats['A'];
              const sB = stats['B'];
              if (!sA || !sB) return null;
              return (
                <div className="mb-6">
                  <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                    <BarChart2 className="h-4 w-4" />
                    Сравнение метрик (A vs B)
                  </h4>
                  <div className="bg-gray-50 rounded-lg p-4">
                    {renderMetricComparison('Заказы', sA.orderCount, sB.orderCount, v => String(v))}
                    {renderMetricComparison('Выручка', sA.revenueKopecks, sB.revenueKopecks, v => `${(v / 100).toLocaleString('ru-RU')}₽`)}
                    {renderMetricComparison('CTR рекламы', (sA as any).adCtr != null ? (sA as any).adCtr * 100 : 0, (sB as any).adCtr != null ? (sB as any).adCtr * 100 : 0, v => `${v.toFixed(2)}%`)}
                    {renderMetricComparison('% заказов от показов', (sA.ctrOrder ?? 0) * 100, (sB.ctrOrder ?? 0) * 100, v => `${v.toFixed(2)}%`)}
                  </div>
                </div>
              );
            })()}

            {/* Timeline chart (по дням) — фикс 2026-06-08 */}
            {workspaceId && selectedTest && (
              <div className="mb-6">
                <AbPhotoTimeline workspaceId={workspaceId} testId={selectedTest.testId} />
              </div>
            )}

            {/* Settings — изменения применяются по кнопке «Сохранить» */}
            {settingsDraft && (
              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <Settings className="h-4 w-4" />
                  Настройки теста
                </h4>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-gray-500">Периодичность ротации</label>
                    <select
                      className="w-full mt-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                      value={settingsDraft.rotationMinutes}
                      onChange={(e) => setSettingsDraft((d) => d ? { ...d, rotationMinutes: Number(e.target.value) } : d)}
                      disabled={selectedTest.status === 'completed'}
                    >
                      {ROTATION_PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">Цель</label>
                    <select
                      className="w-full mt-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                      value={settingsDraft.goal}
                      onChange={(e) => setSettingsDraft((d) => d ? { ...d, goal: e.target.value as 'orders' | 'ctr' | 'revenue' } : d)}
                      disabled={selectedTest.status === 'completed'}
                    >
                      <option value="orders">Заказы</option>
                      <option value="ctr">CTR</option>
                      <option value="revenue">Выручка</option>
                    </select>
                  </div>
                </div>
                <div className="flex items-center gap-4 mt-3 flex-wrap">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={settingsDraft.autoRotate}
                      onChange={(e) => setSettingsDraft((d) => d ? { ...d, autoRotate: e.target.checked } : d)}
                      disabled={selectedTest.status === 'completed'}
                      className="rounded border-gray-300"
                    />
                    Автоматическая ротация
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={settingsDraft.compareAdsSeparately}
                      onChange={(e) => setSettingsDraft((d) => d ? { ...d, compareAdsSeparately: e.target.checked } : d)}
                      disabled={selectedTest.status === 'completed'}
                      className="rounded border-gray-300"
                    />
                    Раздельные метрики рекламы
                  </label>
                </div>

                {/* Кнопка «Сохранить» — активна только если есть несохранённые
                    изменения. Под ней — баннер «Новые параметры вступили в силу»
                    после успешного PATCH. */}
                <div className="mt-4 flex items-center gap-3 flex-wrap">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={onSaveSettings}
                    disabled={!settingsDirty || savingSettings || selectedTest.status === 'completed'}
                    loading={savingSettings}
                  >
                    Сохранить
                  </Button>
                  {settingsDirty && !savingSettings && (
                    <span className="text-xs text-amber-700">Есть несохранённые изменения</span>
                  )}
                  {settingsSavedAt && !settingsDirty && (
                    <span className="text-xs text-emerald-700 flex items-center gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Новые параметры вступили в силу
                    </span>
                  )}
                </div>

                {nextRotationAt && selectedTest.status === 'running' && (
                  <div className="mt-3 text-xs text-gray-500">
                    Следующая ротация через: {formatTimeUntil(nextRotationAt)}
                  </div>
                )}
              </div>
            )}

            {/* Phases timeline */}
            <div className="mt-6">
              <h4 className="text-sm font-medium text-gray-700 mb-3">История фаз</h4>
              <div className="space-y-2">
                {phases.map((phase, i) => (
                  <div key={phase.phaseId} className="flex items-center gap-3 text-sm">
                    <Badge variant={phase.variant === 'A' ? 'info' : 'warning'} size="sm">
                      {phase.variant}
                    </Badge>
                    <span className="text-gray-500">
                      {new Date(phase.startedAt).toLocaleString()} 
                      {phase.endedAt && ` → ${new Date(phase.endedAt).toLocaleString()}`}
                    </span>
                    {!phase.endedAt && <Badge variant="success" size="sm">Активна</Badge>}
                  </div>
                ))}
                {phases.length === 0 && (
                  <div className="text-sm text-gray-500">Нет фаз</div>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* Create modal */}
        {showCreate && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <Card className="w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-medium">
                  Создать A/B тест — {currentTab.label.toLowerCase()}
                </h2>
                <button onClick={() => setShowCreate(false)} className="text-gray-500 hover:text-gray-600">
                  ×
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-sm text-gray-600">Товар *</label>
                  {/* B3 fix 2026-05-07: replaced raw Input with ProductSearchInput
                      so user can search by name/vendorCode/nmId with autocomplete
                      instead of manually typing nmId. Single-select mode. */}
                  {workspaceId !== null && workspaceId > 0 ? (
                    <div className="mt-1">
                      <ProductSearchInput
                        workspaceId={workspaceId}
                        value={newTest.nmId}
                        onChange={(v) => setNewTest(n => ({ ...n, nmId: v }))}
                        single
                        placeholder="Поиск по названию или артикулу..."
                      />
                    </div>
                  ) : (
                    <Input
                      value={newTest.nmId}
                      onChange={(e) => setNewTest(n => ({ ...n, nmId: e.target.value }))}
                      placeholder="123456789"
                      className="mt-1"
                    />
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm text-gray-600">Периодичность ротации</label>
                    <select
                      className="w-full mt-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                      value={newTest.rotationMinutes}
                      onChange={(e) => setNewTest(n => ({ ...n, rotationMinutes: Number(e.target.value) }))}
                    >
                      {ROTATION_PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-sm text-gray-600">Цель теста</label>
                    <select
                      className="w-full mt-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                      value={newTest.goal}
                      onChange={(e) => setNewTest(n => ({ ...n, goal: e.target.value as any }))}
                    >
                      <option value="orders">Заказы</option>
                      <option value="ctr">CTR</option>
                      <option value="revenue">Выручка</option>
                    </select>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={newTest.autoRotate}
                      onChange={(e) => setNewTest(n => ({ ...n, autoRotate: e.target.checked }))}
                      className="rounded border-gray-300"
                    />
                    Автоматическая ротация
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={newTest.compareAdsSeparately}
                      onChange={(e) => setNewTest(n => ({ ...n, compareAdsSeparately: e.target.checked }))}
                      className="rounded border-gray-300"
                    />
                    Раздельные метрики рекламы
                  </label>
                </div>

                {/* Динамические варианты (2-5). Active tab задаёт какое поле
                    редактируется — backend ждёт «один тест = один тип». */}
                {activeTab !== 'characteristics' && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium text-gray-700">
                        Варианты для теста ({newVariants.length} из 5)
                      </div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="neutral"
                          size="sm"
                          disabled={newVariants.length <= 2}
                          onClick={() => setNewVariants(prev => prev.slice(0, -1))}
                        >
                          − Убрать
                        </Button>
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          disabled={newVariants.length >= 5}
                          onClick={() => setNewVariants(prev => [...prev, { photos: [], title: '', description: '' }])}
                        >
                          + Добавить вариант
                        </Button>
                      </div>
                    </div>

                    <div
                      className={cn(
                        'grid gap-4',
                        newVariants.length === 2 && 'sm:grid-cols-2',
                        newVariants.length === 3 && 'sm:grid-cols-3',
                        newVariants.length >= 4 && 'sm:grid-cols-2 lg:grid-cols-4',
                      )}
                    >
                      {newVariants.map((v, idx) => {
                        const label = variantLabels[idx];
                        const updateThis = (patch: Partial<VariantContent>) => {
                          setNewVariants(prev => prev.map((x, i) => i === idx ? { ...x, ...patch } : x));
                        };
                        return (
                          <div key={idx} className="rounded-lg border border-gray-200 p-3">
                            <div className="text-sm font-medium text-gray-700 mb-2">Вариант {label}</div>

                            {activeTab === 'photos' && workspaceId !== null && workspaceId > 0 && (
                              <PhotoUploader
                                workspaceId={workspaceId}
                                value={v.photos}
                                onChange={(photos) => updateThis({ photos })}
                                max={4}
                              />
                            )}

                            {activeTab === 'title' && (
                              <>
                                <input
                                  type="text"
                                  maxLength={120}
                                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                                  placeholder={`Заголовок ${label} (до 120 символов)`}
                                  value={v.title}
                                  onChange={(e) => updateThis({ title: e.target.value })}
                                />
                                <div className="text-xs text-gray-400 mt-1">{v.title.length}/120</div>
                              </>
                            )}

                            {activeTab === 'description' && (
                              <>
                                <textarea
                                  rows={6}
                                  maxLength={5000}
                                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                                  placeholder={`Описание ${label}`}
                                  value={v.description}
                                  onChange={(e) => updateThis({ description: e.target.value })}
                                />
                                <div className="text-xs text-gray-400 mt-1">{v.description.length}/5000</div>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-4">
                <Button variant="neutral" onClick={() => setShowCreate(false)}>
                  Отмена
                </Button>
                <Button variant="primary" onClick={onCreate} loading={creating}>
                  Создать тест
                </Button>
              </div>
            </Card>
          </div>
        )}
      </div>
    </AppShell>
  );
}

/**
 * Inline-editor имени теста. Клик по имени переключает в input, Enter / blur
 * сохраняет через PATCH /ab-photo/:ws/:id/settings (name). Escape отменяет.
 */
function TestNameEditor({
  testId,
  workspaceId,
  shopParam,
  initialName,
  onSaved,
}: {
  testId: number;
  workspaceId: number;
  shopParam: string;
  initialName: string;
  onSaved: (name: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialName);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setValue(initialName); }, [initialName, testId]);

  const fallback = `Тест #${testId}`;
  const displayName = (initialName?.trim() ? initialName.trim() : fallback);

  const save = async () => {
    const next = value.trim();
    if (next === (initialName ?? '').trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const q = shopParam ? `?${shopParam.slice(1)}` : '';
      await apiFetch(`/ab-photo/${workspaceId}/${testId}/settings${q}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: next || null }),
        headers: { 'Content-Type': 'application/json' },
      });
      onSaved(next || null);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  if (!editing) {
    return (
      <h3
        className="text-lg font-medium cursor-pointer hover:bg-gray-50 rounded px-1 -mx-1 inline-flex items-center gap-1.5 group"
        title="Кликни чтобы переименовать"
        onClick={() => setEditing(true)}
      >
        <span>{displayName}</span>
        <Pencil className="h-3.5 w-3.5 text-gray-400 group-hover:text-indigo-600 transition-colors" />
      </h3>
    );
  }

  return (
    <input
      autoFocus
      className="text-lg font-medium border-b border-indigo-400 outline-none px-1 -mx-1 bg-transparent w-full max-w-md"
      value={value}
      disabled={saving}
      placeholder={fallback}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { setValue(initialName); setEditing(false); }
      }}
    />
  );
}
