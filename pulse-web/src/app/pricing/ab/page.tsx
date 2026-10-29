'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import { PricingTabs } from '@/components/pricing/PricingTabs';

type Variant = { label: string; priceKop: number };
type Test = {
  testId: number;
  workspaceId: number;
  shopId: number | null;
  nmId: number;
  name: string | null;
  status: 'running' | 'paused' | 'completed';
  goal: 'orders' | 'revenue' | 'margin' | 'ctr';
  periodDays: number;
  variants: Variant[];
  currentVariant: string | null;
  winnerVariant: string | null;
  rotationMinutes: number;
  autoRotate: boolean;
  originalPriceKop: number | null;
  lastRotatedAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};
type Phase = {
  phaseId: number;
  testId: number;
  variant: string;
  priceKop: number;
  startedAt: string;
  endedAt: string | null;
  metricsSummary: Record<string, number>;
  priceSynced: boolean;
  syncError: string | null;
};

const GOAL_LABELS: Record<Test['goal'], string> = {
  orders: 'Заказы',
  revenue: 'Выручка',
  margin: 'Маржа',
  ctr: 'CTR',
};

function rub(kop: number | null | undefined): string {
  if (kop == null) return '—';
  return new Intl.NumberFormat('ru-RU').format(Math.round(kop / 100)) + ' ₽';
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function PriceAbPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopId = useWorkspaceStore((s) => s.shopId);
  const [tests, setTests] = useState<Test[]>([]);
  const [selected, setSelected] = useState<Test | null>(null);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newTest, setNewTest] = useState({
    nmId: '',
    name: '',
    goal: 'orders' as Test['goal'],
    periodDays: 7,
    rotationMinutes: 20,
    autoRotate: true,
    variants: [
      { label: 'A', priceRub: '' },
      { label: 'B', priceRub: '' },
    ],
  });

  const shopQs = shopId ? `&shopId=${shopId}` : '';

  async function refreshTests() {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const res = (await apiFetch(`/price-ab/${workspaceId}?workspaceId=${workspaceId}${shopQs}`)) as { tests: Test[] };
      setTests(res.tests ?? []);
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось загрузить тесты');
    } finally {
      setLoading(false);
    }
  }

  async function selectTest(test: Test) {
    setSelected(test);
    if (!workspaceId) return;
    try {
      const res = (await apiFetch(`/price-ab/${workspaceId}/${test.testId}?workspaceId=${workspaceId}${shopQs}`)) as { test: Test; phases: Phase[] };
      setSelected(res.test);
      setPhases(res.phases ?? []);
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось загрузить детали теста');
    }
  }

  useEffect(() => {
    void refreshTests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, shopId]);

  async function createTest() {
    if (!workspaceId) return;
    const nmId = Number.parseInt(newTest.nmId, 10);
    if (!Number.isFinite(nmId) || nmId <= 0) {
      setError('Укажи nm_id');
      return;
    }
    const variants = newTest.variants
      .map((v) => ({ label: v.label, priceKop: Math.round(Number.parseFloat(v.priceRub.replace(',', '.')) * 100) }))
      .filter((v) => v.priceKop > 0);
    if (variants.length < 2) {
      setError('Нужно минимум 2 варианта цены');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = (await apiFetch(`/price-ab/${workspaceId}?workspaceId=${workspaceId}${shopQs}`, {
        method: 'POST',
        body: JSON.stringify({
          nmId,
          name: newTest.name || null,
          goal: newTest.goal,
          periodDays: newTest.periodDays,
          rotationMinutes: newTest.rotationMinutes,
          autoRotate: newTest.autoRotate,
          variants,
        }),
      })) as { test: Test };
      setShowCreate(false);
      setNewTest({ ...newTest, nmId: '', name: '' });
      await refreshTests();
      await selectTest(res.test);
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось создать тест');
    } finally {
      setLoading(false);
    }
  }

  async function stopTest(test: Test) {
    if (!workspaceId) return;
    if (!confirm('Остановить тест и вернуть исходную цену?')) return;
    try {
      await apiFetch(`/price-ab/${workspaceId}/${test.testId}/stop?workspaceId=${workspaceId}${shopQs}`, { method: 'POST' });
      await refreshTests();
      if (selected?.testId === test.testId) await selectTest(test);
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось остановить');
    }
  }

  async function applyWinner(test: Test, label: string) {
    if (!workspaceId) return;
    if (!confirm(`Применить вариант ${label} как победителя? Тест завершится.`)) return;
    try {
      await apiFetch(`/price-ab/${workspaceId}/${test.testId}/apply-winner?workspaceId=${workspaceId}${shopQs}`, {
        method: 'POST',
        body: JSON.stringify({ winnerLabel: label }),
      });
      await refreshTests();
      if (selected?.testId === test.testId) await selectTest(test);
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось применить победителя');
    }
  }

  function metricForGoal(p: Phase, goal: Test['goal']): { value: string; label: string } {
    const m = p.metricsSummary ?? {};
    if (goal === 'orders') return { value: String(Number(m.orders ?? 0)), label: 'заказов' };
    if (goal === 'revenue') return { value: rub(Number(m.ordersRub ?? 0)), label: 'выручка' };
    if (goal === 'margin') return { value: rub(Number(m.marginRub ?? 0)), label: 'маржа' };
    if (goal === 'ctr') {
      const views = Number(m.views ?? 0);
      const orders = Number(m.orders ?? 0);
      const conv = views ? Math.round((orders / views) * 10000) / 100 : 0;
      return { value: conv.toFixed(2) + '%', label: 'конв.' };
    }
    return { value: '0', label: '' };
  }

  return (
    <AppShell>
      <div className="p-6 max-w-6xl mx-auto">
        <h1 className="text-2xl font-semibold mb-1">Цена</h1>
        <p className="text-sm text-gray-500 mb-6">
          Управление ценой: правила репрайса, A/B-тесты цены, история изменений.
        </p>
        <PricingTabs current="ab" />

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded">{error}</div>
        )}

        <div className="flex justify-between items-center mb-4">
          <div className="text-sm text-gray-500">
            Загружаешь 2–4 цены, Sigma чередует их в кабинете WB каждые N минут.
            Победителя выбираешь сам или по цели после завершения теста.
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700 whitespace-nowrap"
          >
            + Новый тест
          </button>
        </div>

        {loading && tests.length === 0 && <div className="text-sm text-gray-400">Загрузка…</div>}

        {!loading && tests.length === 0 && !showCreate && (
          <div className="p-8 border border-dashed border-gray-300 rounded text-center text-gray-500 text-sm">
            Пока нет тестов. Нажми «+ Новый тест» — за 1 минуту тест запущен.
          </div>
        )}

        {tests.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            {tests.map((test) => (
              <button
                key={test.testId}
                onClick={() => selectTest(test)}
                className={`text-left p-4 rounded border transition-colors ${
                  selected?.testId === test.testId
                    ? 'border-indigo-500 bg-indigo-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="flex justify-between items-start gap-2 mb-2">
                  <div className="text-sm font-medium">
                    {test.name ?? `Тест #${test.testId}`} · nm {test.nmId}
                  </div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      test.status === 'running'
                        ? 'bg-green-100 text-green-700'
                        : test.status === 'completed'
                        ? 'bg-gray-100 text-gray-600'
                        : 'bg-yellow-100 text-yellow-700'
                    }`}
                  >
                    {test.status}
                  </span>
                </div>
                <div className="text-xs text-gray-500 flex gap-3 flex-wrap">
                  <span>{test.variants.length} вариантов</span>
                  <span>ротация {test.rotationMinutes} мин</span>
                  <span>цель: {GOAL_LABELS[test.goal]}</span>
                  {test.winnerVariant && (
                    <span className="text-indigo-600 font-medium">победитель: {test.winnerVariant}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {selected && (
          <div className="border border-gray-200 rounded p-4 mb-6">
            <div className="flex justify-between items-start mb-4">
              <div>
                <div className="text-lg font-semibold">{selected.name ?? `Тест #${selected.testId}`}</div>
                <div className="text-sm text-gray-500">
                  nm {selected.nmId} · цель {GOAL_LABELS[selected.goal]} · период {selected.periodDays} дн · ротация{' '}
                  {selected.rotationMinutes} мин
                </div>
              </div>
              {selected.status === 'running' && (
                <button
                  onClick={() => stopTest(selected)}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50"
                >
                  Остановить
                </button>
              )}
            </div>

            {selected.lastSyncError && (
              <div className="mb-3 p-2 bg-yellow-50 border border-yellow-200 text-yellow-800 text-xs rounded">
                Последняя ошибка sync: {selected.lastSyncError}
              </div>
            )}

            <div className="mb-4">
              <div className="text-xs text-gray-500 mb-2">Варианты цены</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {selected.variants.map((v) => {
                  const isActive = selected.currentVariant === v.label;
                  const isWinner = selected.winnerVariant === v.label;
                  return (
                    <div
                      key={v.label}
                      className={`p-3 border rounded ${
                        isWinner
                          ? 'border-indigo-500 bg-indigo-50'
                          : isActive
                          ? 'border-green-500 bg-green-50'
                          : 'border-gray-200'
                      }`}
                    >
                      <div className="text-xs text-gray-500">{v.label}</div>
                      <div className="text-base font-semibold">{rub(v.priceKop)}</div>
                      {isActive && <div className="text-xs text-green-700 mt-1">сейчас в WB</div>}
                      {isWinner && <div className="text-xs text-indigo-700 mt-1">победитель</div>}
                      {selected.status === 'running' && !isWinner && (
                        <button
                          onClick={() => applyWinner(selected, v.label)}
                          className="mt-2 text-xs text-indigo-600 hover:underline"
                        >
                          Применить
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="text-xs text-gray-500 mb-2">Фазы (свежие сверху)</div>
            <div className="border border-gray-200 rounded overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="text-left p-2">Вар</th>
                    <th className="text-right p-2">Цена</th>
                    <th className="text-left p-2">С</th>
                    <th className="text-left p-2">По</th>
                    <th className="text-right p-2">Часов</th>
                    <th className="text-right p-2">По цели</th>
                    <th className="text-right p-2">Показы / Заказы</th>
                  </tr>
                </thead>
                <tbody>
                  {phases.map((p) => {
                    const goalM = metricForGoal(p, selected.goal);
                    return (
                      <tr key={p.phaseId} className="border-t border-gray-100">
                        <td className="p-2 font-medium">{p.variant}</td>
                        <td className="p-2 text-right">{rub(p.priceKop)}</td>
                        <td className="p-2 text-xs text-gray-500">{fmtDate(p.startedAt)}</td>
                        <td className="p-2 text-xs text-gray-500">{p.endedAt ? fmtDate(p.endedAt) : 'идёт'}</td>
                        <td className="p-2 text-right text-xs">
                          {(p.metricsSummary?.exposureHours ?? '—').toString()}
                        </td>
                        <td className="p-2 text-right font-medium">
                          {goalM.value} <span className="text-xs text-gray-400">{goalM.label}</span>
                        </td>
                        <td className="p-2 text-right text-xs text-gray-500">
                          {p.metricsSummary?.views ?? 0} / {p.metricsSummary?.orders ?? 0}
                        </td>
                      </tr>
                    );
                  })}
                  {phases.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-4 text-center text-gray-400 text-sm">
                        Фаз пока нет.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {showCreate && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-lg max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto">
              <div className="flex justify-between items-center mb-4">
                <div className="text-lg font-semibold">Новый A/B-тест цены</div>
                <button onClick={() => setShowCreate(false)} className="text-gray-400 hover:text-gray-600 text-xl">
                  ×
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-xs text-gray-500">nm_id товара</label>
                  <input
                    type="number"
                    value={newTest.nmId}
                    onChange={(e) => setNewTest({ ...newTest, nmId: e.target.value })}
                    className="w-full mt-1 px-3 py-2 border border-gray-300 rounded text-sm"
                    placeholder="200523909"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500">Название (опц.)</label>
                  <input
                    type="text"
                    value={newTest.name}
                    onChange={(e) => setNewTest({ ...newTest, name: e.target.value })}
                    className="w-full mt-1 px-3 py-2 border border-gray-300 rounded text-sm"
                    placeholder="например, снижение цены на 5%"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-500">Варианты цены (в рублях)</label>
                  <div className="space-y-2 mt-1">
                    {newTest.variants.map((v, i) => (
                      <div key={i} className="flex gap-2 items-center">
                        <span className="text-sm font-medium w-6">{v.label}</span>
                        <input
                          type="text"
                          value={v.priceRub}
                          onChange={(e) =>
                            setNewTest({
                              ...newTest,
                              variants: newTest.variants.map((x, j) =>
                                j === i ? { ...x, priceRub: e.target.value } : x,
                              ),
                            })
                          }
                          className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm"
                          placeholder="1500"
                        />
                        {newTest.variants.length > 2 && (
                          <button
                            onClick={() =>
                              setNewTest({
                                ...newTest,
                                variants: newTest.variants.filter((_, j) => j !== i),
                              })
                            }
                            className="text-gray-400 hover:text-red-600 text-xl"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                    {newTest.variants.length < 4 && (
                      <button
                        onClick={() =>
                          setNewTest({
                            ...newTest,
                            variants: [
                              ...newTest.variants,
                              { label: String.fromCharCode(65 + newTest.variants.length), priceRub: '' },
                            ],
                          })
                        }
                        className="text-xs text-indigo-600 hover:underline"
                      >
                        + добавить вариант
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-gray-500">Ротация (мин)</label>
                    <input
                      type="number"
                      value={newTest.rotationMinutes}
                      min={20}
                      max={10080}
                      onChange={(e) => setNewTest({ ...newTest, rotationMinutes: Number(e.target.value) })}
                      className="w-full mt-1 px-3 py-2 border border-gray-300 rounded text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">Длительность (дней)</label>
                    <input
                      type="number"
                      value={newTest.periodDays}
                      min={1}
                      max={60}
                      onChange={(e) => setNewTest({ ...newTest, periodDays: Number(e.target.value) })}
                      className="w-full mt-1 px-3 py-2 border border-gray-300 rounded text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs text-gray-500">Цель</label>
                  <select
                    value={newTest.goal}
                    onChange={(e) => setNewTest({ ...newTest, goal: e.target.value as Test['goal'] })}
                    className="w-full mt-1 px-3 py-2 border border-gray-300 rounded text-sm"
                  >
                    <option value="orders">Заказы</option>
                    <option value="revenue">Выручка</option>
                    <option value="margin">Маржа (нужны COGS)</option>
                    <option value="ctr">CTR / конверсия</option>
                  </select>
                </div>
              </div>

              <div className="flex gap-2 justify-end mt-6">
                <button
                  onClick={() => setShowCreate(false)}
                  className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50"
                >
                  Отмена
                </button>
                <button
                  onClick={createTest}
                  disabled={loading}
                  className="px-4 py-2 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700 disabled:opacity-50"
                >
                  {loading ? 'Запуск…' : 'Запустить тест'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
