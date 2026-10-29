'use client';

import { FileText, CheckSquare } from 'lucide-react';

export type ContextMenuState = {
  x: number;
  y: number;
  date: string;
  nmId: number;
} | null;

export function ContextMenu({
  menu,
  onAddEvent,
  onClose,
}: {
  menu: ContextMenuState;
  onAddEvent: (type: 'alert' | 'log' | 'task', date: string, nmId: number) => void;
  onClose: () => void;
}) {
  if (!menu) return null;

  return (
    <div
      className="fixed z-50 rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] py-1 text-sm shadow-xl"
      style={{ left: menu.x, top: menu.y }}
    >
      <button
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-[var(--content-text)] hover:bg-slate-50"
        type="button"
        onClick={() => {
          onAddEvent('log', menu.date, menu.nmId);
          onClose();
        }}
      >
        <FileText className="h-3.5 w-3.5 text-slate-500" /> Событие
      </button>
      <button
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-[var(--content-text)] hover:bg-slate-50"
        type="button"
        onClick={() => {
          onAddEvent('task', menu.date, menu.nmId);
          onClose();
        }}
      >
        <CheckSquare className="h-3.5 w-3.5 text-violet-500" /> Задача
      </button>
      <button
        className="block w-full px-4 py-2 text-left text-[var(--content-muted)] hover:bg-slate-50"
        type="button"
        onClick={onClose}
      >
        отмена
      </button>
    </div>
  );
}
