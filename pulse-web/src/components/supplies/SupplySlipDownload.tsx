'use client';

import { useState } from 'react';
import { FileText, Loader2, Download } from 'lucide-react';
import { apiFetch } from '@/lib/api';

type Props = {
  workspaceId: number;
  supplyRowId: number;
};

type Status = 'idle' | 'generating' | 'ready' | 'error';

export function SupplySlipDownload({ workspaceId, supplyRowId }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  const fileUrl = `/api/proxy/agents/${workspaceId}/supply-slip/${supplyRowId}/file`;

  const handleGenerate = async () => {
    setStatus('generating');
    setError(null);
    try {
      await apiFetch(`/agents/${workspaceId}/supply-slip/${supplyRowId}/generate`, { method: 'POST' });
      setStatus('ready');
      window.open(fileUrl, '_blank');
    } catch (err) {
      setStatus('error');
      setError((err as Error)?.message ?? 'Ошибка генерации');
    }
  };

  if (status === 'generating') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Генерация...
      </span>
    );
  }

  if (status === 'error') {
    return (
      <button
        onClick={handleGenerate}
        title={error ?? 'Ошибка, нажмите для повтора'}
        className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-600"
      >
        <FileText className="h-3.5 w-3.5" /> Ошибка — повторить
      </button>
    );
  }

  // idle / ready — показываем кнопку; ready позволяет открыть cached-файл.
  return (
    <div className="inline-flex items-center gap-2">
      <button
        onClick={handleGenerate}
        title="Сгенерировать лист приёмки (PDF с штрих-кодами)"
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-violet-700 bg-violet-50 hover:bg-violet-100 border border-violet-200"
      >
        <FileText className="h-3.5 w-3.5" /> Лист приёмки
      </button>
      {status === 'ready' && (
        <a
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Скачать"
          className="text-gray-500 hover:text-gray-700"
        >
          <Download className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
}
