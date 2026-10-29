'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Wallet,
  Plus,
  Trash2,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Calendar,
  Check,
  FolderTree,
} from 'lucide-react';
import { useShopChange } from '@/hooks/useShopChange';
import { useShopParam } from '@/hooks/useShopParam';
import { CashflowCategories } from './components/CashflowCategories';
import { WbPayouts } from './components/WbPayouts';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { AppShell } from '@/components/AppShell';
import { SyncFreshnessBadge } from '@/components/SyncFreshnessBadge';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { formatNumber } from '@/lib/format';
import { useWorkspaceStore } from '@/store/workspace';
import { Paywall } from '@/components/Paywall';
import { ExportButton } from '@/components/ui/ExportButton';
import type { ExportColumn } from '@/lib/exportTable';

const PLANNED_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'name', label: 'Название', type: 'text' },
  { key: 'category', label: 'Категория', type: 'text' },
  { key: 'amount', label: 'Сумма', type: 'rub' },
  { key: 'plannedDate', label: 'Дата', type: 'date' },
  { key: 'isCompleted', label: 'Выполнено', type: 'text' },
];

const FORECAST_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'weekStart', label: 'Неделя с', type: 'date' },
  { key: 'weekEnd', label: 'Неделя по', type: 'date' },
  { key: 'income', label: 'Доход', type: 'rub' },
  { key: 'expenses', label: 'Расход', type: 'rub' },
  { key: 'netFlow', label: 'Чистый поток', type: 'rub' },
  { key: 'balance', label: 'Баланс', type: 'rub' },
];

// Types
type PlannedItem = {
  itemId: number;
  name: string;
  category: string;
  amount: string;
  isRecurring: boolean;
  recurrenceType: string | null;
  startDate: string;
  plannedDate: string | null;
  isCompleted: boolean;
  notes: string | null;
};

type Entry = {
  entryId: number;
  date: string;
  category: string;
  description: string | null;
  amount: string;
  source: string;
};

type ForecastWeek = {
  weekStart: string;
  weekEnd: string;
  income: number;
  expenses: number;
  netFlow: number;
  balance: number;
  items: Array<{ name: string; amount: number; category: string }>;
};

type StatForecastWeek = {
  weekStart: string;
  weekEnd: string;
  predictedIncome: number;
  predictedExpenses: number;
  predictedNetFlow: number;
  predictedBalance: number;
  confidence: 'high' | 'medium' | 'low';
};

type Trends = {
  avgWeeklyIncome: number;
  avgWeeklyExpenses: number;
  incomeSlope: number;
  expenseSlope: number;
  incomeTrend: 'growing' | 'declining' | 'stable';
  expenseTrend: 'growing' | 'declining' | 'stable';
};

type Summary = {
  income: number;
  expenses: number;
  netFlow: number;
  currentBalance: number;
  byCategory: Array<{ category: string; label: string; total: number }>;
};

const categoryLabels: Record<string, string> = {
  purchase: 'Закупки',
  salary: 'Зарплата',
  rent: 'Аренда',
  ads: 'Реклама',
  tax: 'Налоги',
  other_expense: 'Прочие расходы',
  other_income: 'Прочие доходы',
  wb_payout: 'Выплата WB',
};

const categoryColors: Record<string, string> = {
  purchase: 'bg-blue-100 text-blue-700',
  salary: 'bg-purple-100 text-purple-700',
  rent: 'bg-orange-100 text-orange-700',
  ads: 'bg-pink-100 text-pink-700',
  tax: 'bg-red-100 text-red-700',
  other_expense: 'bg-gray-100 text-gray-700',
  other_income: 'bg-green-100 text-green-700',
  wb_payout: 'bg-emerald-100 text-emerald-700',
};

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function CashflowPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopParam = useShopParam();

  // Date range
  const today = useMemo(() => new Date(), []);
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - 30);
    return isoDate(d);
  });
  const [dateTo, setDateTo] = useState(() => isoDate(today));

  const [summary, setSummary] = useState<Summary | null>(null);
  const [forecast, setForecast] = useState<ForecastWeek[]>([]);
  const [statForecast, setStatForecast] = useState<StatForecastWeek[]>([]);
  const [trends, setTrends] = useState<Trends | null>(null);
  const [cashGaps, setCashGaps] = useState<ForecastWeek[]>([]);
  const [plannedItems, setPlannedItems] = useState<PlannedItem[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New item form
  const [showAddForm, setShowAddForm] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const [newItem, setNewItem] = useState(() => {
    const d = new Date();
    const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return {
      name: '',
      category: 'other_expense',
      amount: '',
      isExpense: true,
      plannedDate: localDate,
    };
  });

  // Fetch data
  const fetchData = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const dateParams = `dateFrom=${dateFrom}&dateTo=${dateTo}`;
      const [summaryRes, forecastRes, plannedRes, entriesRes] = await Promise.all([
        apiFetch<Summary>(`/cashflow/${workspaceId}/summary?${dateParams}${shopParam}`),
        apiFetch<{ forecast: ForecastWeek[]; cashGaps: ForecastWeek[]; currentBalance: number; statForecast?: StatForecastWeek[]; trends?: Trends }>(
          `/cashflow/${workspaceId}/forecast?${dateParams}${shopParam}`
        ),
        apiFetch<{ items: PlannedItem[] }>(`/cashflow/${workspaceId}/planned?${dateParams}${shopParam}`),
        apiFetch<{ entries: Entry[] }>(`/cashflow/${workspaceId}/entries?limit=50&${dateParams}${shopParam}`),
      ]);
      setSummary(summaryRes);
      setForecast(forecastRes.forecast);
      setStatForecast(forecastRes.statForecast ?? []);
      setTrends(forecastRes.trends ?? null);
      setCashGaps(forecastRes.cashGaps);
      setPlannedItems(plannedRes.items);
      setEntries(entriesRes.entries);

      // /cashflow/summary теперь читает финансы ВБ on-the-fly из wb_finance_reports.
      // Никакого auto-sync через sync-wb-payouts больше не нужно (эндпоинт deprecated, 410).
    } catch (err) {
      console.error('Failed to fetch cashflow data:', err);
      setError(err instanceof Error ? err.message : 'Не удалось загрузить данные ДДС');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, dateFrom, dateTo, shopParam]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Reload when shop/workspace changes
  useShopChange(fetchData);

  // Add planned item
  const handleAddItem = async () => {
    if (!workspaceId || !newItem.name || !newItem.amount) return;
    try {
      const amount = parseFloat(newItem.amount) * (newItem.isExpense ? -1 : 1);
      await apiFetch(`/cashflow/${workspaceId}/planned`, {
        method: 'POST',
        body: JSON.stringify({
          name: newItem.name,
          category: newItem.category,
          amount,
          startDate: newItem.plannedDate,
          plannedDate: newItem.plannedDate,
        }),
      });
      setShowAddForm(false);
      const d = new Date();
      const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      setNewItem({
        name: '',
        category: 'other_expense',
        amount: '',
        isExpense: true,
        plannedDate: localDate,
      });
      fetchData();
    } catch (err) {
      console.error('Failed to add item:', err);
      setError(err instanceof Error ? err.message : 'Не удалось добавить платёж');
    }
  };

  // Mark as completed
  const handleComplete = async (itemId: number) => {
    if (!workspaceId) return;
    try {
      await apiFetch(`/cashflow/${workspaceId}/planned/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isCompleted: true }),
      });
      fetchData();
    } catch (err) {
      console.error('Failed to complete item:', err);
      setError(err instanceof Error ? err.message : 'Не удалось отметить выполненным');
    }
  };

  // Delete item
  const handleDelete = async (itemId: number) => {
    if (!workspaceId) return;
    if (!confirm('Удалить эту запись?')) return;
    try {
      await apiFetch(`/cashflow/${workspaceId}/planned/${itemId}`, { method: 'DELETE' });
      fetchData();
    } catch (err) {
      console.error('Failed to delete item:', err);
      setError(err instanceof Error ? err.message : 'Не удалось удалить платёж');
    }
  };

  if (!workspaceId) {
    return (
      <AppShell>
        <div className="p-8 text-center text-muted-foreground">Выберите магазин</div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Paywall workspaceId={workspaceId ?? 0} feature="ДДС и прогнозы">
        <div className="space-y-6">
          {/* Cashflow depends on the finance + supplies streams. */}
          <div className="flex flex-wrap gap-2">
            <SyncFreshnessBadge stage="finance-daily" label="Финансы" />
            <SyncFreshnessBadge stage="supplies" label="Поставки" />
          </div>

          {/* Error Banner */}
          {error && <ErrorBanner error={error} onRetry={fetchData} onDismiss={() => setError(null)} />}

          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <Wallet className="h-6 w-6" />
                Движение денежных средств
            </h1>
            <p className="text-muted-foreground">Планирование и прогноз кассовых разрывов</p>
          </div>
          <div className="flex items-center gap-2">
            <DateRangePicker
              dateFrom={dateFrom}
              dateTo={dateTo}
              onDateFromChange={setDateFrom}
              onDateToChange={setDateTo}
            />
            <Button variant="neutral" onClick={() => setShowCategories(!showCategories)}>
              <FolderTree className="mr-2 h-4 w-4" />
              Категории
            </Button>
            <Button variant="neutral" onClick={fetchData} disabled={loading}>
              <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
              Обновить
            </Button>
            <Button onClick={() => setShowAddForm(!showAddForm)}>
              <Plus className="mr-2 h-4 w-4" />
              Добавить
            </Button>
          </div>
        </div>

        {/* Categories Panel */}
        {showCategories && workspaceId && (
          <CashflowCategories workspaceId={workspaceId} onClose={() => setShowCategories(false)} />
        )}

        {/* Summary Cards */}
        {summary && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:gap-4">
            <Card className="p-4">
              <div className="text-sm text-muted-foreground">Текущий баланс</div>
              <div
                className={cn(
                  'text-2xl font-bold',
                  summary.currentBalance >= 0 ? 'text-green-700' : 'text-red-600'
                )}
              >
                {formatNumber(summary.currentBalance)} ₽
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-sm text-muted-foreground flex items-center gap-1">
                <TrendingUp className="h-4 w-4 text-green-500" /> Доходы (30д)
              </div>
              <div className="text-2xl font-bold text-green-700">
                +{formatNumber(summary.income)} ₽
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-sm text-muted-foreground flex items-center gap-1">
                <TrendingDown className="h-4 w-4 text-red-500" /> Расходы (30д)
              </div>
              <div className="text-2xl font-bold text-red-600">
                -{formatNumber(summary.expenses)} ₽
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-sm text-muted-foreground">Чистый поток</div>
              <div
                className={cn(
                  'text-2xl font-bold',
                  summary.netFlow >= 0 ? 'text-green-700' : 'text-red-600'
                )}
              >
                {summary.netFlow >= 0 ? '+' : ''}{formatNumber(summary.netFlow)} ₽
              </div>
            </Card>
          </div>
        )}

        {/* Cash Gaps Warning */}
        {cashGaps.length > 0 && (
          <Card className="p-4 bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800">
            <div className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="h-5 w-5" />
              <span className="font-semibold">
                Обнаружено {cashGaps.length} потенциальных кассовых разрывов!
              </span>
            </div>
            <div className="mt-2 text-sm text-red-600">
              {cashGaps.map((gap, i) => (
                <div key={i}>
                  Неделя {gap.weekStart}: баланс {formatNumber(gap.balance)} ₽
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Add Form */}
        {showAddForm && (
          <Card className="p-4">
            <h3 className="font-semibold mb-3">Добавить платёж</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:gap-4">
              <div>
                <label className="text-sm text-muted-foreground">Название</label>
                <Input
                  value={newItem.name}
                  onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
                  placeholder="Закупка товара"
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Категория</label>
                <Select
                  value={newItem.category}
                  onValueChange={(v) => setNewItem({ ...newItem, category: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(categoryLabels).filter(([k]) => k !== 'wb_payout').map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Сумма</label>
                <div className="flex gap-2">
                  <Select
                    value={newItem.isExpense ? 'expense' : 'income'}
                    onValueChange={(v) => setNewItem({ ...newItem, isExpense: v === 'expense' })}
                  >
                    <SelectTrigger className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="expense">Расход</SelectItem>
                      <SelectItem value="income">Доход</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    value={newItem.amount}
                    onChange={(e) => setNewItem({ ...newItem, amount: e.target.value })}
                    placeholder="100000"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Дата</label>
                <Input
                  type="date"
                  value={newItem.plannedDate}
                  onChange={(e) => setNewItem({ ...newItem, plannedDate: e.target.value })}
                />
              </div>
              <div className="flex items-end">
                <Button onClick={handleAddItem} disabled={!newItem.name || !newItem.amount}>
                  Добавить
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Forecast — скрываем целиком если ВСЕ строки нулевые (8 строк +0/-0/=0
            на странице ничего не дают пользователю; вместо них — одно понятное
            сообщение). 2026-06-01. */}
        {(() => {
          const hasMeaningfulForecast = forecast?.some((w) => w.income !== 0 || w.expenses !== 0 || w.balance !== 0);
          if (!forecast || forecast.length === 0 || !hasMeaningfulForecast) {
            return (
              <Card className="p-6 border-dashed bg-gray-50/50">
                <h3 className="font-semibold mb-1">Прогноз будущих недель</h3>
                <p className="text-sm text-muted-foreground">
                  Чтобы построить прогноз кассы на 8 недель вперёд — нужны фактические данные о доходах и расходах
                  минимум за <span className="font-medium">4 последние недели</span>. SigmaSeller возьмёт их автоматически
                  из финансового отчёта WB и рассчитает прогноз без твоего участия.
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  Сейчас прогноз пустой — ждём пока WB пришлёт первые еженедельные отчёты, либо проверь что фильтр
                  магазина сверху правильный.
                </p>
              </Card>
            );
          }
          return (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Прогноз на 8 недель</h3>
            <ExportButton
              title="Прогноз ДДС на 8 недель"
              subtitle={`Начало: ${dateFrom}`}
              columns={FORECAST_EXPORT_COLUMNS}
              rows={forecast}
            />
          </div>
          <div className="space-y-2">
            {forecast.map((week, i) => (
              <div
                key={i}
                className={cn(
                  'flex items-center gap-4 p-2 rounded',
                  week.balance < 0 && 'bg-red-50 dark:bg-red-950'
                )}
              >
                <div className="w-32 text-sm text-muted-foreground">
                  {new Date(week.weekStart).toLocaleDateString('ru', { day: 'numeric', month: 'short' })}
                </div>
                <div className="flex-1">
                  <div className="flex gap-4 text-sm">
                    <span className="text-green-700">+{formatNumber(week.income)}</span>
                    <span className="text-red-600">-{formatNumber(week.expenses)}</span>
                    <span className={week.netFlow >= 0 ? 'text-green-700' : 'text-red-600'}>
                      = {week.netFlow >= 0 ? '+' : ''}{formatNumber(week.netFlow)}
                    </span>
                  </div>
                </div>
                <div
                  className={cn(
                    'w-32 text-right font-medium',
                    week.balance >= 0 ? 'text-green-700' : 'text-red-600'
                  )}
                >
                  {formatNumber(week.balance)} ₽
                </div>
              </div>
            ))}
          </div>
        </Card>
          );
        })()}

        {/* Statistical Forecast (AI) — show only if has data */}
        {statForecast.length > 0 && statForecast.some((w) => w.predictedIncome !== 0 || w.predictedExpenses !== 0) ? (
          <Card className="p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-indigo-500" />
                Статистический прогноз (на основе истории)
              </h3>
              {trends && (
                <div className="flex gap-3 text-xs">
                  <span className={cn(
                    'px-2 py-1 rounded',
                    trends.incomeTrend === 'growing' ? 'bg-green-100 text-green-700' :
                    trends.incomeTrend === 'declining' ? 'bg-red-100 text-red-700' :
                    'bg-gray-100 text-gray-700'
                  )}>
                    Доходы: {trends.incomeTrend === 'growing' ? 'растут' : trends.incomeTrend === 'declining' ? 'падают' : 'стабильны'}
                    {' '}(~{formatNumber(trends.avgWeeklyIncome)} ₽/нед)
                  </span>
                  <span className={cn(
                    'px-2 py-1 rounded',
                    trends.expenseTrend === 'growing' ? 'bg-red-100 text-red-700' :
                    trends.expenseTrend === 'declining' ? 'bg-green-100 text-green-700' :
                    'bg-gray-100 text-gray-700'
                  )}>
                    Расходы: {trends.expenseTrend === 'growing' ? 'растут' : trends.expenseTrend === 'declining' ? 'падают' : 'стабильны'}
                    {' '}(~{formatNumber(trends.avgWeeklyExpenses)} ₽/нед)
                  </span>
                </div>
              )}
            </div>
            <div className="space-y-2">
              {statForecast.map((week, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex items-center gap-4 p-2 rounded',
                    week.predictedBalance < 0 && 'bg-red-50 dark:bg-red-950'
                  )}
                >
                  <div className="w-32 text-sm text-muted-foreground">
                    {new Date(week.weekStart).toLocaleDateString('ru', { day: 'numeric', month: 'short' })}
                  </div>
                  <div className="flex-1">
                    <div className="flex gap-4 text-sm">
                      <span className="text-green-700">+{formatNumber(week.predictedIncome)}</span>
                      <span className="text-red-600">-{formatNumber(week.predictedExpenses)}</span>
                      <span className={week.predictedNetFlow >= 0 ? 'text-green-700' : 'text-red-600'}>
                        = {week.predictedNetFlow >= 0 ? '+' : ''}{formatNumber(week.predictedNetFlow)}
                      </span>
                    </div>
                  </div>
                  <Badge
                    className={cn(
                      'text-xs',
                      week.confidence === 'high' ? 'bg-green-100 text-green-700' :
                      week.confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-gray-100 text-gray-500'
                    )}
                  >
                    {week.confidence === 'high' ? 'Высокая' : week.confidence === 'medium' ? 'Средняя' : 'Низкая'}
                  </Badge>
                  <div
                    className={cn(
                      'w-36 text-right font-medium',
                      week.predictedBalance >= 0 ? 'text-green-700' : 'text-red-600'
                    )}
                  >
                    {formatNumber(week.predictedBalance)} ₽
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Прогноз построен на основе взвешенного скользящего среднего и линейного тренда за последние 12 недель
            </p>
          </Card>
        ) : (
          <Card className="p-4">
            <h3 className="font-semibold flex items-center gap-2 mb-4">
              <TrendingUp className="h-5 w-5 text-indigo-500" />
              Статистический прогноз (на основе истории)
            </h3>
            <div className="text-center py-8 text-muted-foreground">
              <p>Для прогноза денежного потока нужны данные о продажах за 4+ недели.</p>
              <p className="text-sm mt-1">Данные синхронизируются автоматически из Wildberries.</p>
            </div>
          </Card>
        )}

        {/* WB Payouts */}
        <WbPayouts workspaceId={workspaceId} dateFrom={dateFrom} dateTo={dateTo} />

        {/* Planned Items */}
        <Card>
          <div className="p-4 border-b flex items-center justify-between">
            <h3 className="font-semibold">Запланированные платежи</h3>
            <ExportButton
              title="Запланированные платежи"
              subtitle={`Период: ${dateFrom} – ${dateTo}`}
              columns={PLANNED_EXPORT_COLUMNS}
              rows={plannedItems.map((p) => ({
                name: p.name,
                category: categoryLabels[p.category] || p.category,
                amount: Number(p.amount),
                plannedDate: p.plannedDate ?? p.startDate,
                isCompleted: p.isCompleted ? 'Да' : 'Нет',
              }))}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-[700px] w-full">
              <thead>
                <tr className="border-b text-left text-sm text-muted-foreground">
                  <th className="p-3">Название</th>
                  <th className="p-3">Категория</th>
                  <th className="p-3">Сумма</th>
                  <th className="p-3">Дата</th>
                  <th className="p-3">Действия</th>
                </tr>
              </thead>
              <tbody>
                {plannedItems.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-muted-foreground">
                      Нет запланированных платежей
                    </td>
                  </tr>
                )}
                {plannedItems.map((item) => {
                  const amount = parseFloat(item.amount);
                  return (
                    <tr key={item.itemId} className="border-b hover:bg-muted/50">
                      <td className="p-3 font-medium">{item.name}</td>
                      <td className="p-3">
                        <Badge className={categoryColors[item.category] || ''}>
                          {categoryLabels[item.category] || item.category}
                        </Badge>
                      </td>
                      <td className={cn('p-3 font-medium', amount < 0 ? 'text-red-600' : 'text-green-700')}>
                        {amount < 0 ? '' : '+'}{formatNumber(amount)} ₽
                      </td>
                      <td className="p-3 text-sm text-muted-foreground">
                        {item.plannedDate
                          ? new Date(item.plannedDate).toLocaleDateString('ru')
                          : new Date(item.startDate).toLocaleDateString('ru')}
                      </td>
                      <td className="p-3">
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleComplete(item.itemId)}
                            title="Отметить выполненным"
                          >
                            <Check className="h-4 w-4 text-green-500" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(item.itemId)}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
        </div>
      </Paywall>
    </AppShell>
  );
}
