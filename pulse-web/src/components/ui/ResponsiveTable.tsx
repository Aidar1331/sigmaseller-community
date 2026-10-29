'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';
import { useIsMobile } from '@/hooks/useMediaQuery';

/**
 * ResponsiveTable
 *
 * Desktop (>= sm): обычная HTML-таблица с собственным горизонтальным скроллом.
 * Mobile  (< sm):  список карточек — каждая строка превращается в карточку,
 *                  где слева label колонки, справа значение.
 *
 * Колонки описываются явно, чтобы FE-код был стабилен и не зависел от того,
 * какой ключ возвращает API.
 */

export type ColumnAlign = 'left' | 'right' | 'center';

export interface ResponsiveColumn<T> {
  key: string;
  label: React.ReactNode;
  /** Custom render. По умолчанию читает (row as any)[key]. */
  render?: (row: T, index: number) => React.ReactNode;
  /** Выравнивание в десктоп-таблице. */
  align?: ColumnAlign;
  /** На мобиле скрыть колонку (например, технические id'шники). */
  hideOnMobile?: boolean;
  /** На десктопе скрыть. */
  hideOnDesktop?: boolean;
  /** Сделать ячейкой-заголовком карточки (крупно сверху, без лейбла). */
  mobileTitle?: boolean;
  /** Кликабельная сортировка. */
  onSort?: () => void;
  /** Индикатор активной сортировки ('asc' | 'desc' | null). */
  sortDir?: 'asc' | 'desc' | null;
  /** Доп классы для th. */
  thClassName?: string;
  /** Доп классы для td. */
  tdClassName?: string;
}

interface ResponsiveTableProps<T> {
  rows: T[];
  columns: ResponsiveColumn<T>[];
  /** Уникальный ключ строки. */
  rowKey: (row: T, index: number) => React.Key;
  /** Клик по строке. */
  onRowClick?: (row: T) => void;
  /** Что показать, если rows пустой. */
  emptyState?: React.ReactNode;
  className?: string;
  /** Дополнительные классы для строки/карточки. */
  rowClassName?: string | ((row: T) => string);
}

export function ResponsiveTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  emptyState,
  className,
  rowClassName,
}: ResponsiveTableProps<T>) {
  const isMobile = useIsMobile();

  if (!rows.length && emptyState) {
    return <div className={cn('p-6 text-center text-sm text-gray-500', className)}>{emptyState}</div>;
  }

  if (isMobile) {
    return <MobileCards rows={rows} columns={columns} rowKey={rowKey} onRowClick={onRowClick} className={className} rowClassName={rowClassName} />;
  }

  return <DesktopTable rows={rows} columns={columns} rowKey={rowKey} onRowClick={onRowClick} className={className} rowClassName={rowClassName} />;
}

function DesktopTable<T>({ rows, columns, rowKey, onRowClick, className, rowClassName }: ResponsiveTableProps<T>) {
  const cols = columns.filter((c) => !c.hideOnDesktop);

  return (
    <div className={cn('table-scroll', className)}>
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 text-xs font-medium text-gray-500">
            {cols.map((col) => (
              <th
                key={col.key}
                className={cn(
                  'py-3 px-3 font-medium',
                  col.align === 'right' && 'text-right',
                  col.align === 'center' && 'text-center',
                  !col.align && 'text-left',
                  col.onSort && 'cursor-pointer select-none hover:text-gray-700',
                  col.thClassName
                )}
                onClick={col.onSort}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {col.sortDir === 'asc' && <span aria-hidden>↑</span>}
                  {col.sortDir === 'desc' && <span aria-hidden>↓</span>}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const extraCls = typeof rowClassName === 'function' ? rowClassName(row) : rowClassName;
            return (
              <tr
                key={rowKey(row, i)}
                className={cn(
                  'border-b border-gray-100 last:border-b-0',
                  onRowClick && 'cursor-pointer hover:bg-indigo-50/40',
                  extraCls
                )}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {cols.map((col) => {
                  const value = col.render ? col.render(row, i) : (row as any)[col.key];
                  return (
                    <td
                      key={col.key}
                      className={cn(
                        'py-2.5 px-3',
                        col.align === 'right' && 'text-right tabular-nums',
                        col.align === 'center' && 'text-center',
                        col.tdClassName
                      )}
                    >
                      {value}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MobileCards<T>({ rows, columns, rowKey, onRowClick, className, rowClassName }: ResponsiveTableProps<T>) {
  const visible = columns.filter((c) => !c.hideOnMobile);
  const titleCol = visible.find((c) => c.mobileTitle);
  const restCols = visible.filter((c) => !c.mobileTitle);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {rows.map((row, i) => {
        const extraCls = typeof rowClassName === 'function' ? rowClassName(row) : rowClassName;
        return (
          <div
            key={rowKey(row, i)}
            className={cn(
              'rounded-xl border border-gray-200 bg-white px-3 py-3',
              onRowClick && 'cursor-pointer active:bg-indigo-50/40',
              extraCls
            )}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            {titleCol && (
              <div className="text-sm font-semibold text-gray-900 mb-2 break-words">
                {titleCol.render ? titleCol.render(row, i) : (row as any)[titleCol.key]}
              </div>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
              {restCols.map((col) => {
                const value = col.render ? col.render(row, i) : (row as any)[col.key];
                return (
                  <React.Fragment key={col.key}>
                    <dt className="text-gray-500 self-center">{col.label}</dt>
                    <dd className="text-gray-900 text-right tabular-nums self-center">{value}</dd>
                  </React.Fragment>
                );
              })}
            </dl>
          </div>
        );
      })}
    </div>
  );
}
