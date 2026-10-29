'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { apiFetch } from '@/lib/api';
import { ArrowUpDown, Download, Package, AlertCircle } from 'lucide-react';
import {
  useTableSelection,
  type SelectionColumn,
} from '@/hooks/useTableSelection';
import { SelectionBar } from '@/components/table/SelectionBar';

interface Item {
  nmId: number;
  title: string;
  vendorCode: string;
  photo: string | null;
  lines: number;
  saleQty: number;
  returns: number;
  hasCogs: boolean;
  revenueRub: number;
  retailAmountRub: number;
  commissionRub: number;
  logisticsRub: number;
  storageRub: number;
  penaltyRub: number;
  acceptanceRub: number;
  acquiringRub: number;
  otherHoldRub: number;
  adjustmentRub: number;
  advRub: number;
  cogsRub: number;
  taxRub: number;
  vatRub: number;
  profitRub: number;
  marginPct: number;
}

interface Totals {
  revenueRub: number;
  retailAmountRub: number;
  commissionRub: number;
  logisticsRub: number;
  storageRub: number;
  penaltyRub: number;
  acceptanceRub: number;
  acquiringRub: number;
  otherHoldRub: number;
  adjustmentRub: number;
  advRub: number;
  cogsRub: number;
  taxRub: number;
  vatRub: number;
  profitRub: number;
  lines: number;
  saleQty: number;
  returns: number;
}

interface Unattributed {
  logisticsRub: number;
  storageRub: number;
  acceptanceRub: number;
  penaltyRub: number;
  deductionRub: number;
}

interface Resp {
  start: string;
  end: string;
  count: number;
  items: Item[];
  totals: Totals;
  unattributed?: Unattributed;
}

type SortKey = 'revenue' | 'penalty' | 'storage' | 'adv' | 'cogs' | 'profit' | 'commission' | 'logistics' | 'margin';
type FilterKey = 'all' | 'with_penalty' | 'with_storage' | 'with_adv' | 'without_cogs' | 'negative_profit';

const SORT_OPTIONS: { k: SortKey; l: string }[] = [
  { k: 'revenue', l: 'Выручка' },
  { k: 'profit', l: 'Прибыль' },
  { k: 'margin', l: 'Маржа %' },
  { k: 'penalty', l: 'Штрафы' },
  { k: 'storage', l: 'Хранение' },
  { k: 'adv', l: 'Реклама' },
  { k: 'cogs', l: 'Себестоимость' },
  { k: 'commission', l: 'Комиссия' },
  { k: 'logistics', l: 'Логистика' },
];

const FILTER_OPTIONS: { k: FilterKey; l: string }[] = [
  { k: 'all', l: 'Все артикулы' },
  { k: 'with_penalty', l: 'Со штрафами' },
  { k: 'with_storage', l: 'С хранением' },
  { k: 'with_adv', l: 'С рекламой' },
  { k: 'without_cogs', l: 'Без себестоимости' },
  { k: 'negative_profit', l: 'Убыточные' },
];

interface Props {
  workspaceId: number | null;
  shopId?: number;
  start: string;
  end: string;
}

type DateBasis = 'report' | 'sale';

const SEL_COLUMNS: SelectionColumn[] = [
  { key: 'saleQty',    label: 'Продаж',        unit: 'шт' },
  { key: 'revenue',    label: 'Выручка',       unit: '₽' },
  { key: 'profit',     label: 'Прибыль',       unit: '₽' },
  { key: 'margin',     label: 'Маржа',         unit: '%' },
  { key: 'penalty',    label: 'Штрафы',        unit: '₽' },
  { key: 'storage',    label: 'Хранение',      unit: '₽' },
  { key: 'adv',        label: 'Реклама',       unit: '₽' },
  { key: 'cogs',       label: 'Себестоимость', unit: '₽' },
  { key: 'commission', label: 'Комиссия',      unit: '₽' },
  { key: 'logistics',  label: 'Логистика',     unit: '₽' },
];

export function ByProductTab({ workspaceId, shopId, start, end }: Props) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('revenue');
  const [filterKey, setFilterKey] = useState<FilterKey>('all');
  const [dateBasis, setDateBasis] = useState<DateBasis>('report');

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    const params = new URLSearchParams({ start, end, sortBy: 'revenue', limit: '500', dateBasis });
    if (shopId) params.set('shopId', String(shopId));
    apiFetch<Resp>(`/finance/${workspaceId}/by-product?${params}`)
      .then(setData)
      .catch((e) => console.error('by-product', e))
      .finally(() => setLoading(false));
  }, [workspaceId, shopId, start, end, dateBasis]);

  const filtered = useMemo(() => {
    if (!data) return [];
    let arr = [...data.items];
    if (filterKey === 'with_penalty') arr = arr.filter((i) => i.penaltyRub > 0);
    if (filterKey === 'with_storage') arr = arr.filter((i) => i.storageRub > 0);
    if (filterKey === 'with_adv') arr = arr.filter((i) => i.advRub > 0);
    if (filterKey === 'without_cogs') arr = arr.filter((i) => !i.hasCogs);
    if (filterKey === 'negative_profit') arr = arr.filter((i) => i.profitRub < 0);
    arr.sort((a, b) => {
      const sortMap: Record<SortKey, number> = {
        revenue: b.revenueRub - a.revenueRub,
        profit: b.profitRub - a.profitRub,
        margin: b.marginPct - a.marginPct,
        penalty: b.penaltyRub - a.penaltyRub,
        storage: b.storageRub - a.storageRub,
        adv: b.advRub - a.advRub,
        cogs: b.cogsRub - a.cogsRub,
        commission: b.commissionRub - a.commissionRub,
        logistics: b.logisticsRub - a.logisticsRub,
      };
      return sortMap[sortKey];
    });
    return arr;
  }, [data, sortKey, filterKey]);

  const downloadCsv = () => {
    if (!data) return;
    const h = 'nmId;vendorCode;title;lines;returns;hasCogs;revenue;commission;logistics;storage;penalty;acceptance;acquiring;adv;cogs;tax;vat;profit;marginPct';
    const lines = data.items.map((r) =>
      [
        r.nmId, r.vendorCode, `"${r.title.replace(/"/g, '""')}"`, r.lines, r.returns, r.hasCogs ? 1 : 0,
        r.revenueRub, r.commissionRub, r.logisticsRub, r.storageRub, r.penaltyRub,
        r.acceptanceRub, r.acquiringRub, r.advRub, r.cogsRub, r.taxRub, r.vatRub, r.profitRub, r.marginPct,
      ].join(';'),
    );
    const blob = new Blob(['﻿' + [h, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `finance_by_product_${start}_${end}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Список отображаемых строк (учитывая slice 200). Селекция привязана к этим
  // индексам.
  const visibleRows = useMemo(() => filtered.slice(0, 200), [filtered]);

  const valueFor = (row: Item, col: string): number => {
    switch (col) {
      case 'saleQty':    return row.saleQty;
      case 'revenue':    return row.revenueRub;
      case 'profit':     return row.profitRub;
      case 'margin':     return row.marginPct;
      case 'penalty':    return row.penaltyRub;
      case 'storage':    return row.storageRub;
      case 'adv':        return row.advRub;
      case 'cogs':       return row.cogsRub;
      case 'commission': return row.commissionRub;
      case 'logistics':  return row.logisticsRub;
      default:           return 0;
    }
  };

  const sel = useTableSelection<Item>({
    rows: visibleRows,
    columns: SEL_COLUMNS,
    getValue: valueFor,
    resetDeps: [filterKey, sortKey, dateBasis, start, end, shopId],
  });

  if (loading && !data) return <Card><CardContent className="p-6 text-sm text-gray-500">Загрузка…</CardContent></Card>;
  if (!data) return null;

  const noCogsCount = data.items.filter((i) => !i.hasCogs).length;
  const t = data.totals;

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Финансы по артикулам</h2>
            <p className="text-xs text-gray-500 mt-1">
              {start} — {end} · {data.count} артикулов с продажами в периоде
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Date basis toggle */}
            <div className="inline-flex rounded-md border border-gray-200 bg-white text-xs overflow-hidden" title="По какой дате считать">
              <button
                onClick={() => setDateBasis('report')}
                className={'px-3 py-1.5 transition ' + (dateBasis === 'report' ? 'bg-violet-600 text-white' : 'text-gray-600 hover:bg-gray-100')}
                title="Дата формирования отчёта ВБ — совпадает с цифрами в ЛК ВБ"
              >
                По дате отчёта ВБ
              </button>
              <button
                onClick={() => setDateBasis('sale')}
                className={'px-3 py-1.5 transition ' + (dateBasis === 'sale' ? 'bg-violet-600 text-white' : 'text-gray-600 hover:bg-gray-100')}
                title="Дата покупки клиентом — для маркетинговой аналитики"
              >
                По дате продажи
              </button>
            </div>
            <Button variant="neutral" size="sm" onClick={downloadCsv}>
              <Download className="h-3.5 w-3.5 mr-1" /> Скачать CSV
            </Button>
          </div>
        </div>

        {/* Сводка по всем */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <Stat label="Выручка" value={t.revenueRub} />
          <Stat label="Комиссия" value={-t.commissionRub} red />
          <Stat label="Логистика" value={-t.logisticsRub} red />
          <Stat label="Хранение" value={-t.storageRub} red />
          <Stat label="Штрафы" value={-t.penaltyRub} red />
          <Stat label="Реклама" value={-t.advRub} red />
          <Stat label="Себестоимость" value={-t.cogsRub} red />
          <Stat label="Налог" value={-t.taxRub} red />
          {t.vatRub > 0 && <Stat label="НДС" value={-t.vatRub} red />}
          <Stat label="Чистая прибыль" value={t.profitRub} highlight />
          <Stat label="Маржа" value={t.retailAmountRub > 0 ? `${((t.profitRub / t.retailAmountRub) * 100).toFixed(1)}%` : '—'} highlight raw />
          <Stat label="Продаж (шт)" value={t.saleQty} raw />
          <Stat label="Возвратов" value={t.returns} raw />
        </div>

        {/* Инфо-плашка: какие расходы ВБ не привязал к артикулам и которые
            мы размазали по строкам пропорционально выручке каждого товара. */}
        {data?.unattributed && (
          (data.unattributed.logisticsRub > 0 ||
           data.unattributed.storageRub > 0 ||
           data.unattributed.acceptanceRub > 0 ||
           data.unattributed.penaltyRub > 0 ||
           data.unattributed.deductionRub > 0) && (
            <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-3">
              <div className="text-xs font-semibold text-blue-900 mb-2">
                ℹ Размазано по артикулам пропорционально выручке
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                {data.unattributed.logisticsRub > 0 && (
                  <div className="text-xs"><span className="text-gray-500">Логистика</span><div className="font-mono text-blue-800">{data.unattributed.logisticsRub.toLocaleString('ru-RU')} ₽</div></div>
                )}
                {data.unattributed.storageRub > 0 && (
                  <div className="text-xs"><span className="text-gray-500">Хранение</span><div className="font-mono text-blue-800">{data.unattributed.storageRub.toLocaleString('ru-RU')} ₽</div></div>
                )}
                {data.unattributed.acceptanceRub > 0 && (
                  <div className="text-xs"><span className="text-gray-500">Приёмка</span><div className="font-mono text-blue-800">{data.unattributed.acceptanceRub.toLocaleString('ru-RU')} ₽</div></div>
                )}
                {data.unattributed.penaltyRub > 0 && (
                  <div className="text-xs"><span className="text-gray-500">Штрафы</span><div className="font-mono text-blue-800">{data.unattributed.penaltyRub.toLocaleString('ru-RU')} ₽</div></div>
                )}
                {data.unattributed.deductionRub > 0 && (
                  <div className="text-xs"><span className="text-gray-500">Прочие удержания</span><div className="font-mono text-blue-800">{data.unattributed.deductionRub.toLocaleString('ru-RU')} ₽</div></div>
                )}
              </div>
              <div className="text-[10px] text-blue-700/80 mt-2">
                ВБ часть расходов в финансовом отчёте отдаёт без привязки к артикулу (хранение per склад, общие штрафы магазина, WB-продвижение).
                Эти суммы теперь автоматически разносятся по товарам пропорционально их доле в выручке —
                чтобы маржа «По артикулам» совпадала с итогом «Отчётов ВБ».
              </div>
            </div>
          )
        )}

        {/* Как считается — методология */}
        <details className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded p-2">
          <summary className="cursor-pointer font-medium text-gray-700">Как считаются цифры</summary>
          <ul className="mt-2 space-y-1 list-disc list-inside">
            <li>
              <span className="font-medium">Выручка</span> — сумма реализации по артикулу из ежедневного финансового отчёта ВБ.
              Деньги по выкупленным заказам с учётом СПП — те же цифры, что в xlsx-отчёте из ЛК ВБ.
            </li>
            <li>
              <span className="font-medium">Продаж (шт)</span> — фактическое количество проданных штук, не строк отчёта.
              Возвраты — отдельным счётчиком, учтены в выручке отрицательной строкой.
            </li>
            <li>
              <span className="font-medium">Себестоимость</span> — твоя цена закупа за единицу с{' '}
              <a href="/cogs" className="underline">страницы Себестоимость</a> × количество продаж за период.
              Если для артикула себестоимость не указана — рядом с артикулом будет ⚠ и она не вычитается из прибыли (= завышенная маржа).
            </li>
            <li>
              <span className="font-medium">Реклама</span> — фактические списания за продвижение в ЛК ВБ за период,
              распределённые между артикулами по показам и кликам. Совпадает с xlsx «История затрат» по итогу.
            </li>
            <li>
              <span className="font-medium">Прочие удержания</span> — компенсации, корректировки и взаимозачёты,
              которые ВБ начислил магазину, но не привязал к конкретному артикулу.
              Показываются отдельным блоком «Расходы без привязки к артикулам».
            </li>
            <li>
              <span className="font-medium">Налог + НДС</span> — берётся за период из «Отчётов ВБ» (с учётом регламента магазина: УСН 6%, УСН 15%, ОСНО),
              распределяется по артикулам пропорционально их выручке. Так сумма чистой прибыли по товарам совпадает с маржинальной прибылью в «Отчётах».
            </li>
            <li>
              <span className="font-medium">Чистая прибыль</span> = Выручка − Комиссия − Логистика − Хранение − Штрафы − Приёмка
              − Эквайринг − Реклама − Себестоимость − Налог − НДС.
            </li>
          </ul>
        </details>

        {noCogsCount > 0 && (
          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <div>
              <span className="font-medium">{noCogsCount} артикулов без себестоимости</span> в периоде — их «чистая прибыль» завышена,
              потому что закупка не учтена. Загрузите себестоимость на странице{' '}
              <a href="/cogs" className="underline">Себестоимость</a>.
            </div>
          </div>
        )}

        {/* Фильтр и сортировка */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-gray-500">Фильтр:</span>
          {FILTER_OPTIONS.map((o) => (
            <button
              key={o.k}
              onClick={() => setFilterKey(o.k)}
              className={'px-2 py-1 rounded ' + (filterKey === o.k ? 'bg-violet-100 text-violet-700 font-medium' : 'text-gray-500 hover:bg-gray-100')}
            >
              {o.l}
            </button>
          ))}
        </div>

        {/* Таблица */}
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 sticky top-0">
              <tr className="text-gray-600">
                <th className="px-2 py-2 text-left font-medium">Артикул</th>
                <th className="px-2 py-2 text-right font-medium" title="Количество продаж (шт) и возвратов">
                  Продаж
                </th>
                {SORT_OPTIONS.map((s) => (
                  <th
                    key={s.k}
                    onClick={() => setSortKey(s.k)}
                    className={'px-2 py-2 text-right font-medium cursor-pointer hover:bg-gray-100 ' + (sortKey === s.k ? 'bg-violet-100 text-violet-700' : '')}
                  >
                    <span className="inline-flex items-center gap-0.5">
                      {s.l}
                      <ArrowUpDown className="h-3 w-3" />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visibleRows.map((r, idx) => {
                const cellCls = (col: string, extra = '') =>
                  'px-2 py-1.5 text-right tabular-nums cursor-pointer select-none transition-colors ' +
                  (sel.isSelected(col, idx) ? 'bg-violet-200 ring-1 ring-inset ring-violet-500 ' : 'hover:bg-violet-50 ') +
                  extra;
                return (
                  <tr key={r.nmId} className={r.profitRub < 0 ? 'bg-red-50/30' : ''}>
                    <td className="px-2 py-1.5 max-w-[260px]">
                      <div className="flex items-center gap-2">
                        {r.photo ? (
                          <img src={r.photo} alt="" className="w-20 h-20 object-cover rounded flex-shrink-0" />
                        ) : (
                          <div className="w-20 h-20 bg-gray-100 rounded flex items-center justify-center flex-shrink-0">
                            <Package className="h-8 w-8 text-gray-400" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="font-mono text-[10px] text-gray-500 flex items-center gap-1">
                            <NmIdLink nmId={r.nmId} />
                            {!r.hasCogs && <span className="text-amber-700" title="Нет себестоимости">⚠</span>}
                          </div>
                          <div className="truncate text-gray-700">{r.title || r.vendorCode || '—'}</div>
                        </div>
                      </div>
                    </td>
                    <td className={cellCls('saleQty')} onClick={(e) => sel.handleClick('saleQty', idx, e)}>
                      <span className="font-medium">{r.saleQty}</span>
                      {r.returns > 0 && <span className="text-red-500 text-[10px] ml-1">−{r.returns}</span>}
                    </td>
                    <td className={cellCls('revenue', 'font-medium')} onClick={(e) => sel.handleClick('revenue', idx, e)}>
                      {r.revenueRub.toLocaleString('ru-RU')}
                    </td>
                    <td
                      className={cellCls('profit', 'font-medium ' + (r.profitRub > 0 ? 'text-emerald-700' : r.profitRub < 0 ? 'text-red-600' : ''))}
                      onClick={(e) => sel.handleClick('profit', idx, e)}
                    >
                      {r.profitRub.toLocaleString('ru-RU')}
                    </td>
                    <td className={cellCls('margin')} onClick={(e) => sel.handleClick('margin', idx, e)}>
                      {r.marginPct}%
                    </td>
                    <td className={cellCls('penalty')} onClick={(e) => sel.handleClick('penalty', idx, e)}>
                      {r.penaltyRub > 0 ? r.penaltyRub.toLocaleString('ru-RU') : '—'}
                    </td>
                    <td className={cellCls('storage')} onClick={(e) => sel.handleClick('storage', idx, e)}>
                      {r.storageRub > 0 ? r.storageRub.toLocaleString('ru-RU') : '—'}
                    </td>
                    <td className={cellCls('adv')} onClick={(e) => sel.handleClick('adv', idx, e)}>
                      {r.advRub > 0 ? r.advRub.toLocaleString('ru-RU') : '—'}
                    </td>
                    <td className={cellCls('cogs')} onClick={(e) => sel.handleClick('cogs', idx, e)}>
                      {r.cogsRub > 0 ? r.cogsRub.toLocaleString('ru-RU') : '—'}
                    </td>
                    <td className={cellCls('commission')} onClick={(e) => sel.handleClick('commission', idx, e)}>
                      {r.commissionRub.toLocaleString('ru-RU')}
                    </td>
                    <td className={cellCls('logistics')} onClick={(e) => sel.handleClick('logistics', idx, e)}>
                      {r.logisticsRub.toLocaleString('ru-RU')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length > 200 && (
            <div className="text-xs text-gray-500 mt-2 px-2">
              Показано первые 200 из {filtered.length}. Полный список — CSV.
            </div>
          )}
          {filtered.length === 0 && (
            <div className="text-sm text-gray-500 text-center py-8">
              Нет данных под выбранный фильтр.
            </div>
          )}
          <div className="text-[10px] text-gray-400 mt-2 px-2">
            Подсказка: клик по числовой ячейке выделяет её. Shift-клик — диапазон,
            Ctrl/⌘-клик — добавить/убрать. Esc — сбросить.
          </div>
        </div>
      </CardContent>

      <SelectionBar col={sel.selColMeta} stats={sel.stats} onClear={sel.clear} />
    </Card>
  );
}

function Stat({ label, value, red, highlight, raw }: { label: string; value: number | string; red?: boolean; highlight?: boolean; raw?: boolean }) {
  const colorClass = highlight ? (Number(value) >= 0 ? 'text-emerald-700' : 'text-red-600') : red ? 'text-red-600' : 'text-gray-900';
  return (
    <div className={highlight ? 'rounded-md bg-violet-50 border border-violet-200 p-2' : 'rounded-md border border-gray-200 p-2'}>
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-base font-semibold ${colorClass}`}>
        {raw ? value : (typeof value === 'number' ? value.toLocaleString('ru-RU') + ' ₽' : value)}
      </div>
    </div>
  );
}
