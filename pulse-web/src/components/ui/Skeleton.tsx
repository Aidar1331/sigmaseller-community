'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Skeleton — базовый загрузчик. Использует существующий .skeleton класс
 * (shimmer-анимация из globals.css), fallback — animate-pulse.
 *
 * Использование:
 *   <Skeleton.Line w="60%" />
 *   <Skeleton.Card />
 *   <Skeleton.TableRow cols={4} />
 *   <Skeleton.Kpi />
 */

interface BaseProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
}

function Box({ className, ...props }: BaseProps) {
  return (
    <div
      className={cn('rounded-md bg-gray-100 animate-pulse', className)}
      aria-hidden="true"
      {...props}
    />
  );
}

interface LineProps extends BaseProps {
  /** Ширина строки. Можно "60%", "120px" или Tailwind class через className. */
  w?: string | number;
  /** Высота. По умолчанию h-3 (12px). */
  h?: string | number;
}

function Line({ w, h, className, style, ...props }: LineProps) {
  const finalStyle: React.CSSProperties = {
    width: typeof w === 'number' ? `${w}px` : w,
    height: typeof h === 'number' ? `${h}px` : h,
    ...style,
  };
  return (
    <Box
      className={cn('h-3 w-full max-w-full rounded', !h && 'h-3', className)}
      style={finalStyle}
      {...props}
    />
  );
}

function Card({ className, ...props }: BaseProps) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-gray-200 bg-white p-5 space-y-3',
        className
      )}
      aria-hidden="true"
      {...props}
    >
      <Box className="h-4 w-1/3" />
      <Box className="h-3 w-full" />
      <Box className="h-3 w-5/6" />
      <Box className="h-3 w-4/6" />
    </div>
  );
}

interface TableRowProps extends BaseProps {
  cols: number;
}

function TableRow({ cols, className, ...props }: TableRowProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 border-b border-gray-100 px-3 py-3 last:border-b-0',
        className
      )}
      aria-hidden="true"
      {...props}
    >
      {Array.from({ length: cols }).map((_, i) => (
        <Box
          key={i}
          className={cn(
            'h-3 flex-1',
            i === 0 ? 'max-w-[40%]' : 'max-w-[18%]'
          )}
        />
      ))}
    </div>
  );
}

function Kpi({ className, ...props }: BaseProps) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-gray-200 bg-white p-4 space-y-2',
        className
      )}
      aria-hidden="true"
      {...props}
    >
      <Box className="h-3 w-1/2" />
      <Box className="h-6 w-3/4" />
      <Box className="h-3 w-1/3" />
    </div>
  );
}

/**
 * Default-экспорт — namespace со всеми вариантами. Так удобно писать
 * `<Skeleton.Card />` без 4 импортов.
 */
export const Skeleton = Object.assign(Box, {
  Line,
  Card,
  TableRow,
  Kpi,
});

export type { LineProps as SkeletonLineProps, TableRowProps as SkeletonTableRowProps };
