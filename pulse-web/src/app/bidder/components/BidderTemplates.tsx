'use client';

/**
 * Шаблоны правил биддера «из коробки» — пять предконфигурированных стратегий.
 * При клике на карточку показывается модалка с прогнозом эффекта на основе
 * данных за последние 7 дней (POST /bidder/:ws/simulate), затем подтверждение
 * создаёт правило через существующий POST /bidder/:ws/rules.
 *
 * Источник: ресёрч Промпта #4 (2026-05-31). Подключается в bidder/page.tsx
 * наверху страницы — если у пользователя 0 правил, это первое что он видит.
 */

import { useEffect, useState } from 'react';
import {
  Shield, TrendingUp, Sun, PiggyBank, Scale,
  Loader2, AlertTriangle, X,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';

type TemplateKey = 'protective' | 'aggressive_growth' | 'peak_hours' | 'budget_guard' | 'balanced';

interface Template {
  key: TemplateKey;
  name: string;
  icon: typeof Shield;
  iconColor: string;
  forWho: string;
  effect: string;
  warning?: string;
  payload: Record<string, unknown>;
}

const TEMPLATES: Template[] = [
  {
    key: 'balanced',
    name: 'Балансный',
    icon: Scale,
    iconColor: 'text-indigo-600 bg-indigo-50',
    forWho: 'Универсальный — если не знаешь что выбрать',
    effect: 'ДРР ≤ 20%, плавная подстройка ±10%',
    payload: {
      name: 'Шаблон: Балансный (рекомендуем)',
      targetType: 'all',
      ruleType: 'drr_target',
      conditions: { targetDrr: 20 },
      actionType: 'decrease_percent',
      actionValue: 10,
      minBid: 50,
      maxBid: 2000,
      maxChangePerHour: 200,
    },
  },
  {
    key: 'protective',
    name: 'Защитный',
    icon: Shield,
    iconColor: 'text-emerald-600 bg-emerald-50',
    forWho: 'Маржинальный товар, реклама — буст',
    effect: 'ДРР ≤ 15%, экономия 15–25%',
    payload: {
      name: 'Шаблон: Защитный (ДРР ≤ 15%)',
      targetType: 'all',
      ruleType: 'drr_target',
      conditions: { targetDrr: 15 },
      actionType: 'decrease_percent',
      actionValue: 15,
      minBid: 125,
      maxBid: 5000,
      maxChangePerHour: 300,
    },
  },
  {
    key: 'aggressive_growth',
    name: 'Агрессивный рост',
    icon: TrendingUp,
    iconColor: 'text-rose-600 bg-rose-50',
    forWho: 'Запуск новой карточки, нужен топ-10',
    effect: 'Поднимает CPM до +20%, расход ×2–3',
    warning: 'Подходит только для запуска новых SKU',
    payload: {
      name: 'Шаблон: Агрессивный рост (топ-10)',
      targetType: 'search',
      ruleType: 'position_target',
      conditions: { targetPosition: 10 },
      actionType: 'increase_percent',
      actionValue: 20,
      minBid: 200,
      maxBid: 8000,
      maxChangePerHour: 1000,
    },
  },
  {
    key: 'peak_hours',
    name: 'Час пик',
    icon: Sun,
    iconColor: 'text-amber-600 bg-amber-50',
    forWho: 'Дневной трафик (Дом, Красота, Детям)',
    effect: 'Работает 9–21, экономия 10–15% ночью',
    payload: {
      name: 'Шаблон: Час пик (9:00–21:00, ДРР 20%)',
      targetType: 'all',
      ruleType: 'drr_target',
      conditions: { targetDrr: 20 },
      actionType: 'decrease_percent',
      actionValue: 10,
      minBid: 200,
      maxBid: 4000,
      activeHours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
      activeDays: [1, 2, 3, 4, 5, 6, 7],
      maxChangePerHour: 400,
    },
  },
  {
    key: 'budget_guard',
    name: 'Защита бюджета',
    icon: PiggyBank,
    iconColor: 'text-sky-600 bg-sky-50',
    forWho: 'Новичок, страх «слить за ночь»',
    effect: 'Лимит 2 000 ₽/день/кампанию',
    payload: {
      name: 'Шаблон: Защита бюджета (≤ 2 000 ₽/день)',
      targetType: 'all',
      ruleType: 'budget_limit',
      conditions: { maxBudget: 2000 },
      actionType: 'decrease_percent',
      actionValue: 30,
      minBid: 125,
      maxBid: 3000,
      maxChangePerHour: 1500,
    },
  },
];

interface SimulationResult {
  currentDailySpend: number;
  estimatedDailySpend: number;
  estimatedSavingsPct: number;
  warnings: string[];
}

interface Props {
  workspaceId: number;
  shopParam: string;
  hasExistingRules: boolean;
  onApplied: () => void;
}

export function BidderTemplates({ workspaceId, shopParam, hasExistingRules, onApplied }: Props) {
  const [selected, setSelected] = useState<Template | null>(null);
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Закрытие модалки по Escape
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !applying) setSelected(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected, applying]);

  const openTemplate = async (tpl: Template) => {
    setSelected(tpl);
    setSimulation(null);
    setError(null);
    setSimulating(true);
    try {
      const res = await apiFetch<SimulationResult>(
        `/bidder/${workspaceId}/simulate${shopParam ? `?${shopParam.slice(1)}` : ''}`,
        { method: 'POST', body: JSON.stringify(tpl.payload) },
      );
      setSimulation(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Не удалось рассчитать прогноз');
    } finally {
      setSimulating(false);
    }
  };

  const apply = async () => {
    if (!selected) return;
    setApplying(true);
    setError(null);
    try {
      await apiFetch(`/bidder/${workspaceId}/rules${shopParam ? `?${shopParam.slice(1)}` : ''}`, {
        method: 'POST',
        body: JSON.stringify(selected.payload),
      });
      setSelected(null);
      onApplied();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Не удалось применить шаблон');
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <Card className={cn('p-4', !hasExistingRules && 'border-indigo-200 bg-indigo-50/30')}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h3 className="font-semibold text-gray-900">Шаблоны из коробки</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {hasExistingRules
                ? 'Добавь дополнительный шаблон к существующим правилам.'
                : 'Запусти биддер за 1 клик — без ручной настройки.'}
            </p>
          </div>
          {!hasExistingRules && <Badge variant="primary-solid">начни здесь</Badge>}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {TEMPLATES.map((tpl) => {
            const Icon = tpl.icon;
            const isRecommended = tpl.key === 'balanced';
            return (
              <button
                key={tpl.key}
                type="button"
                onClick={() => openTemplate(tpl)}
                className={cn(
                  'flex flex-col items-start gap-2 rounded-xl border bg-white p-3 text-left transition hover:border-indigo-300 hover:shadow-sm',
                  isRecommended && 'border-indigo-300 ring-1 ring-indigo-100',
                )}
              >
                <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg', tpl.iconColor)}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="font-semibold text-gray-900 leading-tight">{tpl.name}</div>
                <div className="text-xs text-muted-foreground leading-snug">{tpl.forWho}</div>
                <div className="text-xs font-medium text-emerald-700 mt-auto">{tpl.effect}</div>
                {isRecommended && <Badge variant="primary-solid" className="text-[10px]">рекомендуем</Badge>}
                {tpl.warning && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-amber-700">
                    <AlertTriangle className="h-3 w-3" />
                    {tpl.warning}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </Card>

      {/* Простая native-style модалка через fixed overlay (Dialog компонента нет в проекте). */}
      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
          onClick={() => !applying && setSelected(null)}
        >
          <div
            className="w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-xl border border-gray-200 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 p-5 border-b border-gray-100">
              <h3 className="font-semibold text-lg text-gray-900">
                Применить шаблон «{selected.name}»?
              </h3>
              <button
                onClick={() => !applying && setSelected(null)}
                className="text-gray-400 hover:text-gray-700 shrink-0"
                aria-label="Закрыть"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-5 space-y-3 text-sm">
              <div className="text-muted-foreground">
                Шаблон будет применён ко всем активным WB-кампаниям этого шопа. Биддер начнёт работать
                автоматически в течение часа. Ты можешь выключить правило в любой момент.
              </div>

              {simulating && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Считаем прогноз по твоим данным за 7 дней…
                </div>
              )}

              {simulation && (
                <div className="rounded-lg border border-indigo-100 bg-indigo-50/40 p-3 space-y-1.5">
                  <div className="text-xs uppercase tracking-wide text-indigo-600 font-semibold">
                    Прогноз (приблизительный)
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Сейчас (среднее за 7 дней):</span>
                    <span className="font-medium">{formatNumber(simulation.currentDailySpend)} ₽/день</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Прогноз после применения:</span>
                    <span className="font-medium">{formatNumber(simulation.estimatedDailySpend)} ₽/день</span>
                  </div>
                  <div className="flex justify-between text-emerald-700 font-medium">
                    <span>Экономия:</span>
                    <span>
                      {simulation.estimatedSavingsPct > 0 ? '−' : '+'}
                      {Math.abs(simulation.estimatedSavingsPct).toFixed(0)}%
                    </span>
                  </div>
                  {simulation.warnings.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {simulation.warnings.map((w, i) => (
                        <div key={i} className="flex items-start gap-1.5 text-xs text-amber-700">
                          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                          <span>{w}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="text-[10px] text-muted-foreground pt-1 border-t border-indigo-100">
                    Это симуляция, реальный результат зависит от рыночной ситуации.
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {error}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 p-5 border-t border-gray-100 bg-gray-50/50">
              <Button variant="neutral" onClick={() => setSelected(null)} disabled={applying}>
                Отмена
              </Button>
              <Button onClick={apply} disabled={applying || simulating}>
                {applying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Да, применить
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
