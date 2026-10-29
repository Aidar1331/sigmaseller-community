'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { PricingTabs } from '@/components/pricing/PricingTabs';
import { Card } from '@/components/ui/Card';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useShopChange } from '@/hooks/useShopChange';
import {
  TrendingUp, TrendingDown, Plus, Trash2, Play, DollarSign,
  RefreshCw, ArrowRight, Shield, AlertTriangle, Check, X,
} from 'lucide-react';

type Strategy = {
  strategyId: number;
  workspaceId: number;
  nmId: number;
  strategyType: string;
  config: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
};

type Decision = {
  decisionId: number;
  workspaceId: number;
  nmId: number;
  strategyType: string;
  currentPriceKop: number;
  proposedPriceKop: number;
  constrainedPriceKop: number | null;
  allowed: boolean;
  violations: string[] | null;
  reason: string | null;
  createdAt: string;
};

type Evaluation = {
  strategyType: string;
  proposedPriceKop: number;
  reason: string;
  constraint: {
    allowed: boolean;
    constrainedPriceKop: number;
    violations: string[];
  };
  decision: { decisionId: number };
};

const STRATEGY_LABELS: Record<string, { label: string; description: string }> = {
  maximize_profit: { label: 'Макс. прибыль', description: 'Оптимизация цены для максимальной маржи' },
  hold_supply: { label: 'Удержание запасов', description: 'Управление ценой при избытке запасов' },
  demand_up: { label: 'Рост спроса', description: 'Повышение цены при растущем спросе' },
  demand_down: { label: 'Падение спроса', description: 'Снижение цены при падающем спросе' },
  turnover: { label: 'Оборачиваемость', description: 'Оптимизация под скорость продаж' },
  negative_reviews: { label: 'Негативные отзывы', description: 'Адаптация при негативных отзывах' },
  atc_optimize: { label: 'ATC оптимизация', description: 'Оптимизация Add-to-Cart' },
  aggressive_sale: { label: 'Агрессивная распродажа', description: 'Быстрая распродажа товара' },
  oos_protection: { label: 'Защита от OOS', description: 'Повышение цены при малых остатках' },
};

type Tab = 'strategies' | 'decisions';

export default function PricingPage() {
  const [activeTab, setActiveTab] = useState<Tab>('strategies');
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(false);

  // Create strategy
  const [showCreate, setShowCreate] = useState(false);
  const [newNmId, setNewNmId] = useState('');
  const [newType, setNewType] = useState('maximize_profit');
  const [creating, setCreating] = useState(false);

  // Evaluate
  const [evalNmId, setEvalNmId] = useState('');
  const [evalPrice, setEvalPrice] = useState('');
  const [evaluating, setEvaluating] = useState(false);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);

  const loadStrategies = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ strategies: Strategy[] }>('/pricing/strategies');
      setStrategies(res.strategies ?? []);
    } catch (err) {
      console.error('Failed to load strategies:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDecisions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ decisions: Decision[] }>('/pricing/decisions');
      setDecisions(res.decisions ?? []);
    } catch (err) {
      console.error('Failed to load decisions:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCurrentTab = useCallback(() => {
    if (activeTab === 'strategies') loadStrategies();
    else loadDecisions();
  }, [activeTab, loadStrategies, loadDecisions]);

  useEffect(() => {
    loadCurrentTab();
  }, [loadCurrentTab]);

  useShopChange(loadCurrentTab);

  const createStrategy = async () => {
    const nmId = Number(newNmId);
    if (!nmId || nmId <= 0) return;
    setCreating(true);
    try {
      await apiFetch('/pricing/strategies', {
        method: 'POST',
        body: JSON.stringify({ nmId, strategyType: newType }),
      });
      setShowCreate(false);
      setNewNmId('');
      loadStrategies();
    } catch (err) {
      console.error('Failed to create strategy:', err);
    } finally {
      setCreating(false);
    }
  };

  const deleteStrategy = async (stratId: number) => {
    try {
      await apiFetch(`/pricing/strategies/${stratId}`, { method: 'DELETE' });
      setStrategies((prev) => prev.filter((s) => s.strategyId !== stratId));
    } catch (err) {
      console.error('Failed to delete strategy:', err);
    }
  };

  const evaluate = async () => {
    const nmId = Number(evalNmId);
    const priceRub = Number(evalPrice);
    if (!nmId || !priceRub) return;
    setEvaluating(true);
    setEvaluations([]);
    try {
      const res = await apiFetch<{ evaluations: Evaluation[] }>('/pricing/evaluate', {
        method: 'POST',
        body: JSON.stringify({ nmId, currentPriceKop: Math.round(priceRub * 100) }),
      });
      setEvaluations(res.evaluations ?? []);
    } catch (err) {
      console.error('Failed to evaluate:', err);
    } finally {
      setEvaluating(false);
    }
  };

  const formatPrice = (kop: number) => (kop / 100).toLocaleString('ru-RU', { maximumFractionDigits: 0 });

  return (
    <AppShell title="Цена">
      <div className="space-y-4">
        <PricingTabs current="rules" />
        {/* Header */}
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-violet-600" />
              <h1 className="text-lg font-semibold text-gray-900">Ценообразование</h1>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                <button
                  onClick={() => setActiveTab('strategies')}
                  className={cn(
                    'px-3 py-1.5 text-xs font-medium transition-colors',
                    activeTab === 'strategies'
                      ? 'bg-violet-50 text-violet-700'
                      : 'text-gray-500 hover:bg-gray-50'
                  )}
                >
                  Стратегии
                </button>
                <button
                  onClick={() => setActiveTab('decisions')}
                  className={cn(
                    'px-3 py-1.5 text-xs font-medium transition-colors',
                    activeTab === 'decisions'
                      ? 'bg-violet-50 text-violet-700'
                      : 'text-gray-500 hover:bg-gray-50'
                  )}
                >
                  Решения
                </button>
              </div>
              {activeTab === 'strategies' && (
                <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
                  <Plus className="h-4 w-4" />
                  Добавить
                </Button>
              )}
            </div>
          </div>
        </Card>

        {/* Strategies Tab */}
        {activeTab === 'strategies' && (
          <>
            {/* Create strategy modal */}
            {showCreate && (
              <Card className="p-4 border-violet-200 bg-violet-50/30">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-medium text-gray-900 text-sm">Новая стратегия</h3>
                  <button onClick={() => setShowCreate(false)}>
                    <X className="h-4 w-4 text-gray-500" />
                  </button>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Input
                    value={newNmId}
                    onChange={(e) => setNewNmId(e.target.value)}
                    placeholder="Артикул товара"
                    className="w-40"
                    type="number"
                  />
                  <select
                    value={newType}
                    onChange={(e) => setNewType(e.target.value)}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    {Object.entries(STRATEGY_LABELS).map(([key, { label }]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                  <Button variant="primary" size="md" onClick={createStrategy} loading={creating}>
                    Создать
                  </Button>
                </div>
              </Card>
            )}

            {/* Evaluate section */}
            <Card className="p-4">
              <h3 className="text-sm font-medium text-gray-700 mb-3">Оценить цену товара</h3>
              <div className="flex flex-wrap gap-3">
                <Input
                  value={evalNmId}
                  onChange={(e) => setEvalNmId(e.target.value)}
                  placeholder="Артикул товара"
                  className="w-40"
                  type="number"
                />
                <Input
                  value={evalPrice}
                  onChange={(e) => setEvalPrice(e.target.value)}
                  placeholder="Текущая цена (руб)"
                  className="w-48"
                  type="number"
                />
                <Button variant="primary" size="md" onClick={evaluate} loading={evaluating}>
                  <Play className="h-4 w-4" />
                  Оценить
                </Button>
              </div>

              {/* Evaluation results */}
              {evaluations.length > 0 && (
                <div className="mt-4 space-y-3">
                  <h4 className="text-xs font-medium text-gray-500">Результаты оценки:</h4>
                  {evaluations.map((ev, i) => {
                    const info = STRATEGY_LABELS[ev.strategyType];
                    const priceDiff = ev.constraint.constrainedPriceKop - Number(evalPrice) * 100;
                    return (
                      <div key={i} className="p-3 bg-gray-50 rounded-lg border border-gray-100">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div>
                            <span className="font-medium text-sm text-gray-900">
                              {info?.label ?? ev.strategyType}
                            </span>
                            {ev.constraint.allowed ? (
                              <Badge variant="success" size="sm" className="ml-2">
                                <Check className="h-3 w-3" /> Разрешено
                              </Badge>
                            ) : (
                              <Badge variant="warning" size="sm" className="ml-2">
                                <AlertTriangle className="h-3 w-3" /> Ограничено
                              </Badge>
                            )}
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-semibold">
                              {formatPrice(ev.constraint.constrainedPriceKop)} ₽
                            </div>
                            <div className={cn(
                              'text-xs',
                              priceDiff > 0 ? 'text-emerald-600' : priceDiff < 0 ? 'text-red-600' : 'text-gray-500'
                            )}>
                              {priceDiff > 0 ? '+' : ''}{formatPrice(priceDiff)} ₽
                            </div>
                          </div>
                        </div>
                        <p className="text-xs text-gray-600">{ev.reason}</p>
                        {ev.constraint.violations.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {ev.constraint.violations.map((v, j) => (
                              <Badge key={j} variant="warning" size="sm">{v}</Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* Strategies list */}
            {loading ? (
              <Card className="p-8 text-center text-gray-500">
                <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2" />
                Загрузка...
              </Card>
            ) : strategies.length === 0 ? (
              <Card className="p-8 text-center">
                <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-gray-100 flex items-center justify-center">
                  <DollarSign className="h-6 w-6 text-gray-500" />
                </div>
                <p className="text-sm text-gray-500">Нет активных стратегий</p>
                <p className="text-xs text-gray-500 mt-1 mb-3">Создайте стратегию для автоматического ценообразования</p>
                <div className="text-xs text-gray-500 text-left max-w-md mx-auto space-y-1">
                  <p>Доступные стратегии:</p>
                  <p>- <b>Максимизация прибыли</b> — повышение цены при стабильных продажах</p>
                  <p>- <b>Удержание запаса</b> — снижение/повышение цены по остаткам</p>
                  <p>- <b>Стимуляция спроса</b> — снижение цены для роста продаж</p>
                  <p>- <b>Защита от OOS</b> — повышение при низких остатках</p>
                </div>
              </Card>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {strategies.map((strat) => {
                  const info = STRATEGY_LABELS[strat.strategyType];
                  return (
                    <Card key={strat.strategyId} className="p-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium text-sm text-gray-900">
                              {info?.label ?? strat.strategyType}
                            </span>
                            <Badge variant="neutral" size="sm">Артикул: <NmIdLink nmId={strat.nmId} className="hover:underline" /></Badge>
                          </div>
                          <p className="text-xs text-gray-500">{info?.description ?? ''}</p>
                          <p className="text-xs text-gray-500 mt-1">
                            {new Date(strat.createdAt).toLocaleDateString('ru-RU')}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => deleteStrategy(strat.strategyId)}
                        >
                          <Trash2 className="h-4 w-4 text-red-400" />
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* Decisions Tab */}
        {activeTab === 'decisions' && (
          <>
            {loading ? (
              <Card className="p-8 text-center text-gray-500">
                <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2" />
                Загрузка...
              </Card>
            ) : decisions.length === 0 ? (
              <Card className="p-8 text-center text-gray-500 text-sm">
                Нет решений. Запустите оценку цены для создания решений.
              </Card>
            ) : (
              <div className="space-y-3">
                {decisions.map((d) => {
                  const info = STRATEGY_LABELS[d.strategyType];
                  return (
                    <Card key={d.decisionId} className="p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium text-sm">{info?.label ?? d.strategyType}</span>
                            <Badge variant="neutral" size="sm">Артикул: <NmIdLink nmId={d.nmId} className="hover:underline" /></Badge>
                            {d.allowed ? (
                              <Badge variant="success" size="sm">OK</Badge>
                            ) : (
                              <Badge variant="warning" size="sm">Ограничено</Badge>
                            )}
                          </div>
                          {d.reason && (
                            <p className="text-xs text-gray-500 line-clamp-1">{d.reason}</p>
                          )}
                          {d.violations && d.violations.length > 0 && (
                            <div className="flex gap-1 mt-1">
                              {d.violations.map((v, i) => (
                                <Badge key={i} variant="warning" size="sm">{v}</Badge>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <div className="text-right">
                            <div className="text-xs text-gray-500">{formatPrice(d.currentPriceKop)} ₽</div>
                            <div className="flex items-center gap-1">
                              <ArrowRight className="h-3 w-3 text-gray-500" />
                              <span className="font-semibold text-sm">
                                {formatPrice(d.constrainedPriceKop ?? d.proposedPriceKop)} ₽
                              </span>
                            </div>
                          </div>
                          <span className="text-xs text-gray-500">
                            {new Date(d.createdAt).toLocaleDateString('ru-RU')}
                          </span>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
