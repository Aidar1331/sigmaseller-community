'use client';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { X } from 'lucide-react';

export function SavePresetModal({
  open,
  name,
  description,
  onNameChange,
  onDescriptionChange,
  onSave,
  onClose,
}: {
  open: boolean;
  name: string;
  description: string;
  onNameChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-[var(--radius-lg)] border border-[var(--card-border)] bg-[var(--card-bg)] p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-[var(--content-text)]">Сохранить пресет</div>
          <button type="button" className="text-[var(--content-muted)] hover:text-[var(--content-text)]" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-3">
          <label className="block text-xs font-medium text-[var(--content-muted)]">Название</label>
          <Input
            className="mt-1 w-full"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            autoFocus
          />
        </div>
        <div className="mt-3">
          <label className="block text-xs font-medium text-[var(--content-muted)]">Описание (опционально)</label>
          <textarea
            className="mt-1 w-full rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--content-text)] outline-none focus:ring-2 focus:ring-indigo-500/30"
            rows={3}
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={onSave} disabled={!name.trim()}>
            Сохранить
          </Button>
        </div>
      </div>
    </div>
  );
}
