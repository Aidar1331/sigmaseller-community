'use client';

import { Cloud, CloudOff, Loader2, Check, AlertCircle } from 'lucide-react';
import { formatLastSaved } from '@/hooks/useAutoSave';

interface SaveStatusProps {
  isSaving: boolean;
  lastSaved: Date | null;
  hasUnsavedChanges: boolean;
  error?: string | null;
}

export function SaveStatus({ isSaving, lastSaved, hasUnsavedChanges, error }: SaveStatusProps) {
  if (error) {
    return (
      <div className="flex items-center gap-1.5 text-destructive text-xs">
        <AlertCircle className="w-3.5 h-3.5" />
        <span>Ошибка сохранения</span>
      </div>
    );
  }

  if (isSaving) {
    return (
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>Сохранение...</span>
      </div>
    );
  }

  if (hasUnsavedChanges) {
    return (
      <div className="flex items-center gap-1.5 text-amber-700 text-xs">
        <CloudOff className="w-3.5 h-3.5" />
        <span>Не сохранено</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
      <Check className="w-3.5 h-3.5 text-green-500" />
      <span>{formatLastSaved(lastSaved)}</span>
    </div>
  );
}
