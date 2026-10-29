/**
 * Universal data-table widget. Агент вызывает этот tool когда хочет показать
 * длинную таблицу (>10 строк), чтобы не обрезать её в markdown и не тратить
 * output-токены на ASCII-форматирование.
 *
 * UI рендерит `DataTableWidget` с сортировкой, поиском, пагинацией и экспортом CSV.
 * Колонки с `type: 'nmId'` автоматически превращаются в ссылки на wildberries.ru.
 */
export interface DataTableColumn {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'nmId' | 'rub' | 'pct' | 'date';
  width?: string;
}

export interface ShowDataTableInput {
  title?: string;
  subtitle?: string;
  columns: DataTableColumn[];
  rows: Array<Record<string, unknown>>;
  pageSize?: number;
  _workspaceId?: number;
  _shopId?: number | null;
}

export async function showDataTable(input: ShowDataTableInput): Promise<string> {
  const columns = Array.isArray(input.columns) ? input.columns : [];
  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (columns.length === 0) {
    return JSON.stringify({ status: 'error', error: 'columns required' });
  }
  return JSON.stringify({
    status: 'ok',
    __widget: 'data_table',
    props: {
      title: input.title ?? null,
      subtitle: input.subtitle ?? null,
      columns,
      rows,
      pageSize: input.pageSize ?? 10,
    },
    summary: `Показано ${rows.length} строк (${columns.length} колонок).`,
  });
}
