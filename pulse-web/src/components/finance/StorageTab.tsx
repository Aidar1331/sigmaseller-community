'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { apiFetch } from '@/lib/api';
import { Warehouse } from 'lucide-react';
import { FinanceStat } from './FinanceStat';

type NmRow = {
  nmId: number;
  vendorCode: string;
  title: string;
  photo: string | null;
  costKop: number;
  volume: number;
  days: number;
};

type Resp = {
  dateFrom: string;
  dateTo: string;
  totals: { cost: number; volume: number; count: number; items: number };
  byNm: NmRow[];
};

function rub(v: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(v));
}

interface Props {
  workspaceId: number;
  shopId?: number;
  start?: string;
  end?: string;
}

export function StorageTab({ workspaceId, shopId, start, end }: Props) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    const today = new Date().toISOString().slice(0, 10);
    const dateTo = end ?? today;
    const dateFrom = start ?? new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
    const params = new URLSearchParams({ from: dateFrom, to: dateTo });
    if (shopId) params.set('shopId', String(shopId));
    apiFetch<Resp>(`/finance/${workspaceId}/storage?${params}`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [workspaceId, shopId, start, end]);

  const t = data?.totals;
  const totalCostRub = (t?.cost ?? 0) / 100;
  const avgDailyRub = t ? totalCostRub / Math.max(1, daysBetween(data?.dateFrom, data?.dateTo)) : 0;

  return (
    <div className="space-y-4">
      <Card>
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-lg font-semibold flex items-center gap-2">
                <Warehouse className="h-5 w-5 text-blue-500" /> Хранение
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                Платное хранение на складах ВБ — по дням и по артикулам.
              </div>
            </div>
            {loading && <div className="text-sm text-gray-500">Загрузка…</div>}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <FinanceStat label="Всего хранение" value={-totalCostRub} red />
            <FinanceStat label="В среднем в день" value={-avgDailyRub} red />
            <FinanceStat label="Артикулов на складе" value={t?.items ?? 0} raw />
            <FinanceStat label="Объём (м³·дн.)" value={(t?.volume ?? 0).toFixed(3)} raw />
          </div>

          <details className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded p-2 mt-3">
            <summary className="cursor-pointer font-medium">Как считаются цифры</summary>
            <div className="mt-2 space-y-1">
              <p>Это плата ВБ за хранение твоих остатков на складах FBO. Считается ежедневно: тариф склада × объём × количество дней.</p>
              <p>Разбивка по артикулам — реальная: ВБ отдаёт стоимость с привязкой к конкретному артикулу.</p>
            </div>
          </details>
        </div>
      </Card>

      <Card>
        <div className="p-4">
          <div className="text-sm font-semibold mb-2">По артикулам (топ-100)</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr className="text-left text-xs text-gray-500 uppercase">
                  <th className="px-3 py-2 w-14">Фото</th>
                  <th className="px-3 py-2">Артикул</th>
                  <th className="px-3 py-2">Название</th>
                  <th className="px-3 py-2 text-right">Стоимость хран.</th>
                  <th className="px-3 py-2 text-right">Объём (м³·дн.)</th>
                  <th className="px-3 py-2 text-right">Дней</th>
                </tr>
              </thead>
              <tbody>
                {(data?.byNm ?? []).map((r) => (
                  <tr key={r.nmId} className="border-t border-gray-50">
                    <td className="px-3 py-1.5">
                      {r.photo ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={r.photo}
                          alt={r.title || String(r.nmId)}
                          className="h-10 w-10 rounded object-cover border border-gray-100 bg-gray-50"
                          loading="lazy"
                        />
                      ) : (
                        <div className="h-10 w-10 rounded bg-gray-100" />
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums"><NmIdLink nmId={r.nmId} /></td>
                    <td className="px-3 py-2">
                      <div className="truncate max-w-md text-gray-900" title={r.title}>{r.title || r.vendorCode || '—'}</div>
                      {r.vendorCode && <div className="text-[10px] text-gray-400">{r.vendorCode}</div>}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-blue-700">{rub(r.costKop / 100)} ₽</td>
                    <td className="px-3 py-2 text-right text-gray-600">{r.volume.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{r.days}</td>
                  </tr>
                ))}
                {(data?.byNm ?? []).length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-gray-400">Нет данных за период</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Card>
    </div>
  );
}

function daysBetween(from?: string, to?: string): number {
  if (!from || !to) return 1;
  const d1 = new Date(from + 'T00:00:00');
  const d2 = new Date(to + 'T00:00:00');
  return Math.max(1, Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1);
}
