'use client';

/**
 * Explainer — раскрывающийся блок «Как читать и что делать» для секций
 * Лаборатории. По умолчанию свёрнут — заголовок виден всегда.
 */

import { useState, type ReactNode } from 'react';

interface Props {
  title?: string;
  /** Краткое описание над summary — что изображено */
  read: ReactNode;
  /** Что с этим делать */
  use: ReactNode;
  /** По умолчанию свёрнут */
  defaultOpen?: boolean;
}

export function Explainer({ title = 'Как читать и что делать', read, use, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 rounded-md"
      >
        <span>📖 {title}</span>
        <span className="text-slate-400">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-0 text-[11px] text-slate-700 space-y-2 leading-relaxed">
          <div>
            <div className="font-semibold text-slate-800 mb-0.5">Как читать</div>
            <div>{read}</div>
          </div>
          <div>
            <div className="font-semibold text-slate-800 mb-0.5">Что с этим делать</div>
            <div>{use}</div>
          </div>
        </div>
      )}
    </div>
  );
}
