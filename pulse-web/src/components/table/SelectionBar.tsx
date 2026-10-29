'use client';

/**
 * SelectionBar — плавающая плашка-итог по выделенным ячейкам таблицы.
 * Парная к `useTableSelection`. Показывает Count / Sum / Avg / Min / Max
 * по текущему выделению.
 *
 * Сумма скрывается для процентных колонок (unit='%' ) — её там показывать
 * бессмысленно.
 */

import { X } from 'lucide-react';
import type {
  SelectionColumn,
  SelectionStats,
  SelectionUnit,
} from '@/hooks/useTableSelection';

interface SelectionBarProps {
  col: SelectionColumn | null;
  stats: SelectionStats | null;
  onClear: () => void;
}

function formatVal(n: number, unit: SelectionUnit): string {
  if (unit === '%') return `${n.toFixed(1)}%`;
  const num = n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
  if (unit === '₽') return `${num} ₽`;
  if (unit === 'шт') return `${num} шт`;
  return num;
}

export function SelectionBar({ col, stats, onClear }: SelectionBarProps) {
  if (!col || !stats) return null;
  const unit: SelectionUnit = col.unit ?? '';
  const showSum = unit !== '%';

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 px-2 max-w-[calc(100vw-1rem)]">
      <div className="flex items-center gap-3 sm:gap-4 px-3 sm:px-4 py-2 rounded-full bg-gray-900 text-white shadow-xl text-xs whitespace-nowrap overflow-x-auto">
        <div className="flex items-center gap-1.5">
          <span className="text-gray-400 hidden sm:inline">Столбец:</span>
          <span className="font-medium">{col.label}</span>
        </div>
        <div className="h-4 w-px bg-gray-700 shrink-0" />
        <div className="flex items-center gap-1.5">
          <span className="text-gray-400">Выделено:</span>
          <span className="font-mono font-semibold">{stats.count}</span>
        </div>
        {showSum && (
          <div className="flex items-center gap-1.5">
            <span className="text-gray-400">Сумма:</span>
            <span className="font-mono font-semibold text-violet-300">
              {formatVal(stats.sum, unit)}
            </span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span className="text-gray-400">Среднее:</span>
          <span className="font-mono">{formatVal(stats.avg, unit)}</span>
        </div>
        <div className="hidden sm:flex items-center gap-1.5 text-gray-300">
          <span className="text-gray-500">мин</span>
          <span className="font-mono">{formatVal(stats.min, unit)}</span>
          <span className="text-gray-500 ml-1">макс</span>
          <span className="font-mono">{formatVal(stats.max, unit)}</span>
        </div>
        <button
          onClick={onClear}
          className="ml-1 p-1 rounded hover:bg-gray-800 transition-colors shrink-0"
          title="Сбросить (Esc)"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
