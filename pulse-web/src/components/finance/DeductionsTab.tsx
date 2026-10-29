'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { apiFetch } from '@/lib/api';
import { AlertTriangle } from 'lucide-react';
import { FinanceStat } from './FinanceStat';

type DailyRow = { date: string; penaltyRub: number; deductionRub: number };
type NmRow = { nmId: number; vendorCode: string; title: string; photo: string | null; penaltyRub: number };

type Resp = {
  dateFrom: string;
  dateTo: string;
  totals: { penaltyRub: number; deductionRub: number; totalRub: number; days: number; items: number };
  daily: DailyRow[];
  byNm: NmRow[];
};

function rub(v: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(v));
}

function fmtDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

interface Props {
  workspaceId: number;
  shopId?: number;
  start?: string;
  end?: string;
}

export function DeductionsTab({ workspaceId, shopId, start, end }: Props) {
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
    apiFetch<Resp>(`/finance/${workspaceId}/deductions?${params}`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [workspaceId, shopId, start, end]);

  const t = data?.totals;

  return (
    <div className="space-y-4">
      <Card>
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-lg font-semibold flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" /> Штрафы и удержания
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                Штрафы и удержания из финансового отчёта ВБ за выбранный период
              </div>
            </div>
            {loading && <div className="text-sm text-gray-500">Загрузка…</div>}
          </div>

          {t && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                <FinanceStat label="Штрафы" value={-t.penaltyRub} red />
                <FinanceStat label="Прочие удерж. (включая WB-промо)" value={-t.deductionRub} red />
                <FinanceStat label="Артикулов со штрафом" value={t.items} raw />
                <FinanceStat label="Всего изъятий" value={-t.totalRub} highlight />
              </div>
              <details className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded p-2 mt-3">
                <summary className="cursor-pointer font-medium">Как считаются цифры</summary>
                <div className="mt-2 space-y-1">
                  <p><strong>Штрафы</strong> — поле <code className="bg-white px-1 rounded text-[10px]">penalty</code> из финотчёта (типовые штрафы за нарушения).</p>
                  <p><strong>Прочие удержания</strong> — поле <code className="bg-white px-1 rounded text-[10px]">deduction</code>: WB-Продвижение (рекламные списания с paymentType=Баланс) + подписки/сервисы + возмещения. WB не возвращает разбивку по типам через API.</p>
                </div>
              </details>
            </>
          )}
        </div>
      </Card>

      {/* Per-day */}
      <Card>
        <div className="p-4">
          <div className="text-sm font-semibold mb-2">По дням</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr className="text-left text-xs text-gray-500 uppercase">
                  <th className="px-3 py-2">Дата</th>
                  <th className="px-3 py-2 text-right">Штрафы</th>
                  <th className="px-3 py-2 text-right">Прочие удерж.</th>
                  <th className="px-3 py-2 text-right">Итого</th>
                </tr>
              </thead>
              <tbody>
                {(data?.daily ?? []).filter((r) => r.penaltyRub + r.deductionRub > 0).map((r) => (
                  <tr key={r.date} className="border-t border-gray-50">
                    <td className="px-3 py-2 font-medium">{fmtDate(r.date)}</td>
                    <td className="px-3 py-2 text-right text-red-600">{r.penaltyRub > 0 ? `−${rub(r.penaltyRub)} ₽` : '—'}</td>
                    <td className="px-3 py-2 text-right text-red-600">{r.deductionRub > 0 ? `−${rub(r.deductionRub)} ₽` : '—'}</td>
                    <td className="px-3 py-2 text-right font-semibold text-red-700">−{rub(r.penaltyRub + r.deductionRub)} ₽</td>
                  </tr>
                ))}
                {(data?.daily ?? []).filter((r) => r.penaltyRub + r.deductionRub > 0).length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-gray-400">Штрафов и удержаний за период нет</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      {/* Per-nm */}
      <Card>
        <div className="p-4">
          <div className="text-sm font-semibold mb-2">По артикулам</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr className="text-left text-xs text-gray-500 uppercase">
                  <th className="px-3 py-2">Артикул</th>
                  <th className="px-3 py-2">Название</th>
                  <th className="px-3 py-2 text-right">Штраф</th>
                </tr>
              </thead>
              <tbody>
                {(data?.byNm ?? []).map((r) => (
                  <tr key={r.nmId} className="border-t border-gray-50">
                    <td className="px-3 py-2 tabular-nums"><NmIdLink nmId={r.nmId} /></td>
                    <td className="px-3 py-2 truncate max-w-md" title={r.title}>{r.title || r.vendorCode || '—'}</td>
                    <td className="px-3 py-2 text-right font-semibold text-red-700">−{rub(r.penaltyRub)} ₽</td>
                  </tr>
                ))}
                {(data?.byNm ?? []).length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-6 text-center text-gray-400">Нет артикулов со штрафами за период</td>
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
