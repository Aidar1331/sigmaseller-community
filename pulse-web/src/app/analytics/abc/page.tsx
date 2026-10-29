'use client';

import { useShopChange } from '@/hooks/useShopChange';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Info } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { NmIdLink } from '@/components/ui/NmIdLink';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatNumber, formatRub, formatPct } from '@/lib/format';
import { useWorkspaceStore } from '@/store/workspace';
import { useActiveShop } from '@/hooks/useShopParam';
import {
  useTableSelection,
  type SelectionColumn,
} from '@/hooks/useTableSelection';
import { SelectionBar } from '@/components/table/SelectionBar';

const ABC_SEL_COLUMNS: SelectionColumn[] = [
  { key: 'orders',     label: 'Заказы',      unit: 'шт' },
  { key: 'metric',     label: 'Выручка',     unit: '₽' },
  { key: 'share',      label: 'Доля',        unit: '%' },
  { key: 'cumulative', label: 'Кумулятивно', unit: '%' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AbcRow = {
  nmId: number;
  vendorCode: string | null;
  title: string | null;
  ordersCount: number;
  ordersRub: number;
  salesRub: number;
  forPayRub: number;
  metricRub: number;
  sharePercent: number;
  cumulativePercent: number;
  abcGroup: 'A' | 'B' | 'C';
};

type AbcResponse = {
  workspaceId: number;
  from: string;
  to: string;
  metric: 'orders' | 'sales';
  thresholdA: number;
  thresholdB: number;
  tagId: number | null;
  totalRub: number;
  rows: AbcRow[];
};

type TagRow = { tagId: number; name: string };

function isoDate(d: Date): string {
  const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0"); return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

const QUICK_PERIODS = [14, 30, 60, 90] as const;

// Tooltip component for metric explanations
function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="relative group inline-flex ml-1 cursor-help">
      <Info className="h-3.5 w-3.5 text-gray-500 hover:text-gray-600" />
      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs text-white bg-gray-800 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
        {text}
      </span>
    </span>
  );
}

export default function AbcAnalyticsPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const { shopId } = useActiveShop();

  const today = useMemo(() => isoDate(new Date()), []);
  const defaultFrom = useMemo(() => isoDate(addDays(new Date(), -30)), []);

  const [dateFrom, setDateFrom] = useState(defaultFrom);
  const [dateTo, setDateTo] = useState(today);
  const [metric, setMetric] = useState<'orders' | 'sales'>('orders');
  const [thresholdA, setThresholdA] = useState(80);
  const [thresholdB, setThresholdB] = useState(95);
  const [tagId, setTagId] = useState('');

  const [tags, setTags] = useState<TagRow[]>([]);

  const [rows, setRows] = useState<AbcRow[]>([]);
  const [totalRub, setTotalRub] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validationError = useMemo(() => {
    if (thresholdA < 1 || thresholdA > 99) return 'Порог A должен быть от 1 до 99';
    if (thresholdB < 2 || thresholdB > 100) return 'Порог B должен быть от 2 до 100';
    if (thresholdA >= thresholdB) return 'Порог A должен быть меньше порога B';
    return null;
  }, [thresholdA, thresholdB]);

  useEffect(() => {
    async function loadTags() {
      try {
        const res = (await apiFetch(`/tags/${workspaceId}`)) as { rows: TagRow[] };
        setTags(res.rows ?? []);
      } catch (e) {
        console.error('Failed to load tags:', e);
        setTags([]);
      }
    }
    loadTags();
  }, [workspaceId]);

  const loadData = useCallback(async () => {
    if (validationError) {
      setRows([]);
      setTotalRub(0);
      setError(validationError);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set('from', dateFrom);
      qs.set('to', dateTo);
      qs.set('metric', metric);
      qs.set('thresholdA', String(thresholdA));
      qs.set('thresholdB', String(thresholdB));
      if (tagId) qs.set('tagId', tagId);
      if (shopId) qs.set('shopId', String(shopId));

      const res = (await apiFetch(`/analytics/${workspaceId}/abc?${qs.toString()}`)) as AbcResponse;
      setRows(res.rows ?? []);
      setTotalRub(res.totalRub ?? 0);
    } catch (e: any) {
      setRows([]);
      setTotalRub(0);
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, dateFrom, dateTo, metric, thresholdA, thresholdB, tagId, validationError, shopId]);

  useEffect(() => {
    loadData();
  }, [loadData]);
  useShopChange(loadData);

  const sel = useTableSelection<AbcRow>({
    rows,
    columns: ABC_SEL_COLUMNS,
    getValue: (row, col) => {
      switch (col) {
        case 'orders':     return row.ordersCount;
        case 'metric':     return row.metricRub / 100; // в БД копейки → отдаём рубли
        case 'share':      return row.sharePercent;
        case 'cumulative': return row.cumulativePercent;
        default:           return 0;
      }
    },
    resetDeps: [metric, thresholdA, thresholdB, tagId, dateFrom, dateTo, shopId],
  });

  const groupSummary = useMemo(() => {
    const base = {
      A: { count: 0, sum: 0 },
      B: { count: 0, sum: 0 },
      C: { count: 0, sum: 0 },
    };

    for (const row of rows) {
      const entry = base[row.abcGroup];
      entry.count += 1;
      entry.sum += row.metricRub;
    }

    return base;
  }, [rows]);

  const metricLabel = metric === 'orders' ? 'Выручка заказов' : 'Выручка продаж';

  function handleQuick(days: number) {
    const end = new Date();
    const start = addDays(end, -days);
    setDateFrom(isoDate(start));
    setDateTo(isoDate(end));
  }

  if (workspaceId === null) {
    return (
      <AppShell title="ABC‑анализ">
        <div className="p-6">
          <Card className="p-8 text-center text-[var(--content-muted)]">
            Выберите магазин для просмотра анализа
          </Card>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="ABC‑анализ">
      <div className="p-6 space-y-6">
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <DateRangePicker
              dateFrom={dateFrom}
              dateTo={dateTo}
              onDateFromChange={setDateFrom}
              onDateToChange={setDateTo}
            />

            <div className="flex items-center gap-2">
              {QUICK_PERIODS.map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => handleQuick(days)}
                  className="h-8 rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 text-xs text-[var(--content-muted)] hover:bg-slate-50"
                >
                  {days}д
                </button>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="neutral"
                size="sm"
                onClick={loadData}
                loading={loading}
              >
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                Обновить
              </Button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-[1.2fr_1fr_1fr]">
            <label className="text-xs text-[var(--content-muted)]">
              Метрика
              <InfoTooltip text="Заказы — включают отмены; Продажи — только выкупленные" />
              <Select value={metric} onValueChange={(v) => setMetric(v as 'orders' | 'sales')}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="orders">Выручка заказов</SelectItem>
                  <SelectItem value="sales">Выручка продаж</SelectItem>
                </SelectContent>
              </Select>
            </label>

            <label className="text-xs text-[var(--content-muted)]">
              Тег товара
              <Select value={tagId || '__all__'} onValueChange={(v) => setTagId(v === '__all__' ? '' : v)}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Все" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Все</SelectItem>
                  {tags.map((t) => (
                    <SelectItem key={t.tagId} value={String(t.tagId)}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-[var(--content-muted)]">
                Порог A, %
                <Input
                  className="mt-1"
                  type="number"
                  min={1}
                  max={99}
                  value={thresholdA}
                  onChange={(e) => setThresholdA(Number.parseInt(e.target.value || '0', 10))}
                />
              </label>
              <label className="text-xs text-[var(--content-muted)]">
                Порог B, %
                <Input
                  className="mt-1"
                  type="number"
                  min={2}
                  max={100}
                  value={thresholdB}
                  onChange={(e) => setThresholdB(Number.parseInt(e.target.value || '0', 10))}
                />
              </label>
            </div>
          </div>

          {error ? (
            <div className="mt-3 text-sm text-rose-400">{error}</div>
          ) : null}
        </Card>

        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)]">Сводка</div>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {(['A', 'B', 'C'] as const).map((group) => {
              const sum = groupSummary[group].sum;
              const count = groupSummary[group].count;
              const share = totalRub > 0 ? (sum / totalRub) * 100 : 0;

              const badgeVariant =
                group === 'A' ? 'success' : group === 'B' ? 'warning' : 'danger';

              return (
                <div
                  key={group}
                  className="rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] p-3"
                >
                  <div className="flex items-center justify-between">
                    <Badge variant={badgeVariant}>{group}</Badge>
                    <div className="text-xs text-[var(--content-muted)]">{count} SKU</div>
                  </div>
                  <div className="mt-2 text-lg font-semibold">
                    {formatRub(sum / 100)} ₽
                  </div>
                  <div className="mt-1 text-xs text-[var(--content-muted)]">
                    {formatPct(share)}% от {metricLabel.toLowerCase()}
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-slate-100">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        group === 'A' && 'bg-emerald-400',
                        group === 'B' && 'bg-amber-400',
                        group === 'C' && 'bg-rose-400'
                      )}
                      style={{ width: `${Math.min(100, Math.max(0, share))}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-[var(--content-text)]">Товары</div>
              <div className="text-xs text-[var(--content-muted)]">
                {metricLabel} за выбранный период
              </div>
            </div>
            <div className="text-xs text-[var(--content-muted)]">
              Итого: {formatRub(totalRub / 100)} ₽
            </div>
          </div>

          <div className="mt-4 overflow-auto">
            <table className="min-w-[860px] w-full text-sm">
              <thead className="text-xs text-[var(--content-muted)]">
                <tr className="border-b border-[var(--card-border)]">
                  <th className="py-2 text-left">
                    Группа
                    <InfoTooltip text="A = топ товары (80% выручки), B = средние (15%), C = остальные (5%)" />
                  </th>
                  <th className="py-2 text-left">Артикул</th>
                  <th className="py-2 text-left">Товар</th>
                  <th className="py-2 text-right">Заказы, шт</th>
                  <th className="py-2 text-right">
                    {metricLabel}, ₽
                    <InfoTooltip text={metric === 'orders' ? 'Сумма всех заказов, включая последующие отмены и возвраты' : 'Сумма только выкупленных товаров'} />
                  </th>
                  <th className="py-2 text-right">
                    Доля, %
                    <InfoTooltip text="Процент от общей выручки" />
                  </th>
                  <th className="py-2 text-right">
                    Кумулятивно, %
                    <InfoTooltip text="Накопительный процент (товары отсортированы по убыванию выручки)" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => {
                  const badgeVariant =
                    row.abcGroup === 'A'
                      ? 'success'
                      : row.abcGroup === 'B'
                      ? 'warning'
                      : 'danger';
                  const selCellCls = (col: string) =>
                    cn(
                      'py-2 text-right tabular-nums cursor-pointer select-none transition-colors',
                      sel.isSelected(col, idx)
                        ? 'bg-violet-200 ring-1 ring-inset ring-violet-500'
                        : 'hover:bg-violet-50',
                    );

                  return (
                    <tr key={row.nmId} className="border-b border-[var(--card-border)]">
                      <td className="py-2">
                        <Badge variant={badgeVariant}>{row.abcGroup}</Badge>
                      </td>
                      <td className="py-2">
                        <div className="font-medium"><NmIdLink nmId={row.nmId} /></div>
                        <div className="text-xs text-[var(--content-muted)]">
                          {row.vendorCode || '—'}
                        </div>
                      </td>
                      <td className="py-2">
                        <div className="max-w-[360px] truncate" title={row.title ?? undefined}>
                          {row.title || '—'}
                        </div>
                      </td>
                      <td className={selCellCls('orders')} onClick={(e) => sel.handleClick('orders', idx, e)}>
                        {formatNumber(row.ordersCount)}
                      </td>
                      <td className={selCellCls('metric')} onClick={(e) => sel.handleClick('metric', idx, e)}>
                        {formatRub(row.metricRub / 100)} ₽
                      </td>
                      <td className={selCellCls('share')} onClick={(e) => sel.handleClick('share', idx, e)}>
                        {formatPct(row.sharePercent)}%
                      </td>
                      <td className={selCellCls('cumulative')} onClick={(e) => sel.handleClick('cumulative', idx, e)}>
                        {formatPct(row.cumulativePercent)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!loading && rows.length === 0 ? (
            <div className="mt-4 text-sm text-[var(--content-muted)]">
              <div>Нет данных за выбранный период.</div>
              <div className="mt-1 text-xs text-gray-400">
                Попробуйте расширить даты вверху или сбросить фильтры.
              </div>
            </div>
          ) : (
            <div className="text-[10px] text-gray-400 mt-2">
              Подсказка: клик по числовой ячейке выделяет её. Shift-клик — диапазон,
              Ctrl/⌘-клик — добавить/убрать. Esc — сбросить.
            </div>
          )}
        </Card>
        <SelectionBar col={sel.selColMeta} stats={sel.stats} onClear={sel.clear} />
      </div>
    </AppShell>
  );
}
