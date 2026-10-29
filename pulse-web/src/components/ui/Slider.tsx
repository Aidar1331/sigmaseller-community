'use client';

import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { cn } from '@/lib/cn';

interface SliderProps {
  value: number;
  onValueChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  suffix?: string;
  showValue?: boolean;
  color?: 'indigo' | 'teal' | 'emerald' | 'amber' | 'rose';
  className?: string;
}

export function Slider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  suffix = '%',
  showValue = true,
  color = 'indigo',
  className,
}: SliderProps) {
  const colorStyles = {
    indigo: { range: 'bg-indigo-500', thumb: 'border-indigo-500', ring: 'focus-visible:ring-indigo-200' },
    teal: { range: 'bg-teal-500', thumb: 'border-teal-500', ring: 'focus-visible:ring-teal-200' },
    emerald: { range: 'bg-emerald-500', thumb: 'border-emerald-500', ring: 'focus-visible:ring-emerald-200' },
    amber: { range: 'bg-amber-500', thumb: 'border-amber-500', ring: 'focus-visible:ring-amber-200' },
    rose: { range: 'bg-rose-500', thumb: 'border-rose-500', ring: 'focus-visible:ring-rose-200' },
  };

  const colors = colorStyles[color];

  return (
    <div className={cn('flex items-center gap-3', className)}>
      {label && <span className="text-xs font-medium text-gray-500 whitespace-nowrap">{label}</span>}
      <SliderPrimitive.Root
        className="relative flex h-5 w-32 touch-none select-none items-center"
        value={[value]}
        onValueChange={([v]) => onValueChange(v)}
        min={min}
        max={max}
        step={step}
      >
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-gray-200">
          <SliderPrimitive.Range className={cn('absolute h-full', colors.range)} />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb 
          className={cn(
            'block h-4 w-4 rounded-full bg-white',
            'border-2 shadow-md',
            'transition-all duration-150',
            'hover:scale-110',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
            colors.thumb,
            colors.ring
          )} 
        />
      </SliderPrimitive.Root>
      {showValue && (
        <span className="min-w-[3rem] text-right text-xs font-semibold tabular-nums text-gray-700">
          {value}{suffix}
        </span>
      )}
    </div>
  );
}

/* ----------  Range Slider ---------- */

interface RangeSliderProps {
  values: [number, number];
  onValuesChange: (v: [number, number]) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  suffix?: string;
  color?: 'indigo' | 'teal' | 'emerald' | 'amber' | 'rose';
  className?: string;
}

export function RangeSlider({
  values,
  onValuesChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  suffix = '',
  color = 'indigo',
  className,
}: RangeSliderProps) {
  const colorStyles = {
    indigo: { range: 'bg-indigo-500', thumb: 'border-indigo-500', ring: 'focus-visible:ring-indigo-200' },
    teal: { range: 'bg-teal-500', thumb: 'border-teal-500', ring: 'focus-visible:ring-teal-200' },
    emerald: { range: 'bg-emerald-500', thumb: 'border-emerald-500', ring: 'focus-visible:ring-emerald-200' },
    amber: { range: 'bg-amber-500', thumb: 'border-amber-500', ring: 'focus-visible:ring-amber-200' },
    rose: { range: 'bg-rose-500', thumb: 'border-rose-500', ring: 'focus-visible:ring-rose-200' },
  };

  const colors = colorStyles[color];

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {label && (
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-gray-500">{label}</span>
          <span className="text-xs font-semibold tabular-nums text-gray-700">
            {values[0]}{suffix} — {values[1]}{suffix}
          </span>
        </div>
      )}
      <SliderPrimitive.Root
        className="relative flex h-5 w-full touch-none select-none items-center"
        value={values}
        onValueChange={(v) => onValuesChange(v as [number, number])}
        min={min}
        max={max}
        step={step}
      >
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-gray-200">
          <SliderPrimitive.Range className={cn('absolute h-full', colors.range)} />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb 
          className={cn(
            'block h-4 w-4 rounded-full bg-white border-2 shadow-md',
            'transition-all duration-150 hover:scale-110',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
            colors.thumb, colors.ring
          )} 
        />
        <SliderPrimitive.Thumb 
          className={cn(
            'block h-4 w-4 rounded-full bg-white border-2 shadow-md',
            'transition-all duration-150 hover:scale-110',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
            colors.thumb, colors.ring
          )} 
        />
      </SliderPrimitive.Root>
    </div>
  );
}
