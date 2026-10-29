/**
 * Унифицированная KPI-плашка для табов /finance.
 * Тот же стиль что Stat в ByProductTab.
 */
export function FinanceStat({
  label,
  value,
  red,
  highlight,
  raw,
}: {
  label: string;
  value: number | string;
  red?: boolean;
  highlight?: boolean;
  raw?: boolean;
}) {
  const numeric = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.-]/g, '')) || 0;
  const colorClass = highlight
    ? numeric >= 0
      ? 'text-emerald-700'
      : 'text-red-600'
    : red
    ? 'text-red-600'
    : 'text-gray-900';
  const formatRub = (n: number) => new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₽';
  const display = raw
    ? String(value)
    : typeof value === 'number'
    ? formatRub(value)
    : formatRub(numeric);
  return (
    <div className={highlight ? 'rounded-md bg-emerald-50 border border-emerald-200 p-2' : 'rounded-md border border-gray-200 p-2'}>
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-base font-semibold ${colorClass}`}>{display}</div>
    </div>
  );
}
