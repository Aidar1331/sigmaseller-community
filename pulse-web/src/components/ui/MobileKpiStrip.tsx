'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * MobileKpiStrip — горизонтально-скроллящаяся sticky-полоска KPI.
 *
 * - Mobile (<sm): horizontal snap-scroll, sticky top-0 (под шапкой),
 *   карточки фиксированной ширины, тень при отрыве от верха.
 * - Desktop (>=sm): обычный grid (2-4-N колонок).
 *
 * Props:
 *   items: массив { label, value, delta?, tone? }
 *   sticky: делать ли sticky-shadow при скролле (default true)
 *   stickyTop: CSS top, по умолчанию 'top-14' (под Header высотой 64px=4rem,
 *     но мы оставляем чуть меньше для тактильной близости)
 */

export type KpiTone = 'default' | 'positive' | 'negative' | 'warning' | 'accent';

export interface KpiItem {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Прирост / изменение. Можно строкой ("+12%") или JSX. */
  delta?: React.ReactNode;
  /** Цветовой акцент. */
  tone?: KpiTone;
  /** Иконка слева (lucide компонент или JSX). */
  icon?: React.ReactNode;
  /** Hint, показывается при тапе/клике в title. */
  hint?: string;
}

interface MobileKpiStripProps {
  items: KpiItem[];
  className?: string;
  /** Включить sticky-поведение под шапкой. */
  sticky?: boolean;
  /** Tailwind-класс top для sticky, например 'top-14' или 'top-16'. */
  stickyTop?: string;
}

const toneStyles: Record<KpiTone, { value: string; delta: string; badge: string }> = {
  default:  { value: 'text-gray-900',     delta: 'text-gray-500',   badge: 'bg-gray-100  text-gray-700'   },
  positive: { value: 'text-emerald-700',  delta: 'text-emerald-600', badge: 'bg-emerald-50 text-emerald-700' },
  negative: { value: 'text-red-700',      delta: 'text-red-600',     badge: 'bg-red-50    text-red-700'     },
  warning:  { value: 'text-amber-700',    delta: 'text-amber-600',   badge: 'bg-amber-50  text-amber-700'   },
  accent:   { value: 'text-indigo-700',   delta: 'text-indigo-600',  badge: 'bg-indigo-50 text-indigo-700'  },
};

export function MobileKpiStrip({
  items,
  className,
  sticky = true,
  stickyTop = 'top-14',
}: MobileKpiStripProps) {
  // Отслеживаем "оторвался от верха" — добавляем тень
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = React.useState(false);

  React.useEffect(() => {
    if (!sticky || !ref.current) return;
    const el = ref.current;
    // Sentinel-элемент перед strip — пересекается с viewport-top => не stuck
    const sentinel = document.createElement('div');
    sentinel.style.cssText = 'position:absolute;top:-1px;height:1px;width:100%;';
    el.style.position = 'relative';
    el.parentElement?.insertBefore(sentinel, el);
    const obs = new IntersectionObserver(
      ([entry]) => setStuck(!entry.isIntersecting),
      { threshold: [1] }
    );
    obs.observe(sentinel);
    return () => {
      obs.disconnect();
      sentinel.remove();
    };
  }, [sticky]);

  return (
    <div
      ref={ref}
      className={cn(
        sticky && `sticky ${stickyTop} z-20`,
        'bg-[var(--bg-base)] transition-shadow duration-200',
        stuck && 'shadow-[0_4px_12px_-6px_rgba(0,0,0,0.12)]',
        className
      )}
    >
      {/* Mobile: scroll-snap */}
      <div
        className={cn(
          'flex gap-2 overflow-x-auto px-4 py-3 -mx-4',
          'snap-x snap-mandatory scroll-px-4',
          'sm:hidden',
          // hide scrollbar
          '[scrollbar-width:none] [-ms-overflow-style:none]',
          '[&::-webkit-scrollbar]:hidden'
        )}
      >
        {items.map((it, i) => (
          <KpiCard key={i} item={it} mobile />
        ))}
      </div>

      {/* Desktop: grid */}
      <div
        className={cn(
          'hidden gap-3 px-0 py-3',
          'sm:grid',
          items.length <= 2 && 'sm:grid-cols-2',
          items.length === 3 && 'sm:grid-cols-3',
          items.length >= 4 && 'sm:grid-cols-2 lg:grid-cols-4',
        )}
      >
        {items.map((it, i) => (
          <KpiCard key={i} item={it} />
        ))}
      </div>
    </div>
  );
}

function KpiCard({ item, mobile }: { item: KpiItem; mobile?: boolean }) {
  const tone = item.tone ?? 'default';
  const styles = toneStyles[tone];
  return (
    <div
      title={item.hint}
      className={cn(
        'rounded-2xl border border-gray-200 bg-white p-3',
        mobile
          ? 'snap-start shrink-0 w-[160px] min-h-[88px]'
          : 'min-h-[88px]'
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-gray-500">
        {item.icon}
        <span className="truncate">{item.label}</span>
      </div>
      <div className={cn('mt-1 text-lg font-semibold tabular-nums truncate', styles.value)}>
        {item.value}
      </div>
      {item.delta != null && (
        <div className={cn('mt-0.5 text-xs tabular-nums', styles.delta)}>
          {item.delta}
        </div>
      )}
    </div>
  );
}
