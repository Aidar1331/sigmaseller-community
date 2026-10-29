'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Download,
  FileSpreadsheet,
  Package,
  TrendingDown,
  TrendingUp,
  Minus,
  Upload,
} from 'lucide-react';

import { AppShell } from '@/components/AppShell';
import { AiAnalyzeButton } from '@/components/ai';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { TagFilter, type TagOption } from '@/components/ui/TagFilter';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';

import { apiFetch } from '@/lib/api';
import { getUserIdOrNull } from '@/store/auth';
import { useWorkspaceStore } from '@/store/workspace';
import { useShopChange } from '@/hooks/useShopChange';
import { formatNumber, formatRub, formatPct } from '@/lib/format';
import * as XLSX from 'xlsx';
import { MonthlyTargetSection } from '@/components/plan/MonthlyTargetSection';
import { AutoSuggestSection } from '@/components/plan/AutoSuggestSection';
import { PlanDistributionSection } from '@/components/plan/PlanDistributionSection';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface PlanProductRow {
  nmId: number;
  name: string;
  photo?: string | null;
  tag?: string | null;
  planQty: number;
  factQty: number;
  planRevenue: number;
  factRevenue: number;
}

interface PlanSummary {
  month: string; // "2026-03"
  planOrdersQty: number;
  factOrdersQty: number;
  planRevenue: number;
  factRevenue: number;
  products: PlanProductRow[];
  tags?: TagOption[];
  availableMonths?: string[];
}

type SortKey = 'name' | 'planQty' | 'factQty' | 'pctQty' | 'planRevenue' | 'factRevenue' | 'pctRevenue';
type SortDir = 'asc' | 'desc';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function toBase64(buf: ArrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function pct(fact: number, plan: number): number {
  if (!plan) return 0;
  return (fact / plan) * 100;
}

function pctColor(value: number): string {
  if (value >= 100) return 'text-emerald-600';
  if (value >= 80) return 'text-amber-700';
  return 'text-red-600';
}

function pctBg(value: number): string {
  if (value >= 100) return 'bg-emerald-500';
  if (value >= 80) return 'bg-amber-500';
  return 'bg-red-500';
}

function pctBgLight(value: number): string {
  if (value >= 100) return 'bg-emerald-100';
  if (value >= 80) return 'bg-amber-100';
  return 'bg-red-100';
}

function pctBadgeVariant(value: number): 'success' | 'warning' | 'danger' {
  if (value >= 100) return 'success';
  if (value >= 80) return 'warning';
  return 'danger';
}

/** Build month options: last 12 months including current */
function buildMonthOptions(): { value: string; label: string }[] {
  const months: { value: string; label: string }[] = [];
  const now = new Date();
  const names = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
  ];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({ value: val, label: `${names[d.getMonth()]} ${d.getFullYear()}` });
  }
  return months;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/*  InlinePlanCell — клик по ячейке → input, blur/Enter сохраняет.     */
/*  Карандашик показывает что ячейка кликабельна.                       */
/*  Esc отменяет. Пустое значение сохраняется как 0.                   */
/* ------------------------------------------------------------------ */
function InlinePlanCell({ value, onSave }: { value: number; onSave: (v: number) => Promise<void> | void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(String(value));
  const [saving, setSaving] = useState(false);
  const [hover, setHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value === 0 ? '' : String(value));
      // Двойной requestAnimationFrame чтобы input точно успел отрендериться
      // перед фокусом — без этого иногда input появлялся, но без курсора.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }));
    }
  }, [editing, value]);

  const commit = async () => {
    const parsed = Number.parseInt(draft.replace(/\s+/g, ''), 10);
    const newValue = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    if (newValue === value) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(newValue);
    } catch (e: any) {
      // Без catch'а юзер не видел ошибки — теперь alert делает их явными.
      // eslint-disable-next-line no-alert
      alert(`Не удалось сохранить план: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { setEditing(false); }
        }}
        disabled={saving}
        className="w-24 rounded border-2 border-indigo-400 bg-white px-2 py-1 text-right tabular-nums text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:opacity-50"
      />
    );
  }
  // Используем <span role="button"> вместо <button>, чтобы избежать конфликта
  // с другими handlers таблицы (sort headers и т.д.) и не получить лишний
  // focus ring при tab-навигации.
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(true); } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Кликните, чтобы изменить плановое количество"
      className="inline-flex items-center gap-1.5 cursor-pointer rounded px-2 py-1 text-right tabular-nums text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 hover:ring-1 hover:ring-indigo-200 transition-all"
    >
      <span className="font-medium">{formatNumber(value)}</span>
      <svg className={`w-3 h-3 transition-opacity ${hover ? 'opacity-100 text-indigo-500' : 'opacity-30 text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
      </svg>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Progress bar component                                             */
/* ------------------------------------------------------------------ */

function ProgressBar({ value, className }: { value: number; className?: string }) {
  const clamped = Math.min(value, 100);
  return (
    <div className={`h-2 w-full rounded-full ${pctBgLight(value)} ${className ?? ''}`}>
      <div
        className={`h-full rounded-full transition-all duration-500 ${pctBg(value)}`}
        style={{ width: `${Math.max(clamped, 2)}%` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Summary card component                                             */
/* ------------------------------------------------------------------ */

function SummaryCard({
  title,
  planValue,
  factValue,
  formatter,
  unit,
}: {
  title: string;
  planValue: number;
  factValue: number;
  formatter: (n: number) => string;
  unit: string;
}) {
  const p = pct(factValue, planValue);
  return (
    <Card className="flex-1 min-w-[280px]">
      <CardContent className="space-y-3">
        <div className="text-sm font-medium text-gray-500">{title}</div>
        <div className="flex items-end justify-between">
          <div>
            <div className="text-2xl font-bold text-gray-900">
              {formatter(factValue)} <span className="text-sm font-normal text-gray-500">{unit}</span>
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              план: {formatter(planValue)} {unit}
            </div>
          </div>
          <Badge variant={pctBadgeVariant(p)} size="lg" className="tabular-nums font-semibold">
            {formatPct(p)}%
          </Badge>
        </div>
        <ProgressBar value={p} />
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Sortable table header                                              */
/* ------------------------------------------------------------------ */

function SortHeader({
  label,
  sortKey,
  currentKey,
  currentDir,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  currentDir: SortDir;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = currentKey === sortKey;
  return (
    <th
      className={`px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:text-gray-700 transition-colors ${className ?? ''}`}
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          currentDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        )}
      </span>
    </th>
  );
}

/* ------------------------------------------------------------------ */
/*  Trend indicator                                                    */
/* ------------------------------------------------------------------ */

function TrendIndicator({ value }: { value: number }) {
  if (value >= 100) return <TrendingUp className="h-4 w-4 text-emerald-500" />;
  if (value >= 80) return <Minus className="h-4 w-4 text-amber-500" />;
  return <TrendingDown className="h-4 w-4 text-red-500" />;
}

/* ------------------------------------------------------------------ */
/*  Import section (collapsible)                                       */
/* ------------------------------------------------------------------ */

function ImportSection({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setOpen = onOpenChange;
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  function downloadTemplate() {
    const wb = XLSX.utils.book_new();
    const today = new Date();
    const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const exampleDate1 = new Date(nextMonth.getFullYear(), nextMonth.getMonth(), 1);
    const exampleDate2 = new Date(nextMonth.getFullYear(), nextMonth.getMonth(), 2);
    const headerRow = ['Дата', 'nmId_1', 'nmId_2', 'nmId_3'];
    // Разные примеры для разных листов — чтобы было понятно, что куда вводить.
    const examples: Record<string, any[][]> = {
      'Заказы (шт)':  [[exampleDate1, 5, 3, 0],   [exampleDate2, 7, 4, 1]],
      'Заказы (руб)': [[exampleDate1, 5000, 4500, 0], [exampleDate2, 7000, 6000, 1500]],
      'Продажи (шт)': [[exampleDate1, 4, 3, 0],   [exampleDate2, 6, 4, 1]],
      'Продажи (руб)': [[exampleDate1, 4000, 4500, 0], [exampleDate2, 6000, 6000, 1500]],
    };
    for (const [sheetName, dataRows] of Object.entries(examples)) {
      const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows], { cellDates: true });
      ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }
    XLSX.writeFile(wb, 'plan_template.xlsx');
  }

  async function run(dryRun: boolean) {
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const buf = await file.arrayBuffer();
      const xlsxBase64 = toBase64(buf);
      const res = await apiFetch('/plans/import/xlsx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          actorUserId: getUserIdOrNull(),
          xlsxBase64,
          overwrite: true,
          dryRun,
        }),
      });
      setResult(res);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <button
        className="w-full flex items-center justify-between p-5 text-left"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-2">
          <Upload className="h-4 w-4 text-gray-500" />
          <span className="text-sm font-semibold text-gray-700">Импорт плана из XLSX</span>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-gray-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100">
          <div className="mt-4 text-sm text-gray-500 space-y-1">
            <div>
              Загрузи xlsx-шаблон с 4 листами:
              <code className="ml-1 rounded bg-gray-100 px-1 text-[11px]">Заказы (шт)</code>,
              <code className="ml-1 rounded bg-gray-100 px-1 text-[11px]">Заказы (руб)</code>,
              <code className="ml-1 rounded bg-gray-100 px-1 text-[11px]">Продажи (шт)</code>,
              <code className="ml-1 rounded bg-gray-100 px-1 text-[11px]">Продажи (руб)</code>.
            </div>
            <div>
              Формат каждого листа: первая ячейка — «Дата», в строке 1 справа — nmId товаров,
              далее по строкам идут даты и числовые значения.
            </div>
            <div>
              Не уверен в формате — нажми «Скачать шаблон» ниже, заполни его и загрузи обратно.
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              variant="neutral"
              size="sm"
              onClick={downloadTemplate}
              leftIcon={<Download className="h-4 w-4" />}
              title="Скачать пустой шаблон с правильными названиями листов"
            >
              Скачать шаблон
            </Button>

            <input
              type="file"
              accept=".xlsx"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-xs text-gray-700"
            />

            <Button
              variant="neutral"
              size="sm"
              disabled={!file || loading}
              onClick={() => run(true)}
              title="Проверить файл без сохранения"
            >
              {loading ? '...' : 'Проверить'}
            </Button>

            <Button
              size="sm"
              disabled={!file || loading}
              onClick={() => run(false)}
              title="Импорт с перезаписью пересекающегося диапазона"
            >
              {loading ? 'Импорт...' : 'Импортировать'}
            </Button>

            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                {error}
              </div>
            )}
          </div>

          {result && (
            <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
              <div className="font-medium">Результат</div>
              <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-gray-500">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Empty state                                                        */
/* ------------------------------------------------------------------ */

function EmptyState({ onOpenImport }: { onOpenImport?: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-16 text-center">
        <div className="rounded-2xl bg-gray-100 p-4 mb-4">
          <FileSpreadsheet className="h-10 w-10 text-gray-500" />
        </div>
        <h3 className="text-lg font-semibold text-gray-800 mb-2">Нет данных плана</h3>
        <p className="text-sm text-gray-500 max-w-md mb-6">
          Чтобы увидеть аналитику факт/план, импортируйте XLSX-шаблон с плановыми показателями.
          Шаблон содержит 4 листа: Заказы и Продажи в штуках и рублях.
        </p>
        <Button
          variant="primary"
          leftIcon={<Upload className="h-4 w-4" />}
          onClick={onOpenImport}
        >
          Импортировать план
        </Button>
      </CardContent>
    </Card>
  );
}

/* ================================================================== */
/*  Main page                                                          */
/* ================================================================== */

export default function PlanPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopId = useWorkspaceStore((s) => s.shopId);

  /* ---- State ---- */
  const [month, setMonth] = useState(currentMonth);
  const [tagId, setTagId] = useState<number | null>(null);
  const [data, setData] = useState<PlanSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('pctQty');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [importOpen, setImportOpen] = useState(false);
  const importRef = useRef<HTMLDivElement>(null);

  const openImport = useCallback(() => {
    setImportOpen(true);
    // small delay so the section animates open before we scroll to it
    setTimeout(() => {
      importRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }, []);

  const monthOptions = useMemo(buildMonthOptions, []);

  /* ---- Fetch ---- */
  const fetchData = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      // Backend /plans/summary requires start, end, metric (not month).
      // Derive YYYY-MM-DD range from the selected "YYYY-MM" month.
      const [y, m] = month.split('-').map(Number);
      if (!y || !m) {
        setData(null);
        return;
      }
      const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month = last day of current
      const start = `${month}-01`;
      const end = `${month}-${String(lastDay).padStart(2, '0')}`;

      const params = new URLSearchParams({ start, end, metric: 'orders_qty' });
      if (tagId != null) params.set('tagId', String(tagId));
      params.set('workspaceId', String(workspaceId));
      if (shopId) params.set('shopId', String(shopId));
      const res = await apiFetch<PlanSummary>(`/plans/summary?${params}`);
      setData(res);
    } catch (e: any) {
      // API may not exist yet -- fall back gracefully
      console.warn('Plan summary fetch failed:', e);
      setData(null);
      // Only show error if it's not a 404 (endpoint not yet implemented)
      if (!String(e?.message ?? e).includes('404')) {
        setError(String(e?.message ?? e));
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceId, month, tagId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // После «Сохранить в таблицу артикулов» обновляем Products table — иначе
  // юзер не видит свежие planQty в строках без ручного refresh.
  useEffect(() => {
    const handler = () => fetchData();
    window.addEventListener('plan-distribution-saved', handler);
    return () => window.removeEventListener('plan-distribution-saved', handler);
  }, [fetchData]);

  useShopChange(fetchData);

  /* ---- Sort logic ---- */
  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  const sortedProducts = useMemo(() => {
    if (!data?.products) return [];
    const rows = [...data.products];
    rows.sort((a, b) => {
      let va: number | string = 0;
      let vb: number | string = 0;
      switch (sortKey) {
        case 'name':
          va = a.name.toLowerCase();
          vb = b.name.toLowerCase();
          break;
        case 'planQty':
          va = a.planQty;
          vb = b.planQty;
          break;
        case 'factQty':
          va = a.factQty;
          vb = b.factQty;
          break;
        case 'pctQty':
          va = pct(a.factQty, a.planQty);
          vb = pct(b.factQty, b.planQty);
          break;
        case 'planRevenue':
          va = a.planRevenue;
          vb = b.planRevenue;
          break;
        case 'factRevenue':
          va = a.factRevenue;
          vb = b.factRevenue;
          break;
        case 'pctRevenue':
          va = pct(a.factRevenue, a.planRevenue);
          vb = pct(b.factRevenue, b.planRevenue);
          break;
      }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return rows;
  }, [data?.products, sortKey, sortDir]);

  /* ---- Export ---- */
  function handleExport() {
    if (!data) return;
    const header = ['Товар', 'План шт', 'Факт шт', '% шт', 'План руб', 'Факт руб', '% руб'];
    const csvRows = [header.join(';')];
    for (const p of data.products) {
      csvRows.push(
        [
          `"${p.name}"`,
          p.planQty,
          p.factQty,
          pct(p.factQty, p.planQty).toFixed(1),
          p.planRevenue,
          p.factRevenue,
          pct(p.factRevenue, p.planRevenue).toFixed(1),
        ].join(';'),
      );
    }
    const blob = new Blob(['\uFEFF' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fact-plan-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ---- Derived ---- */
  const hasData = data && data.products && data.products.length > 0;
  const tags: TagOption[] = data?.tags ?? [];
  const ordersPct = data ? pct(data.factOrdersQty, data.planOrdersQty) : 0;
  const revenuePct = data ? pct(data.factRevenue, data.planRevenue) : 0;

  /* ---- Render ---- */
  return (
    <AppShell title="Факт / План">
      <div className="p-6 space-y-6">
        {/* ===== Filters row ===== */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Месяц</span>
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger className="h-10 w-[220px] text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {monthOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {tags.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Тег</span>
              <TagFilter
                tags={tags}
                value={tagId}
                onChange={setTagId}
                placeholder="Все товары"
                className="w-[200px]"
              />
            </div>
          )}

          <div className="ml-auto flex items-end gap-2">
            {hasData && (
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Download className="h-4 w-4" />}
                onClick={handleExport}
              >
                Экспорт отчёта
              </Button>
            )}
          </div>
        </div>

        {/* ===== Loading ===== */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-indigo-500" />
          </div>
        )}

        {/* ===== Monthly target + daily grid (по шаблону оператора) ===== */}
        <MonthlyTargetSection workspaceId={workspaceId} shopId={shopId ?? undefined} month={month} />

        {/* ===== Авто-предложение плана по SKU (продажи 30д + тренд + остатки FBO/FBS) ===== */}
        <AutoSuggestSection workspaceId={workspaceId} shopId={shopId ?? undefined} month={month} />

        {/* ===== Error ===== */}
        {!loading && error && (
          <Card>
            <CardContent>
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                {error}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ===== Empty state ===== */}
        {!loading && !error && !hasData && <EmptyState onOpenImport={openImport} />}

        {/* ===== Summary cards ===== */}
        {!loading && hasData && (
          <>
            <div className="flex flex-wrap gap-4">
              <SummaryCard
                title="Заказы (шт)"
                planValue={data!.planOrdersQty}
                factValue={data!.factOrdersQty}
                formatter={formatNumber}
                unit="шт"
              />
              <SummaryCard
                title="Выручка"
                planValue={data!.planRevenue}
                factValue={data!.factRevenue}
                formatter={formatRub}
                unit="руб"
              />
            </div>

            {/* ===== Распределить план по SKU (перенесено из MonthlyTargetSection: рядом с таблицей, в которую вносятся изменения) ===== */}
            <PlanDistributionSection workspaceId={workspaceId} shopId={shopId ?? undefined} month={month} />

            {/* ===== Products table ===== */}
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50/50">
                      <SortHeader
                        label="Товар"
                        sortKey="name"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-left min-w-[200px]"
                      />
                      <SortHeader
                        label="План шт"
                        sortKey="planQty"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortHeader
                        label="Факт шт"
                        sortKey="factQty"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortHeader
                        label="% шт"
                        sortKey="pctQty"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortHeader
                        label="План руб"
                        sortKey="planRevenue"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortHeader
                        label="Факт руб"
                        sortKey="factRevenue"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <SortHeader
                        label="% руб"
                        sortKey="pctRevenue"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                        className="text-right"
                      />
                      <th className="px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider text-center">
                        Тренд
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {sortedProducts.map((row) => {
                      const qPct = pct(row.factQty, row.planQty);
                      const rPct = pct(row.factRevenue, row.planRevenue);
                      return (
                        <tr key={row.nmId} className="hover:bg-gray-50/50 transition-colors">
                          {/* Product */}
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-3">
                              {row.photo ? (
                                <img
                                  src={row.photo}
                                  alt=""
                                  className="h-9 w-9 rounded-lg object-cover bg-gray-100 shrink-0"
                                />
                              ) : (
                                <div className="h-9 w-9 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                                  <Package className="h-4 w-4 text-gray-500" />
                                </div>
                              )}
                              <div className="min-w-0">
                                <div className="font-medium text-gray-900 truncate max-w-[250px]">
                                  {row.name}
                                </div>
                                <div className="text-xs text-gray-500"><NmIdLink nmId={row.nmId} className="text-blue-500 hover:underline" /></div>
                              </div>
                            </div>
                          </td>
                          {/* Plan qty — inline editable. Click → input → blur/Enter saves. */}
                          <td className="px-3 py-3 text-right tabular-nums">
                            <InlinePlanCell
                              value={row.planQty}
                              onSave={async (newValue) => {
                                if (!workspaceId) return;
                                try {
                                  await apiFetch('/plans/upsert', {
                                    method: 'POST',
                                    body: JSON.stringify({
                                      workspaceId,
                                      ...(shopId ? { shopId } : {}),
                                      actorUserId: getUserIdOrNull() ?? undefined,
                                      nmId: row.nmId,
                                      month,
                                      metric: 'orders_qty',
                                      value: newValue,
                                    }),
                                  });
                                  await fetchData();
                                } catch (e: any) {
                                  setError(e?.message ?? 'Ошибка сохранения');
                                }
                              }}
                            />
                          </td>
                          {/* Fact qty */}
                          <td className="px-3 py-3 text-right tabular-nums font-medium text-gray-900">
                            {formatNumber(row.factQty)}
                          </td>
                          {/* % qty */}
                          <td className="px-3 py-3 text-right">
                            <Badge variant={pctBadgeVariant(qPct)} size="sm" className="tabular-nums">
                              {formatPct(qPct)}%
                            </Badge>
                          </td>
                          {/* Plan revenue */}
                          <td className="px-3 py-3 text-right tabular-nums text-gray-500">
                            {formatRub(row.planRevenue)}
                          </td>
                          {/* Fact revenue */}
                          <td className="px-3 py-3 text-right tabular-nums font-medium text-gray-900">
                            {formatRub(row.factRevenue)}
                          </td>
                          {/* % revenue */}
                          <td className="px-3 py-3 text-right">
                            <Badge variant={pctBadgeVariant(rPct)} size="sm" className="tabular-nums">
                              {formatPct(rPct)}%
                            </Badge>
                          </td>
                          {/* Trend */}
                          <td className="px-3 py-3 text-center">
                            <TrendIndicator value={qPct} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}

        {/* ===== Import section (collapsible) ===== */}
        <div ref={importRef}>
          <ImportSection workspaceId={workspaceId} open={importOpen} onOpenChange={setImportOpen} />
        </div>
      </div>

      {/* AI Analyze Button — обсудить план/факт с агентом */}
      <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-30">
        <AiAnalyzeButton
          context={{ page: 'plan', month, shopId: shopId ?? undefined }}
          prompt="Проанализируй план/факт за выбранный месяц. Где идём по плану, где отстаём?"
          label="Обсудить с ИИ"
        />
      </div>
    </AppShell>
  );
}
