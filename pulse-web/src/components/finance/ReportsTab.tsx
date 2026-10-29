'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/api';
import { RefreshCw, Download, FileText, ChevronRight } from 'lucide-react';
import { FinanceDatePicker } from './FinanceDatePicker';

interface ReportRow {
  reportId: number;
  sellerFinanceName?: string;
  dateFrom: string;
  dateTo: string;
  createDate: string;
  reportType: number;
  retailAmountRub: number;
  forPayRub: number;
  deliveryServiceRub: number;
  paidStorageRub: number;
  paidAcceptanceRub: number;
  deductionRub: number;
  penaltyRub: number;
  additionalPaymentRub: number;
  bankPaymentRub: number;
  advRub: number;
  cogsRub: number;
  taxRub: number;
  vatRub: number;
  marginRub: number;
}

interface Resp {
  start: string;
  end: string;
  count: number;
  reports: ReportRow[];
  totals: any;
}

function rub(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(n));
}

interface Props {
  workspaceId: number | null;
  shopId?: number;
  start: string;
  end: string;
  onDateChange?: (start: string, end: string) => void;
}

export function ReportsTab({ workspaceId, shopId, start, end, onDateChange }: Props) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | '1' | '2'>('all');
  const [syncing, setSyncing] = useState(false);

  const load = async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const p = new URLSearchParams({ start, end });
      if (shopId) p.set('shopId', String(shopId));
      const r = await apiFetch<Resp>(`/finance/${workspaceId}/reports?${p}`);
      setData(r);
    } catch (e) { console.error('reports', e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [workspaceId, shopId, start, end]);

  const sync = async () => {
    if (!workspaceId || !shopId) return;
    setSyncing(true);
    try {
      await apiFetch(`/finance/${workspaceId}/reports/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId, start, end }),
      });
      await load();
    } catch (e) { console.error('sync', e); }
    finally { setSyncing(false); }
  };

  const downloadCsv = () => {
    if (!data?.reports?.length) return;
    const h = 'reportId;dateFrom;dateTo;createDate;reportType;retail;forPay;delivery;storage;acceptance;deduction;penalty;additional;bankPay;adv;cogs';
    const lines = data.reports.map((r) => [
      r.reportId, r.dateFrom, r.dateTo, r.createDate, r.reportType,
      r.retailAmountRub, r.forPayRub, r.deliveryServiceRub, r.paidStorageRub,
      r.paidAcceptanceRub, r.deductionRub, r.penaltyRub, r.additionalPaymentRub,
      r.bankPaymentRub, r.advRub, r.cogsRub,
    ].join(';'));
    const blob = new Blob(['﻿' + [h, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `finance_reports_${start}_${end}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading && !data) {
    return <Card><CardContent className="p-6 text-sm text-gray-500">Загрузка…</CardContent></Card>;
  }

  const filtered = (data?.reports ?? []).filter((r) => filter === 'all' ? true : String(r.reportType) === filter);

  // Сводная пересчитывается ИЗ ОТФИЛЬТРОВАННЫХ строк — чтобы при выборе
  // «Основные» KPI показывали сумму только по основным отчётам, а не все.
  const t = filtered.reduce((acc, r) => ({
    retailAmountRub: acc.retailAmountRub + r.retailAmountRub,
    forPayRub: acc.forPayRub + r.forPayRub,
    deliveryServiceRub: acc.deliveryServiceRub + r.deliveryServiceRub,
    paidStorageRub: acc.paidStorageRub + r.paidStorageRub,
    paidAcceptanceRub: acc.paidAcceptanceRub + r.paidAcceptanceRub,
    deductionRub: acc.deductionRub + r.deductionRub,
    penaltyRub: acc.penaltyRub + r.penaltyRub,
    additionalPaymentRub: acc.additionalPaymentRub + r.additionalPaymentRub,
    bankPaymentRub: acc.bankPaymentRub + r.bankPaymentRub,
    advRub: acc.advRub + r.advRub,
    cogsRub: acc.cogsRub + r.cogsRub,
    taxRub: acc.taxRub + (r.taxRub ?? 0),
    vatRub: acc.vatRub + (r.vatRub ?? 0),
    marginRub: acc.marginRub + (r.marginRub ?? 0),
  }), {
    retailAmountRub: 0, forPayRub: 0, deliveryServiceRub: 0, paidStorageRub: 0,
    paidAcceptanceRub: 0, deductionRub: 0, penaltyRub: 0, additionalPaymentRub: 0,
    bankPaymentRub: 0, advRub: 0, cogsRub: 0,
    taxRub: 0, vatRub: 0, marginRub: 0,
  });

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <FileText className="h-5 w-5 text-indigo-600" />
              Отчёты ВБ (реализация)
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              {start} — {end} · {data?.count ?? 0} отчётов · Те же отчёты что в твоём личном кабинете ВБ → «Финансовые отчёты»
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {onDateChange && (
              <FinanceDatePicker
                dateFrom={start}
                dateTo={end}
                onDateFromChange={(s) => onDateChange(s, end)}
                onDateToChange={(e) => onDateChange(start, e)}
              />
            )}
            <Button variant="neutral" size="sm" onClick={sync} loading={syncing} disabled={!shopId}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> Обновить из ВБ
            </Button>
            <Button variant="neutral" size="sm" onClick={downloadCsv}>
              <Download className="h-3.5 w-3.5 mr-1" /> CSV
            </Button>
          </div>
        </div>

        {/* Totals */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <Stat label="Продажа" value={t.retailAmountRub ?? 0} />
          <Stat label="К перечислению (брутто)" value={t.forPayRub ?? 0} />
          <Stat label="Логистика" value={-(t.deliveryServiceRub ?? 0)} red />
          <Stat label="Хранение" value={-(t.paidStorageRub ?? 0)} red />
          <Stat label="Штрафы" value={-(t.penaltyRub ?? 0)} red />
          <Stat label="Прочие удерж." value={-(t.deductionRub ?? 0)} red />
          <Stat label="Корректировка ВВ" value={t.additionalPaymentRub ?? 0} />
          <Stat label="Реклама (в Прочих удерж.)" value={t.advRub ?? 0} />
          <Stat label="Себестоимость" value={-(t.cogsRub ?? 0)} red />
          <Stat label="Налог" value={-(t.taxRub ?? 0)} red />
          <Stat label="НДС" value={-(t.vatRub ?? 0)} red />
          <Stat label="Маржинальная прибыль" value={t.marginRub ?? 0} highlight />
          <Stat
            label="Маржинальность"
            value={(t.retailAmountRub ?? 0) > 0
              ? ((t.marginRub ?? 0) / (t.retailAmountRub ?? 1) * 100).toFixed(1) + '%'
              : '—'}
            highlight
            raw
          />
          <Stat label="Поступит на счёт (нетто)" value={t.bankPaymentRub ?? 0} />
        </div>

        {/* Filter */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">Тип отчёта:</span>
          {[
            { k: 'all' as const, l: 'Все' },
            { k: '1' as const, l: 'Основные' },
            { k: '2' as const, l: 'По выкупам' },
          ].map((o) => (
            <button
              key={o.k}
              onClick={() => setFilter(o.k)}
              className={'px-2 py-1 rounded ' + (filter === o.k ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-gray-500 hover:bg-gray-100')}
            >
              {o.l}
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr className="text-gray-600">
                <th className="px-2 py-2 text-left font-medium">№ отчёта</th>
                <th className="px-2 py-2 text-left font-medium">Дата</th>
                <th className="px-2 py-2 text-center font-medium">Тип</th>
                <th className="px-2 py-2 text-right font-medium">Продажа</th>
                <th className="px-2 py-2 text-right font-medium">Логистика</th>
                <th className="px-2 py-2 text-right font-medium">Хранение</th>
                <th className="px-2 py-2 text-right font-medium">Штрафы</th>
                <th className="px-2 py-2 text-right font-medium">Прочие</th>
                <th className="px-2 py-2 text-right font-medium">Реклама</th>
                <th className="px-2 py-2 text-right font-medium">Cогs</th>
                <th className="px-2 py-2 text-right font-medium">Налог</th>
                <th className="px-2 py-2 text-right font-medium">НДС</th>
                <th className="px-2 py-2 text-right font-medium">Итого к оплате</th>
                <th className="px-2 py-2 text-right font-medium bg-emerald-50">Маржинальная прибыль</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((r) => (
                <tr key={r.reportId} className="hover:bg-gray-50">
                  <td className="px-2 py-1.5 font-mono text-[10px] text-gray-500">{r.reportId}</td>
                  <td className="px-2 py-1.5 text-gray-700">{r.dateFrom}</td>
                  <td className="px-2 py-1.5 text-center">
                    <span className={'px-1.5 py-0.5 rounded text-[10px] ' + (r.reportType === 1 ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700')}>
                      {r.reportType === 1 ? 'Осн.' : r.reportType === 2 ? 'Выкуп.' : `Т${r.reportType}`}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-medium">{rub(r.retailAmountRub)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{rub(r.deliveryServiceRub)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{rub(r.paidStorageRub)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{r.penaltyRub ? rub(r.penaltyRub) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{r.deductionRub ? rub(r.deductionRub) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-amber-700">{r.advRub ? rub(r.advRub) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-amber-700">{r.cogsRub ? rub(r.cogsRub) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{r.taxRub ? rub(r.taxRub) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{r.vatRub ? rub(r.vatRub) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-700">{rub(r.bankPaymentRub)}</td>
                  <td className={'px-2 py-1.5 text-right tabular-nums font-semibold bg-emerald-50/40 ' + ((r.marginRub ?? 0) >= 0 ? 'text-emerald-700' : 'text-red-600')}>{rub(r.marginRub ?? 0)}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={14} className="px-2 py-6 text-center text-gray-500">
                    Нет отчётов. Кликни «Обновить из ВБ» — SigmaSeller подтянет за указанный период.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <details className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded p-2">
          <summary className="cursor-pointer font-medium">Что это за отчёты</summary>
          <div className="mt-2 space-y-1">
            <p>Каждая строка — один <strong>финансовый отчёт</strong> Wildberries (такой же, как в твоём ЛК ВБ в разделе «Финансовые отчёты»).</p>
            <p>ВБ выпускает два вида отчётов:</p>
            <ul className="list-disc list-inside ml-2">
              <li><strong>Основной</strong> — продажи и удержания за день.</li>
              <li><strong>По выкупам</strong> — отдельный отчёт по выкупленным товарам (момент, когда деньги становятся твоими).</li>
            </ul>
            <p><strong>Реклама</strong> и <strong>Себестоимость</strong> — это твои данные (расход на продвижение и закупочная цена). SigmaSeller подмешивает их к каждому отчёту, чтобы ты видел реальную чистую прибыль. В отчётах ВБ их нет.</p>
            <p className="mt-2 border-t border-gray-200 pt-2"><strong>«К перечислению (брутто)»</strong> — сумма после комиссии ВБ, но ДО маркетплейс-удержаний (логистика, хранение, штрафы, прочие). <strong>«Поступит на счёт (нетто)»</strong> — что реально придёт на расчётный счёт после всех удержаний. Разница = сумма удержаний.</p>
            <p className="mt-2 border-t border-gray-200 pt-2"><strong>«Реклама» уже включена в «Прочие удержания»</strong> — рекламные списания с paymentType=Баланс ВБ удерживает прямо из выручки и отражает в поле deduction финотчёта. Поэтому в формуле маржинальной прибыли реклама <strong>отдельно НЕ вычитается</strong> (иначе было бы задвоение). Плашка «Реклама» показывается как информация (сколько ушло на бидер) и используется для распределения по артикулам в табе «По артикулам».</p>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, red, highlight, raw }: { label: string; value: number | string; red?: boolean; highlight?: boolean; raw?: boolean }) {
  const numeric = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.-]/g, '')) || 0;
  const colorClass = highlight ? (numeric >= 0 ? 'text-emerald-700' : 'text-red-600') : red ? 'text-red-600' : 'text-gray-900';
  const display = raw ? String(value) : `${rub(typeof value === 'number' ? value : numeric)} ₽`;
  return (
    <div className={highlight ? 'rounded-md bg-emerald-50 border border-emerald-200 p-2' : 'rounded-md border border-gray-200 p-2'}>
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-base font-semibold ${colorClass}`}>{display}</div>
    </div>
  );
}
