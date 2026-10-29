'use client';

import { useShopChange } from '@/hooks/useShopChange';
import { useShopParam } from '@/hooks/useShopParam';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { formatRub, formatNumber } from '@/lib/format';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';

import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { Paywall } from '@/components/Paywall';
import { useWorkspaceStore } from '@/store/workspace';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';
import { Combobox } from '@/components/ui/Combobox';
import { cn } from '@/lib/cn';
import {
  useTableSelection,
  type SelectionColumn,
} from '@/hooks/useTableSelection';
import { SelectionBar } from '@/components/table/SelectionBar';

const UNIT_ECO_SEL_COLUMNS: SelectionColumn[] = [
  { key: 'qty',        label: 'Кол-во',       unit: 'шт' },
  { key: 'revenue',    label: 'Выручка',      unit: '₽' },
  { key: 'commission', label: 'Комиссия',     unit: '₽' },
  { key: 'logistics',  label: 'Логистика',    unit: '₽' },
  { key: 'cogs',       label: 'Себестоимость', unit: '₽' },
  { key: 'tax',        label: 'Налог',        unit: '₽' },
  { key: 'profit',     label: 'Прибыль',      unit: '₽' },
  { key: 'margin',     label: 'Маржа',        unit: '%' },
];

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type TabKey = 'all' | 'calculator' | 'single';

type AllProductRow = {
  nmId: number;
  vendorCode: string | null;
  title: string | null;
  qty: number;
  revenueRub: number;
  commissionRub: number;
  logisticsRub: number;
  storageRub: number;
  cogsRub: number;
  taxRub: number;
  profitRub: number;
  marginPct: number;
  drrPct: number;
};

type SortKey = 'revenue' | 'profit' | 'margin' | 'cogs' | 'qty';

type UnitEcoRow = {
  bucketStart: string;
  bucketEnd: string;
  salesModel?: 'fbo' | 'fbs';
  nmId: number;
  vendorCode: string | null;
  subjectId: number | null;
  baseBuyoutSum: number;
  buyoutCount: number;
  segments: {
    buyerPriceRub?: number;
    sppRub?: number;
    commissionRub: number;
    acquiringRub: number;
    logisticsRub: number;
    cogsRub: number;
    taxRub: number;
    profitRub: number;
    pct?: {
      buyerPrice?: number;
      spp?: number;
      commission: number;
      acquiring: number;
      logistics: number;
      cogs: number;
      tax: number;
      profit: number;
    };
  };
  fact?: {
    logisticsRub?: number;
  } | null;
  meta: {
    commissionPct: number;
    acquiringRate: number;
    taxRate: number;
    volumeLiters: number | null;
    logisticsModel: string;
    logisticsPerUnitRub: number | null;
    cogsPerUnitRub?: number;
  };
};

type UnitEcoResponse = {
  workspaceId: number;
  start: string;
  end: string;
  mergeWeeks: boolean;
  mergeProducts: boolean;
  taxRate: number;
  acquiringRate: number;
  rows: UnitEcoRow[];
};

type SubjectItem = {
  subjectId: number;
  subjectName: string;
  commissionPct: number;
};

type TaxRegime = 'income' | 'income_minus_expenses' | 'ausn8' | 'ausn20' | 'osno' | 'patent';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

const inputCls =
  'mt-1 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-500 transition-all duration-200';

const selectCls =
  'mt-1 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-500 transition-all duration-200';

function rub(n: number): string {
  if (!Number.isFinite(n)) return '---';
  return formatRub(Math.round(n)) + ' ₽';
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return '---';
  return n.toFixed(1) + '%';
}

/* ------------------------------------------------------------------ */
/*  Tab 1 - All Products Table                                         */
/* ------------------------------------------------------------------ */

function AllProductsTable({
  workspaceId,
  setWorkspaceId,
  start,
  end,
  setStart,
  setEnd,
}: {
  workspaceId: number | null;
  setWorkspaceId: (v: number) => void;
  start: string;
  end: string;
  setStart: (v: string) => void;
  setEnd: (v: string) => void;
}) {
  const shopParam = useShopParam();
  const [rows, setRows] = useState<AllProductRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('revenue');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [filterUnprofitable, setFilterUnprofitable] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // Inline price editing state
  const [editedPrices, setEditedPrices] = useState<Record<number, number>>({});
  const [applyingPrices, setApplyingPrices] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    apiFetch(
      `/unit-economics/${workspaceId}/all?start=${start}&end=${end}&sortBy=${sortBy}&sortOrder=${sortOrder}&limit=100${shopParam}`
    )
      .then((res: any) => {
        // BE отдаёт salesQty/netProfitRub/totalTaxRub — таблица читает qty/profitRub/taxRub.
        // Нормализуем на границе, чтобы не плодить рассинхрон по всему компоненту.
        const rows: AllProductRow[] = (res.rows ?? []).map((r: any) => ({
          nmId: r.nmId,
          vendorCode: r.vendorCode ?? null,
          title: r.title ?? null,
          qty: Number(r.qty ?? r.salesQty ?? 0),
          revenueRub: Number(r.revenueRub ?? 0),
          commissionRub: Number(r.commissionRub ?? 0),
          logisticsRub: Number(r.logisticsRub ?? 0),
          storageRub: Number(r.storageRub ?? 0),
          cogsRub: Number(r.cogsRub ?? 0),
          taxRub: Number(r.taxRub ?? r.totalTaxRub ?? 0),
          profitRub: Number(r.profitRub ?? r.netProfitRub ?? 0),
          marginPct: Number(r.marginPct ?? 0),
          drrPct: Number(r.drrPct ?? 0),
        }));
        setRows(rows);
        setTotal(res.total ?? 0);
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [workspaceId, start, end, sortBy, sortOrder, shopParam]);

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc');
    } else {
      setSortBy(key);
      setSortOrder('desc');
    }
  };

  const displayRows = useMemo(() => {
    if (!filterUnprofitable) return rows;
    return rows.filter((r) => r.marginPct < 0);
  }, [rows, filterUnprofitable]);

  const sel = useTableSelection<AllProductRow>({
    rows: displayRows,
    columns: UNIT_ECO_SEL_COLUMNS,
    getValue: (row, col) => {
      switch (col) {
        case 'qty':        return row.qty;
        case 'revenue':    return row.revenueRub;
        case 'commission': return row.commissionRub;
        case 'logistics':  return row.logisticsRub;
        case 'cogs':       return row.cogsRub;
        case 'tax':        return row.taxRub;
        case 'profit':     return row.profitRub;
        case 'margin':     return row.marginPct;
        default:           return 0;
      }
    },
    resetDeps: [sortBy, sortOrder, filterUnprofitable, start, end, shopParam],
  });

  const handlePriceChange = (nmId: number, newPrice: number) => {
    setEditedPrices((prev) => ({ ...prev, [nmId]: newPrice }));
  };

  const computeForecastProfit = (row: AllProductRow, newPrice: number): number => {
    if (!newPrice || newPrice <= 0) return row.profitRub;
    const oldPrice = row.qty > 0 ? row.revenueRub / row.qty : 0;
    if (oldPrice <= 0) return row.profitRub;
    const ratio = newPrice / oldPrice;
    const newRevenue = row.revenueRub * ratio;
    const newCommission = row.commissionRub * ratio;
    const newProfit = newRevenue - newCommission - row.logisticsRub - row.storageRub - row.cogsRub - row.taxRub;
    return newProfit;
  };

  const hasEditedPrices = Object.keys(editedPrices).length > 0;

  const handleApplyPrices = async () => {
    if (!workspaceId || !hasEditedPrices) return;
    setApplyingPrices(true);
    try {
      const data = Object.entries(editedPrices).map(([nmId, price]) => ({
        nmID: Number(nmId),
        price,
      }));
      await apiFetch(`/prices/${workspaceId}/upload${shopParam ? `?${shopParam.slice(1)}` : ''}`, {
        method: 'POST',
        body: JSON.stringify({ data }),
      });
      setEditedPrices({});
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось применить цены');
    } finally {
      setApplyingPrices(false);
    }
  };

  const SortHeader = ({ label, sortKey }: { label: string; sortKey: SortKey }) => (
    <th
      className="py-3 px-3 text-right font-medium cursor-pointer hover:bg-gray-50 select-none whitespace-nowrap"
      onClick={() => handleSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortBy === sortKey && (
          <span className="text-indigo-500">{sortOrder === 'desc' ? '\u2193' : '\u2191'}</span>
        )}
      </span>
    </th>
  );

  const exportCsv = () => {
    const header = [
      'Артикул',
      'Код',
      'Товар',
      'Кол-во',
      'Выручка',
      'Комиссия',
      'Логистика',
      'Хранение',
      'Себест.',
      'Налог',
      'Прибыль',
      'Маржа %',
    ];
    const csvRows = rows.map((r) => [
      r.nmId,
      r.vendorCode ?? '',
      r.title ?? '',
      r.qty,
      r.revenueRub,
      r.commissionRub,
      r.logisticsRub,
      r.storageRub ?? 0,
      r.cogsRub,
      r.taxRub,
      r.profitRub,
      r.marginPct,
    ]);
    const csv = [header, ...csvRows].map((row) => row.join(';')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `unit-economics-${start}-${end}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="p-5">
      {error && (
        <div className="mb-3 rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 ml-2">✕</button>
        </div>
      )}
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-sm font-semibold text-gray-900">
            Юнит-экономика всех товаров
          </div>
          <p className="text-xs text-gray-500">
            Сводная таблица по {total} товарам за период
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasEditedPrices && (
            <Button
              variant="primary"
              size="sm"
              onClick={handleApplyPrices}
              loading={applyingPrices}
            >
              Применить цены ({Object.keys(editedPrices).length})
            </Button>
          )}
          <Button variant="neutral" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
            Экспорт CSV
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-4 mb-4 flex-wrap">
        <DateRangePicker
          dateFrom={start}
          dateTo={end}
          onDateFromChange={setStart}
          onDateToChange={setEnd}
        />
        <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={filterUnprofitable}
            onChange={(e) => setFilterUnprofitable(e.target.checked)}
            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          Только убыточные
        </label>
      </div>

      {loading ? (
        <div className="text-sm text-gray-500 text-center py-12">Загрузка...</div>
      ) : displayRows.length === 0 ? (
        <div className="text-sm text-gray-500 text-center py-12 border border-dashed border-gray-200 rounded-lg">
          {filterUnprofitable ? 'Нет убыточных товаров' : 'Нет данных за выбранный период'}
        </div>
      ) : (
        <div className="overflow-auto -mx-5 px-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500">
                <th className="py-3 px-3 text-left font-medium">Товар</th>
                <SortHeader label="Кол-во" sortKey="qty" />
                <SortHeader label="Выручка" sortKey="revenue" />
                <th className="py-3 px-3 text-right font-medium">Комиссия</th>
                <th className="py-3 px-3 text-right font-medium">Логистика</th>
                <SortHeader label="Себест." sortKey="cogs" />
                <th className="py-3 px-3 text-right font-medium">Налог</th>
                <SortHeader label="Прибыль" sortKey="profit" />
                <SortHeader label="Маржа" sortKey="margin" />
                <th className="py-3 px-3 text-right font-medium whitespace-nowrap">Новая цена</th>
                <th className="py-3 px-3 text-right font-medium whitespace-nowrap">Прогноз прибыли</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((r, idx) => {
                const edited = editedPrices[r.nmId];
                const forecast =
                  edited !== undefined ? computeForecastProfit(r, edited) : null;
                const selCellCls = (col: string, extra = '') =>
                  cn(
                    'py-2.5 px-3 text-right tabular-nums cursor-pointer select-none transition-colors',
                    sel.isSelected(col, idx)
                      ? 'bg-violet-200 ring-1 ring-inset ring-violet-500'
                      : 'hover:bg-violet-50',
                    extra,
                  );

                return (
                  <tr
                    key={r.nmId}
                    className={cn(
                      'border-b border-gray-100 transition-colors',
                      r.marginPct < 0 && 'bg-red-50/40'
                    )}
                  >
                    <td className="py-2.5 px-3">
                      <div className="font-medium text-gray-900">
                        <NmIdLink nmId={r.nmId}>{r.vendorCode || r.nmId}</NmIdLink>
                      </div>
                      {r.title && (
                        <div className="text-xs text-gray-500 truncate max-w-[200px]">
                          {r.title}
                        </div>
                      )}
                    </td>
                    <td className={selCellCls('qty')} onClick={(e) => sel.handleClick('qty', idx, e)}>{r.qty}</td>
                    <td className={selCellCls('revenue')} onClick={(e) => sel.handleClick('revenue', idx, e)}>
                      {formatRub(r.revenueRub)}
                    </td>
                    <td className={selCellCls('commission', 'text-amber-700')} onClick={(e) => sel.handleClick('commission', idx, e)}>
                      {formatRub(r.commissionRub)}
                    </td>
                    <td className={selCellCls('logistics', 'text-purple-600')} onClick={(e) => sel.handleClick('logistics', idx, e)}>
                      {formatRub(r.logisticsRub)}
                    </td>
                    <td className={selCellCls('cogs', 'text-blue-600')} onClick={(e) => sel.handleClick('cogs', idx, e)}>
                      {formatRub(r.cogsRub)}
                    </td>
                    <td className={selCellCls('tax', 'text-orange-700')} onClick={(e) => sel.handleClick('tax', idx, e)}>
                      {formatRub(r.taxRub)}
                    </td>
                    <td
                      className={selCellCls(
                        'profit',
                        'font-medium ' + (r.profitRub >= 0 ? 'text-emerald-600' : 'text-rose-600'),
                      )}
                      onClick={(e) => sel.handleClick('profit', idx, e)}
                    >
                      {formatRub(r.profitRub)}
                    </td>
                    <td
                      className={selCellCls(
                        'margin',
                        r.marginPct >= 20
                          ? 'text-emerald-600'
                          : r.marginPct >= 10
                            ? 'text-amber-700'
                            : 'text-rose-600',
                      )}
                      onClick={(e) => sel.handleClick('margin', idx, e)}
                    >
                      {r.marginPct.toFixed(1)}%
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        placeholder="---"
                        value={edited ?? ''}
                        onChange={(e) =>
                          handlePriceChange(r.nmId, Number(e.target.value))
                        }
                        className="w-24 rounded-lg border border-gray-200 bg-white px-2 py-1 text-right text-sm tabular-nums outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-500"
                      />
                    </td>
                    <td
                      className={cn(
                        'py-2.5 px-3 text-right tabular-nums font-medium',
                        forecast !== null
                          ? forecast >= 0
                            ? 'text-emerald-600'
                            : 'text-rose-600'
                          : 'text-gray-500'
                      )}
                    >
                      {forecast !== null ? formatRub(forecast) : '---'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="text-[10px] text-gray-400 mt-2 px-2">
            Подсказка: клик по числовой ячейке выделяет её. Shift-клик — диапазон,
            Ctrl/⌘-клик — добавить/убрать. Esc — сбросить.
          </div>
        </div>
      )}
      <SelectionBar col={sel.selColMeta} stats={sel.stats} onClear={sel.clear} />
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 2 - Calculator                                                 */
/* ------------------------------------------------------------------ */

function CalculatorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900 border-b border-gray-100 pb-2">
        {title}
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">{children}</div>
    </div>
  );
}

function CalcField({
  label,
  value,
  onChange,
  suffix,
  readOnly,
  placeholder,
  highlight,
  type = 'number',
}: {
  label: string;
  value: number | string;
  onChange?: (v: number) => void;
  suffix?: string;
  readOnly?: boolean;
  placeholder?: string;
  highlight?: boolean;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500">{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <input
          type={type}
          step="any"
          min={0}
          value={value}
          readOnly={readOnly}
          placeholder={placeholder ?? '0'}
          onChange={(e) => onChange?.(Number(e.target.value))}
          className={cn(
            'w-full rounded-xl border px-3 py-2 text-sm outline-none transition-all duration-200',
            readOnly
              ? 'border-gray-200 bg-gray-50 text-gray-600 cursor-default'
              : 'border-gray-300 bg-white text-gray-900 focus:ring-2 focus:ring-indigo-200 focus:border-indigo-500',
            highlight && 'border-indigo-300 bg-indigo-50/50'
          )}
        />
        {suffix && <span className="text-xs text-gray-500 whitespace-nowrap">{suffix}</span>}
      </div>
    </div>
  );
}

function CalcFieldDual({
  label,
  pctValue,
  rubValue,
  onPctChange,
  pctReadOnly,
  pctSuffix,
  rubSuffix,
}: {
  label: string;
  pctValue: number | string;
  rubValue: number | string;
  onPctChange?: (v: number) => void;
  pctReadOnly?: boolean;
  pctSuffix?: string;
  rubSuffix?: string;
}) {
  return (
    <div className="sm:col-span-2 lg:col-span-3">
      <label className="block text-xs font-medium text-gray-500">{label}</label>
      <div className="mt-1 flex items-center gap-3">
        <div className="flex items-center gap-2 flex-1">
          <input
            type="number"
            step="any"
            min={0}
            value={pctValue}
            readOnly={pctReadOnly}
            onChange={(e) => onPctChange?.(Number(e.target.value))}
            className={cn(
              'w-24 rounded-xl border px-3 py-2 text-sm outline-none transition-all duration-200',
              pctReadOnly
                ? 'border-gray-200 bg-gray-50 text-gray-600 cursor-default'
                : 'border-gray-300 bg-white text-gray-900 focus:ring-2 focus:ring-indigo-200 focus:border-indigo-500'
            )}
          />
          <span className="text-xs text-gray-500">{pctSuffix ?? '%'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">В рублях:</span>
          <span className="text-sm font-medium text-gray-900 tabular-nums min-w-[80px] text-right">
            {typeof rubValue === 'number' ? rub(rubValue) : rubValue}
          </span>
        </div>
      </div>
    </div>
  );
}

function WbCalculator({ workspaceId }: { workspaceId: number }) {
  const shopParam = useShopParam();
  // --- Your product ---
  const [subjects, setSubjects] = useState<SubjectItem[]>([]);
  const [subjectId, setSubjectId] = useState<string>('');
  const [commissionPctFromSubject, setCommissionPctFromSubject] = useState(0);
  const [price, setPrice] = useState(0);
  const [costPrice, setCostPrice] = useState(0);

  // --- Fulfillment ---
  const [logFromManufacturer, setLogFromManufacturer] = useState(0);
  const [packaging, setPackaging] = useState(0);
  const [logToMP, setLogToMP] = useState(0);
  const [fulfillmentService, setFulfillmentService] = useState(0);
  const [packagingCostPerUnit, setPackagingCostPerUnit] = useState(0);

  // --- Marketplace ---
  const [warehouseId, setWarehouseId] = useState('default');
  const [commissionPct, setCommissionPct] = useState(0);
  const [lengthCm, setLengthCm] = useState(0);
  const [widthCm, setWidthCm] = useState(0);
  const [heightCm, setHeightCm] = useState(0);
  const [weightKg, setWeightKg] = useState(0);
  const [defectPct, setDefectPct] = useState(2);
  const [storagePerDay, setStoragePerDay] = useState(0);
  const [buyoutPct, setBuyoutPct] = useState(80);

  // --- Taxes ---
  const [taxRegime, setTaxRegime] = useState<TaxRegime>('income');
  const [taxRate, setTaxRate] = useState(6);

  // --- Other ---
  const [otherExpenses, setOtherExpenses] = useState(0);

  // --- Batch ---
  const [batchSize, setBatchSize] = useState(100);

  // Load subjects
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    apiFetch(`/unit-economics/${workspaceId}/subjects${shopParam ? `?${shopParam.slice(1)}` : ''}`)
      .then((res: any) => {
        if (!alive) return;
        const items: SubjectItem[] = res.subjects ?? res.rows ?? res ?? [];
        setSubjects(Array.isArray(items) ? items : []);
      })
      .catch(() => {
        if (alive) setSubjects([]);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, shopParam]);

  // Update commission when subject changes
  useEffect(() => {
    if (!subjectId) return;
    const found = subjects.find((s) => String(s.subjectId) === subjectId);
    if (found) {
      setCommissionPctFromSubject(found.commissionPct);
      setCommissionPct(found.commissionPct);
    }
  }, [subjectId, subjects]);

  // Update tax rate when regime changes
  useEffect(() => {
    const defaults: Record<TaxRegime, number> = { income: 6, income_minus_expenses: 15, ausn8: 8, ausn20: 20, osno: 20, patent: 0 };
    setTaxRate(defaults[taxRegime] ?? 15);
  }, [taxRegime]);

  // --- Calculations ---
  const volumeLiters = (lengthCm * widthCm * heightCm) / 1000;
  // WB formula: volumetric weight = volume(L) / 5, then take max of volumetric vs actual
  const volumeWeight = Math.max(volumeLiters / 5, weightKg);

  // Logistics cost estimate (simplified WB tariff, adjusted by warehouse)
  const logisticsCostRub = useMemo(() => {
    if (volumeWeight <= 0) return 0;
    // Base rate roughly matching WB tariff structure
    const baseRate = 33;
    const perLiter = 6;
    // Warehouse coefficient: regional warehouses have different tariffs
    const warehouseCoeff: Record<string, number> = {
      default: 1.0, msk: 1.0, msk2: 1.0,
      spb: 1.05, kzn: 1.08, ekb: 1.1,
      nsk: 1.15, krd: 1.05,
    };
    const coeff = warehouseCoeff[warehouseId] ?? 1.0;
    return Math.round((baseRate + perLiter * Math.max(0, volumeWeight - 1)) * coeff);
  }, [volumeWeight, warehouseId]);

  const fulfillmentTotal = fulfillmentService + packagingCostPerUnit;

  const commissionRub = price * commissionPct / 100;

  const defectRub = price * defectPct / 100;

  const logisticsWithBuyout = buyoutPct > 0 ? logisticsCostRub / (buyoutPct / 100) : logisticsCostRub;

  const storageRub = storagePerDay;

  // DRR (ad costs etc.) = otherExpenses as % or direct rub
  const drrRub = otherExpenses;

  // Total marketplace deductions
  const totalMPDeductions = commissionRub + logisticsWithBuyout + storageRub + defectRub + drrRub;

  // Transfer to seller
  const toTransfer = price - totalMPDeductions;

  // Tax calculation
  const taxAmount = useMemo(() => {
    if (taxRegime === 'income' || taxRegime === 'ausn8') {
      return price * taxRate / 100;
    }
    // income_minus_expenses / ausn20 / osno — tax from profit
    return Math.max(0, toTransfer) * taxRate / 100;
  }, [taxRegime, price, toTransfer, taxRate]);

  const revenueAfterTax = toTransfer - taxAmount;

  // Investment per unit
  const investment = costPrice + logFromManufacturer + packaging + logToMP + fulfillmentTotal;

  // Gross profit (marginal profit)
  const grossProfit = revenueAfterTax - investment;

  // Markup
  const markup = costPrice > 0 ? price / costPrice : 0;

  // Margin (profitability by price)
  const marginPct = price > 0 ? (grossProfit / price) * 100 : 0;

  // ROI (profitability by investment)
  const roiPct = investment > 0 ? (grossProfit / investment) * 100 : 0;

  // Minimum price (profit = 0 scenario)
  const minPrice = useMemo(() => {
    // We need to find price P such that grossProfit = 0
    // grossProfit = revenueAfterTax - investment
    // revenueAfterTax = toTransfer - taxAmount
    // For 'income' tax: taxAmount = P * taxRate / 100
    // toTransfer = P - (P * commPct/100 + logisticsWithBuyout + storageRub + P*defectPct/100 + drrRub)
    // = P * (1 - commPct/100 - defectPct/100) - logisticsWithBuyout - storageRub - drrRub
    // For 'income': revAfterTax = P*(1-comm/100-defect/100) - logWithBuyout - storage - drr - P*taxRate/100
    // = P*(1-comm/100-defect/100-taxRate/100) - logWithBuyout - storage - drr
    // grossProfit = above - investment = 0
    // P*(1-comm/100-defect/100-taxRate/100) = investment + logWithBuyout + storage + drr
    // P = (investment + logWithBuyout + storage + drr) / (1 - comm/100 - defect/100 - taxRate/100)

    const fixedCosts = investment + logisticsWithBuyout + storageRub + drrRub;

    if (taxRegime === 'income' || taxRegime === 'ausn8') {
      const coeff = 1 - commissionPct / 100 - defectPct / 100 - taxRate / 100;
      if (coeff <= 0) return 0;
      return fixedCosts / coeff;
    }

    // For 'income_minus_expenses':
    // toTransfer = P*(1 - comm/100 - defect/100) - logWithBuyout - storage - drr
    // taxAmount = max(0, toTransfer) * taxRate / 100
    // revAfterTax = toTransfer * (1 - taxRate/100)
    // grossProfit = toTransfer*(1-taxRate/100) - investment = 0
    // toTransfer = investment / (1-taxRate/100)
    // P*(1-comm/100-defect/100) - logWithBuyout - storage - drr = investment / (1-taxRate/100)
    // P = (investment/(1-taxRate/100) + logWithBuyout + storage + drr) / (1-comm/100-defect/100)

    const taxMultiplier = 1 - taxRate / 100;
    if (taxMultiplier <= 0) return 0;
    const numerator = investment / taxMultiplier + logisticsWithBuyout + storageRub + drrRub;
    const denominator = 1 - commissionPct / 100 - defectPct / 100;
    if (denominator <= 0) return 0;
    return numerator / denominator;
  }, [
    investment,
    logisticsWithBuyout,
    storageRub,
    drrRub,
    commissionPct,
    defectPct,
    taxRate,
    taxRegime,
  ]);

  // Max discount
  const maxDiscountPct = price > 0 ? (1 - minPrice / price) * 100 : 0;

  // Batch calculations
  const batchInvestment = investment * batchSize;
  const batchProfit = grossProfit * batchSize;
  const batchRevenue = price * batchSize;

  return (
    <div className="space-y-6">
      {/* Results Bar - sticky on top, visible while scrolling inputs */}
      <div className="sticky top-0 z-20">
        <Card className="p-0 shadow-xl border-indigo-200">
          <div className="px-5 py-4">
            <div className="text-xs font-semibold text-gray-500 mb-3">
              Итоговые значения за 1 ед.
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              {/* Investment */}
              <div>
                <div className="text-[11px] text-gray-500 uppercase tracking-wide">Инвестиции</div>
                <div className="mt-1 text-lg font-bold text-gray-900 tabular-nums">
                  {rub(investment)}
                </div>
              </div>

              {/* ROI */}
              <div>
                <div className="text-[11px] text-gray-500 uppercase tracking-wide">Доходность</div>
                <div
                  className={cn(
                    'mt-1 text-lg font-bold tabular-nums',
                    roiPct >= 0 ? 'text-blue-600' : 'text-rose-600'
                  )}
                >
                  {pct(roiPct)}
                </div>
              </div>

              {/* Margin */}
              <div>
                <div className="text-[11px] text-gray-500 uppercase tracking-wide">
                  Маржинальность
                </div>
                <div
                  className={cn(
                    'mt-1 text-lg font-bold tabular-nums',
                    marginPct >= 20
                      ? 'text-emerald-600'
                      : marginPct >= 0
                        ? 'text-amber-700'
                        : 'text-rose-600'
                  )}
                >
                  {pct(marginPct)}
                </div>
              </div>

              {/* Marginal profit */}
              <div>
                <div className="text-[11px] text-gray-500 uppercase tracking-wide">
                  Маржинальная прибыль
                </div>
                <div
                  className={cn(
                    'mt-1 text-lg font-bold tabular-nums',
                    grossProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'
                  )}
                >
                  {rub(grossProfit)}
                </div>
              </div>

              {/* Min price */}
              <div>
                <div className="text-[11px] text-gray-500 uppercase tracking-wide">
                  Мин. цена
                </div>
                <div className="mt-1 text-lg font-bold text-purple-600 tabular-nums">
                  {rub(minPrice)}
                </div>
              </div>

              {/* Max discount */}
              <div>
                <div className="text-[11px] text-gray-500 uppercase tracking-wide">
                  Макс. скидка
                </div>
                <div className="mt-1 text-lg font-bold text-indigo-600 tabular-nums">
                  {maxDiscountPct > 0 ? pct(maxDiscountPct) : '---'}
                </div>
              </div>
            </div>
          </div>

          {/* Breakdown bar */}
          {price > 0 && (
            <div className="border-t border-gray-100 px-5 py-3">
              <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
                <span>
                  Наценка:{' '}
                  <strong className="text-gray-700">{markup > 0 ? `x${markup.toFixed(2)}` : '---'}</strong>
                </span>
                <span className="text-gray-300">|</span>
                <span>
                  Комиссия WB: <strong className="text-amber-700">{rub(commissionRub)}</strong>
                </span>
                <span className="text-gray-300">|</span>
                <span>
                  Логистика (с учётом выкупа):{' '}
                  <strong className="text-purple-600">{rub(logisticsWithBuyout)}</strong>
                </span>
                <span className="text-gray-300">|</span>
                <span>
                  Налог: <strong className="text-orange-700">{rub(taxAmount)}</strong>
                </span>
                <span className="text-gray-300">|</span>
                <span>
                  К перечислению:{' '}
                  <strong className="text-gray-900">{rub(toTransfer)}</strong>
                </span>
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Section: Your Product */}
      <Card className="p-5">
        <CalculatorSection title="Ваш товар">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Предмет</label>
            <Combobox
              options={subjects.map((s) => ({
                value: String(s.subjectId),
                label: `${s.subjectName} (${s.commissionPct}%)`,
              }))}
              value={subjectId}
              onValueChange={setSubjectId}
              placeholder="Выберите предмет..."
              searchPlaceholder="Поиск по названию или ID..."
              emptyText={subjects.length === 0 ? 'Загрузка...' : 'Ничего не найдено'}
            />
            {commissionPctFromSubject > 0 && (
              <p className="mt-1 text-[11px] text-indigo-600">
                Комиссия WB: {commissionPctFromSubject}%
              </p>
            )}
          </div>

          <CalcField
            label="Цена на WB, ₽"
            value={price || ''}
            onChange={setPrice}
            highlight
          />

          <CalcField
            label="Себестоимость, ₽"
            value={costPrice || ''}
            onChange={setCostPrice}
            highlight
          />
        </CalculatorSection>
      </Card>

      {/* Section: Fulfillment */}
      <Card className="p-5">
        <CalculatorSection title="Фулфилмент">
          <CalcField
            label="Логистика от производителя, ₽"
            value={logFromManufacturer || ''}
            onChange={setLogFromManufacturer}
          />
          <CalcField
            label="Упаковка, ₽"
            value={packaging || ''}
            onChange={setPackaging}
          />
          <CalcField
            label="Логистика до маркетплейса, ₽"
            value={logToMP || ''}
            onChange={setLogToMP}
          />
          <CalcField
            label="Услуги фулфилмента, ₽"
            value={fulfillmentService || ''}
            onChange={setFulfillmentService}
          />
          <CalcField
            label="Стоимость упаковки за 1 ед., ₽"
            value={packagingCostPerUnit || ''}
            onChange={setPackagingCostPerUnit}
          />
        </CalculatorSection>
      </Card>

      {/* Section: Marketplace */}
      <Card className="p-5">
        <CalculatorSection title="Маркетплейс">
          <div>
            <label className="block text-xs font-medium text-gray-500">
              Склад отгрузки
            </label>
            <select
              className={selectCls}
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
            >
              <option value="default">Основной склад</option>
              <option value="kzn">Казань</option>
              <option value="spb">Санкт-Петербург</option>
              <option value="ekb">Екатеринбург</option>
              <option value="nsk">Новосибирск</option>
              <option value="krd">Краснодар</option>
              <option value="msk">Москва (Коледино)</option>
              <option value="msk2">Москва (Электросталь)</option>
            </select>
          </div>

          <CalcFieldDual
            label="Комиссия WB"
            pctValue={commissionPct || ''}
            rubValue={commissionRub}
            onPctChange={setCommissionPct}
            pctSuffix="%"
          />

          <div className="sm:col-span-2 lg:col-span-3">
            <label className="block text-xs font-medium text-gray-500 mb-2">
              Логистика до Wildberries (габариты)
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <CalcField
                label="Длина, см"
                value={lengthCm || ''}
                onChange={setLengthCm}
              />
              <CalcField
                label="Ширина, см"
                value={widthCm || ''}
                onChange={setWidthCm}
              />
              <CalcField
                label="Высота, см"
                value={heightCm || ''}
                onChange={setHeightCm}
              />
              <CalcField
                label="Вес, кг"
                value={weightKg || ''}
                onChange={setWeightKg}
              />
            </div>
            {volumeWeight > 0 && (
              <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
                <span>
                  Объём: <strong className="text-gray-700">{volumeLiters.toFixed(1)} л</strong>
                </span>
                <span>
                  Объёмный вес: <strong className="text-gray-700">{volumeWeight.toFixed(1)} кг</strong>
                </span>
                <span>
                  В рублях: <strong className="text-gray-900">{rub(logisticsCostRub)}</strong>
                </span>
              </div>
            )}
          </div>

          <CalcFieldDual
            label="Брак"
            pctValue={defectPct}
            rubValue={defectRub}
            onPctChange={setDefectPct}
            pctSuffix="%"
          />

          <div className="sm:col-span-2 lg:col-span-3">
            <label className="block text-xs font-medium text-gray-500">
              Хранение 1 ед. в день
            </label>
            <div className="mt-1 flex items-center gap-3">
              <input
                type="number"
                step="any"
                min={0}
                value={storagePerDay || ''}
                onChange={(e) => setStoragePerDay(Number(e.target.value))}
                className="w-32 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-500 transition-all duration-200"
                placeholder="0"
              />
              <span className="text-xs text-gray-500">₽ / день</span>
              <span className="text-xs text-gray-500">В рублях:</span>
              <span className="text-sm font-medium text-gray-900 tabular-nums">
                {rub(storageRub)}
              </span>
            </div>
          </div>

          <div className="sm:col-span-2 lg:col-span-3">
            <label className="block text-xs font-medium text-gray-500">Выкуп</label>
            <div className="mt-1 flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  step="1"
                  min={1}
                  max={100}
                  value={buyoutPct}
                  onChange={(e) => setBuyoutPct(Number(e.target.value))}
                  className="w-20 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-500 transition-all duration-200"
                />
                <span className="text-xs text-gray-500">%</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Логистика с учётом % выкупа:</span>
                <span className="text-sm font-medium text-gray-900 tabular-nums">
                  {rub(logisticsWithBuyout)}
                </span>
              </div>
            </div>
          </div>
        </CalculatorSection>
      </Card>

      {/* Section: Taxes */}
      <Card className="p-5">
        <CalculatorSection title="Налоги">
          <div>
            <label className="block text-xs font-medium text-gray-500">Налоговый режим</label>
            <select
              className={selectCls}
              value={taxRegime}
              onChange={(e) => setTaxRegime(e.target.value as TaxRegime)}
            >
              <option value="income">УСН Доходы (6%)</option>
              <option value="income_minus_expenses">УСН Доходы − расходы (15%)</option>
              <option value="osno">ОСНО (20%)</option>
              <option value="patent">Патент (0%)</option>
              <option value="ausn8">АУСН Доходы (8%)</option>
              <option value="ausn20">АУСН Доходы − расходы (20%)</option>
            </select>
          </div>

          <CalcFieldDual
            label="Налоговая ставка"
            pctValue={taxRate}
            rubValue={taxAmount}
            onPctChange={setTaxRate}
            pctSuffix="%"
          />
        </CalculatorSection>
      </Card>

      {/* Section: Other */}
      <Card className="p-5">
        <CalculatorSection title="Прочее">
          <CalcField
            label="Прочие расходы (реклама и т.д.), ₽"
            value={otherExpenses || ''}
            onChange={setOtherExpenses}
          />
        </CalculatorSection>
      </Card>

      {/* Section: Batch calculation */}
      <Card className="p-5">
        <div className="text-sm font-semibold text-gray-900 mb-4">Расчёт партии</div>
        <div className="space-y-4">
          <CalcField
            label="Размер партии, шт"
            value={batchSize || ''}
            onChange={setBatchSize}
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-3 border-t border-gray-100">
            <div className="rounded-xl bg-gray-50 p-4">
              <div className="text-xs text-gray-500">Инвестиции на партию</div>
              <div className="mt-1 text-lg font-semibold text-gray-900 tabular-nums">
                {rub(batchInvestment)}
              </div>
            </div>
            <div className="rounded-xl bg-gray-50 p-4">
              <div className="text-xs text-gray-500">Выручка партии</div>
              <div className="mt-1 text-lg font-semibold text-gray-900 tabular-nums">
                {rub(batchRevenue)}
              </div>
            </div>
            <div
              className={cn(
                'rounded-xl p-4',
                batchProfit >= 0 ? 'bg-emerald-50' : 'bg-red-50'
              )}
            >
              <div className="text-xs text-gray-500">Прибыль партии</div>
              <div
                className={cn(
                  'mt-1 text-lg font-semibold tabular-nums',
                  batchProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'
                )}
              >
                {rub(batchProfit)}
              </div>
            </div>
          </div>
        </div>
      </Card>

    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 3 - Single Product Analysis (from WB data)                     */
/* ------------------------------------------------------------------ */

const SEGMENTS_LEFT: Array<{ key: keyof UnitEcoRow['segments']; title: string; color: string }> = [
  { key: 'buyerPriceRub', title: 'Цена для покупателя', color: '#93C5FD' },
  { key: 'sppRub', title: 'СПП', color: '#22D3EE' },
];

const SEGMENTS_RIGHT: Array<{ key: keyof UnitEcoRow['segments']; title: string; color: string }> = [
  { key: 'cogsRub', title: 'Себестоимость', color: '#2563EB' },
  { key: 'logisticsRub', title: 'Логистика', color: '#7C3AED' },
  { key: 'commissionRub', title: 'Комиссия', color: '#F59E0B' },
  { key: 'taxRub', title: 'Налог', color: '#F97316' },
  { key: 'profitRub', title: 'Прибыль', color: '#22C55E' },
];

function SingleProductView({
  workspaceId,
  setWorkspaceId,
}: {
  workspaceId: number;
  setWorkspaceId: (v: number) => void;
}) {
  const shopParam = useShopParam();
  const today = new Date();
  const [end, setEnd] = useState<string>(isoDate(today));
  const [start, setStart] = useState<string>(isoDate(addDays(today, -30)));

  const [nmId, setNmId] = useState('');
  const [mergeWeeks, setMergeWeeks] = useState(true);
  const [salesModel, setSalesModel] = useState<'fbo' | 'fbs' | 'compare'>('fbo');
  const [includeFact, setIncludeFact] = useState(false);
  const [taxRatePct, setTaxRatePct] = useState(15); // percent (15 = 15%)
  const taxRate = taxRatePct / 100; // decimal for API
  const acquiringRate = 0.02;
  const [sppOverride, setSppOverride] = useState<number | null>(null);
  const [sppMode, setSppMode] = useState<'wb' | 'manual'>('wb');
  const [cogsRub, setCogsRub] = useState<number>(0);

  const [data, setData] = useState<UnitEcoResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [hover, setHover] = useState<null | {
    periodKey: string;
    model: string;
    segment: string;
    value: number;
    pct?: number;
    x: number;
    y: number;
  }>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `/unit-economics/${workspaceId}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(
        end
      )}&nmIds=${encodeURIComponent(nmId)}&mergeWeeks=${mergeWeeks ? '1' : '0'}&mergeProducts=0&rounding=standard&includeFact=${includeFact ? '1' : '0'}&salesModel=${encodeURIComponent(
        salesModel
      )}&taxRate=${encodeURIComponent(String(taxRate))}&acquiringRate=${encodeURIComponent(
        String(acquiringRate)
      )}&cogsRub=${encodeURIComponent(String(cogsRub))}&calcBase=perUnit&quantity=1${
        sppOverride != null ? `&sppOverride=${encodeURIComponent(String(sppOverride))}` : ''
      }${shopParam}`;
      const res = (await apiFetch(url)) as UnitEcoResponse;
      setData(res);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, start, end, nmId, salesModel, mergeWeeks, includeFact, taxRate, cogsRub, sppOverride, shopParam]);

  useEffect(() => {
    load();
  }, [load]);
  useShopChange(load);

  // Auto-load COGS
  useEffect(() => {
    const id = nmId.trim().split(',')[0]?.trim();
    if (!id || !Number.isFinite(Number(id))) return;
    let alive = true;
    apiFetch(`/cogs/${workspaceId}?nmIds=${encodeURIComponent(id)}${shopParam}`)
      .then((res: any) => {
        if (!alive) return;
        const row = Array.isArray(res?.rows) ? res.rows[0] : null;
        if (row?.cogsKopecks != null) setCogsRub(Number(row.cogsKopecks) / 100);
      })
      .catch((e) => { console.error('COGS auto-load failed:', e); });
    return () => {
      alive = false;
    };
  }, [nmId, workspaceId, shopParam]);

  const periods = useMemo(() => {
    if (!data) return [] as Array<{ key: string; start: string; end: string }>;
    const keys = new Map<string, { start: string; end: string }>();
    for (const r of data.rows) {
      const k = `${r.bucketStart}\u2192${r.bucketEnd}`;
      keys.set(k, { start: r.bucketStart, end: r.bucketEnd });
    }
    return Array.from(keys.entries()).map(([key, v]) => ({ key, ...v }));
  }, [data]);

  const rowsByPeriodAndModel = useMemo(() => {
    const m = new Map<string, UnitEcoRow>();
    if (!data) return m;
    for (const r of data.rows) {
      const pk = `${r.bucketStart}\u2192${r.bucketEnd}`;
      const model = r.salesModel ?? (salesModel === 'compare' ? 'fbo' : salesModel);
      m.set(`${pk}|${model}`, r);
    }
    return m;
  }, [data, salesModel]);

  function renderChart() {
    if (!data || periods.length === 0) {
      return <div className="text-xs text-gray-500">Нет данных</div>;
    }

    const models: Array<'fbo' | 'fbs'> =
      salesModel === 'compare' ? ['fbo', 'fbs'] : [salesModel === 'fbs' ? 'fbs' : 'fbo'];

    const latestPeriod = periods[periods.length - 1];
    const legendValue = (segKey: keyof UnitEcoRow['segments']) => {
      if (!latestPeriod) return null;
      if (salesModel === 'compare') {
        const rFbo = rowsByPeriodAndModel.get(`${latestPeriod.key}|fbo`);
        const rFbs = rowsByPeriodAndModel.get(`${latestPeriod.key}|fbs`);
        const vFbo = rFbo ? (rFbo.segments as any)[segKey] : null;
        const vFbs = rFbs ? (rFbs.segments as any)[segKey] : null;
        const parts = [
          vFbo != null ? `FBO ${formatRub(Number(vFbo))}` : null,
          vFbs != null ? `FBS ${formatRub(Number(vFbs))}` : null,
        ].filter(Boolean);
        return parts.length ? parts.join(' \u00B7 ') : null;
      }
      const model = salesModel === 'fbs' ? 'fbs' : 'fbo';
      const r = rowsByPeriodAndModel.get(`${latestPeriod.key}|${model}`);
      const v = r ? (r.segments as any)[segKey] : null;
      return v != null ? formatRub(Number(v)) : null;
    };

    const totals: number[] = [];
    for (const p of periods) {
      for (const model of models) {
        const r = rowsByPeriodAndModel.get(`${p.key}|${model}`);
        if (!r) continue;
        const left = SEGMENTS_LEFT.reduce(
          (acc, s) => acc + ((r.segments[s.key] as unknown as number) || 0),
          0
        );
        const right = SEGMENTS_RIGHT.reduce(
          (acc, s) => acc + ((r.segments[s.key] as unknown as number) || 0),
          0
        );
        totals.push(left, right);
      }
    }
    const max = Math.max(1, ...totals);

    const W = 980;
    const H = 320;
    const pad = { l: 80, r: 20, t: 45, b: 55 };
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;

    const groupCount = periods.length;
    const groupGap = 24;

    const columnGap = salesModel === 'compare' ? 8 : 10;
    const modelGap = salesModel === 'compare' ? 24 : 0;
    const columnsPerModel = 2;
    const modelsCount = salesModel === 'compare' ? 2 : 1;
    const cols = columnsPerModel * modelsCount;

    const totalGaps = columnGap * (cols - 1) + (salesModel === 'compare' ? modelGap : 0);
    const groupW =
      (innerW - groupGap * Math.max(0, groupCount - 1)) / Math.max(1, groupCount);
    const barW = Math.max(20, (groupW - totalGaps) / cols);

    const yScale = (v: number) => pad.t + innerH - (v / max) * innerH;

    return (
      <div className="relative overflow-x-auto">
        {hover ? (
          <div
            className="pointer-events-none absolute z-50 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-gray-900 shadow-xl"
            style={{ left: hover.x + 12, top: hover.y + 12 }}
          >
            <div className="font-medium">
              {hover.segment} \u00B7 {hover.model}
            </div>
            <div className="mt-1 font-mono text-[11px]">{formatRub(hover.value)}</div>
            {hover.pct !== undefined ? (
              <div className="mt-0.5 text-[11px] text-gray-500">{hover.pct}%</div>
            ) : null}
            <div className="mt-1 text-[11px] text-gray-500">{hover.periodKey}</div>
          </div>
        ) : null}

        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" style={{ overflow: 'visible' }}>
          <line
            x1={pad.l}
            y1={pad.t + innerH}
            x2={pad.l + innerW}
            y2={pad.t + innerH}
            stroke="#e2e8f0"
          />
          <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + innerH} stroke="#e2e8f0" />

          {periods.map((p, gi) => {
            const gx = pad.l + gi * (groupW + groupGap);

            return models.flatMap((model, mi) => {
              const r = rowsByPeriodAndModel.get(`${p.key}|${model}`);
              if (!r) return [];

              const baseX =
                gx + mi * (2 * barW + columnGap + (salesModel === 'compare' ? modelGap : 0));

              const columns: Array<{ kind: 'left' | 'right'; segs: typeof SEGMENTS_LEFT }> = [
                { kind: 'left', segs: SEGMENTS_LEFT as any },
                { kind: 'right', segs: SEGMENTS_RIGHT as any },
              ];

              return columns.map((col, ci) => {
                const bx = baseX + ci * (barW + columnGap);
                let acc = 0;
                const segs = col.segs as any[];
                const total = segs.reduce(
                  (a: number, s: any) => a + (((r.segments as any)[s.key] as number) || 0),
                  0
                );

                return (
                  <g key={`${p.key}|${model}|${col.kind}`}>
                    {segs.map((s: any) => {
                      const v = (((r.segments as any)[s.key] as number) || 0) as number;
                      const y0 = yScale(acc + v);
                      const h = (v / max) * innerH;
                      acc += v;

                      const pctVal = r.segments.pct
                        ? (r.segments.pct as any)[String(s.key).replace('Rub', '')]
                        : undefined;

                      return (
                        <g key={String(s.key)}>
                          <rect
                            x={bx}
                            y={y0}
                            width={Math.max(0, barW)}
                            height={Math.max(0, h)}
                            fill={s.color}
                            opacity={0.9}
                            rx={2}
                            onMouseMove={(e) => {
                              const bounds = (
                                e.target as any
                              ).ownerSVGElement.getBoundingClientRect();
                              setHover({
                                periodKey: p.key,
                                model,
                                segment: s.title,
                                value: v,
                                pct: pctVal,
                                x: e.clientX - bounds.left,
                                y: e.clientY - bounds.top,
                              });
                            }}
                            onMouseLeave={() => setHover(null)}
                          />
                          {['sppRub', 'cogsRub', 'taxRub'].includes(String(s.key)) &&
                          v > 0 && h >= 14 && barW >= 30 ? (
                            <text
                              x={bx + barW / 2}
                              y={y0 + Math.max(8, h / 2)}
                              textAnchor="middle"
                              dominantBaseline="middle"
                              fontSize={barW < 50 ? '8' : '9'}
                              fill={h >= 10 ? '#0f172a' : '#334155'}
                              opacity={0.9}
                            >
                              {formatRub(v)}
                            </text>
                          ) : null}
                        </g>
                      );
                    })}

                    <text
                      x={bx + barW / 2}
                      y={yScale(total) - 6}
                      textAnchor="middle"
                      fontSize="11"
                      fill="#64748b"
                    >
                      {formatRub(total)}
                    </text>
                    <text
                      x={bx + barW / 2}
                      y={pad.t + innerH + 12}
                      textAnchor="middle"
                      fontSize="10"
                      fill="#94a3b8"
                    >
                      {col.kind === 'left' ? 'Цена/СПП' : 'ЮЭ'}
                    </text>
                    {salesModel === 'compare' && ci === 0 ? (
                      <text
                        x={baseX + barW + columnGap / 2}
                        y={pad.t - 10}
                        textAnchor="middle"
                        fontSize="10"
                        fontWeight="600"
                        fill={model === 'fbo' ? '#6366f1' : '#ec4899'}
                      >
                        {model.toUpperCase()}
                      </text>
                    ) : null}
                  </g>
                );
              });
            });
          })}

          {periods.map((p, gi) => {
            const gx = pad.l + gi * (groupW + groupGap);
            const cx = gx + groupW / 2;
            return (
              <text
                key={p.key}
                x={cx}
                y={pad.t + innerH + 24}
                textAnchor="middle"
                fontSize="10"
                fill="#94a3b8"
              >
                {p.key}
              </text>
            );
          })}
        </svg>

        {/* Legend */}
        <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-gray-700">
          {SEGMENTS_LEFT.map((s) => (
            <div key={s.title} className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded" style={{ background: s.color }} />
              <span>{s.title}</span>
              {legendValue(s.key) && (
                <span className="text-gray-500">({legendValue(s.key)})</span>
              )}
            </div>
          ))}
          <span className="mx-1 text-gray-300">|</span>
          {SEGMENTS_RIGHT.map((s) => (
            <div key={s.title} className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded" style={{ background: s.color }} />
              <span>{s.title}</span>
              {legendValue(s.key) && (
                <span className="text-gray-500">({legendValue(s.key)})</span>
              )}
            </div>
          ))}
        </div>

        {/* Key metrics pills */}
        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
          {[
            { key: 'sppRub', label: 'СПП', color: '#22D3EE' },
            { key: 'cogsRub', label: 'Себестоимость', color: '#2563EB' },
            { key: 'taxRub', label: 'НДС', color: '#F97316' },
          ].map((s) => (
            <div
              key={s.key}
              className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-2.5 py-1"
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: s.color }}
              />
              <span className="font-medium text-gray-900">{s.label}:</span>
              <span className="font-mono text-gray-500">
                {legendValue(s.key as any) ?? '\u2014'}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <Card className="p-5">
        <div className="text-sm font-semibold text-gray-900">Параметры расчёта</div>
        <p className="mt-1 text-xs text-gray-500">
          Расчёт на основе данных WB Analytics: выкупы x комиссия/логистика по тарифам
        </p>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="text-xs font-medium text-gray-500">
            Период
            <div className="mt-1">
              <DateRangePicker
                dateFrom={start}
                dateTo={end}
                onDateFromChange={setStart}
                onDateToChange={setEnd}
              />
            </div>
          </div>

          <div />

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Артикул WB</span>
            <ProductSearchInput
              workspaceId={workspaceId}
              value={nmId}
              onChange={setNmId}
              single
              compact
              placeholder="Выберите товар..."
            />
          </div>

          <label className="text-xs font-medium text-gray-500">
            Схема работы
            <select
              className={selectCls}
              value={salesModel}
              onChange={(e) => setSalesModel(e.target.value as any)}
            >
              <option value="fbo">FBO</option>
              <option value="fbs">FBS</option>
              <option value="compare">FBO vs FBS</option>
            </select>
          </label>

          <label className="text-xs font-medium text-gray-500">
            Налоговая ставка, %
            <input
              className={inputCls}
              type="number"
              step="1"
              min="0"
              max="100"
              value={taxRatePct}
              onChange={(e) => setTaxRatePct(Number(e.target.value))}
            />
          </label>

          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-gray-900">
              СПП (скидка постоянного покупателя)
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                className={cn(
                  'rounded-lg px-2 py-1 text-[11px] font-medium transition-colors',
                  sppMode === 'wb'
                    ? 'bg-indigo-100 text-indigo-700'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                )}
                onClick={() => {
                  setSppMode('wb');
                  setSppOverride(null);
                }}
              >
                WB данные
              </button>
              <button
                type="button"
                className={cn(
                  'rounded-lg px-2 py-1 text-[11px] font-medium transition-colors',
                  sppMode === 'manual'
                    ? 'bg-indigo-100 text-indigo-700'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                )}
                onClick={() => {
                  setSppMode('manual');
                  setSppOverride(sppOverride ?? 20);
                }}
              >
                Вручную
              </button>
            </div>
            {sppMode === 'manual' && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={sppOverride ?? 20}
                  onChange={(e) => setSppOverride(Number(e.target.value))}
                  className="flex-1 h-1.5 accent-indigo-500"
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={sppOverride ?? 20}
                  onChange={(e) => setSppOverride(Number(e.target.value))}
                  className={inputCls + ' !mt-0 w-16 text-center'}
                />
                <span className="text-xs text-gray-500">%</span>
              </div>
            )}
            <div className="mt-1 text-[11px] text-gray-500">
              {sppMode === 'wb'
                ? 'СПП загружается из данных WB'
                : `СПП: ${sppOverride ?? 20}% (ручной ввод для моделирования)`}
            </div>
          </div>

          <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3">
            <div className="text-xs font-medium text-gray-900">Себестоимость (на 1 шт), руб.</div>
            <div className="mt-2 flex items-center gap-3">
              <input
                className={inputCls + ' !mt-0 w-32 border-indigo-300 focus:ring-indigo-200'}
                type="number"
                step="1"
                min="0"
                value={cogsRub}
                onChange={(e) => setCogsRub(Number(e.target.value))}
              />
              <span className="text-sm font-mono text-indigo-700">{formatRub(cogsRub)}</span>
            </div>
            <div className="mt-1 text-[10px] text-gray-500">
              Себестоимость загружается из раздела "Себестоимость" или введите вручную
            </div>
          </div>

          <div className="flex items-end justify-end">
            <Button className="w-full" onClick={load} disabled={loading}>
              {loading ? 'Считаю...' : 'Посчитать'}
            </Button>
          </div>
        </div>
      </Card>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">
          {error}
        </div>
      ) : null}

      {/* Chart */}
      <Card className="p-5">
        <div className="text-sm font-semibold text-gray-900">График (стек)</div>
        <div className="mt-4">{renderChart()}</div>
      </Card>

      {/* Fact comparison */}
      {data?.rows?.[0]?.fact && includeFact ? (
        <Card className="p-5">
          <div className="text-sm font-semibold text-gray-900">
            Факт WB (еженедельная сводка) -- для сравнения
          </div>
          <div className="mt-3 text-xs text-gray-700">
            Логистика (руб.):{' '}
            <span className="font-mono">{formatRub(data.rows[0].fact?.logisticsRub ?? 0)}</span>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'all', label: 'Все товары' },
  { key: 'calculator', label: 'Калькулятор' },
  // { key: 'single', label: 'Расчёт по товару' }, // TODO: доработать расчёт
];

export default function UnitEconomicsPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const setWorkspaceId = useWorkspaceStore((s) => s.setWorkspaceId);

  const [activeTab, setActiveTab] = useState<TabKey>('calculator');

  const today = new Date();
  const [end, setEnd] = useState<string>(isoDate(today));
  const [start, setStart] = useState<string>(isoDate(addDays(today, -30)));

  if (workspaceId === null) {
    return (
      <AppShell title="Юнит-экономика">
        <div className="p-6">
          <Card className="p-8 text-center text-gray-500">
            Выберите магазин для расчёта юнит-экономики
          </Card>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Юнит-экономика">
      <Paywall workspaceId={workspaceId} feature="Юнит-экономика">
        <div className="p-6 space-y-6">
          {/* Tab Navigation */}
          <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  'px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200',
                  activeTab === tab.key
                    ? 'bg-white text-indigo-700 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab 1: All Products */}
          {activeTab === 'all' && (
            <AllProductsTable
              workspaceId={workspaceId}
              setWorkspaceId={setWorkspaceId}
              start={start}
              end={end}
              setStart={setStart}
              setEnd={setEnd}
            />
          )}

          {/* Tab 2: Calculator */}
          {activeTab === 'calculator' && <WbCalculator workspaceId={workspaceId} />}

          {/* Tab 3: Single Product Analysis */}
          {activeTab === 'single' && (
            <SingleProductView
              workspaceId={workspaceId}
              setWorkspaceId={setWorkspaceId}
            />
          )}
        </div>
      </Paywall>
    </AppShell>
  );
}
