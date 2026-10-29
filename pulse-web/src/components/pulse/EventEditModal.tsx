'use client';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { ChevronDown, ExternalLink, X } from 'lucide-react';
import { EventAiActionsPanel, type EventAiContext } from './EventAiActionsPanel';
import { CardChangeDetailsView, type CardChangeDetails } from './CardChangeDetailsView';

// Human-readable category labels for the modal subheader. The DB stores
// machine codes (`card_change`, `price`, ...) but the user shouldn't see them.
const CATEGORY_LABEL_RU: Record<string, string> = {
  card_change: 'Изменение карточки',
  card: 'Изменение карточки',
  price: 'Изменение цены',
  stock: 'Остатки',
  sales: 'Продажи / Маржа',
  review: 'Отзыв',
  promo: 'Акция',
  ads: 'Реклама',
  other: 'Другое',
};

export type EventEditData = {
  eventId: number;
  date: string;
  time: string;
  category: string;
  severity: string;
  title: string;
  description: string;
  dueAt: string;
  nmId?: number | null;
  evidence?: Record<string, unknown> | null;
};

export function EventEditModal({
  open,
  data,
  onChange,
  onSave,
  onClose,
}: {
  open: boolean;
  data: EventEditData | null;
  onChange: (update: Partial<EventEditData>) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  if (!open || !data) return null;

  const selectCls = 'mt-1 w-full rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--content-text)] outline-none focus:ring-2 focus:ring-indigo-500/30';

  const aiContext: EventAiContext = {
    eventId: data.eventId,
    category: data.category,
    severity: data.severity,
    title: data.title,
    description: data.description,
    nmId: data.nmId ?? null,
    date: data.date,
    evidence: data.evidence ?? null,
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="w-full max-w-xl rounded-[var(--radius-lg)] border border-[var(--card-border)] bg-[var(--card-bg)] p-5 shadow-xl my-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--content-text)] truncate">{data.title || `Событие #${data.eventId}`}</div>
            <div className="text-[11px] text-[var(--content-muted)]">#{data.eventId} · {CATEGORY_LABEL_RU[data.category] ?? data.category ?? 'без категории'} · {data.date}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {data.nmId ? (
              <NmIdLink nmId={data.nmId} className="inline-flex items-center gap-1 rounded-md border border-[var(--card-border)] px-2 py-1 text-xs text-blue-600 hover:bg-blue-50">
                <ExternalLink className="h-3.5 w-3.5" />
                {data.nmId} на WB
              </NmIdLink>
            ) : null}
            <button className="text-[var(--content-muted)] hover:text-[var(--content-text)]" type="button" onClick={onClose}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* AI Actions Panel — primary entry point */}
        <div className="mt-4">
          <EventAiActionsPanel event={aiContext} onClose={onClose} />
        </div>

        {/* Visual detailed diff for card_change events */}
        {(() => {
          if (data.category !== 'card_change' && data.category !== 'card') return null;
          const details = (data.evidence as Record<string, unknown> | null | undefined)?.details as
            | CardChangeDetails
            | undefined;
          if (!details) return null;
          return (
            <div className="mt-4">
              <CardChangeDetailsView details={details} />
            </div>
          );
        })()}

        {/* Description preview (read-only quick view, full edit below) */}
        {data.description && (
          <div className="mt-4 text-xs text-[var(--content-muted)] whitespace-pre-line">
            {data.description}
          </div>
        )}

        {/* Collapsed edit form — for when user genuinely wants to edit fields */}
        <details className="mt-4 group">
          <summary className="flex items-center justify-between cursor-pointer text-xs font-medium text-[var(--content-muted)] hover:text-[var(--content-text)] select-none">
            <span>Редактировать поля</span>
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
          </summary>

          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="block text-xs font-medium text-[var(--content-muted)]">
              Дата
              <Input className="mt-1 w-full" value={data.date} onChange={(e) => onChange({ date: e.target.value })} placeholder="YYYY-MM-DD" />
            </label>
            <label className="block text-xs font-medium text-[var(--content-muted)]">
              Время
              <Input className="mt-1 w-full" value={data.time} onChange={(e) => onChange({ time: e.target.value })} placeholder="13:00" />
            </label>
            <label className="block text-xs font-medium text-[var(--content-muted)]">
              Категория
              <Input className="mt-1 w-full" value={data.category} onChange={(e) => onChange({ category: e.target.value })} placeholder="финансы/логистика/..." />
            </label>
            <label className="block text-xs font-medium text-[var(--content-muted)]">
              Важность
              <select className={selectCls} value={data.severity} onChange={(e) => onChange({ severity: e.target.value })}>
                <option value="">—</option>
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="critical">critical</option>
              </select>
            </label>
            <label className="block text-xs font-medium text-[var(--content-muted)] md:col-span-2">
              Заголовок
              <Input className="mt-1 w-full" value={data.title} onChange={(e) => onChange({ title: e.target.value })} />
            </label>
            <label className="block text-xs font-medium text-[var(--content-muted)] md:col-span-2">
              Описание
              <textarea
                className="mt-1 w-full rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--content-text)] outline-none focus:ring-2 focus:ring-indigo-500/30"
                rows={4}
                value={data.description}
                onChange={(e) => onChange({ description: e.target.value })}
              />
            </label>
            <label className="block text-xs font-medium text-[var(--content-muted)]">
              Дедлайн (task)
              <Input className="mt-1 w-full" type="datetime-local" value={data.dueAt} onChange={(e) => onChange({ dueAt: e.target.value })} />
            </label>
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Закрыть
            </Button>
            <Button onClick={onSave}>
              Сохранить изменения
            </Button>
          </div>
        </details>
      </div>
    </div>
  );
}
