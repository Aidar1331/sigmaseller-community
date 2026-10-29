'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        success: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
        danger: 'bg-red-50 text-red-700 border border-red-200',
        warning: 'bg-amber-50 text-amber-700 border border-amber-200',
        info: 'bg-blue-50 text-blue-700 border border-blue-200',
        neutral: 'bg-gray-100 text-gray-600 border border-gray-200',
        secondary: 'bg-gray-100 text-gray-600 border border-gray-200',
        destructive: 'bg-red-50 text-red-700 border border-red-200',
        purple: 'bg-purple-50 text-purple-700 border border-purple-200',
        indigo: 'bg-indigo-50 text-indigo-700 border border-indigo-200',
        teal: 'bg-teal-50 text-teal-700 border border-teal-200',
        // Solid variants
        'success-solid': 'bg-emerald-500 text-white',
        'danger-solid': 'bg-red-500 text-white',
        'warning-solid': 'bg-amber-500 text-white',
        'info-solid': 'bg-blue-500 text-white',
        'primary-solid': 'bg-indigo-500 text-white',
      },
      size: {
        sm: 'text-[10px] px-1.5 py-0.5 rounded-md',
        md: 'text-xs px-2 py-0.5 rounded-lg',
        lg: 'text-sm px-2.5 py-1 rounded-lg',
      },
    },
    defaultVariants: {
      variant: 'neutral',
      size: 'md',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, size, ...props }, ref) => (
    <span ref={ref} className={cn(badgeVariants({ variant, size }), className)} {...props} />
  )
);
Badge.displayName = 'Badge';

/* ----------  DeltaBadge ---------- */

interface DeltaBadgeProps {
  pct?: number | null;
  className?: string;
  showIcon?: boolean;
  size?: 'sm' | 'md' | 'lg';
  inverted?: boolean;
}

function DeltaBadge({ pct, className, showIcon = true, size = 'sm', inverted = false }: DeltaBadgeProps) {
  if (pct === undefined || pct === null) return null;

  const isPositive = inverted ? pct < 0 : pct > 0;
  const isNegative = inverted ? pct > 0 : pct < 0;
  
  const variant: BadgeProps['variant'] =
    isPositive ? 'success' : isNegative ? 'danger' : 'neutral';

  const Icon = pct > 0 ? ArrowUp : pct < 0 ? ArrowDown : Minus;

  // Compact formatting: >999% → no decimals, >9999% → "9.9K%"
  const absPct = Math.abs(pct);
  let pctStr: string;
  if (absPct >= 10000) {
    pctStr = (pct / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  } else if (absPct >= 100) {
    pctStr = Math.round(pct).toString();
  } else {
    pctStr = pct.toFixed(1);
  }

  return (
    <Badge variant={variant} size={size} className={cn('tabular-nums font-semibold whitespace-nowrap', className)}>
      {showIcon && <Icon className={cn(size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3')} />}
      {pct > 0 ? '+' : ''}
      {pctStr}%
    </Badge>
  );
}

/* ----------  StatusBadge ---------- */

interface StatusBadgeProps {
  status: 'online' | 'offline' | 'busy' | 'away' | 'error' | 'success' | 'pending';
  label?: string;
  pulse?: boolean;
  className?: string;
}

function StatusBadge({ status, label, pulse = false, className }: StatusBadgeProps) {
  const statusConfig = {
    online: { color: 'bg-emerald-500', text: 'text-emerald-700', label: 'Онлайн' },
    offline: { color: 'bg-gray-400', text: 'text-gray-600', label: 'Офлайн' },
    busy: { color: 'bg-red-500', text: 'text-red-700', label: 'Занят' },
    away: { color: 'bg-amber-500', text: 'text-amber-700', label: 'Отошёл' },
    error: { color: 'bg-red-500', text: 'text-red-700', label: 'Ошибка' },
    success: { color: 'bg-emerald-500', text: 'text-emerald-700', label: 'Успешно' },
    pending: { color: 'bg-amber-500', text: 'text-amber-700', label: 'В ожидании' },
  };

  const config = statusConfig[status];

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className={cn(
        'h-2 w-2 rounded-full',
        config.color,
        pulse && 'animate-pulse'
      )} />
      <span className={cn('text-xs font-medium', config.text)}>
        {label ?? config.label}
      </span>
    </span>
  );
}

export { Badge, badgeVariants, DeltaBadge, StatusBadge };
