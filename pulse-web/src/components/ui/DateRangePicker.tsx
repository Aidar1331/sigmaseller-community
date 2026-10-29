'use client';

import * as React from 'react';
import { DayPicker, type DateRange } from 'react-day-picker';
import { ru } from 'date-fns/locale';
import { format } from 'date-fns';
import * as Popover from '@radix-ui/react-popover';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';

const QUICK_PERIODS = [
  { label: '7д', days: 7 },
  { label: '14д', days: 14 },
  { label: '30д', days: 30 },
  { label: '60д', days: 60 },
  { label: '90д', days: 90 },
] as const;

interface DateRangePickerProps {
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

function parseDate(s: string): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s + 'T00:00:00');
  return isNaN(d.getTime()) ? undefined : d;
}

export function DateRangePicker({
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  className,
}: DateRangePickerProps) {
  const [open, setOpen] = React.useState(false);
  const [range, setRange] = React.useState<DateRange | undefined>(undefined);
  const clickCount = React.useRef(0);
  const isMobile = useIsMobile();

  const from = parseDate(dateFrom);
  const to = parseDate(dateTo);

  // Sync internal range with external props when popover opens
  React.useEffect(() => {
    if (open) {
      setRange(from || to ? { from, to } : undefined);
      clickCount.current = 0;
    }
  }, [open]);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
  }

  function handleDayClick(day: Date) {
    clickCount.current += 1;

    if (clickCount.current === 1) {
      // First click: start new range from clicked date
      setRange({ from: day, to: undefined });
    } else if (clickCount.current >= 2) {
      // Second click: complete the range
      const firstDate = range?.from ?? day;
      let start = firstDate;
      let end = day;
      if (start > end) [start, end] = [end, start];
      setRange({ from: start, to: end });
      onDateFromChange(isoDate(start));
      onDateToChange(isoDate(end));
      clickCount.current = 0;
      setOpen(false);
    }
  }

  function handleSelect(_nextRange: DateRange | undefined) {
    // Visual update handled by handleDayClick, ignore DayPicker's range logic
  }

  function setQuickPeriod(days: number) {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    onDateFromChange(isoDate(start));
    onDateToChange(isoDate(end));
    setOpen(false);
  }

  const displayText = React.useMemo(() => {
    if (from && to) {
      return `${format(from, 'd MMM', { locale: ru })} – ${format(to, 'd MMM yyyy', { locale: ru })}`;
    }
    if (from) return `${format(from, 'd MMM yyyy', { locale: ru })} – …`;
    return 'Выбрать период';
  }, [from, to]);

  const defaultMonth = React.useMemo(() => {
    const ref = to ?? from ?? new Date();
    const m = new Date(ref);
    m.setMonth(m.getMonth() - 1);
    return m;
  }, [from, to]);

  const isSelecting = clickCount.current === 1 && range?.from;

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-10 items-center gap-2 rounded-xl',
            'border border-gray-300 bg-white px-3 text-sm text-gray-900',
            'transition-all duration-200 ease-out',
            'hover:border-gray-400',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-200',
            !from && 'text-gray-500',
            className
          )}
        >
          <Calendar className="h-4 w-4 text-gray-500" />
          {displayText}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className={cn(
            'z-50 rounded-2xl border border-gray-200 bg-white p-0',
            'shadow-xl',
            'animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2'
          )}
        >
          <DayPicker
            mode="range"
            selected={range}
            onSelect={handleSelect}
            onDayClick={handleDayClick}
            defaultMonth={defaultMonth}
            numberOfMonths={isMobile ? 1 : 2}
            locale={ru}
            showOutsideDays
            classNames={{
              root: 'rdp p-4',
              months: 'rdp-months flex gap-6',
              month: 'rdp-month space-y-4',
              month_caption: 'rdp-month_caption flex justify-center items-center h-8',
              caption_label: 'rdp-caption_label text-sm font-semibold text-gray-900',
              nav: 'rdp-nav flex items-center gap-1',
              button_previous: cn(
                'rdp-button_previous absolute left-3 top-4 h-8 w-8 flex items-center justify-center rounded-lg',
                'border border-gray-200 bg-white text-gray-600',
                'hover:bg-gray-50 hover:text-gray-900',
                'transition-all duration-150'
              ),
              button_next: cn(
                'rdp-button_next absolute right-3 top-4 h-8 w-8 flex items-center justify-center rounded-lg',
                'border border-gray-200 bg-white text-gray-600',
                'hover:bg-gray-50 hover:text-gray-900',
                'transition-all duration-150'
              ),
              weekdays: 'rdp-weekdays flex',
              weekday: 'rdp-weekday w-9 text-center text-[11px] font-medium text-gray-500 uppercase',
              weeks: 'rdp-weeks space-y-1',
              week: 'rdp-week flex',
              day: 'rdp-day h-9 w-9 text-center text-sm p-0',
              day_button: cn(
                'rdp-day_button h-9 w-9 flex items-center justify-center rounded-lg',
                'transition-all duration-150 text-gray-700 cursor-pointer',
                'hover:bg-gray-100'
              ),
              selected: 'rdp-selected bg-indigo-600 text-white hover:bg-indigo-700',
              range_start: 'rdp-range_start bg-indigo-600 text-white rounded-l-lg rounded-r-none',
              range_end: 'rdp-range_end bg-indigo-600 text-white rounded-r-lg rounded-l-none',
              range_middle: 'rdp-range_middle bg-indigo-50 text-indigo-900 rounded-none',
              today: 'rdp-today font-bold text-indigo-600 ring-1 ring-indigo-200',
              outside: 'rdp-outside text-gray-300',
              disabled: 'rdp-disabled text-gray-200',
            }}
            components={{
              Chevron: ({ orientation }) =>
                orientation === 'left' ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />,
            }}
          />

          {isSelecting && range?.from && (
            <div className="flex items-center gap-2 border-t border-gray-100 px-4 py-2 bg-indigo-50">
              <div className="h-2 w-2 rounded-full bg-indigo-500 animate-pulse" />
              <span className="text-xs text-indigo-700 font-medium">
                Начало: {format(range.from, 'd MMM', { locale: ru })} — выберите конечную дату
              </span>
            </div>
          )}

          <div className="flex items-center gap-2 border-t border-gray-100 px-4 py-3 overflow-x-auto">
            <span className="text-xs font-medium text-gray-500 mr-1 shrink-0">Период:</span>
            {QUICK_PERIODS.map((p) => (
              <button
                key={p.days}
                type="button"
                onClick={() => setQuickPeriod(p.days)}
                className={cn(
                  'h-7 shrink-0 rounded-lg px-2.5 text-xs font-medium',
                  'border border-gray-200 bg-white text-gray-600',
                  'hover:bg-indigo-50 hover:text-indigo-700 hover:border-indigo-200',
                  'transition-all duration-150'
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
