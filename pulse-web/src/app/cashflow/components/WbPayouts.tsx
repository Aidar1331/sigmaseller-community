'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Loader2, Wallet, TrendingUp, TrendingDown } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useWorkspaceStore } from '@/store/workspace';

// Раньше — таблица weekly выплат из cashflow_wb_payouts (cash basis, лагала на 1-2 недели).
// Теперь — daily breakdown по wb_finance_reports/wb_finance_daily + wb_adv_finance:
// доходы (forPay + доплаты) и расходы (комиссия, логистика, хранение, штрафы, реклама, прочее)
// за выбранный период.

type DailyRow = {
  date: string;
  forPayRub: number;
  additionalPaymentRub: number;
  commissionRub: number;
  logisticsRub: number;
  storageRub: number;
  paidAcceptanceRub: number;
  penaltyRub: number;
  acquiringRub: number;
  otherHoldRub: number;
  advRub: number;
  incomeRub: number;
  expensesRub: number;
  netRub: number;
  retailRub: number;
  payoutRub: number;
  salesCount: number;
  returnsCount: number;
};

type WbFinanceResponse = {
  period: { from: string; to: string };
  days: number;
  totals: Omit<DailyRow, 'date'>;
  daily: DailyRow[];
};

type Props = {
  workspaceId: number;
  dateFrom: string;
  dateTo: string;
};

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function formatDay(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function WbPayouts({ workspaceId, dateFrom, dateTo }: Props) {
  const shopId = useWorkspaceStore((s) => s.shopId);
  const [data, setData] = useState<WbFinanceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from: dateFrom, to: dateTo });
      if (shopId) params.set('shopId', String(shopId));
      const res = await apiFetch<WbFinanceResponse>(`/cashflow/${workspaceId}/wb-finance?${params.toString()}`);
      setData(res);
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось загрузить операции ВБ');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, shopId, dateFrom, dateTo]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const formatRub = (v: number) => formatNumber(Math.round(v));

  const t = data?.totals;

  return (
    <Card>
      <div className="p-4 border-b">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold flex items-center gap-2">
              <Wallet className="h-5 w-5 text-emerald-500" />
              Операции Wildberries — по дням
            </h3>
            {t && (
              <p className="text-sm text-muted-foreground mt-1">
                Дней с операциями: {data?.days ?? 0} ·
                <span className="text-emerald-600 ml-1">
                  <TrendingUp className="inline h-3 w-3" /> Доход: {formatRub(t.incomeRub)} ₽
                </span>
                <span className="text-red-500 ml-2">
                  <TrendingDown className="inline h-3 w-3" /> Расход: {formatRub(t.expensesRub)} ₽
                </span>
              </p>
            )}
          </div>
          <Button variant="neutral" size="sm" onClick={fetchData} disabled={loading}>
            <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
            Обновить
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-700 text-sm">{error}</div>
      )}

      {loading && !data ? (
        <div className="p-8 text-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
          Загрузка операций...
        </div>
      ) : !data?.daily?.length ? (
        <div className="p-8 text-center text-muted-foreground">
          <Wallet className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>За выбранный период нет операций ВБ</p>
          <p className="text-sm mt-1">Проверьте, что финансовые отчёты ВБ загружены (вкладка «Финансы»).</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="py-3 px-3 text-left font-medium">Дата</th>
                <th className="py-3 px-3 text-right font-medium text-emerald-600">forPay</th>
                <th className="py-3 px-3 text-right font-medium text-red-500">Комиссия</th>
                <th className="py-3 px-3 text-right font-medium text-red-500">Логистика</th>
                <th className="py-3 px-3 text-right font-medium text-red-500">Хранение</th>
                <th className="py-3 px-3 text-right font-medium text-red-500">Приёмка</th>
                <th className="py-3 px-3 text-right font-medium text-red-500">Штрафы</th>
                <th className="py-3 px-3 text-right font-medium text-red-500">Реклама</th>
                <th className="py-3 px-3 text-right font-medium text-red-500">Прочее</th>
                <th className="py-3 px-3 text-right font-medium">Итог дня</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.daily.map((row) => (
                <tr key={row.date} className="hover:bg-muted/30 transition-colors">
                  <td className="py-2 px-3 whitespace-nowrap">{formatDay(row.date)}</td>
                  <td className="py-2 px-3 text-right font-mono text-emerald-600">
                    {row.forPayRub > 0 ? `+${formatRub(row.forPayRub)}` : formatRub(row.forPayRub)}
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-red-500">{formatRub(row.commissionRub)}</td>
                  <td className="py-2 px-3 text-right font-mono text-red-500">{formatRub(row.logisticsRub)}</td>
                  <td className="py-2 px-3 text-right font-mono text-red-500">{formatRub(row.storageRub)}</td>
                  <td className="py-2 px-3 text-right font-mono text-red-500">{formatRub(row.paidAcceptanceRub)}</td>
                  <td className="py-2 px-3 text-right font-mono text-red-500">{formatRub(row.penaltyRub)}</td>
                  <td className="py-2 px-3 text-right font-mono text-red-500">{formatRub(row.advRub)}</td>
                  <td className="py-2 px-3 text-right font-mono text-red-500">
                    {formatRub(row.acquiringRub + row.otherHoldRub)}
                  </td>
                  <td className={cn('py-2 px-3 text-right font-mono font-semibold', row.netRub >= 0 ? 'text-emerald-600' : 'text-red-500')}>
                    {row.netRub >= 0 ? `+${formatRub(row.netRub)}` : formatRub(row.netRub)}
                  </td>
                </tr>
              ))}
            </tbody>
            {t && (
              <tfoot>
                <tr className="border-t-2 bg-muted/50 font-semibold">
                  <td className="py-3 px-3">Итого</td>
                  <td className="py-3 px-3 text-right font-mono text-emerald-600">
                    +{formatRub(t.forPayRub)}
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-red-500">{formatRub(t.commissionRub)}</td>
                  <td className="py-3 px-3 text-right font-mono text-red-500">{formatRub(t.logisticsRub)}</td>
                  <td className="py-3 px-3 text-right font-mono text-red-500">{formatRub(t.storageRub)}</td>
                  <td className="py-3 px-3 text-right font-mono text-red-500">{formatRub(t.paidAcceptanceRub)}</td>
                  <td className="py-3 px-3 text-right font-mono text-red-500">{formatRub(t.penaltyRub)}</td>
                  <td className="py-3 px-3 text-right font-mono text-red-500">{formatRub(t.advRub)}</td>
                  <td className="py-3 px-3 text-right font-mono text-red-500">
                    {formatRub(t.acquiringRub + t.otherHoldRub)}
                  </td>
                  <td className={cn('py-3 px-3 text-right font-mono text-lg', t.netRub >= 0 ? 'text-emerald-600' : 'text-red-500')}>
                    {t.netRub >= 0 ? `+${formatRub(t.netRub)}` : formatRub(t.netRub)} ₽
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </Card>
  );
}
