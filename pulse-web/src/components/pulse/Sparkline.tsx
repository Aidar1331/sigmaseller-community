'use client';

import { cn } from '@/lib/cn';

export function Sparkline(props: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  className?: string;
}) {
  const w = props.width ?? 100;
  const h = props.height ?? 24;
  const vals = props.values.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return null;

  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;

  const points = props.values
    .map((v, i) => {
      const x = (i / Math.max(1, props.values.length - 1)) * (w - 2) + 1;
      const y = h - 1 - ((v - min) / span) * (h - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const strokeColor = props.color ?? '#6366f1';

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={cn('shrink-0', props.className)}
    >
      {/* Gradient fill under line */}
      <defs>
        <linearGradient id={`sp-grad-${strokeColor.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={strokeColor} stopOpacity="0.15" />
          <stop offset="100%" stopColor={strokeColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline
        fill={`url(#sp-grad-${strokeColor.replace('#', '')})`}
        stroke="none"
        points={`1,${h} ${points} ${w - 1},${h}`}
      />
      <polyline
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}
