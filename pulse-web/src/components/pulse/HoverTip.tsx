'use client';

import { AlertTriangle, FileText, CheckSquare } from 'lucide-react';

export type HoverTipState = {
  date: string;
  nmId: number;
  x: number;
  y: number;
  rows: any[];
} | null;

export function HoverTip({
  tip,
  eventTypeFilter,
  eventStatusFilter,
}: {
  tip: HoverTipState;
  eventTypeFilter: { alert: boolean; log: boolean; task: boolean };
  eventStatusFilter: { open: boolean; ack: boolean; resolved: boolean; done: boolean };
}) {
  if (!tip) return null;

  const filtered = (tip.rows ?? []).filter((ev: any) => {
    if (ev.type === 'alert' && !eventTypeFilter.alert) return false;
    if (ev.type === 'log' && !eventTypeFilter.log) return false;
    if (ev.type === 'task' && !eventTypeFilter.task) return false;
    if (!eventStatusFilter[ev.status as keyof typeof eventStatusFilter]) return false;
    return true;
  });

  const TypeIcon = ({ type }: { type: string }) => {
    if (type === 'alert') return <AlertTriangle className="h-3 w-3 text-red-500" />;
    if (type === 'task') return <CheckSquare className="h-3 w-3 text-violet-500" />;
    return <FileText className="h-3 w-3 text-slate-400" />;
  };

  return (
    <div
      className="pointer-events-none fixed z-50 max-h-48 w-80 overflow-hidden rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] p-2.5 text-[11px] text-[var(--content-text)] shadow-xl"
      style={{ left: tip.x + 10, top: tip.y - 60 }}
    >
      <div className="mb-1.5 text-xs text-[var(--content-muted)]">
        {tip.date} · {tip.nmId > 0 ? `арт. ${tip.nmId}` : 'все товары'} · {filtered.length} событий
      </div>
      {filtered.slice(0, 5).map((ev: any, i: number) => (
        <div key={i} className="flex items-center gap-1.5 truncate py-0.5">
          <TypeIcon type={ev.type} />
          <span>{ev.title}</span>
        </div>
      ))}
      {filtered.length > 5 ? <div className="mt-1 text-[var(--content-muted)]">… ещё {filtered.length - 5}</div> : null}
    </div>
  );
}
