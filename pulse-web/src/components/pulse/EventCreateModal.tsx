'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';
import { X, ChevronDown, ChevronUp, AlertTriangle, FileText, CheckSquare } from 'lucide-react';

export function EventCreateModal({
  open,
  date,
  type,
  time,
  category,
  severity,
  dueAt,
  title,
  description,
  nmId,
  workspaceId,
  onDateChange,
  onTypeChange,
  onTimeChange,
  onCategoryChange,
  onSeverityChange,
  onDueAtChange,
  onTitleChange,
  onDescriptionChange,
  onNmIdChange,
  onCreate,
  onClose,
}: {
  open: boolean;
  date: string;
  type: 'alert' | 'log' | 'task';
  time: string;
  category: string;
  severity: 'info' | 'warn' | 'critical';
  dueAt: string;
  title: string;
  description: string;
  nmId?: string;
  workspaceId?: number | null;
  onDateChange: (v: string) => void;
  onTypeChange: (v: 'alert' | 'log' | 'task') => void;
  onTimeChange: (v: string) => void;
  onCategoryChange: (v: string) => void;
  onSeverityChange: (v: 'info' | 'warn' | 'critical') => void;
  onDueAtChange: (v: string) => void;
  onTitleChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onNmIdChange?: (v: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  if (!open) return null;

  const selectCls = 'w-full rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--content-text)] outline-none focus:ring-2 focus:ring-indigo-500/30';

  const typeOptions = [
    { value: 'log' as const, label: 'Событие', icon: FileText, color: 'text-gray-500' },
    { value: 'task' as const, label: 'Задача', icon: CheckSquare, color: 'text-violet-400' },
    { value: 'alert' as const, label: 'Алерт', icon: AlertTriangle, color: 'text-red-400' },
  ];

  const severityOptions = [
    { value: 'info' as const, label: 'Низкий', color: 'bg-blue-500/20 text-blue-400' },
    { value: 'warn' as const, label: 'Средний', color: 'bg-yellow-500/20 text-yellow-400' },
    { value: 'critical' as const, label: 'Высокий', color: 'bg-red-500/20 text-red-400' },
  ];

  const placeholders = [
    'Обновить цену на товар',
    'Проверить остатки на складе',
    'Сфотографировать новый товар',
    'Ответить на негативный отзыв',
    'Запустить рекламную кампанию',
  ];
  const placeholder = placeholders[Math.floor(Date.now() / 60000) % placeholders.length];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-[var(--radius-lg)] border border-[var(--card-border)] bg-[var(--card-bg)] p-5 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-[var(--content-text)]">Добавить событие</div>
          <button className="text-[var(--content-muted)] hover:text-[var(--content-text)]" type="button" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* === REQUIRED FIELDS (always visible) === */}

        {/* 1. Title — top priority */}
        <label className="mt-4 block text-xs font-medium text-[var(--content-muted)]">
          Заголовок <span className="text-red-500">*</span>
          <Input
            className="mt-1 w-full text-base"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder={placeholder}
            autoFocus
          />
        </label>

        {/* 2. Type + Priority — one row */}
        <div className="mt-3 flex items-center gap-2">
          {typeOptions.map((opt) => {
            const Icon = opt.icon;
            const isActive = type === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onTypeChange(opt.value)}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  isActive
                    ? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-400'
                    : 'border-[var(--card-border)] text-[var(--content-muted)] hover:border-[var(--content-muted)]'
                }`}
              >
                <Icon className={`h-3.5 w-3.5 ${isActive ? 'text-indigo-400' : opt.color}`} />
                {opt.label}
              </button>
            );
          })}

          <div className="mx-1 h-4 w-px bg-[var(--card-border)]" />

          {severityOptions.map((opt) => {
            const isActive = severity === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onSeverityChange(opt.value)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                  isActive ? opt.color : 'text-[var(--content-muted)] hover:text-[var(--content-text)]'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* 3. Date + Deadline — one row */}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block text-xs font-medium text-[var(--content-muted)]">
            Дата <span className="text-red-500">*</span>
            <Input className="mt-1 w-full" type="date" value={date} onChange={(e) => onDateChange(e.target.value)} required />
          </label>
          <label className="block text-xs font-medium text-[var(--content-muted)]">
            Дедлайн {type === 'task' && <span className="text-red-500">*</span>}
            <Input className="mt-1 w-full" type="datetime-local" value={dueAt} onChange={(e) => onDueAtChange(e.target.value)} required={type === 'task'} />
          </label>
        </div>

        {/* === COLLAPSIBLE DETAILS === */}
        <button
          type="button"
          onClick={() => setShowDetails(!showDetails)}
          className="mt-4 flex w-full items-center gap-1 text-xs font-medium text-[var(--content-muted)] hover:text-[var(--content-text)] transition-colors"
        >
          {showDetails ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          Дополнительно
          <span className="ml-1 text-[10px] opacity-60">(описание, товар, категория, время)</span>
        </button>

        {showDetails && (
          <div className="mt-2 space-y-3 rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)]/50 p-3">
            <label className="block text-xs font-medium text-[var(--content-muted)]">
              Описание
              <textarea
                className="mt-1 w-full rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--content-text)] outline-none focus:ring-2 focus:ring-indigo-500/30"
                rows={3}
                value={description}
                onChange={(e) => onDescriptionChange(e.target.value)}
                placeholder="Подробности..."
              />
            </label>

            {workspaceId && onNmIdChange && (
              <label className="block text-xs font-medium text-[var(--content-muted)]">
                Привязка к товару
                <div className="mt-1">
                  <ProductSearchInput
                    workspaceId={workspaceId}
                    value={nmId ?? ''}
                    onChange={onNmIdChange}
                    placeholder="Поиск по артикулу или названию..."
                  />
                </div>
              </label>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-medium text-[var(--content-muted)]">
                Категория
                <select className={`mt-1 ${selectCls}`} value={category} onChange={(e) => onCategoryChange(e.target.value)}>
                  <option value="">Без категории</option>
                  <option value="финансы">Финансы</option>
                  <option value="логистика">Логистика</option>
                  <option value="продвижение">Продвижение</option>
                  <option value="контент">Контент</option>
                  <option value="репутация">Репутация</option>
                </select>
              </label>
              <label className="block text-xs font-medium text-[var(--content-muted)]">
                Время
                <Input className="mt-1 w-full" placeholder="13:00" value={time} onChange={(e) => onTimeChange(e.target.value)} />
              </label>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={onCreate} disabled={!date || !title.trim() || (type === 'task' && !dueAt)}>
            Создать
          </Button>
        </div>
      </div>
    </div>
  );
}
