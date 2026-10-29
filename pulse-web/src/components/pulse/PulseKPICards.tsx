'use client';

import { formatNumber, formatRub, formatPct } from '@/lib/format';
import type { Overview } from '@/types/pulse';
import { DeltaBadge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import {
  ShoppingCart,
  Package,
  DollarSign,
  Megaphone,
  Percent,
  TrendingUp,
  Banknote,
  type LucideIcon,
} from 'lucide-react';

// Color map for KPI cards - defined outside component to avoid recreation on each render
const COLOR_MAP = {
  indigo: {
    gradient: 'from-indigo-500 to-indigo-600',
    bg: 'bg-indigo-50',
    text: 'text-indigo-600',
    border: 'border-indigo-200',
    shadow: 'shadow-indigo-100',
  },
  purple: {
    gradient: 'from-purple-500 to-purple-600',
    bg: 'bg-purple-50',
    text: 'text-purple-600',
    border: 'border-purple-200',
    shadow: 'shadow-purple-100',
  },
  teal: {
    gradient: 'from-teal-500 to-teal-600',
    bg: 'bg-teal-50',
    text: 'text-teal-600',
    border: 'border-teal-200',
    shadow: 'shadow-teal-100',
  },
  rose: {
    gradient: 'from-rose-500 to-rose-600',
    bg: 'bg-rose-50',
    text: 'text-rose-600',
    border: 'border-rose-200',
    shadow: 'shadow-rose-100',
  },
  amber: {
    gradient: 'from-amber-500 to-amber-600',
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    border: 'border-amber-200',
    shadow: 'shadow-amber-100',
  },
  emerald: {
    gradient: 'from-emerald-500 to-emerald-600',
    bg: 'bg-emerald-50',
    text: 'text-emerald-600',
    border: 'border-emerald-200',
    shadow: 'shadow-emerald-100',
  },
  blue: {
    gradient: 'from-blue-500 to-blue-600',
    bg: 'bg-blue-50',
    text: 'text-blue-600',
    border: 'border-blue-200',
    shadow: 'shadow-blue-100',
  },
} as const;

/* ─── Single KPI card ─── */
function KPICard({
  icon: Icon,
  title,
  value,
  deltaPct,
  negative,
  active,
  color = 'indigo',
  onClick,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  value: string;
  deltaPct?: number;
  negative?: boolean;
  active?: boolean;
  color?: 'indigo' | 'purple' | 'teal' | 'rose' | 'amber' | 'emerald' | 'blue';
  onClick?: () => void;
  testId?: string;
}) {
  const colors = COLOR_MAP[color];

  return (
    <div
      data-testid={testId}
      className={cn(
        'group relative overflow-hidden rounded-2xl border bg-white',
        'transition-all duration-300 ease-out',
        onClick && 'cursor-pointer',
        active
          ? `border-2 ${colors.border} shadow-lg ${colors.shadow}`
          : 'border-gray-200 hover:border-gray-300 hover:shadow-md hover:-translate-y-0.5',
      )}
      onClick={onClick}
    >
      {/* Top gradient bar */}
      <div className={cn(
        'h-1 bg-gradient-to-r',
        active ? colors.gradient : 'from-gray-200 via-gray-300 to-gray-200',
        'transition-all duration-300',
        !active && 'group-hover:from-indigo-400 group-hover:via-purple-400 group-hover:to-pink-400'
      )} />

      <div className="p-4">
        {/* Header: Icon + Title */}
        <div className="flex items-center gap-3 mb-3">
          <div className={cn(
            'flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-300',
            active 
              ? `bg-gradient-to-br ${colors.gradient} text-white shadow-md ${colors.shadow}`
              : `${colors.bg} ${colors.text} group-hover:scale-105`
          )}>
            <Icon className="h-5 w-5" />
          </div>
          <span className="text-xs font-medium text-gray-500 leading-tight">
            {title}
          </span>
        </div>

        {/* Value + Delta */}
        <div className="flex items-baseline gap-1.5 flex-wrap min-w-0">
          <span className={cn(
            'font-bold tabular-nums tracking-tight truncate',
            value.length > 9 ? 'text-lg' : 'text-2xl',
            negative ? 'text-rose-600' : 'text-gray-900'
          )}>
            {value}
          </span>
          <DeltaBadge pct={deltaPct} showIcon={false} />
        </div>
      </div>
    </div>
  );
}

const KPI_METRIC_MAP: Array<{
  metricKey: string;
  icon: LucideIcon;
  title: string;
  color: 'indigo' | 'purple' | 'teal' | 'rose' | 'amber' | 'emerald' | 'blue';
}> = [
  { metricKey: 'ordersCount', icon: ShoppingCart, title: 'Заказы', color: 'indigo' },
  { metricKey: 'ordersRub', icon: DollarSign, title: 'Заказы ₽', color: 'blue' },
  { metricKey: 'salesCount', icon: Package, title: 'Продажи', color: 'teal' },
  { metricKey: 'salesRub', icon: DollarSign, title: 'Продажи ₽', color: 'teal' },
  { metricKey: 'advSpendRub', icon: Megaphone, title: 'Рекл. расход', color: 'amber' },
  { metricKey: 'drrPercent', icon: Percent, title: 'ДРР', color: 'purple' },
  { metricKey: 'marginRub', icon: TrendingUp, title: 'Маржа', color: 'emerald' },
  { metricKey: 'netProfitRub', icon: Banknote, title: 'Чистая прибыль', color: 'emerald' },
];

/** Smart format: auto-shorten large values (10M+ → "10 млн", 1B+ → "1 млрд") */
function formatKpiSmart(v: number, isMoney: boolean): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) {
    return (v / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + ' млрд';
  }
  if (abs >= 10_000_000) {
    return Math.round(v / 1_000_000) + ' млн';
  }
  return isMoney ? formatRub(v) : formatNumber(v);
}

function formatKpiValue(key: string, kpis: Overview['kpis'], showUnits?: boolean): string {
  const v = (kpis as any)[key];
  if (v == null || !Number.isFinite(v)) return '—';
  if (key.endsWith('Percent') || key === 'drrPercent') return formatPct(v) + '%';
  const formatted = formatKpiSmart(v, key.endsWith('Rub'));
  if (!showUnits) return formatted;
  const unit = key.endsWith('Rub') ? ' \u20BD' : ' шт';
  return formatted + unit;
}

export function PulseKPICards({
  overview,
  activeMetric,
  onMetricChange,
  showUnits,
}: {
  overview: Overview | null;
  activeMetric?: string;
  onMetricChange?: (key: string) => void;
  showUnits?: boolean;
}) {
  // Mobile-first: horizontal snap-x scrolling with sticky-shadow on scroll.
  // На mobile (< sm) карточки в одну строку с горизонтальным свайпом — гораздо
  // лучше чем grid 2×4 (раньше превращалось в простыню).
  return (
    <div
      className="
        flex gap-3 overflow-x-auto snap-x snap-mandatory pb-1
        -mx-4 px-4 sm:mx-0 sm:px-0 sm:overflow-x-visible
        sm:grid sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8
      "
      style={{ scrollbarWidth: 'thin' }}
    >
      {KPI_METRIC_MAP.map(({ metricKey, icon, title, color }) => {
        const isEstimated = (overview?.kpis as { isMarginEstimated?: boolean } | undefined)?.isMarginEstimated && (metricKey === 'marginRub' || metricKey === 'netProfitRub');
        return (
          <div key={metricKey} className="snap-start shrink-0 w-[160px] sm:w-auto sm:shrink">
            <KPICard
              icon={icon}
              title={isEstimated ? title + ' ~' : title}
              color={isEstimated ? 'amber' : color}
              testId={`kpi-${metricKey}`}
              value={overview ? formatKpiValue(metricKey, overview.kpis, showUnits) : '—'}
              deltaPct={overview?.compare?.pct ? (overview.compare.pct as any)[metricKey] : undefined}
              negative={metricKey === 'netProfitRub' && overview != null && overview.kpis.netProfitRub < 0}
              active={activeMetric === metricKey}
              onClick={onMetricChange ? () => onMetricChange(metricKey) : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}
