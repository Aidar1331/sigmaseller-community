'use client';

import { cn } from '@/lib/cn';

interface MetaBadgeProps {
  requiredMeta?: string[];
  filledMeta?: string[];
  className?: string;
  showLabels?: boolean;
}

const META_LABELS: Record<string, string> = {
  sgtin: 'ЧЗ',
  imei: 'IMEI',
  uin: 'УИН',
  gtin: 'GTIN',
  expiration: 'Срок',
  customsDeclaration: 'ГТД',
};

const META_FULL_LABELS: Record<string, string> = {
  sgtin: 'Честный знак',
  imei: 'IMEI',
  uin: 'УИН',
  gtin: 'GTIN (Беларусь)',
  expiration: 'Срок годности',
  customsDeclaration: 'ГТД',
};

export function MetaBadge({ requiredMeta, filledMeta, className, showLabels = false }: MetaBadgeProps) {
  if (!requiredMeta?.length) return null;

  const filled = new Set(filledMeta ?? []);
  const missing = requiredMeta.filter((m) => !filled.has(m));

  if (missing.length === 0) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
          'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
          className
        )}
        title="Маркировка заполнена"
      >
        ✓ {showLabels ? 'Маркировка' : ''}
      </span>
    );
  }

  const labels = showLabels ? META_FULL_LABELS : META_LABELS;
  const missingLabels = missing.map((m) => labels[m] || m);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
        className
      )}
      title={`Требуется: ${missing.map(m => META_FULL_LABELS[m] || m).join(', ')}`}
    >
      ⚠ {missingLabels.join(', ')}
    </span>
  );
}

/**
 * Compact version for tables
 */
export function MetaBadgeCompact({ requiredMeta, filledMeta }: Pick<MetaBadgeProps, 'requiredMeta' | 'filledMeta'>) {
  if (!requiredMeta?.length) return null;

  const filled = new Set(filledMeta ?? []);
  const missing = requiredMeta.filter((m) => !filled.has(m));

  if (missing.length === 0) {
    return (
      <span className="text-green-700 dark:text-green-400" title="Маркировка ОК">
        ✓
      </span>
    );
  }

  return (
    <span
      className="text-amber-700 dark:text-amber-400 cursor-help"
      title={`Требуется: ${missing.map(m => META_FULL_LABELS[m] || m).join(', ')}`}
    >
      ⚠
    </span>
  );
}
