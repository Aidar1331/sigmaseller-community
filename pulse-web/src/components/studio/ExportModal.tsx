'use client';

import { useState } from 'react';
import {
  Download,
  Save,
  X,
  Image as ImageIcon,
  FileImage,
  Loader2,
  Check,
  Share2,
} from 'lucide-react';
import { useWorkspaceStore } from '@/store/workspace';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

interface ExportModalProps {
  open: boolean;
  onClose: () => void;
  /** Function to export canvas as data URL */
  exportCanvas: (format: 'png' | 'jpeg', quality?: number) => string | null;
  /** Project info */
  projectId?: number;
  projectName: string;
  nmId?: number;
  /** Canvas dimensions */
  width: number;
  height: number;
}

const FORMAT_OPTIONS = [
  { id: 'png', label: 'PNG', description: 'Без потерь, прозрачность', icon: FileImage },
  { id: 'jpeg', label: 'JPEG', description: 'Меньший размер', icon: ImageIcon },
] as const;

const QUALITY_PRESETS = [
  { value: 100, label: 'Максимальное' },
  { value: 90, label: 'Высокое' },
  { value: 80, label: 'Среднее' },
  { value: 60, label: 'Низкое' },
];

export function ExportModal({
  open,
  onClose,
  exportCanvas,
  projectId,
  projectName,
  nmId,
  width,
  height,
}: ExportModalProps) {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const queryClient = useQueryClient();

  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [quality, setQuality] = useState(90);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isSavingToProduct, setIsSavingToProduct] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Save to product (upload to S3 + link to product)
  const saveMutation = useMutation({
    mutationFn: async () => {
      const dataUrl = exportCanvas(format, quality / 100);
      if (!dataUrl) throw new Error('Failed to export canvas');

      // Convert data URL to blob
      const res = await fetch(dataUrl);
      const blob = await res.blob();

      // Create form data
      const formData = new FormData();
      formData.append('file', blob, `${projectName}.${format}`);

      // Upload
      const result = await fetch(
        `/api/proxy/studio/assets/upload?workspaceId=${workspaceId}&type=exported`,
        {
          method: 'POST',
          body: formData,
        }
      ).then((r) => r.json());

      return result;
    },
    onSuccess: () => {
      setSaveSuccess(true);
      queryClient.invalidateQueries({ queryKey: ['studio-assets'] });
      setTimeout(() => setSaveSuccess(false), 3000);
    },
  });

  const handleDownload = () => {
    setIsDownloading(true);

    try {
      const dataUrl = exportCanvas(format, quality / 100);
      if (!dataUrl) {
        alert('Не удалось экспортировать изображение');
        return;
      }

      // Create download link
      const link = document.createElement('a');
      link.download = `${projectName}.${format}`;
      link.href = dataUrl;
      link.click();
    } finally {
      setIsDownloading(false);
    }
  };

  const handleSaveToAssets = () => {
    setIsSavingToProduct(true);
    saveMutation.mutate(undefined, {
      onSettled: () => setIsSavingToProduct(false),
    });
  };

  const handleCopyToClipboard = async () => {
    const dataUrl = exportCanvas('png');
    if (!dataUrl) return;

    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ]);
      alert('Скопировано в буфер обмена');
    } catch {
      alert('Не удалось скопировать');
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background rounded-xl w-full max-w-lg shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-bold">Экспорт изображения</h2>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-6">
          {/* Preview */}
          <div className="flex items-center gap-4 p-3 bg-muted/50 rounded-lg">
            <div className="w-16 h-20 bg-muted rounded flex items-center justify-center">
              <ImageIcon className="w-6 h-6 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium">{projectName}</p>
              <p className="text-sm text-muted-foreground">
                {width} × {height} px
              </p>
            </div>
          </div>

          {/* Format Selection */}
          <div>
            <label className="text-sm font-medium mb-2 block">Формат</label>
            <div className="grid grid-cols-2 gap-3">
              {FORMAT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setFormat(opt.id)}
                  className={`p-3 border rounded-lg text-left transition-colors ${
                    format === opt.id
                      ? 'border-primary bg-primary/5'
                      : 'hover:bg-muted'
                  }`}
                >
                  <opt.icon className="w-5 h-5 mb-1" />
                  <div className="font-medium">{opt.label}</div>
                  <div className="text-xs text-muted-foreground">{opt.description}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Quality (for JPEG) */}
          {format === 'jpeg' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium">Качество</label>
                <span className="text-sm text-muted-foreground">{quality}%</span>
              </div>
              <input
                type="range"
                min={10}
                max={100}
                step={5}
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                {QUALITY_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    onClick={() => setQuality(preset.value)}
                    className={`hover:text-foreground ${
                      quality === preset.value ? 'text-primary font-medium' : ''
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Estimated Size */}
          <div className="text-sm text-muted-foreground">
            Примерный размер: ~{estimateFileSize(width, height, format, quality)} КБ
          </div>
        </div>

        {/* Actions */}
        <div className="p-4 border-t space-y-3">
          {/* Primary Actions */}
          <div className="flex gap-3">
            <button
              onClick={handleDownload}
              disabled={isDownloading}
              className="flex-1 flex items-center justify-center gap-2 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
            >
              {isDownloading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              Скачать
            </button>

            <button
              onClick={handleSaveToAssets}
              disabled={isSavingToProduct || !workspaceId}
              className="flex-1 flex items-center justify-center gap-2 py-3 border rounded-lg hover:bg-muted disabled:opacity-50"
            >
              {isSavingToProduct ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : saveSuccess ? (
                <Check className="w-4 h-4 text-green-500" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              {saveSuccess ? 'Сохранено!' : 'В мои ассеты'}
            </button>
          </div>

          {/* Secondary Actions */}
          <button
            onClick={handleCopyToClipboard}
            className="w-full flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <Share2 className="w-4 h-4" />
            Скопировать в буфер обмена
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Rough estimate of file size
 */
function estimateFileSize(width: number, height: number, format: 'png' | 'jpeg', quality: number): number {
  const pixels = width * height;
  
  if (format === 'png') {
    // PNG: roughly 3-4 bytes per pixel after compression
    return Math.round((pixels * 3.5) / 1024);
  } else {
    // JPEG: depends heavily on quality and content
    const qualityFactor = quality / 100;
    return Math.round((pixels * qualityFactor * 0.5) / 1024);
  }
}
