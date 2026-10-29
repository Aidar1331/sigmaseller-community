'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle, TrendingDown, Circle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { NmIdLink } from '@/components/ui/NmIdLink';

type Urgency = 'critical' | 'high' | 'medium' | 'low';

type Recommendation = {
  id: number;
  nmId: number;
  productTitle: string | null;
  currentStock: number;
  avgDailySales: number;
  daysOfStock: number | null;
  recommendedQty: number;
  urgency: Urgency;
  reason: string | null;
  applied: boolean;
  createdAt: string;
};

type Response = {
  runId: string | null;
  finishedAt: string | null;
  recommendations: Recommendation[];
};

const URGENCY_META: Record<Urgency, { label: string; dot: string; text: string; rank: number }> = {
  critical: { label: 'критично', dot: 'text-red-500', text: 'text-red-700', rank: 0 },
  high: { label: 'высокий', dot: 'text-orange-500', text: 'text-orange-700', rank: 1 },
  medium: { label: 'средний', dot: 'text-yellow-500', text: 'text-yellow-700', rank: 2 },
  low: { label: 'низкий', dot: 'text-slate-400', text: 'text-slate-600', rank: 3 },
};

type Props = {
  workspaceId: number | null;
  shopId: number | null;
};

export function SupplyRecommendations({ workspaceId, shopId }: Props) {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const qs = shopId ? `?shopId=${shopId}` : '';
      const r = await apiFetch<Response>(`/agents/${workspaceId}/supply/recommendations${qs}`);
      setData(r);
    } catch (err) {
      setError((err as Error)?.message ?? 'Не удалось загрузить');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, shopId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRun = async () => {
    if (!workspaceId || running) return;
    setRunning(true);
    setError(null);
    try {
      const qs = shopId ? `?shopId=${shopId}` : '';
      await apiFetch(`/agents/${workspaceId}/supply/run${qs}`, { method: 'POST' });
      await load();
    } catch (err) {
      setError((err as Error)?.message ?? 'Ошибка запуска анализа');
    } finally {
      setRunning(false);
    }
  };

  const recs = (data?.recommendations ?? []).slice().sort((a, b) => {
    const ua = URGENCY_META[a.urgency].rank;
    const ub = URGENCY_META[b.urgency].rank;
    if (ua !== ub) return ua - ub;
    return b.recommendedQty - a.recommendedQty;
  });

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            ИИ-рекомендации поставок
            {recs.length > 0 && (
              <span className="text-xs font-normal text-gray-500">({recs.length})</span>
            )}
          </h3>
          {data?.finishedAt && (
            <div className="text-xs text-gray-500">
              Последний анализ: {new Date(data.finishedAt).toLocaleString('ru-RU')}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="neutral" onClick={load} disabled={loading || running}>
            <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} /> Перечитать
          </Button>
          <Button onClick={handleRun} disabled={!workspaceId || running}>
            <RefreshCw className={cn('mr-2 h-4 w-4', running && 'animate-spin')} />
            {running ? 'Анализирую…' : 'Запустить анализ'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 mb-3">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {recs.length === 0 && !loading && !running && (
        <div className="text-sm text-gray-500 py-6 text-center">
          Нет рекомендаций. Нажмите «Запустить анализ», чтобы агент проанализировал остатки и скорость продаж.
        </div>
      )}

      {recs.length > 0 && (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-[var(--content-muted)]">
                <th className="py-2 px-2">Срочность</th>
                <th className="py-2 px-2">Товар</th>
                <th className="py-2 px-2 text-right">Остаток</th>
                <th className="py-2 px-2 text-right">Прод./день</th>
                <th className="py-2 px-2 text-right">Дней хватит</th>
                <th className="py-2 px-2 text-right">Поставить</th>
                <th className="py-2 px-2">Причина</th>
              </tr>
            </thead>
            <tbody>
              {recs.slice(0, 50).map((r) => {
                const m = URGENCY_META[r.urgency];
                return (
                  <tr key={r.id} className="border-b hover:bg-slate-50/50">
                    <td className="py-2 px-2">
                      <span className={cn('inline-flex items-center gap-1 text-xs font-medium', m.text)}>
                        <Circle className={cn('h-2 w-2 fill-current', m.dot)} /> {m.label}
                      </span>
                    </td>
                    <td className="py-2 px-2">
                      <div className="font-medium text-gray-900 truncate max-w-[260px]" title={r.productTitle ?? ''}>
                        {r.productTitle ?? <NmIdLink nmId={r.nmId} />}
                      </div>
                      <div className="text-xs text-gray-500">
                        <NmIdLink nmId={r.nmId} />
                      </div>
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums">{r.currentStock}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{r.avgDailySales.toFixed(1)}</td>
                    <td className="py-2 px-2 text-right tabular-nums">
                      {r.daysOfStock !== null && r.daysOfStock < 999 ? (
                        <span className={cn(
                          r.daysOfStock < 7 && 'text-red-600 font-semibold',
                          r.daysOfStock >= 7 && r.daysOfStock < 14 && 'text-orange-700',
                        )}>
                          {r.daysOfStock.toFixed(0)}
                        </span>
                      ) : '∞'}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums font-semibold text-violet-700">
                      {r.recommendedQty}
                    </td>
                    <td className="py-2 px-2 text-xs text-gray-600 max-w-[280px]">
                      {r.reason ?? (
                        <span className="inline-flex items-center gap-1">
                          <TrendingDown className="h-3 w-3" /> падение запасов
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {recs.length > 50 && (
            <div className="text-xs text-gray-500 mt-2 text-center">Показаны первые 50 из {recs.length}</div>
          )}
        </div>
      )}
    </Card>
  );
}
