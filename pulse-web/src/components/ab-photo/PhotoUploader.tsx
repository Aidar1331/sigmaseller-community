'use client';

import { useCallback, useRef, useState } from 'react';
import { Upload, X, Link as LinkIcon } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';

type UploadResponse = {
  ok: boolean;
  upload?: { uploadId: number; url: string; size: number };
  error?: string;
  message?: string;
};

type Props = {
  workspaceId: number;
  value: string[];
  onChange: (next: string[]) => void;
  max?: number;
  label?: string;
  disabled?: boolean;
};

const ACCEPTED_TYPES = 'image/jpeg,image/png,image/webp,image/heic,image/heif';

export function PhotoUploader({ workspaceId, value, onChange, max = 4, label, disabled }: Props) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [urlMode, setUrlMode] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const remaining = max - value.length;

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!files.length || disabled) return;
      setError(null);
      setUploading(true);
      const accepted = files.slice(0, remaining);
      const uploaded: string[] = [];
      try {
        for (const file of accepted) {
          const fd = new FormData();
          fd.append('file', file);
          const res = (await apiFetch(`/ab-photo/${workspaceId}/upload`, {
            method: 'POST',
            body: fd,
          })) as UploadResponse;
          if (!res.ok || !res.upload?.url) {
            throw new Error(res.message || res.error || 'Не удалось загрузить');
          }
          uploaded.push(res.upload.url);
        }
        onChange([...value, ...uploaded].slice(0, max));
      } catch (e: any) {
        setError(e?.message ?? 'Ошибка загрузки');
      } finally {
        setUploading(false);
      }
    },
    [workspaceId, value, onChange, max, remaining, disabled],
  );

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    uploadFiles(files);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith('image/'));
    uploadFiles(files);
  };

  const onAddUrl = (raw: string) => {
    const urls = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!urls.length) return;
    onChange([...value, ...urls].slice(0, max));
  };

  const removeAt = (i: number) => {
    onChange(value.filter((_, idx) => idx !== i));
  };

  return (
    <div className="space-y-2">
      {label && <label className="text-sm text-gray-600">{label}</label>}

      {/* Thumbs */}
      {value.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {value.map((url, i) => (
            <div key={`${url}-${i}`} className="relative aspect-square rounded-lg overflow-hidden border border-gray-200 bg-gray-50">
              <img src={url} alt={`photo-${i}`} className="w-full h-full object-cover" />
              {!disabled && (
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  className="absolute top-1 right-1 rounded-full bg-black/60 hover:bg-black/80 p-1 text-white"
                  aria-label="Удалить"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Drop zone */}
      {remaining > 0 && !disabled && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors cursor-pointer',
            dragging ? 'border-indigo-400 bg-indigo-50' : 'border-gray-300 hover:border-gray-400 bg-gray-50',
            uploading && 'opacity-60 pointer-events-none',
          )}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_TYPES}
            multiple
            className="hidden"
            onChange={onFileInput}
            disabled={uploading}
          />
          <Upload className="h-5 w-5 mx-auto mb-1.5 text-gray-400" />
          <div className="text-sm text-gray-700">
            {uploading ? 'Загрузка...' : 'Перетащите или нажмите, чтобы загрузить'}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            JPG / PNG / WEBP / HEIC · до 10MB · ещё {remaining}
          </div>
        </div>
      )}

      {/* URL fallback */}
      {!disabled && (
        <div>
          <button
            type="button"
            onClick={() => setUrlMode((v) => !v)}
            className="text-xs text-gray-500 hover:text-gray-700 inline-flex items-center gap-1"
          >
            <LinkIcon className="h-3 w-3" />
            {urlMode ? 'Скрыть ввод URL' : 'Вставить URL'}
          </button>
          {urlMode && (
            <div className="mt-1.5">
              <textarea
                rows={2}
                placeholder="https://... (по одному URL на строку)"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                onBlur={(e) => {
                  if (e.target.value.trim()) {
                    onAddUrl(e.target.value);
                    e.target.value = '';
                  }
                }}
              />
            </div>
          )}
        </div>
      )}

      <div className="text-xs text-gray-500">{value.length}/{max} фото</div>
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}
