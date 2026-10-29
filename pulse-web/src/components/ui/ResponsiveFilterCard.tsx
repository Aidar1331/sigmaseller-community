'use client';

import * as React from 'react';
import { useState } from 'react';
import { Filter } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/cn';

interface Props {
  /** Содержимое фильтров (DateRangePicker, ToggleGroup, ProductSearchInput, ...) */
  children: React.ReactNode;
  /** Заголовок шита (default "Фильтры") */
  title?: string;
  /** Сколько фильтров сейчас активно — показывается badge'ом на кнопке-триггере */
  activeCount?: number;
  /** Краткое summary активных фильтров для отображения на кнопке-триггере под заголовком */
  summary?: React.ReactNode;
  /** Дополнительный footer внутри BottomSheet (например, кнопка "Применить") */
  footer?: React.ReactNode;
  /** Доп классы для внешней Card обёртки */
  className?: string;
}

/**
 * Responsive filter wrapper:
 *  - Desktop (>= md): обычная Card с фильтрами всегда видна.
 *  - Mobile  (< md):  Card-trigger — кнопка «Фильтры [N активных]» + bottom-sheet
 *                     при тапе. Сами фильтры рендерятся внутри sheet.
 *
 * Преимущество: один и тот же JSX-блок children, никакого дублирования.
 * Применяй на любой странице где есть filter-row выше таблицы/графика.
 */
export function ResponsiveFilterCard({
  children,
  title = 'Фильтры',
  activeCount,
  summary,
  footer,
  className,
}: Props) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  if (!isMobile) {
    // Desktop: full card always expanded
    return <Card className={cn('p-4', className)}>{children}</Card>;
  }

  // Mobile: compact trigger + bottom sheet
  return (
    <>
      <Card className={cn('p-3', className)}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full flex items-center justify-between gap-2 min-h-[44px] text-left"
          aria-label="Открыть фильтры"
          data-compact
        >
          <div className="flex items-center gap-2 min-w-0">
            <Filter className="h-4 w-4 text-violet-600 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900">{title}</div>
              {summary && (
                <div className="text-xs text-gray-500 truncate">{summary}</div>
              )}
            </div>
          </div>
          {activeCount != null && activeCount > 0 && (
            <Badge variant="neutral" size="sm">
              {activeCount}
            </Badge>
          )}
        </button>
      </Card>

      <BottomSheet
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        footer={footer}
      >
        <div className="space-y-4 p-1">{children}</div>
      </BottomSheet>
    </>
  );
}
