'use client';

import { formatRub } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { RefreshCw } from 'lucide-react';
import { NmIdLink } from '@/components/ui/NmIdLink';

export type FinanceRow = {
  period: 'weekly' | 'daily';
  dateFrom: string;
  dateTo: string;
  nmId: number;
  vendorCode: string | null;
  revenueKopecks: number;
  incomeFromSalesKopecks: number;
  logisticsKopecks: number;
  paidAcceptanceKopecks: number;
  storageKopecks: number;
  penaltiesKopecks: number;
  otherHoldKopecks: number;
  additionalPaymentsKopecks: number;
  costsKopecks: number;
  taxKopecks: number;
  netTransferKopecks: number;
  netProfitKopecks: number;
  lines: number;
};

export type FinanceResponse = {
  workspaceId: number;
  period: 'weekly' | 'daily';
  dateFrom: string;
  dateTo: string;
  taxRate: number;
  rows: FinanceRow[];
};

const selectCls = 'rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-2 py-1 text-xs text-[var(--content-text)] outline-none focus:ring-2 focus:ring-indigo-500/30';

export function FinanceTable({
  finance,
  financeLoading,
  financeError,
  financeTaxRate,
  financePeriod,
  financeDateFrom,
  financeDateTo,
  financeFilter,
  financeSort,
  financeShowBreakdown,
  financeAutoSyncState,
  financeAutoSyncMsg,
  periodDays,
  onTaxRateChange,
  onPeriodChange,
  onDateFromChange,
  onDateToChange,
  onFilterChange,
  onSortChange,
  onShowBreakdownChange,
  onLoad,
}: {
  finance: FinanceResponse | null;
  financeLoading: boolean;
  financeError: string | null;
  financeTaxRate: number;
  financePeriod: 'weekly' | 'daily';
  financeDateFrom: string;
  financeDateTo: string;
  financeFilter: string;
  financeSort: 'netProfit' | 'netTransfer' | 'income' | 'costs';
  financeShowBreakdown: boolean;
  financeAutoSyncState: string;
  financeAutoSyncMsg: string;
  periodDays: number;
  onTaxRateChange: (v: number) => void;
  onPeriodChange: (v: 'weekly' | 'daily') => void;
  onDateFromChange: (v: string) => void;
  onDateToChange: (v: string) => void;
  onFilterChange: (v: string) => void;
  onSortChange: (v: 'netProfit' | 'netTransfer' | 'income' | 'costs') => void;
  onShowBreakdownChange: (v: boolean) => void;
  onLoad: () => void;
}) {
  return (
    <Card className="mt-8 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-[var(--content-text)]">Финансы WB → по артикулам (weekly)</div>
          <div className="mt-1 text-[11px] text-[var(--content-muted)]">
            Источник: WB reportDetailByPeriod(period=weekly). Налог: УСН 15% (доход − расход).
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-[var(--content-muted)]">
            Налоговая ставка
            <Input className="ml-2 inline-block w-24" type="number" step="0.01" value={financeTaxRate} onChange={(e) => onTaxRateChange(Number(e.target.value))} />
          </label>
          <label className="text-xs text-[var(--content-muted)]">
            Период
            <select className={cn(selectCls, 'ml-2')} value={financePeriod} onChange={(e) => onPeriodChange(e.target.value as any)}>
              <option value="weekly">weekly</option>
              <option value="daily">daily</option>
            </select>
          </label>

          <label className="text-xs text-[var(--content-muted)]">
            С
            <Input className="ml-2 inline-block w-28" placeholder="YYYY-MM-DD" value={financeDateFrom} onChange={(e) => onDateFromChange(e.target.value)} />
          </label>

          <label className="text-xs text-[var(--content-muted)]">
            По
            <Input className="ml-2 inline-block w-28" placeholder="YYYY-MM-DD" value={financeDateTo} onChange={(e) => onDateToChange(e.target.value)} />
          </label>

          <label className="text-xs text-[var(--content-muted)]">
            Фильтр
            <Input className="ml-2 inline-block w-40" placeholder="Артикул WB или код продавца" value={financeFilter} onChange={(e) => onFilterChange(e.target.value)} />
          </label>

          <label className="text-xs text-[var(--content-muted)]">
            Сортировка
            <select className={cn(selectCls, 'ml-2')} value={financeSort} onChange={(e) => onSortChange(e.target.value as any)}>
              <option value="netProfit">прибыль</option>
              <option value="netTransfer">к переводу</option>
              <option value="income">приход</option>
              <option value="costs">затраты</option>
            </select>
          </label>

          <label className="flex items-center gap-2 text-xs text-[var(--content-muted)]">
            <input type="checkbox" checked={financeShowBreakdown} onChange={(e) => onShowBreakdownChange(e.target.checked)} className="accent-indigo-600" />
            Затраты (детально)
          </label>

          <Button onClick={onLoad} disabled={financeLoading} loading={financeLoading} title="Запрос тяжёлый (WB rate limit 1/min). Нажимай по делу.">
            <RefreshCw className="h-4 w-4" /> {financeLoading ? 'Загружаю…' : `Загрузить (${periodDays}д)`}
          </Button>
        </div>
      </div>

      {financeAutoSyncState !== 'idle' ? (
        <div className="mt-3 rounded-[var(--radius-md)] border border-indigo-200 bg-indigo-50 p-3 text-xs text-[var(--content-text)]">
          <div className="font-medium">Автосинхронизация финансов</div>
          <div className="mt-1 text-[11px] text-[var(--content-muted)]">
            status: <span className="font-mono">{financeAutoSyncState}</span>
            {financeAutoSyncMsg ? <span className="ml-2">— {financeAutoSyncMsg}</span> : null}
          </div>
          <div className="mt-1 text-[11px] text-[var(--content-muted)]">
            Если данные пустые или старше 24ч — запускаем обновление weekly-отчётов в фоне.
          </div>
        </div>
      ) : null}

      {financeError ? (
        <div className="mt-3 rounded-[var(--radius-md)] border border-red-200 bg-red-50 p-3 text-xs text-red-600">
          {financeError}
        </div>
      ) : null}

      {finance ? (
        <div className="mt-4 overflow-auto rounded-[var(--radius-md)] border border-[var(--table-border)]">
          <table className="min-w-[980px] w-full text-sm">
            <thead className="bg-[var(--table-header-bg)]">
              <tr className="text-xs text-[var(--content-muted)]">
                <th className="border-b border-[var(--table-border)] px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide">Период</th>
                <th className="border-b border-[var(--table-border)] px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide">Артикул WB</th>
                <th className="border-b border-[var(--table-border)] px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide">Артикул продавца</th>
                <th className="border-b border-[var(--table-border)] px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wide">Выручка</th>
                <th className="border-b border-[var(--table-border)] px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wide">Приход</th>
                <th className="border-b border-[var(--table-border)] px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wide">Затраты</th>
                <th className="border-b border-[var(--table-border)] px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wide">Налог</th>
                <th className="border-b border-[var(--table-border)] px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wide">Итого к переводу</th>
                <th className="border-b border-[var(--table-border)] px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wide">Чистая прибыль</th>
                {financeShowBreakdown ? (
                  <>
                    <th className="border-b border-[var(--table-border)] px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wide">Логистика</th>
                    <th className="border-b border-[var(--table-border)] px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wide">Платная приемка</th>
                    <th className="border-b border-[var(--table-border)] px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wide">Хранение</th>
                    <th className="border-b border-[var(--table-border)] px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wide">Штрафы</th>
                    <th className="border-b border-[var(--table-border)] px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wide">Удержания</th>
                    <th className="border-b border-[var(--table-border)] px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wide">Доплаты</th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {finance.rows
                .filter((r) => {
                  const f = financeFilter.trim().toLowerCase();
                  if (!f) return true;
                  if (String(r.nmId).includes(f)) return true;
                  if ((r.vendorCode ?? '').toLowerCase().includes(f)) return true;
                  return false;
                })
                .sort((a, b) => {
                  const pick = (x: FinanceRow) => {
                    if (financeSort === 'income') return x.incomeFromSalesKopecks;
                    if (financeSort === 'costs') return x.costsKopecks;
                    if (financeSort === 'netTransfer') return x.netTransferKopecks;
                    return x.netProfitKopecks;
                  };
                  return pick(b) - pick(a);
                })
                .slice(0, 200)
                .map((r) => (
                  <tr key={`${r.dateFrom}|${r.dateTo}|${r.nmId}`} className="transition-colors hover:bg-[var(--table-row-hover)]">
                    <td className="border-b border-[var(--table-border)] px-3 py-2 font-mono text-[11px] text-[var(--content-muted)]">
                      {r.dateFrom}→{r.dateTo}
                    </td>
                    <td className="border-b border-[var(--table-border)] px-3 py-2 font-mono text-[11px] text-[var(--content-text)]"><NmIdLink nmId={r.nmId} /></td>
                    <td className="border-b border-[var(--table-border)] px-3 py-2 font-mono text-[11px] text-[var(--content-text)]">{r.vendorCode ?? '—'}</td>
                    <td className="border-b border-[var(--table-border)] px-3 py-2 text-right font-mono text-[11px] text-[var(--content-text)]">{formatRub(r.revenueKopecks / 100)}</td>
                    <td className="border-b border-[var(--table-border)] px-3 py-2 text-right font-mono text-[11px] text-[var(--content-text)]">{formatRub(r.incomeFromSalesKopecks / 100)}</td>
                    <td className="border-b border-[var(--table-border)] px-3 py-2 text-right font-mono text-[11px] text-[var(--content-text)]">{formatRub(r.costsKopecks / 100)}</td>
                    <td className="border-b border-[var(--table-border)] px-3 py-2 text-right font-mono text-[11px] text-[var(--content-text)]">{formatRub(r.taxKopecks / 100)}</td>
                    <td className="border-b border-[var(--table-border)] px-3 py-2 text-right font-mono text-[11px] text-[var(--content-text)]">{formatRub(r.netTransferKopecks / 100)}</td>
                    <td className="border-b border-[var(--table-border)] px-3 py-2 text-right font-mono text-[11px] text-[var(--content-text)]">{formatRub(r.netProfitKopecks / 100)}</td>
                    {financeShowBreakdown ? (
                      <>
                        <td className="border-b border-[var(--table-border)] px-3 py-2 text-right font-mono text-[11px] text-[var(--content-text)]">{formatRub(r.logisticsKopecks / 100)}</td>
                        <td className="border-b border-[var(--table-border)] px-3 py-2 text-right font-mono text-[11px] text-[var(--content-text)]">{formatRub(r.paidAcceptanceKopecks / 100)}</td>
                        <td className="border-b border-[var(--table-border)] px-3 py-2 text-right font-mono text-[11px] text-[var(--content-text)]">{formatRub(r.storageKopecks / 100)}</td>
                        <td className="border-b border-[var(--table-border)] px-3 py-2 text-right font-mono text-[11px] text-[var(--content-text)]">{formatRub(r.penaltiesKopecks / 100)}</td>
                        <td className="border-b border-[var(--table-border)] px-3 py-2 text-right font-mono text-[11px] text-[var(--content-text)]">{formatRub(r.otherHoldKopecks / 100)}</td>
                        <td className="border-b border-[var(--table-border)] px-3 py-2 text-right font-mono text-[11px] text-[var(--content-text)]">{formatRub(r.additionalPaymentsKopecks / 100)}</td>
                      </>
                    ) : null}
                  </tr>
                ))}
            </tbody>
          </table>
          <div className="border-t border-[var(--table-border)] px-3 py-2 text-[11px] text-[var(--content-muted)]">
            Показаны первые 50 строк. Всего: {finance.rows.length}. (WB limit: 1 запрос/мин)
          </div>
        </div>
      ) : (
        <div className="mt-4 text-[11px] text-[var(--content-muted)]">
          Нажми &quot;Загрузить&quot;, чтобы подтянуть weekly-отчёты WB по артикулам за выбранный период.
        </div>
      )}
    </Card>
  );
}
