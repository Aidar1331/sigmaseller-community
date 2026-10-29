'use client';

import type { PulsePreset } from '@/lib/presets';
import { Button } from '@/components/ui/Button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/ToggleGroup';
import { Card } from '@/components/ui/Card';
import { DateRangePicker } from '@/components/ui/DateRangePicker';

import { Slider } from '@/components/ui/Slider';
import { cn } from '@/lib/cn';
import {
  Settings2,
  Circle,
  Sparkles,
  Bookmark,
  Trash2,
} from 'lucide-react';

export type QuickFilterBarProps = {
  workspaceId: number;
  onWorkspaceIdChange: (v: number) => void;
  tags: Array<{ tagId: number; name: string; color: string | null }>;
  tagId: number | null;
  onTagIdChange: (v: number | null) => void;
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (v: string) => void;
  onDateToChange: (v: string) => void;
  groupBy: 'day' | 'week';
  onGroupByChange: (v: 'day' | 'week') => void;
  anomalies: 'on' | 'off';
  onAnomaliesChange: (v: 'on' | 'off') => void;
  anomalyThresholdPct: number;
  onAnomalyThresholdPctChange: (v: number) => void;
  presets: PulsePreset[];
  presetId: number | null;
  onSelectPreset: (idStr: string) => void;
  onDeletePreset?: (presetId: number) => void;
  loading?: boolean;
  onRefresh?: () => void;
  onOpenSettings: () => void;
};

export function QuickFilterBar(props: QuickFilterBarProps) {
  const {
    workspaceId, onWorkspaceIdChange,
    tags, tagId, onTagIdChange,
    dateFrom, dateTo, onDateFromChange, onDateToChange,
    groupBy, onGroupByChange,
    anomalies, onAnomaliesChange,
    anomalyThresholdPct, onAnomalyThresholdPctChange,
    presets, presetId, onSelectPreset, onDeletePreset,
    loading, onRefresh, onOpenSettings,
  } = props;

  return (
    <Card className="p-4">
      <div className="space-y-3">
        {/* Row 1: Data filters */}
        <div className="flex flex-wrap items-end gap-3">
          <FilterField label="Период">
            <DateRangePicker
              dateFrom={dateFrom}
              dateTo={dateTo}
              onDateFromChange={onDateFromChange}
              onDateToChange={onDateToChange}
            />
          </FilterField>

          <FilterField label="Тег" className="w-40">
            <Select value={tagId != null ? String(tagId) : '__none__'} onValueChange={(v) => onTagIdChange(v === '__none__' ? null : Number(v))}>
              <SelectTrigger className="h-10 text-sm"><SelectValue placeholder="Все товары" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Все товары</SelectItem>
                {tags.map((t) => (
                  <SelectItem key={t.tagId} value={String(t.tagId)}>
                    <span className="flex items-center gap-2">
                      {t.color && <Circle className="h-2.5 w-2.5 shrink-0" fill={t.color} stroke={t.color} />}
                      {t.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label="Фильтр" className="w-44">
            <div className="flex items-center gap-2">
              <Select
                value={presetId != null ? String(presetId) : '__none__'}
                onValueChange={onSelectPreset}
              >
                <SelectTrigger className="h-10 text-sm flex-1">
                  <Bookmark className="h-4 w-4 mr-1.5 text-gray-500" />
                  <SelectValue placeholder="Не выбран" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Не выбран</SelectItem>
                  {presets.map((p) => (
                    <SelectItem key={p.presetId} value={String(p.presetId)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {presetId != null && onDeletePreset && (
                <button
                  type="button"
                  title="Удалить фильтр"
                  onClick={() => {
                    if (confirm('Удалить сохранённый фильтр?')) onDeletePreset(presetId);
                  }}
                  className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                    'border border-gray-300 bg-white text-gray-500',
                    'hover:bg-red-50 hover:text-red-600 hover:border-red-200',
                    'transition-all duration-200'
                  )}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </FilterField>

          <div className="flex-1" />

          <Button variant="secondary" size="md" onClick={onOpenSettings} className="shrink-0">
            <Settings2 className="h-4 w-4" />
            Фильтры
          </Button>

          {/* Данные обновляются автоматически при смене фильтров */}
        </div>

        {/* Row 2: Display controls */}
        <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-3">
          <ToggleGroup type="single" value={groupBy} onValueChange={(v) => v && onGroupByChange(v as 'day' | 'week')}>
            <ToggleGroupItem value="day" className="h-8 text-xs px-3">День</ToggleGroupItem>
            <ToggleGroupItem value="week" className="h-8 text-xs px-3">Неделя</ToggleGroupItem>
          </ToggleGroup>

          <Separator />

          <div className="flex items-center gap-2">
            <ToggleBtn
              active={anomalies === 'on'}
              onClick={() => onAnomaliesChange(anomalies === 'on' ? 'off' : 'on')}
              icon={<Sparkles className="h-4 w-4" />}
            >
              Аномалии
            </ToggleBtn>
            {anomalies === 'on' && (
              <Slider
                value={anomalyThresholdPct}
                onValueChange={onAnomalyThresholdPctChange}
                min={1}
                max={100}
                step={1}
                suffix="%"
                color="amber"
              />
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function FilterField({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && <span className="text-xs font-medium text-gray-500">{label}</span>}
      {children}
    </div>
  );
}

function Separator() {
  return <div className="h-6 w-px bg-gray-200" />;
}

function ToggleBtn({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 h-8 rounded-xl border px-3 text-xs font-medium transition-all duration-200',
        active
          ? 'border-amber-300 bg-amber-50 text-amber-700'
          : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:text-gray-900'
      )}
    >
      {icon}{children}
    </button>
  );
}
