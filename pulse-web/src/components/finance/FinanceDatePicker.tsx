'use client';

import * as React from 'react';
import { Calendar } from 'lucide-react';
import { cn } from '@/lib/cn';

const QUICK_PERIODS = [
  { label: '7д', days: 7 },
  { label: '30д', days: 30 },
  { label: '90д', days: 90 },
] as const;

interface Props {
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (v: string) => void;
  onDateToChange: (v: string) => void;
  className?: string;
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

/**
 * Простой пикер для /finance: два input[type=date] (нативный пикер браузера)
 * + быстрые кнопки. Без попапа, без DayPicker — ноль конфликтов с touch.
 */
export function FinanceDatePicker({
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  className,
}: Props) {
  const setQuick = (days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    onDateFromChange(isoDate(start));
    onDateToChange(isoDate(end));
  };
  const setThisMonth = () => {
    const now = new Date();
    onDateFromChange(isoDate(startOfMonth(now)));
    onDateToChange(isoDate(now));
  };
  const setLastMonth = () => {
    const now = new Date();
    const ref = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    onDateFromChange(isoDate(startOfMonth(ref)));
    onDateToChange(isoDate(endOfMonth(ref)));
  };

  return (
    <div className={cn('flex items-end gap-2 flex-wrap', className)}>
      <Calendar className="h-4 w-4 text-gray-500 mb-3" />
      <label className="flex flex-col text-[11px] text-gray-600">
        <span className="mb-1 font-medium">С</span>
        <input
          type="date"
          value={dateFrom}
          max={dateTo || undefined}
          onChange={(e) => onDateFromChange(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
        />
      </label>
      <label className="flex flex-col text-[11px] text-gray-600">
        <span className="mb-1 font-medium">По</span>
        <input
          type="date"
          value={dateTo}
          min={dateFrom || undefined}
          onChange={(e) => onDateToChange(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
        />
      </label>
      <div className="flex items-center gap-1.5 mb-1">
        <button type="button" onClick={setThisMonth} className="h-8 rounded-lg border border-gray-200 bg-white px-2.5 text-xs font-medium text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 hover:border-indigo-200">
          Этот месяц
        </button>
        <button type="button" onClick={setLastMonth} className="h-8 rounded-lg border border-gray-200 bg-white px-2.5 text-xs font-medium text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 hover:border-indigo-200">
          Прошлый
        </button>
        {QUICK_PERIODS.map((p) => (
          <button
            key={p.days}
            type="button"
            onClick={() => setQuick(p.days)}
            className="h-8 rounded-lg border border-gray-200 bg-white px-2.5 text-xs font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 hover:border-indigo-200"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
