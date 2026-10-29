'use client';

import * as React from 'react';
import { exportToXlsx, exportToPdf, type ExportColumn } from '@/lib/exportTable';

interface ExportButtonProps {
  /** Заголовок таблицы — идёт в имя файла и header PDF. */
  title?: string;
  /** Подзаголовок / контекст (период, магазин). */
  subtitle?: string;
  columns: ExportColumn[];
  rows: Array<Record<string, unknown>>;
  /** Дополнительный класс для кнопки (обычно не нужен). */
  className?: string;
  /** Короткий label, по умолчанию "Скачать". */
  label?: string;
  /** Короткий вариант без "▾" и label — только иконка (для плотных tool-bar'ов). */
  compact?: boolean;
  /** Показать/спрятать. Если rows пусто — кнопка disabled. */
  disabled?: boolean;
}

/**
 * Универсальная кнопка экспорта таблицы в Excel и PDF.
 * Одна точка — нигде не дублируем логику. PDF идёт с кириллицей через
 * DejaVu Sans (cache один раз за сессию).
 */
export function ExportButton({
  title,
  subtitle,
  columns,
  rows,
  className,
  label = 'Скачать',
  compact,
  disabled,
}: ExportButtonProps) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<'xlsx' | 'pdf' | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const doExport = async (fmt: 'xlsx' | 'pdf') => {
    setOpen(false);
    setBusy(fmt);
    try {
      const payload = { title, subtitle, columns, rows };
      if (fmt === 'xlsx') await exportToXlsx(payload);
      else await exportToPdf(payload);
    } catch (err) {
      console.error('export failed', err);
      alert(`Не удалось скачать: ${err instanceof Error ? err.message : 'ошибка'}`);
    } finally {
      setBusy(null);
    }
  };

  const isDisabled = disabled || rows.length === 0 || !!busy;

  return (
    <div ref={rootRef} className={`relative inline-block ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => !isDisabled && setOpen((o) => !o)}
        disabled={isDisabled}
        className="px-3 py-1.5 text-xs font-medium bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
        title={rows.length === 0 ? 'Нет данных для экспорта' : 'Скачать таблицу'}
      >
        {busy ? '⏳' : '⬇'}
        {!compact && <span>{busy ? (busy === 'xlsx' ? 'Excel…' : 'PDF…') : label}</span>}
        {!compact && <span className="text-gray-500">▾</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white border shadow-lg rounded z-20 min-w-[140px]">
          <button
            type="button"
            onClick={() => doExport('xlsx')}
            className="block w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50"
          >
            📊 Excel (.xlsx)
          </button>
          <button
            type="button"
            onClick={() => doExport('pdf')}
            className="block w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 border-t"
          >
            📄 PDF
          </button>
        </div>
      )}
    </div>
  );
}
