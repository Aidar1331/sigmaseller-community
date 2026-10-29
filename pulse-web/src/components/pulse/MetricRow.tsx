'use client';

import type React from 'react';
import { formatNumber, formatNumberShort, formatRub, formatRubShort, formatPct } from '@/lib/format';
import { Sparkline } from './Sparkline';
import { cn } from '@/lib/cn';

export type MetricRowTableConfig = {
  heatmap: boolean;
  heatmapMode: 'row' | 'global';
  heatmapIntensity: 'soft' | 'medium' | 'strong';
  heatmapGlobal?: { min: number; max: number };
  numberFormat: 'full' | 'short';
  showUnits: boolean;
  dense: boolean;
  anomaliesEnabled: boolean;
};

export type MetricRowEventsConfig = {
  enabled: boolean;
  nmId: number;
  selectedDate?: string | null;
  eventCountsByDate?: Record<string, { alerts: number; logs: number; tasks: number }>;
  onSelectDate: (date: string) => void;
  onHoverDate?: (date: string, x: number, y: number) => void;
  onLeaveHover?: () => void;
  onContextMenu?: (date: string, x: number, y: number) => void;
};

export function MetricRow(props: {
  title: string;
  helpText?: string;
  unit?: string;
  series: Array<string | number>;
  format?: 'int' | 'rub' | 'pct';
  seriesKeys?: string[];
  anomaliesByKey?: Record<string, Record<string, { low?: boolean; high?: boolean; pctDiff?: number; baseline?: number }>>;
  anomalyMetricName?: string;
  table?: MetricRowTableConfig;
  events?: MetricRowEventsConfig;
}) {
  return (
    <tr className="group transition-colors hover:bg-[var(--table-row-hover)]">
      <td
        className={cn(
          'sticky left-0 z-20 whitespace-nowrap bg-white text-xs text-[var(--content-text)] border-b border-r border-[var(--table-border)] shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)] group-hover:bg-gray-50',
          props.table?.dense ? 'px-1 py-1' : 'px-1.5 py-1.5'
        )}
      >
        <div className="flex items-center gap-2">
          <div className="w-[120px] shrink-0">
            <span className="text-[13px] font-semibold text-[var(--content-text)]">{props.title}</span>
            {props.table?.showUnits && props.unit ? (
              <span className="ml-1.5 text-[10px] text-[var(--content-muted)]">({props.unit})</span>
            ) : null}
            {props.helpText ? (
              <span className="ml-1.5 cursor-help text-[var(--content-muted)]" title={props.helpText}>
                ?
              </span>
            ) : null}
          </div>
          <Sparkline values={props.series.map((v) => (typeof v === 'number' ? v : 0))} />
        </div>
      </td>
      {props.series.map((v, idx) => {
        const key = props.seriesKeys?.[idx];
        const flagsRaw =
          key && props.anomaliesByKey && props.anomalyMetricName
            ? props.anomaliesByKey[key]?.[props.anomalyMetricName]
            : undefined;
        const flags = props.table?.anomaliesEnabled ? flagsRaw : undefined;
        const isSelected = !!(props.events?.selectedDate && key && props.events.selectedDate === key);

        const num = typeof v === 'number' && Number.isFinite(v) ? v : null;
        let out: string;
        if (num != null) {
          const short = props.table?.numberFormat === 'short';
          if (props.format === 'rub') out = short ? formatRubShort(num) : formatRub(num);
          else if (props.format === 'pct') out = formatPct(num);
          else out = short ? formatNumberShort(num) : formatNumber(num);
        } else {
          out = '—';
        }

        // Append unit suffix when showUnits is enabled
        if (props.table?.showUnits && props.unit && num != null) {
          out = `${out} ${props.unit}`;
        }

        // heatmap — 7 levels
        let heatStyle: React.CSSProperties | undefined;
        if (props.table?.heatmap && num != null) {
          const intensity = props.table.heatmapIntensity;
          const alpha = intensity === 'soft' ? 0.08 : intensity === 'strong' ? 0.28 : 0.16;

          let min = 0;
          let max = 1;
          if (props.table.heatmapMode === 'global' && props.table.heatmapGlobal) {
            min = props.table.heatmapGlobal.min;
            max = props.table.heatmapGlobal.max;
          } else {
            const nums = props.series
              .map((x) => (typeof x === 'number' ? x : NaN))
              .filter((x) => Number.isFinite(x)) as number[];
            if (nums.length) {
              const sorted = nums.slice().sort((a, b) => a - b);
              const q = (p: number) => {
                const idx2 = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
                return sorted[idx2]!;
              };
              min = q(0.05);
              max = q(0.95);
            }
            if (max === min) max = min + 1;
          }

          const t = Math.max(0, Math.min(1, (num - min) / (max - min)));
          // 7-level heatmap: red → orange → neutral → lime → green
          if (t < 0.17) heatStyle = { backgroundColor: `rgba(239, 68, 68, ${alpha * 1.4})` };
          else if (t < 0.33) heatStyle = { backgroundColor: `rgba(239, 68, 68, ${alpha * 0.7})` };
          else if (t < 0.42) heatStyle = { backgroundColor: `rgba(249, 115, 22, ${alpha * 0.5})` };
          else if (t < 0.58) heatStyle = undefined; // neutral
          else if (t < 0.67) heatStyle = { backgroundColor: `rgba(132, 204, 22, ${alpha * 0.5})` };
          else if (t < 0.83) heatStyle = { backgroundColor: `rgba(34, 197, 94, ${alpha * 0.7})` };
          else heatStyle = { backgroundColor: `rgba(34, 197, 94, ${alpha * 1.4})` };
        }

        // Event counts for this date
        const eventCounts = key ? props.events?.eventCountsByDate?.[key] : undefined;
        const totalEvents = (eventCounts?.alerts ?? 0) + (eventCounts?.logs ?? 0) + (eventCounts?.tasks ?? 0);

        return (
          <td
            key={idx}
            style={heatStyle}
            className={cn(
              'whitespace-nowrap border-b border-[var(--table-border)] text-right font-mono text-xs text-[var(--content-text)] cursor-pointer',
              flags?.high && 'border-2 border-emerald-400 rounded-lg bg-gradient-to-br from-emerald-50/80 to-emerald-100/50',
              flags?.low && 'border-2 border-red-400 rounded-lg bg-gradient-to-br from-red-50/80 to-red-100/50',
              isSelected && 'ring-2 ring-inset ring-indigo-300 bg-indigo-50/50',
              props.table?.dense ? 'px-1 py-0.5' : 'px-1.5 py-1',
              'hover:bg-slate-50/80'
            )}
            title={
              flags?.high
                ? `Рост: +${flags.pctDiff ?? '?'}% от среднего (${flags.baseline ?? '—'})`
                : flags?.low
                  ? `Снижение: ${flags.pctDiff ?? '?'}% от среднего (${flags.baseline ?? '—'})`
                  : totalEvents
                    ? `${eventCounts?.tasks ?? 0} задач, ${eventCounts?.alerts ?? 0} алертов, ${eventCounts?.logs ?? 0} событий`
                    : undefined
            }
            onMouseEnter={(e) => {
              if (!key || !props.events?.enabled) return;
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              props.events.onHoverDate?.(key, rect.left + rect.width / 2, rect.top);
            }}
            onMouseLeave={() => props.events?.onLeaveHover?.()}
            onContextMenu={(e) => {
              if (!key || !props.events?.enabled) return;
              e.preventDefault();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              props.events.onContextMenu?.(key, rect.left + rect.width / 2, rect.top + rect.height / 2);
            }}
            onClick={() => {
              if (!key || !props.events?.enabled) return;
              props.events.onSelectDate(key);
            }}
          >
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-xs tabular-nums">{out}</span>
              {/* Event indicators under the value - compact dots */}
              {totalEvents > 0 && (
                <div className="flex items-center justify-end gap-[3px]">
                  {(eventCounts?.tasks ?? 0) > 0 && (
                    <span 
                      className="w-[6px] h-[6px] rounded-full bg-violet-500"
                      title={`${eventCounts?.tasks} задач`}
                    />
                  )}
                  {(eventCounts?.logs ?? 0) > 0 && (
                    <span 
                      className="w-[6px] h-[6px] rounded-full bg-amber-500"
                      title={`${eventCounts?.logs} событий`}
                    />
                  )}
                  {(eventCounts?.alerts ?? 0) > 0 && (
                    <span 
                      className="w-[6px] h-[6px] rounded-full bg-red-500"
                      title={`${eventCounts?.alerts} алертов`}
                    />
                  )}
                </div>
              )}
            </div>
          </td>
        );
      })}
    </tr>
  );
}
