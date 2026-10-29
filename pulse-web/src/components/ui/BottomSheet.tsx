'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useIsMobile } from '@/hooks/useMediaQuery';

/**
 * BottomSheet — выдвижная нижняя панель.
 *
 * - Mobile (<sm): snap-to-bottom, full-width, выезжает снизу, можно потянуть
 *   за «handle» наверху. На desktop — модалка по центру.
 * - Backdrop с blur, клик закрывает.
 * - safe-area-inset-bottom для notch / home indicator.
 * - Поддержка опциональных snapPoints — по умолчанию [50, 90] (% высоты).
 *
 * Использование:
 *   <BottomSheet open={open} onClose={() => setOpen(false)} title="Фильтры">
 *     <FilterForm />
 *   </BottomSheet>
 */

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  /** Высоты в процентах vh. По умолчанию [50, 90]. На mobile активен последний при первом открытии. */
  snapPoints?: number[];
  /** Кастомные классы для контейнера контента. */
  className?: string;
  /** Скрыть «ручку» (handle) сверху. */
  hideHandle?: boolean;
  /** Скрыть стандартную кнопку «X» в шапке. */
  hideClose?: boolean;
  /** Футер: sticky-блок снизу (кнопки «Применить» / «Сбросить»). */
  footer?: React.ReactNode;
}

export function BottomSheet({
  open,
  onClose,
  title,
  children,
  snapPoints = [50, 90],
  className,
  hideHandle,
  hideClose,
  footer,
}: BottomSheetProps) {
  const isMobile = useIsMobile();
  const [snapIdx, setSnapIdx] = React.useState<number>(snapPoints.length - 1);

  // Body scroll lock при открытии
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Esc для закрытия
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Drag handler — простой: тап по handle переключает между snap points
  const cycleSnap = () => {
    setSnapIdx((i) => (i + 1) % snapPoints.length);
  };

  if (!open) return null;

  const currentSnap = snapPoints[snapIdx] ?? 90;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200"
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        className={cn(
          'relative flex w-full flex-col bg-white shadow-2xl',
          // Mobile: snap-to-bottom + safe-area
          'rounded-t-2xl sm:rounded-2xl',
          'sm:w-[560px] sm:max-h-[85vh]',
          'animate-in slide-in-from-bottom duration-300 sm:slide-in-from-bottom-0 sm:zoom-in-95',
          className
        )}
        style={
          isMobile
            ? { maxHeight: `${currentSnap}vh`, height: `${currentSnap}vh` }
            : undefined
        }
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle (mobile only) */}
        {isMobile && !hideHandle && (
          <button
            type="button"
            onClick={cycleSnap}
            className="flex w-full items-center justify-center py-2 cursor-grab active:cursor-grabbing"
            aria-label="Изменить высоту"
          >
            <div className="h-1.5 w-10 rounded-full bg-gray-300" />
          </button>
        )}

        {/* Header */}
        {(title || !hideClose) && (
          <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 sm:px-5">
            <div className="text-base font-semibold text-gray-900 truncate">
              {title}
            </div>
            {!hideClose && (
              <button
                type="button"
                onClick={onClose}
                className="-mr-2 flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                aria-label="Закрыть"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          {children}
        </div>

        {/* Footer (sticky, with safe-area) */}
        {footer && (
          <div
            className="border-t border-gray-100 bg-white px-4 py-3 sm:px-5"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }}
          >
            {footer}
          </div>
        )}

        {/* Spacer for safe-area when no footer */}
        {!footer && (
          <div style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} />
        )}
      </div>
    </div>
  );
}
