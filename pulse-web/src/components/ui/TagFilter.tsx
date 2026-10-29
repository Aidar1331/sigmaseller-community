'use client';

import * as React from 'react';
import { Circle, Tag } from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { cn } from '@/lib/cn';

export interface TagOption {
  tagId: number;
  name: string;
  color: string | null;
}

interface TagFilterProps {
  tags: TagOption[];
  value: number | null;
  onChange: (tagId: number | null) => void;
  placeholder?: string;
  className?: string;
  showLabel?: boolean;
  label?: string;
  size?: 'sm' | 'md';
}

/**
 * Переиспользуемый фильтр по тегам.
 * Отображает селект с цветными индикаторами тегов.
 */
export function TagFilter({
  tags,
  value,
  onChange,
  placeholder = 'Все товары',
  className,
  showLabel = false,
  label = 'Тег',
  size = 'md',
}: TagFilterProps) {
  const heightClass = size === 'sm' ? 'h-8 text-xs' : 'h-10 text-sm';

  const content = (
    <Select
      value={value != null ? String(value) : '__none__'}
      onValueChange={(v) => onChange(v === '__none__' ? null : Number(v))}
    >
      <SelectTrigger className={cn(heightClass, className)}>
        <Tag className={cn('mr-1.5 text-gray-500', size === 'sm' ? 'h-3 w-3' : 'h-4 w-4')} />
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">{placeholder}</SelectItem>
        {tags.map((t) => (
          <SelectItem key={t.tagId} value={String(t.tagId)}>
            <span className="flex items-center gap-2">
              {t.color && (
                <Circle
                  className="h-2.5 w-2.5 shrink-0"
                  fill={t.color}
                  stroke={t.color}
                />
              )}
              {t.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  if (!showLabel) return content;

  return (
    <div className="flex flex-col gap-1">
      <span className={cn('font-medium text-gray-500', size === 'sm' ? 'text-[10px]' : 'text-xs')}>
        {label}
      </span>
      {content}
    </div>
  );
}
