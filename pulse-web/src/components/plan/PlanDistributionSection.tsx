'use client';

// Перенесён из MonthlyTargetSection — место рядом с Products table /plan,
// чтобы юзер сразу видел в какую таблицу попадут изменения после
// «Сохранить в таблицу артикулов». Дёргает /plans/monthly только за planOrdersQty,
// чтобы не зависеть от родителя.

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { apiFetch } from '@/lib/api';

interface Props {
  workspaceId: number | null;
  shopId?: number;
  month: string; // YYYY-MM
}

export function PlanDistributionSection({ workspaceId, shopId, month }: Props) {
  const [planOrdersQty, setPlanOrdersQty] = useState<number>(0);
  const [distributing, setDistributing] = useState(false);
  const [distribution, setDistribution] = useState<any | null>(null);
  const [savingDistribution, setSavingDistribution] = useState(false);
  const [distributionSavedAt, setDistributionSavedAt] = useState<string | null>(null);

  const loadTarget = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const params = new URLSearchParams({ workspaceId: String(workspaceId), month });
      if (shopId) params.set('shopId', String(shopId));
      const resp = await apiFetch<any>(`/plans/monthly?${params}`);
      const ord = resp?.target?.planOrdersQty ?? 0;
      setPlanOrdersQty(Number(ord) || 0);
    } catch (e) {
      console.warn('PlanDistributionSection: monthly target load failed', e);
    }
  }, [workspaceId, shopId, month]);

  useEffect(() => { loadTarget(); }, [loadTarget]);

  const loadDistribute = async () => {
    if (!workspaceId || planOrdersQty <= 0) return;
    setDistributing(true);
    try {
      const params = new URLSearchParams({
        workspaceId: String(workspaceId),
        month,
        totalQty: String(planOrdersQty),
      });
      if (shopId) params.set('shopId', String(shopId));
      const res = await apiFetch<any>(`/plans/distribute-orders?${params}`);
      setDistribution(res);
    } catch (e) {
      console.error('distribute', e);
    } finally {
      setDistributing(false);
    }
  };

  const saveDistribution = async () => {
    if (!workspaceId || !distribution?.items?.length) return;
    setSavingDistribution(true);
    try {
      await apiFetch('/plans/monthly/per-nm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          shopId: shopId ?? 0,
          month,
          items: distribution.items.map((i: any) => ({
            nmId: i.nmId,
            planQty: i.suggestedQty,
            planRub: 0,
          })),
        }),
      });
      setDistributionSavedAt(new Date().toLocaleTimeString('ru-RU'));
      // Триггер: AutoSuggestSection и /plan page слушают и обновляют свои данные.
      window.dispatchEvent(new CustomEvent('plan-distribution-saved'));
    } catch (e) {
      console.error('save distribution', e);
    } finally {
      setSavingDistribution(false);
    }
  };

  const disabled = planOrdersQty <= 0;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-semibold text-gray-900">Распределить план по SKU</div>
            <div className="text-xs text-gray-500 mt-0.5">
              {disabled
                ? 'Сначала задай «План заказов» в шаблоне месяца сверху страницы.'
                : `Разделит ${planOrdersQty.toLocaleString('ru-RU')} шт пропорционально продажам за 30 дней, с лимитом ×1.5 от факта.`}
            </div>
          </div>
          <Button
            size="sm"
            variant={disabled ? 'neutral' : 'primary'}
            onClick={loadDistribute}
            loading={distributing}
            disabled={disabled}
            title="Распределить план заказов по SKU пропорционально продажам за 30 дней"
          >
            🎯 Распределить план по SKU
          </Button>
        </div>

        {distribution && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-3">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <div className="text-sm font-semibold text-indigo-800">
                Распределение {distribution.totalQty.toLocaleString('ru-RU')} шт по {distribution.items.length} SKU
              </div>
              <div className="flex items-center gap-2">
                <Button size="xs" variant="primary" onClick={saveDistribution} loading={savingDistribution}>
                  💾 Сохранить в таблицу артикулов
                </Button>
                {distributionSavedAt && (
                  <span className="text-[11px] text-emerald-700">Сохранено в {distributionSavedAt}</span>
                )}
                <button onClick={() => setDistribution(null)} className="text-xs text-indigo-600 hover:underline">
                  Скрыть
                </button>
              </div>
            </div>
            <div className="text-[11px] text-indigo-700/80 mb-2">
              Распределено: {distribution.distributedQty.toLocaleString('ru-RU')} шт
              {distribution.remainingQty > 0 && (
                <span className="ml-2 text-amber-700">
                  (нераспределено {distribution.remainingQty.toLocaleString('ru-RU')} — упёрлись в лимит ×1.5 от продаж 30д)
                </span>
              )}
            </div>
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-white/60 border-b border-indigo-200">
                  <tr className="text-left text-[10px] uppercase text-indigo-700">
                    <th className="px-2 py-1.5"></th>
                    <th className="px-2 py-1.5">Артикул</th>
                    <th className="px-2 py-1.5">Название</th>
                    <th className="px-2 py-1.5 text-right">Продано 30д</th>
                    <th className="px-2 py-1.5 text-right">Остаток</th>
                    <th className="px-2 py-1.5 text-right">Доля</th>
                    <th className="px-2 py-1.5 text-right">План, шт</th>
                  </tr>
                </thead>
                <tbody>
                  {distribution.items.map((it: any) => (
                    <tr key={it.nmId} className="border-b border-indigo-100">
                      <td className="px-2 py-1.5">
                        {it.photo ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img src={it.photo} alt="" className="h-8 w-8 rounded object-cover" loading="lazy" />
                        ) : (
                          <div className="h-8 w-8 rounded bg-gray-100" />
                        )}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums"><NmIdLink nmId={it.nmId} /></td>
                      <td className="px-2 py-1.5 truncate max-w-xs" title={it.title}>{it.title}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{it.sold30d}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{it.stockTotal}</td>
                      <td className="px-2 py-1.5 text-right">{it.share}%</td>
                      <td className="px-2 py-1.5 text-right font-semibold">{it.suggestedQty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
