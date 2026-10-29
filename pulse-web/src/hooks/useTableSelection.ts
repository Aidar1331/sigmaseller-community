'use client';

/**
 * useTableSelection — Excel-style выделение числовых ячеек таблицы.
 *
 * Поведение (как в Google Sheets / Excel):
 *  - клик по ячейке → выделить её одну.
 *  - повторный клик по той же выделенной → снять.
 *  - Shift-клик → выделить диапазон строк в той же колонке от lastIdx до idx.
 *  - Ctrl/Cmd-клик → toggle конкретной ячейки.
 *  - смена колонки → старое выделение сбрасывается.
 *  - Esc → полный сброс.
 *
 * Возвращает готовые helpers `handleClick` / `isSelected` и предрассчитанную
 * статистику `stats` (count/sum/avg/min/max) для текущего выделения.
 * Sum для процентных колонок не имеет смысла — используйте `SelectionBar`,
 * она сама умеет скрывать сумму для unit='%' .
 *
 * История: вытащено из `components/finance/ByProductTab.tsx` (там это
 * сидело inline). Контракт сохранён 1:1.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

export type SelectionUnit = '₽' | '%' | 'шт' | '';

export interface SelectionColumn {
  /** Стабильный ключ колонки. */
  key: string;
  /** Заголовок, который покажет SelectionBar. */
  label: string;
  /** Единица измерения — влияет на форматирование и отключает Sum для '%'. */
  unit?: SelectionUnit;
}

export interface SelectionStats {
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
}

export interface SelectionState {
  /** Активная колонка (или null если ничего не выделено). */
  selCol: string | null;
  /** Метаданные активной колонки. */
  selColMeta: SelectionColumn | null;
  /** Map<rowIdx, числовое значение>. Только для текущего selCol. */
  selected: Map<number, number>;
  /** Аггрегаты по выделению (null если выделение пустое). */
  stats: SelectionStats | null;
}

export interface UseTableSelectionResult<T> extends SelectionState {
  /** Клик по числовой ячейке: вешайте на onClick td. */
  handleClick: (colKey: string, rowIdx: number, e: React.MouseEvent) => void;
  /** Подсветка ячейки. */
  isSelected: (colKey: string, rowIdx: number) => boolean;
  /** Полный сброс выделения. */
  clear: () => void;
}

interface UseTableSelectionOptions<T> {
  rows: T[];
  columns: SelectionColumn[];
  /**
   * Достать число из строки для колонки. Если колонки в БД лежат в копейках —
   * делите тут на 100, чтобы Sum/Avg сразу выходили в рублях.
   */
  getValue: (row: T, colKey: string) => number;
  /**
   * Доп. зависимости, после смены которых выделение сбрасывается (фильтр,
   * сортировка, период). Передавать сериализуемые значения.
   */
  resetDeps?: ReadonlyArray<unknown>;
}

export function useTableSelection<T>(
  options: UseTableSelectionOptions<T>,
): UseTableSelectionResult<T> {
  const { rows, columns, getValue, resetDeps } = options;

  const [selCol, setSelCol] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<number, number>>(new Map());
  const [lastIdx, setLastIdx] = useState<number | null>(null);

  const colByKey = useMemo(() => {
    const m = new Map<string, SelectionColumn>();
    for (const c of columns) m.set(c.key, c);
    return m;
  }, [columns]);

  const clear = useCallback(() => {
    setSelected(new Map());
    setSelCol(null);
    setLastIdx(null);
  }, []);

  // Esc — снять выделение.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clear]);

  // Сброс при смене внешних зависимостей (фильтр/сорт/период).
  const depKey = resetDeps ? JSON.stringify(resetDeps) : '';
  useEffect(() => {
    clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey]);

  const handleClick = useCallback(
    (colKey: string, idx: number, e: React.MouseEvent) => {
      e.preventDefault();
      const row = rows[idx];
      if (row === undefined) return;
      const value = getValue(row, colKey);

      // Смена колонки → сбрасываем старое выделение, оставляем только эту ячейку.
      if (selCol !== colKey) {
        const m = new Map<number, number>();
        m.set(idx, value);
        setSelCol(colKey);
        setSelected(m);
        setLastIdx(idx);
        return;
      }

      // Shift-клик → диапазон от lastIdx до idx (включительно).
      if (e.shiftKey && lastIdx !== null) {
        const from = Math.min(lastIdx, idx);
        const to = Math.max(lastIdx, idx);
        const m = new Map(selected);
        for (let i = from; i <= to; i++) {
          const r = rows[i];
          if (r !== undefined) m.set(i, getValue(r, colKey));
        }
        setSelected(m);
        setLastIdx(idx);
        return;
      }

      // Ctrl/Cmd-клик → toggle ячейки.
      if (e.ctrlKey || e.metaKey) {
        const m = new Map(selected);
        if (m.has(idx)) m.delete(idx);
        else m.set(idx, value);
        setSelected(m);
        setLastIdx(idx);
        if (m.size === 0) setSelCol(null);
        return;
      }

      // Обычный клик. Если кликаем по единственной выделенной ячейке — снимаем.
      if (selected.size === 1 && selected.has(idx)) {
        clear();
        return;
      }
      const m = new Map<number, number>();
      m.set(idx, value);
      setSelected(m);
      setLastIdx(idx);
    },
    [rows, getValue, selCol, selected, lastIdx, clear],
  );

  const isSelected = useCallback(
    (colKey: string, idx: number) => selCol === colKey && selected.has(idx),
    [selCol, selected],
  );

  const stats = useMemo<SelectionStats | null>(() => {
    if (selected.size === 0) return null;
    const vals = Array.from(selected.values());
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const v of vals) {
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { count: vals.length, sum, avg: sum / vals.length, min, max };
  }, [selected]);

  const selColMeta = selCol ? colByKey.get(selCol) ?? null : null;

  return { selCol, selColMeta, selected, stats, handleClick, isSelected, clear };
}
