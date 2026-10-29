'use client';

import { AppShell } from '@/components/AppShell';
import { apiFetch } from '@/lib/api';
import { useEffect, useMemo, useState } from 'react';

type Overview = {
  workspaces: number;
  subscriptions: number;
  subscriptionsActive: number;
  payments: number;
  paymentsSumKopecks: number;
};

type SubscriptionRow = {
  workspaceId: number;
  workspaceName: string | null;
  status: string;
  planCode: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  autoRenew: boolean;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  updatedAt: string;
};

type PaymentRow = {
  paymentId: number;
  workspaceId: number;
  workspaceName: string | null;
  provider: string;
  providerPaymentId: string | null;
  amountKopecks: number;
  currency: string;
  subscriptionType: string | null;
  daysAdded: number | null;
  status: string;
  paidAt: string | null;
  createdAt: string;
};

type AiProviderSetting = {
  provider: 'llm' | 'web_search';
  source: 'db' | 'env';
  apiKeyMasked: string | null;
  apiKeyConfigured: boolean;
  baseUrl: string;
  model: string;
  promptPricePer1mUsd: number | null;
  completionPricePer1mUsd: number | null;
};

type AiUsageRow = {
  workspaceId: number;
  workspaceName: string | null;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costMicros: number;
};

type AiUsageSummary = {
  rows: AiUsageRow[];
  totals: AiUsageRow;
};

type UserRow = {
  userId: number;
  email: string;
  isAdmin: boolean;
  createdAt: string;
  workspaces: Array<{
    workspaceId: number;
    workspaceName: string | null;
    role: string;
  }>;
};

const formatDate = (value?: string | null) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU');
};

const formatMoney = (kopecks: number, currency = 'RUB') => {
  const rub = kopecks / 100;
  return `${rub.toFixed(2)} ${currency}`;
};

// AI-провайдеры тарифицируют в micros-USD; админка раньше отдавала "$X.XXXX".
// 2026-05-31: показываем сразу в рублях по рыночному курсу (фиксируем
// конверсию, чтобы не дёргать FX-API на каждый рендер). Если нужно покажем
// «1 ₽ = $X» в подвале — пока не нужно.
const RUB_PER_USD = 95;
const formatAiCost = (micros: number) => {
  const rub = (micros / 1_000_000) * RUB_PER_USD;
  return `${rub.toFixed(2)} ₽`;
};

const formatNumber = (value: number) => new Intl.NumberFormat('ru-RU').format(value);

const daysLeft = (end?: string | null) => {
  if (!end) return 0;
  const d = new Date(end);
  if (Number.isNaN(d.getTime())) return 0;
  const diff = d.getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86400000));
};

export default function AdminPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceFilter, setWorkspaceFilter] = useState<number | ''>('');

  const [aiSettings, setAiSettings] = useState<AiProviderSetting[]>([]);
  const [aiUsage, setAiUsage] = useState<AiUsageSummary | null>(null);
  const [aiSaving, setAiSaving] = useState(false);
  
  // Tab state
  const [tab, setTab] = useState<'overview' | 'users' | 'subscriptions' | 'ai'>('overview');
  
  // Users
  const [users, setUsers] = useState<UserRow[]>([]);
  const [userSearch, setUserSearch] = useState('');
  
  // Editing
  const [editingSub, setEditingSub] = useState<number | null>(null);
  const [editSubForm, setEditSubForm] = useState({ status: '', planCode: '', periodEnd: '' });
  const [aiForm, setAiForm] = useState({
    llm: {
      baseUrl: '',
      model: '',
      apiKey: '',
      promptPricePer1mUsd: '',
      completionPricePer1mUsd: '',
    },
    web_search: {
      baseUrl: '',
      apiKey: '',
    },
  });

  const workspaceQuery = useMemo(() => {
    if (workspaceFilter === '') return '';
    return `&workspaceId=${encodeURIComponent(String(workspaceFilter))}`;
  }, [workspaceFilter]);

  const llmSetting = aiSettings.find((p) => p.provider === 'llm');
  const webSetting = aiSettings.find((p) => p.provider === 'web_search');

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const ov = (await apiFetch('/admin/overview')) as Overview;
      setOverview(ov);

      const subs = (await apiFetch(`/admin/subscriptions?limit=50${workspaceQuery}`)) as { rows: SubscriptionRow[] };
      setSubscriptions(subs.rows ?? []);

      const pays = (await apiFetch(`/admin/payments?limit=50${workspaceQuery}`)) as { rows: PaymentRow[] };
      setPayments(pays.rows ?? []);

      const ai = (await apiFetch('/admin/ai-settings')) as { providers: AiProviderSetting[] };
      setAiSettings(ai.providers ?? []);

      const usage = (await apiFetch(`/admin/ai-usage/summary${workspaceQuery}`)) as AiUsageSummary;
      setAiUsage(usage ?? null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceQuery]);

  async function loadUsers() {
    try {
      const res = (await apiFetch(`/admin/users?limit=100${userSearch ? `&search=${encodeURIComponent(userSearch)}` : ''}`)) as { rows: UserRow[] };
      setUsers(res.rows ?? []);
    } catch (e) { console.error('Failed to load users:', e); }
  }

  async function toggleUserAdmin(userId: number, isAdmin: boolean) {
    try {
      await apiFetch(`/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isAdmin }),
      });
      await loadUsers();
    } catch (e) { console.error('Failed to toggle admin:', e); }
  }

  async function updateSubscription(workspaceId: number) {
    try {
      await apiFetch(`/admin/subscriptions/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: editSubForm.status || undefined,
          planCode: editSubForm.planCode || undefined,
          currentPeriodEnd: editSubForm.periodEnd || undefined,
        }),
      });
      setEditingSub(null);
      await loadData();
    } catch (e) { console.error('Failed to update subscription:', e); }
  }

  useEffect(() => {
    if (tab === 'users') loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, userSearch]);

  useEffect(() => {
    const llm = aiSettings.find((p) => p.provider === 'llm');
    const web = aiSettings.find((p) => p.provider === 'web_search');

    if (!llm && !web) return;

    setAiForm({
      llm: {
        baseUrl: llm?.baseUrl ?? '',
        model: llm?.model ?? '',
        apiKey: '',
        promptPricePer1mUsd: llm?.promptPricePer1mUsd != null ? String(llm.promptPricePer1mUsd) : '',
        completionPricePer1mUsd: llm?.completionPricePer1mUsd != null ? String(llm.completionPricePer1mUsd) : '',
      },
      web_search: {
        baseUrl: web?.baseUrl ?? '',
        apiKey: '',
      },
    });
  }, [aiSettings]);

  async function activate(workspaceId: number, planCode: 'monthly' | 'yearly') {
    await apiFetch(`/subscriptions/${workspaceId}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planCode, provider: 'admin' }),
    });
    await loadData();
  }

  async function cancel(workspaceId: number) {
    await apiFetch(`/subscriptions/${workspaceId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancelAtPeriodEnd: true }),
    });
    await loadData();
  }

  async function saveAiSettings() {
    setAiSaving(true);
    try {
      const providers: any[] = [];
      const llm: any = { provider: 'llm', baseUrl: aiForm.llm.baseUrl, model: aiForm.llm.model };
      if (aiForm.llm.apiKey.trim()) llm.apiKey = aiForm.llm.apiKey.trim();
      if (aiForm.llm.promptPricePer1mUsd.trim()) {
        const n = Number(aiForm.llm.promptPricePer1mUsd);
        if (Number.isFinite(n)) llm.promptPricePer1mUsd = n;
      }
      if (aiForm.llm.completionPricePer1mUsd.trim()) {
        const n = Number(aiForm.llm.completionPricePer1mUsd);
        if (Number.isFinite(n)) llm.completionPricePer1mUsd = n;
      }
      providers.push(llm);

      const web: any = { provider: 'web_search', baseUrl: aiForm.web_search.baseUrl };
      if (aiForm.web_search.apiKey.trim()) web.apiKey = aiForm.web_search.apiKey.trim();
      providers.push(web);

      const res = (await apiFetch('/admin/ai-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers }),
      })) as { providers: AiProviderSetting[] };

      setAiSettings(res.providers ?? []);
      setAiForm((prev) => ({
        ...prev,
        llm: { ...prev.llm, apiKey: '' },
        web_search: { ...prev.web_search, apiKey: '' },
      }));
    } finally {
      setAiSaving(false);
    }
  }

  return (
    <AppShell title="Админ-панель">
      <div className="p-6 space-y-6">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-neutral-400">Workspace</span>
          <input
            className="w-24 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm"
            type="number"
            min={1}
            value={workspaceFilter}
            onChange={(e) => setWorkspaceFilter(e.target.value ? Number(e.target.value) : '')}
          />
          <button
            className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/15"
            type="button"
            onClick={loadData}
            disabled={loading}
          >
            Обновить
          </button>
          {loading && <span className="text-neutral-500">Загрузка…</span>}
          {error && <span className="text-rose-400">{error}</span>}
        </div>

        <div className="grid gap-4 md:grid-cols-5">
          <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
            <div className="text-xs text-neutral-400">Workspaces</div>
            <div className="mt-1 text-lg font-semibold text-white">{overview?.workspaces ?? 0}</div>
          </div>
          <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
            <div className="text-xs text-neutral-400">Подписок</div>
            <div className="mt-1 text-lg font-semibold text-white">{overview?.subscriptions ?? 0}</div>
          </div>
          <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
            <div className="text-xs text-neutral-400">Активных</div>
            <div className="mt-1 text-lg font-semibold text-white">{overview?.subscriptionsActive ?? 0}</div>
          </div>
          <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
            <div className="text-xs text-neutral-400">Платежей</div>
            <div className="mt-1 text-lg font-semibold text-white">{overview?.payments ?? 0}</div>
          </div>
          <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
            <div className="text-xs text-neutral-400">Сумма</div>
            <div className="mt-1 text-lg font-semibold text-white">{formatMoney(overview?.paymentsSumKopecks ?? 0)}</div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-neutral-800">
          {(['overview', 'users', 'subscriptions', 'ai'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t ? 'border-blue-500 text-blue-400' : 'border-transparent text-neutral-400 hover:text-white'
              }`}
            >
              {t === 'overview' ? '📊 Обзор' : t === 'users' ? '👥 Пользователи' : t === 'subscriptions' ? '💳 Подписки' : '🤖 AI'}
            </button>
          ))}
        </div>

        {/* Users Tab */}
        {tab === 'users' && (
          <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-medium">Пользователи</div>
              <input
                type="text"
                placeholder="Поиск по email..."
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                className="w-64 rounded border border-neutral-800 bg-neutral-950 px-3 py-1 text-sm"
              />
            </div>
            <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-800 text-neutral-500">
                  <th className="py-2 pr-3">ID</th>
                  <th className="py-2 pr-3">Email</th>
                  <th className="py-2 pr-3">Workspaces</th>
                  <th className="py-2 pr-3">Admin</th>
                  <th className="py-2 pr-3">Создан</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.userId} className="border-b border-neutral-900">
                    <td className="py-2 pr-3 tabular-nums">{u.userId}</td>
                    <td className="py-2 pr-3">{u.email}</td>
                    <td className="py-2 pr-3">
                      {u.workspaces.map((w) => (
                        <span key={w.workspaceId} className="inline-block mr-2 px-2 py-0.5 bg-neutral-800 rounded text-xs">
                          {w.workspaceName ?? w.workspaceId} ({w.role})
                        </span>
                      ))}
                    </td>
                    <td className="py-2 pr-3">
                      <button
                        onClick={() => toggleUserAdmin(u.userId, !u.isAdmin)}
                        className={`px-2 py-1 rounded text-xs ${u.isAdmin ? 'bg-blue-600' : 'bg-neutral-700'}`}
                      >
                        {u.isAdmin ? '✓ Admin' : 'User'}
                      </button>
                    </td>
                    <td className="py-2 pr-3 text-neutral-500">{formatDate(u.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}

        {/* AI Tab */}
        {tab === 'ai' && (
        <>
        <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-medium">ИИ настройки</div>
            <button
              className="rounded bg-white/10 px-3 py-2 text-sm hover:bg-white/15 disabled:opacity-50"
              type="button"
              onClick={saveAiSettings}
              disabled={aiSaving}
            >
              {aiSaving ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>

          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">LLM</div>
                <div className="text-xs text-neutral-500">Источник: {llmSetting?.source ?? 'env'}</div>
              </div>
              <div className="mt-2 text-xs text-neutral-500">
                Ключ: {llmSetting?.apiKeyConfigured ? llmSetting.apiKeyMasked ?? '***' : 'не задан'}
              </div>

              <div className="mt-3 grid gap-3 text-sm">
                <label className="grid gap-1">
                  <span className="text-neutral-400">Base URL</span>
                  <input
                    className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1"
                    type="text"
                    value={aiForm.llm.baseUrl}
                    onChange={(e) =>
                      setAiForm((prev) => ({
                        ...prev,
                        llm: { ...prev.llm, baseUrl: e.target.value },
                      }))
                    }
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-neutral-400">Модель</span>
                  <input
                    className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1"
                    type="text"
                    value={aiForm.llm.model}
                    onChange={(e) =>
                      setAiForm((prev) => ({
                        ...prev,
                        llm: { ...prev.llm, model: e.target.value },
                      }))
                    }
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-neutral-400">API ключ (новый)</span>
                  <input
                    className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1"
                    type="password"
                    value={aiForm.llm.apiKey}
                    onChange={(e) =>
                      setAiForm((prev) => ({
                        ...prev,
                        llm: { ...prev.llm, apiKey: e.target.value },
                      }))
                    }
                  />
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1">
                    <span className="text-neutral-400">Цена input ($/1M)</span>
                    <input
                      className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1"
                      type="number"
                      step="0.0001"
                      value={aiForm.llm.promptPricePer1mUsd}
                      onChange={(e) =>
                        setAiForm((prev) => ({
                          ...prev,
                          llm: { ...prev.llm, promptPricePer1mUsd: e.target.value },
                        }))
                      }
                    />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-neutral-400">Цена output ($/1M)</span>
                    <input
                      className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1"
                      type="number"
                      step="0.0001"
                      value={aiForm.llm.completionPricePer1mUsd}
                      onChange={(e) =>
                        setAiForm((prev) => ({
                          ...prev,
                          llm: { ...prev.llm, completionPricePer1mUsd: e.target.value },
                        }))
                      }
                    />
                  </label>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Web search</div>
                <div className="text-xs text-neutral-500">Источник: {webSetting?.source ?? 'env'}</div>
              </div>
              <div className="mt-2 text-xs text-neutral-500">
                Ключ: {webSetting?.apiKeyConfigured ? webSetting.apiKeyMasked ?? '***' : 'не задан'}
              </div>

              <div className="mt-3 grid gap-3 text-sm">
                <label className="grid gap-1">
                  <span className="text-neutral-400">Base URL</span>
                  <input
                    className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1"
                    type="text"
                    value={aiForm.web_search.baseUrl}
                    onChange={(e) =>
                      setAiForm((prev) => ({
                        ...prev,
                        web_search: { ...prev.web_search, baseUrl: e.target.value },
                      }))
                    }
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-neutral-400">API ключ (новый)</span>
                  <input
                    className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1"
                    type="password"
                    value={aiForm.web_search.apiKey}
                    onChange={(e) =>
                      setAiForm((prev) => ({
                        ...prev,
                        web_search: { ...prev.web_search, apiKey: e.target.value },
                      }))
                    }
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="mt-3 text-xs text-neutral-500">Оставь ключ пустым — сохранится текущий.</div>
        </div>

        <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">ИИ использование</div>
            <div className="text-xs text-neutral-500">
              Всего: {formatNumber(aiUsage?.totals?.totalTokens ?? 0)} токенов · {formatAiCost(aiUsage?.totals?.costMicros ?? 0)}
            </div>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-neutral-500">
                <tr>
                  <th className="py-2 pr-3">Workspace</th>
                  <th className="py-2 pr-3">Запросов</th>
                  <th className="py-2 pr-3">Prompt</th>
                  <th className="py-2 pr-3">Completion</th>
                  <th className="py-2 pr-3">Всего токенов</th>
                  <th className="py-2">Стоимость</th>
                </tr>
              </thead>
              <tbody className="text-neutral-200">
                {(aiUsage?.rows ?? []).length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-4 text-neutral-500">
                      Нет данных по токенам.
                    </td>
                  </tr>
                )}
                {(aiUsage?.rows ?? []).map((row) => (
                  <tr key={row.workspaceId} className="border-t border-neutral-900">
                    <td className="py-2 pr-3">
                      {row.workspaceId}
                      {row.workspaceName ? <span className="text-neutral-500"> · {row.workspaceName}</span> : null}
                    </td>
                    <td className="py-2 pr-3">{formatNumber(row.requests)}</td>
                    <td className="py-2 pr-3">{formatNumber(row.promptTokens)}</td>
                    <td className="py-2 pr-3">{formatNumber(row.completionTokens)}</td>
                    <td className="py-2 pr-3">{formatNumber(row.totalTokens)}</td>
                    <td className="py-2">{formatAiCost(row.costMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </>
        )}

        {/* Overview Tab - Subscriptions & Payments */}
        {tab === 'overview' && (
        <>
        <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
          <div className="text-sm font-medium">Подписки</div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-neutral-500">
                <tr>
                  <th className="py-2 pr-3">Workspace</th>
                  <th className="py-2 pr-3">Статус</th>
                  <th className="py-2 pr-3">Тариф</th>
                  <th className="py-2 pr-3">Период</th>
                  <th className="py-2 pr-3">Осталось</th>
                  <th className="py-2 pr-3">Авто</th>
                  <th className="py-2 pr-3">Отмена</th>
                  <th className="py-2">Действия</th>
                </tr>
              </thead>
              <tbody className="text-neutral-200">
                {subscriptions.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-4 text-neutral-500">
                      Нет данных.
                    </td>
                  </tr>
                )}
                {subscriptions.map((row) => (
                  <tr key={row.workspaceId} className="border-t border-neutral-900">
                    <td className="py-2 pr-3">
                      {row.workspaceId}
                      {row.workspaceName ? <span className="text-neutral-500"> · {row.workspaceName}</span> : null}
                    </td>
                    <td className="py-2 pr-3">{row.status}</td>
                    <td className="py-2 pr-3">{row.planCode ?? '—'}</td>
                    <td className="py-2 pr-3">
                      {formatDate(row.currentPeriodStart)} → {formatDate(row.currentPeriodEnd)}
                    </td>
                    <td className="py-2 pr-3">{daysLeft(row.currentPeriodEnd)} дн.</td>
                    <td className="py-2 pr-3">{row.autoRenew ? 'да' : 'нет'}</td>
                    <td className="py-2 pr-3">{row.cancelAtPeriodEnd ? 'да' : 'нет'}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/15"
                          type="button"
                          onClick={() => activate(row.workspaceId, 'monthly')}
                        >
                          +Месяц
                        </button>
                        <button
                          className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/15"
                          type="button"
                          onClick={() => activate(row.workspaceId, 'yearly')}
                        >
                          +Год
                        </button>
                        <button
                          className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/15"
                          type="button"
                          onClick={() => cancel(row.workspaceId)}
                        >
                          Отменить
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
          <div className="text-sm font-medium">Платежи</div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-neutral-500">
                <tr>
                  <th className="py-2 pr-3">Дата</th>
                  <th className="py-2 pr-3">Workspace</th>
                  <th className="py-2 pr-3">Сумма</th>
                  <th className="py-2 pr-3">Тариф</th>
                  <th className="py-2 pr-3">Дней</th>
                  <th className="py-2 pr-3">Провайдер</th>
                  <th className="py-2">ID</th>
                </tr>
              </thead>
              <tbody className="text-neutral-200">
                {payments.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-4 text-neutral-500">
                      Нет данных.
                    </td>
                  </tr>
                )}
                {payments.map((row) => (
                  <tr key={row.paymentId} className="border-t border-neutral-900">
                    <td className="py-2 pr-3">{formatDate(row.paidAt || row.createdAt)}</td>
                    <td className="py-2 pr-3">
                      {row.workspaceId}
                      {row.workspaceName ? <span className="text-neutral-500"> · {row.workspaceName}</span> : null}
                    </td>
                    <td className="py-2 pr-3">{formatMoney(row.amountKopecks, row.currency)}</td>
                    <td className="py-2 pr-3">{row.subscriptionType ?? '—'}</td>
                    <td className="py-2 pr-3">{row.daysAdded ?? '—'}</td>
                    <td className="py-2 pr-3">{row.provider}</td>
                    <td className="py-2 text-neutral-400">{row.providerPaymentId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </>
        )}

        {/* Subscriptions Tab - Edit */}
        {tab === 'subscriptions' && (
          <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
            <div className="text-sm font-medium mb-4">Управление подписками</div>
            <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-800 text-neutral-500">
                  <th className="py-2 pr-3">Workspace</th>
                  <th className="py-2 pr-3">Статус</th>
                  <th className="py-2 pr-3">План</th>
                  <th className="py-2 pr-3">Действует до</th>
                  <th className="py-2 pr-3">Действия</th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.map((s) => (
                  <tr key={s.workspaceId} className="border-b border-neutral-900">
                    <td className="py-2 pr-3">{s.workspaceName ?? s.workspaceId}</td>
                    <td className="py-2 pr-3">
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        s.status === 'active' ? 'bg-green-600' : s.status === 'trial' ? 'bg-blue-600' : 'bg-neutral-600'
                      }`}>
                        {s.status}
                      </span>
                    </td>
                    <td className="py-2 pr-3">{s.planCode ?? '—'}</td>
                    <td className="py-2 pr-3 text-neutral-500">{formatDate(s.currentPeriodEnd)}</td>
                    <td className="py-2 pr-3">
                      {editingSub === s.workspaceId ? (
                        <div className="flex items-center gap-2">
                          <select
                            value={editSubForm.status}
                            onChange={(e) => setEditSubForm({ ...editSubForm, status: e.target.value })}
                            className="bg-neutral-800 rounded px-2 py-1 text-xs"
                          >
                            <option value="">Статус...</option>
                            <option value="active">active</option>
                            <option value="trial">trial</option>
                            <option value="canceled">canceled</option>
                            <option value="expired">expired</option>
                          </select>
                          <input
                            type="date"
                            value={editSubForm.periodEnd}
                            onChange={(e) => setEditSubForm({ ...editSubForm, periodEnd: e.target.value })}
                            className="bg-neutral-800 rounded px-2 py-1 text-xs"
                          />
                          <button onClick={() => updateSubscription(s.workspaceId)} className="px-2 py-1 bg-green-600 rounded text-xs">
                            ✓
                          </button>
                          <button onClick={() => setEditingSub(null)} className="px-2 py-1 bg-neutral-600 rounded text-xs">
                            ✕
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setEditingSub(s.workspaceId);
                            setEditSubForm({ status: s.status, planCode: s.planCode ?? '', periodEnd: s.currentPeriodEnd?.slice(0, 10) ?? '' });
                          }}
                          className="px-2 py-1 bg-neutral-700 hover:bg-neutral-600 rounded text-xs"
                        >
                          Редактировать
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
