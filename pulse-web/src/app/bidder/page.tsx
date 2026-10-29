'use client';

import { useShopChange } from '@/hooks/useShopChange';
import { useShopParam } from '@/hooks/useShopParam';

import { useCallback, useEffect, useState } from 'react';
import {
  Zap,
  Power,
  Plus,
  Trash2,
  RefreshCw,
  AlertTriangle,
  Clock,
  TrendingUp,
  TrendingDown,
  Settings,
  Play,
  Pause,
  Key,
} from 'lucide-react';
import { BidderKeywords } from './components/BidderKeywords';
import { BidderCampaigns } from './components/BidderCampaigns';
import { BidderHeatmap } from './components/BidderHeatmap';
import { BidderTemplates } from './components/BidderTemplates';
import { AppShell } from '@/components/AppShell';
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
import { CreateCampaignWizard } from '@/components/bidder/CreateCampaignWizard';

// Types
type Rule = {
  ruleId: number;
  name: string;
  isActive: boolean;
  priority: number;
  targetType: string;
  ruleType: string;
  conditions: any;
  actionType: string;
  actionValue: number;
  minBid: number;
  maxBid: number;
  createdAt: string;
};

type Action = {
  actionId: number;
  ruleId: number | null;
  campaignId: number;
  actionType: string;
  previousValue: number | null;
  newValue: number | null;
  reason: string | null;
  status: string;
  errorText: string | null;
  createdAt: string;
};

type Settings = {
  isEnabled: boolean;
  killSwitchEnabled: boolean;
  checkIntervalMinutes: number;
  globalMinBid: number;
  globalMaxBid: number;
  globalMaxDailySpend: number | null;
  notifyTelegram: boolean;
  lastRunAt: string | null;
};

type Dashboard = {
  isEnabled: boolean;
  killSwitchEnabled: boolean;
  lastRunAt: string | null;
  rules: { total: number; active: number };
  actionsLast24h: { total: number; applied: number; failed: number };
  // Helium-10-style KPI (MP Manager-influenced)
  spendYesterdayRub?: number;
  spendDeltaVsAvgWeekRub?: number;
  drrYesterdayPct?: number;
  drrDeltaVsWeekPct?: number;
  ordersYesterday?: number;
  campaignsActive?: number;
};

const ruleTypeLabels: Record<string, string> = {
  drr_target: 'Целевой ДРР',
  position_target: 'Целевая позиция',
  budget_limit: 'Лимит бюджета',
  time_schedule: 'По расписанию',
  cpm_range: 'Диапазон CPM',
};

const actionTypeLabels: Record<string, string> = {
  set: 'Установить',
  increase: 'Увеличить на',
  decrease: 'Уменьшить на',
  increase_percent: 'Увеличить на %',
  decrease_percent: 'Уменьшить на %',
};

export default function BidderPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopParam = useShopParam();

  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New rule form
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [showKeywords, setShowKeywords] = useState(false);
  const [showCreateWizard, setShowCreateWizard] = useState(false);
  const emptyRule = {
    name: '',
    ruleType: 'drr_target' as Rule['ruleType'],
    targetDrr: 20,
    targetPosition: 10,
    maxBudget: 1000,
    minCpm: 125,
    maxCpm: 500,
    scheduleHourFrom: 9,
    scheduleHourTo: 21,
    actionType: 'decrease_percent',
    actionValue: 10,
    minBid: 50,
    maxBid: 5000,
  };
  const [newRule, setNewRule] = useState(emptyRule);

  // Fetch data
  const fetchData = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const shopQuery = shopParam ? `?${shopParam.slice(1)}` : '';
      const [dash, sett, rulesRes, actionsRes] = await Promise.all([
        apiFetch<Dashboard>(`/bidder/${workspaceId}/dashboard${shopQuery}`),
        apiFetch<Settings>(`/bidder/${workspaceId}/settings${shopQuery}`),
        apiFetch<{ rules: Rule[] }>(`/bidder/${workspaceId}/rules${shopQuery}`),
        apiFetch<{ actions: Action[] }>(`/bidder/${workspaceId}/actions?limit=20${shopParam}`),
      ]);
      setDashboard(dash);
      setSettings(sett);
      setRules(rulesRes.rules);
      setActions(actionsRes.actions);
    } catch (err: any) {
      console.error('Failed to fetch bidder data:', err);
      setError(err?.message ?? 'Не удалось загрузить данные биддера');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, shopParam]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);
  useShopChange(fetchData);

  // Toggle bidder
  const handleToggleBidder = async () => {
    if (!workspaceId || !settings) return;
    const action = settings.isEnabled ? 'выключить' : 'включить';
    if (!confirm(`Вы уверены, что хотите ${action} биддер?`)) return;
    try {
      await apiFetch(`/bidder/${workspaceId}/settings${shopParam ? `?${shopParam.slice(1)}` : ''}`, {
        method: 'PATCH',
        body: JSON.stringify({ isEnabled: !settings.isEnabled }),
      });
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось переключить биддер');
    }
  };

  // Kill switch
  const handleKillSwitch = async () => {
    if (!workspaceId || !dashboard) return;
    const enable = !dashboard.killSwitchEnabled;
    if (enable && !confirm('Включить аварийную остановку? Все операции будут приостановлены.')) {
      return;
    }
    try {
      await apiFetch(`/bidder/${workspaceId}/kill-switch${shopParam ? `?${shopParam.slice(1)}` : ''}`, {
        method: 'POST',
        body: JSON.stringify({ enabled: enable, reason: 'Manual kill switch' }),
      });
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось переключить kill switch');
    }
  };

  // Create rule
  const handleCreateRule = async () => {
    if (!workspaceId || !newRule.name) return;
    try {
      // conditions + activeHours зависят от ruleType. Серверный схема
      // (src/routes/bidder.ts:39-56) ждёт conditions object + optional
      // activeHours[] для time_schedule.
      const conditions: Record<string, number> = {};
      let activeHours: number[] | undefined;
      switch (newRule.ruleType) {
        case 'drr_target':
          conditions.targetDrr = newRule.targetDrr;
          break;
        case 'position_target':
          conditions.targetPosition = newRule.targetPosition;
          break;
        case 'budget_limit':
          conditions.maxBudget = newRule.maxBudget;
          break;
        case 'cpm_range':
          conditions.minCpm = newRule.minCpm;
          conditions.maxCpm = newRule.maxCpm;
          break;
        case 'time_schedule': {
          conditions.targetDrr = newRule.targetDrr;
          const from = Math.max(0, Math.min(23, newRule.scheduleHourFrom));
          const to = Math.max(from, Math.min(23, newRule.scheduleHourTo));
          activeHours = [];
          for (let h = from; h <= to; h++) activeHours.push(h);
          break;
        }
      }

      await apiFetch(`/bidder/${workspaceId}/rules${shopParam ? `?${shopParam.slice(1)}` : ''}`, {
        method: 'POST',
        body: JSON.stringify({
          name: newRule.name,
          ruleType: newRule.ruleType,
          conditions,
          actionType: newRule.actionType,
          actionValue: newRule.actionValue,
          minBid: newRule.minBid,
          maxBid: newRule.maxBid,
          ...(activeHours && activeHours.length ? { activeHours } : {}),
        }),
      });
      setShowRuleForm(false);
      setNewRule(emptyRule);
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось создать правило');
    }
  };

  // Toggle rule
  const handleToggleRule = async (ruleId: number, isActive: boolean) => {
    if (!workspaceId) return;
    try {
      await apiFetch(`/bidder/${workspaceId}/rules/${ruleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !isActive }),
      });
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось переключить правило');
    }
  };

  // Delete rule
  const handleDeleteRule = async (ruleId: number) => {
    if (!workspaceId) return;
    if (!confirm('Удалить это правило?')) return;
    try {
      await apiFetch(`/bidder/${workspaceId}/rules/${ruleId}`, { method: 'DELETE' });
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось удалить правило');
    }
  };

  if (!workspaceId) {
    return (
      <AppShell>
        <div className="p-8 text-center text-muted-foreground">
          Выберите магазин
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Рекламный биддер">
      <Paywall workspaceId={workspaceId ?? 0} feature="Рекламный биддер">
        {error && (
          <ErrorBanner error={error} onRetry={fetchData} onDismiss={() => setError(null)} />
        )}
        <div className="space-y-4">
          {/* Toolbar: actions справа, без дубля h1 (он уже в AppShell). */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="neutral" onClick={() => setShowKeywords(!showKeywords)}>
              <Key className="mr-2 h-4 w-4" />
              Ключевые слова
            </Button>
            <Button variant="neutral" onClick={async () => {
              try {
                await apiFetch(`/bidder/${workspaceId}/campaigns/sync${shopParam ? `?${shopParam.slice(1)}` : ''}`, { method: 'POST' });
                await fetchData();
              } catch (e: any) { setError(e?.message ?? 'Ошибка синхронизации'); }
            }} disabled={loading}>
              <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
              Синхронизировать
            </Button>
            <Button variant="neutral" onClick={fetchData} disabled={loading}>
              Обновить
            </Button>
            {settings && (
              <Button
                variant={settings.isEnabled ? 'danger' : 'primary'}
                onClick={handleToggleBidder}
              >
                <Power className="mr-2 h-4 w-4" />
                {settings.isEnabled ? 'Выключить' : 'Включить'}
              </Button>
            )}
          </div>

        {/* Keywords Panel */}
        {showKeywords && workspaceId && (
          <BidderKeywords workspaceId={workspaceId} onClose={() => setShowKeywords(false)} />
        )}

        {/* Kill Switch Warning */}
        {dashboard?.killSwitchEnabled && (
          <Card className="p-4 bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-red-600">
                <AlertTriangle className="h-5 w-5" />
                <span className="font-semibold">Аварийная остановка активна</span>
              </div>
              <Button variant="neutral" size="sm" onClick={handleKillSwitch}>
                Отключить
              </Button>
            </div>
          </Card>
        )}

        {/* Dashboard Cards — MP Manager-style: расход, ДРР, кампании, действия */}
        {dashboard && (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <BidderKpiCard
              label="Расход вчера"
              value={`${formatNumber(dashboard.spendYesterdayRub ?? 0)} ₽`}
              delta={dashboard.spendDeltaVsAvgWeekRub}
              deltaFormatter={(d) => `${d > 0 ? '+' : ''}${formatNumber(d)} ₽ vs нед.`}
              deltaIsBad={(d) => d > 0}
              hint="Расход на рекламу за вчера + дельта по сравнению со средним за прошлую неделю"
            />
            <BidderKpiCard
              label="ДРР вчера"
              value={`${(dashboard.drrYesterdayPct ?? 0).toFixed(1)}%`}
              delta={dashboard.drrDeltaVsWeekPct}
              deltaFormatter={(d) => `${d > 0 ? '+' : ''}${d.toFixed(1)}пп vs нед.`}
              deltaIsBad={(d) => d > 0}
              hint="Доля рекламных расходов = расход / выручка от рекламы. Чем ниже — тем эффективнее"
            />
            <BidderKpiCard
              label="Активных кампаний"
              value={String(dashboard.campaignsActive ?? 0)}
              hint="Кампаний с расходом > 0 за последний день"
            />
            <BidderKpiCard
              label="Действий биддера / 24ч"
              value={String(dashboard.actionsLast24h.total)}
              subline={
                dashboard.actionsLast24h.failed > 0
                  ? `${dashboard.actionsLast24h.failed} ошибок`
                  : undefined
              }
              sublineIsBad={(dashboard.actionsLast24h.failed ?? 0) > 0}
              hint="Сколько раз биддер автоматически менял ставки за последние сутки"
            />
          </div>
        )}

        {/* Campaigns Section */}
        <BidderCampaigns workspaceId={workspaceId} />

        {/* Heatmap */}
        <BidderHeatmap workspaceId={workspaceId} />

        {/* Templates */}
        <BidderTemplates
          workspaceId={workspaceId}
          shopParam={shopParam ?? ''}
          hasExistingRules={rules.length > 0}
          onApplied={fetchData}
        />

        {/* Rules Section */}
        <Card>
          <div className="p-4 border-b flex items-center justify-between">
            <h3 className="font-semibold">Правила</h3>
            <div className="flex gap-2">
              {!dashboard?.killSwitchEnabled && (
                <Button variant="neutral" size="sm" onClick={handleKillSwitch}>
                  <AlertTriangle className="mr-2 h-4 w-4" />
                  Kill Switch
                </Button>
              )}
              <Button size="sm" onClick={() => setShowRuleForm(!showRuleForm)}>
                <Plus className="mr-2 h-4 w-4" />
                Добавить правило
              </Button>
              <Button size="sm" variant="primary" onClick={() => setShowCreateWizard(true)}>
                <Zap className="mr-2 h-4 w-4" />
                Создать кампанию
              </Button>
            </div>
          </div>

          {/* New Rule Form */}
          {showRuleForm && (
            <div className="p-4 bg-muted/50 border-b space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:gap-4">
                <div className="lg:col-span-2">
                  <label className="text-sm text-muted-foreground">Название</label>
                  <Input
                    value={newRule.name}
                    onChange={(e) => setNewRule({ ...newRule, name: e.target.value })}
                    placeholder="Снижение при высоком ДРР"
                  />
                </div>
                <div>
                  <label className="text-sm text-muted-foreground">Тип правила</label>
                  <Select
                    value={newRule.ruleType}
                    onValueChange={(v) => setNewRule({ ...newRule, ruleType: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(ruleTypeLabels).map(([k, v]) => (
                        <SelectItem key={k} value={k}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-sm text-muted-foreground">Действие</label>
                  <Select
                    value={newRule.actionType}
                    onValueChange={(v) => setNewRule({ ...newRule, actionType: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(actionTypeLabels).map(([k, v]) => (
                        <SelectItem key={k} value={k}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-sm text-muted-foreground">
                    Значение действия {newRule.actionType.includes('percent') ? '%' : '₽'}
                  </label>
                  <Input
                    type="number"
                    min={1}
                    value={newRule.actionValue}
                    onChange={(e) => setNewRule({ ...newRule, actionValue: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-sm text-muted-foreground">Мин. ставка ₽</label>
                  <Input
                    type="number"
                    min={10}
                    value={newRule.minBid}
                    onChange={(e) => setNewRule({ ...newRule, minBid: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-sm text-muted-foreground">Макс. ставка ₽</label>
                  <Input
                    type="number"
                    min={10}
                    value={newRule.maxBid}
                    onChange={(e) => setNewRule({ ...newRule, maxBid: Number(e.target.value) })}
                  />
                </div>
              </div>

              {/* Условия зависят от типа правила */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:gap-4">
                {newRule.ruleType === 'drr_target' && (
                  <div>
                    <label className="text-sm text-muted-foreground">Целевой ДРР %</label>
                    <Input
                      type="number"
                      min={1}
                      value={newRule.targetDrr}
                      onChange={(e) => setNewRule({ ...newRule, targetDrr: Number(e.target.value) })}
                    />
                  </div>
                )}

                {newRule.ruleType === 'position_target' && (
                  <div>
                    <label className="text-sm text-muted-foreground">Целевая позиция (1–100)</label>
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      value={newRule.targetPosition}
                      onChange={(e) => setNewRule({ ...newRule, targetPosition: Number(e.target.value) })}
                    />
                  </div>
                )}

                {newRule.ruleType === 'budget_limit' && (
                  <div>
                    <label className="text-sm text-muted-foreground">Дневной бюджет ₽</label>
                    <Input
                      type="number"
                      min={100}
                      value={newRule.maxBudget}
                      onChange={(e) => setNewRule({ ...newRule, maxBudget: Number(e.target.value) })}
                    />
                  </div>
                )}

                {newRule.ruleType === 'cpm_range' && (
                  <>
                    <div>
                      <label className="text-sm text-muted-foreground">Мин. CPM ₽</label>
                      <Input
                        type="number"
                        min={125}
                        value={newRule.minCpm}
                        onChange={(e) => setNewRule({ ...newRule, minCpm: Number(e.target.value) })}
                      />
                    </div>
                    <div>
                      <label className="text-sm text-muted-foreground">Макс. CPM ₽</label>
                      <Input
                        type="number"
                        min={125}
                        value={newRule.maxCpm}
                        onChange={(e) => setNewRule({ ...newRule, maxCpm: Number(e.target.value) })}
                      />
                    </div>
                  </>
                )}

                {newRule.ruleType === 'time_schedule' && (
                  <>
                    <div>
                      <label className="text-sm text-muted-foreground">Час «с» (0–23)</label>
                      <Input
                        type="number"
                        min={0}
                        max={23}
                        value={newRule.scheduleHourFrom}
                        onChange={(e) => setNewRule({ ...newRule, scheduleHourFrom: Number(e.target.value) })}
                      />
                    </div>
                    <div>
                      <label className="text-sm text-muted-foreground">Час «до» (0–23)</label>
                      <Input
                        type="number"
                        min={0}
                        max={23}
                        value={newRule.scheduleHourTo}
                        onChange={(e) => setNewRule({ ...newRule, scheduleHourTo: Number(e.target.value) })}
                      />
                    </div>
                    <div>
                      <label className="text-sm text-muted-foreground">Целевой ДРР %</label>
                      <Input
                        type="number"
                        min={1}
                        value={newRule.targetDrr}
                        onChange={(e) => setNewRule({ ...newRule, targetDrr: Number(e.target.value) })}
                      />
                    </div>
                  </>
                )}

                <div className="flex items-end">
                  <Button onClick={handleCreateRule} disabled={!newRule.name}>
                    Создать
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Rules Table */}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-sm text-muted-foreground">
                  <th className="p-3">Название</th>
                  <th className="p-3">Тип</th>
                  <th className="p-3">Действие</th>
                  <th className="p-3">Лимиты</th>
                  <th className="p-3">Статус</th>
                  <th className="p-3">Действия</th>
                </tr>
              </thead>
              <tbody>
                {rules.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-muted-foreground">
                      Нет правил. Создайте первое!
                    </td>
                  </tr>
                )}
                {rules.map((rule) => (
                  <tr key={rule.ruleId} className="border-b hover:bg-muted/50">
                    <td className="p-3 font-medium">{rule.name}</td>
                    <td className="p-3">
                      <Badge variant="neutral">{ruleTypeLabels[rule.ruleType] || rule.ruleType}</Badge>
                    </td>
                    <td className="p-3">
                      {actionTypeLabels[rule.actionType]} {rule.actionValue}
                      {rule.actionType.includes('percent') ? '%' : '₽'}
                    </td>
                    <td className="p-3 text-sm text-muted-foreground">
                      {rule.minBid}–{rule.maxBid} ₽
                    </td>
                    <td className="p-3">
                      <Badge variant={rule.isActive ? 'success' : 'secondary'}>
                        {rule.isActive ? 'Активно' : 'Выключено'}
                      </Badge>
                    </td>
                    <td className="p-3">
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleToggleRule(rule.ruleId, rule.isActive)}
                        >
                          {rule.isActive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteRule(rule.ruleId)}
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Recent Actions */}
        <Card>
          <div className="p-4 border-b">
            <h3 className="font-semibold">Последние действия</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-sm text-muted-foreground">
                  <th className="p-3">Время</th>
                  <th className="p-3">Кампания</th>
                  <th className="p-3">Изменение</th>
                  <th className="p-3">Причина</th>
                  <th className="p-3">Статус</th>
                </tr>
              </thead>
              <tbody>
                {actions.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-muted-foreground">
                      Нет действий
                    </td>
                  </tr>
                )}
                {actions.map((action) => (
                  <tr key={action.actionId} className="border-b hover:bg-muted/50">
                    <td className="p-3 text-sm">
                      {new Date(action.createdAt).toLocaleString('ru')}
                    </td>
                    <td className="p-3">{action.campaignId}</td>
                    <td className="p-3">
                      <div className="flex items-center gap-1">
                        {action.previousValue != null && action.newValue != null && action.newValue > action.previousValue ? (
                          <TrendingUp className="h-4 w-4 text-green-500" />
                        ) : (
                          <TrendingDown className="h-4 w-4 text-red-500" />
                        )}
                        {action.previousValue ?? '?'} → {action.newValue ?? '?'} ₽
                      </div>
                    </td>
                    <td className="p-3 text-sm text-muted-foreground max-w-xs truncate">
                      {action.reason || '-'}
                    </td>
                    <td className="p-3">
                      <Badge
                        variant={
                          action.status === 'applied'
                            ? 'success'
                            : action.status === 'failed'
                            ? 'destructive'
                            : 'secondary'
                        }
                      >
                        {action.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        </div>

        {/* Create Campaign Wizard */}
        {showCreateWizard && (
          <CreateCampaignWizard
            workspaceId={workspaceId}
            onClose={() => setShowCreateWizard(false)}
            onSuccess={(advertId) => {
              setShowCreateWizard(false);
              fetchData();
            }}
          />
        )}
      </Paywall>
    </AppShell>
  );
}

// ── KPI карточка биддера (как в /seo, но универсальная по значениям) ──────
// Поддерживает строковые значения (рубли, проценты), кастомный форматтер дельты
// и пометку «это плохо», чтобы рост ДРР подсвечивался красным, а рост экономии — зелёным.
function BidderKpiCard({
  label,
  value,
  delta,
  deltaFormatter,
  deltaIsBad,
  subline,
  sublineIsBad,
  hint,
}: {
  label: string;
  value: string;
  delta?: number;
  deltaFormatter?: (d: number) => string;
  deltaIsBad?: (d: number) => boolean;
  subline?: string;
  sublineIsBad?: boolean;
  hint?: string;
}) {
  let deltaNode: React.ReactNode = null;
  if (typeof delta === 'number' && Math.abs(delta) > 0.01) {
    const bad = deltaIsBad ? deltaIsBad(delta) : false;
    const cls = bad ? 'text-red-600' : 'text-emerald-700';
    deltaNode = (
      <span className={cn('text-xs font-medium ml-2', cls)}>
        {deltaFormatter ? deltaFormatter(delta) : delta}
      </span>
    );
  }
  return (
    <Card className="p-4" title={hint}>
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="flex items-baseline flex-wrap">
        <div className="text-2xl font-bold text-gray-900">{value}</div>
        {deltaNode}
      </div>
      {subline && (
        <div className={cn('text-xs mt-1', sublineIsBad ? 'text-red-500' : 'text-gray-500')}>
          {subline}
        </div>
      )}
    </Card>
  );
}
