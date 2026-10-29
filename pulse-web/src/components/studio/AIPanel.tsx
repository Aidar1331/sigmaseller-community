'use client';

import { useState, useEffect } from 'react';
import {
  Wand2,
  Sparkles,
  Loader2,
  AlertCircle,
  CheckCircle,
  Image as ImageIcon,
  Settings2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useAIGeneration, calculateCost, CREDIT_COSTS } from '@/hooks/useAIGeneration';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaceStore } from '@/store/workspace';
import { apiFetch } from '@/lib/api';

interface AIPanelProps {
  /** URL выбранного изображения на canvas */
  selectedImageUrl?: string;
  /** Callback когда изображение сгенерировано */
  onImageGenerated?: (url: string) => void;
  /** Callback когда фон удалён */
  onBackgroundRemoved?: (url: string) => void;
}

export function AIPanel({ selectedImageUrl, onImageGenerated, onBackgroundRemoved }: AIPanelProps) {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  
  const [activeTab, setActiveTab] = useState<'remove-bg' | 'generate'>('remove-bg');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<'gemini-flash' | 'gemini-pro'>('gemini-flash');
  const [aspectRatio, setAspectRatio] = useState<'3:4' | '1:1' | '4:3' | '9:16' | '16:9'>('3:4');
  const [variants, setVariants] = useState<1 | 2 | 4>(1);
  const [useReference, setUseReference] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [rembgModel, setRembgModel] = useState('birefnet-general-lite');
  const [alphaMatting, setAlphaMatting] = useState(false);

  const {
    isLoading,
    progress,
    error,
    removeBackground,
    generate,
    clearError,
  } = useAIGeneration();

  // Get presets
  const { data: presetsData } = useQuery({
    queryKey: ['studio-presets', workspaceId],
    queryFn: () => apiFetch(`/studio/presets?workspaceId=${workspaceId}`),
    enabled: !!workspaceId,
  });


  const handleRemoveBackground = async () => {
    if (!selectedImageUrl) {
      alert('Сначала выберите изображение на холсте');
      return;
    }

    const result = await removeBackground({
      imageUrl: selectedImageUrl,
      model: rembgModel,
      alphaMatting,
    });

    if (result?.results?.[0]?.url) {
      onBackgroundRemoved?.(result.results[0].url);
    }
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      alert('Введите описание изображения');
      return;
    }


    const result = await generate({
      prompt,
      model,
      aspectRatio,
      variants,
      referenceImageUrl: useReference && selectedImageUrl ? selectedImageUrl : undefined,
    });

    if (result?.results?.[0]?.url) {
      onImageGenerated?.(result.results[0].url);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Tab Switcher */}
      <div className="flex border-b">
        <button
          onClick={() => setActiveTab('remove-bg')}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            activeTab === 'remove-bg'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Wand2 className="w-4 h-4 inline mr-1.5" />
          Удалить фон
        </button>
        <button
          onClick={() => setActiveTab('generate')}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            activeTab === 'generate'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Sparkles className="w-4 h-4 inline mr-1.5" />
          Генерация
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div className="m-3 p-3 bg-destructive/10 text-destructive text-sm rounded-lg flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="flex-1">
            {error}
            <button onClick={clearError} className="ml-2 underline">
              Скрыть
            </button>
          </div>
        </div>
      )}

      {/* Loading State */}
      {isLoading && (
        <div className="m-3 p-4 bg-primary/5 rounded-lg">
          <div className="flex items-center gap-3 mb-2">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
            <span className="font-medium">Обработка...</span>
            <span className="ml-auto text-sm text-muted-foreground">{progress}%</span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Tab Content */}
      <div className="flex-1 overflow-auto p-4">
        {activeTab === 'remove-bg' ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Выберите изображение на холсте и нажмите кнопку для удаления фона.
            </p>

            {/* Selected Image Preview */}
            {selectedImageUrl ? (
              <div className="aspect-square w-full max-w-[200px] mx-auto bg-muted rounded-lg overflow-hidden border">
                <img src={selectedImageUrl} alt="Selected" className="w-full h-full object-contain" />
              </div>
            ) : (
              <div className="aspect-square w-full max-w-[200px] mx-auto bg-muted rounded-lg flex items-center justify-center border border-dashed">
                <div className="text-center text-muted-foreground">
                  <ImageIcon className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p className="text-xs">Выберите изображение</p>
                </div>
              </div>
            )}

            {/* Advanced Settings */}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <Settings2 className="w-4 h-4" />
              Настройки
              {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {showAdvanced && (
              <div className="space-y-3 p-3 bg-muted/50 rounded-lg">
                <div>
                  <label className="text-xs font-medium">Модель</label>
                  <select
                    value={rembgModel}
                    onChange={(e) => setRembgModel(e.target.value)}
                    className="w-full mt-1 px-2 py-1.5 text-sm border rounded"
                  >
                    <option value="birefnet-general-lite">BiRefNet Lite (быстрый)</option>
                    <option value="birefnet-general">BiRefNet (качественный)</option>
                    <option value="birefnet-portrait">BiRefNet Portrait (для людей)</option>
                    <option value="u2net">U²-Net</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={alphaMatting}
                    onChange={(e) => setAlphaMatting(e.target.checked)}
                    className="rounded"
                  />
                  Alpha Matting (волосы, мех)
                </label>
              </div>
            )}

            <button
              onClick={handleRemoveBackground}
              disabled={isLoading || !selectedImageUrl}
              className="w-full py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <Wand2 className="w-4 h-4" />
              Удалить фон
              <span className="ml-auto text-xs opacity-75">Бесплатно</span>
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Prompt */}
            <div>
              <label className="text-sm font-medium">Описание изображения</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Например: Товар на мраморной столешнице, мягкий свет сбоку, минималистичный белый фон..."
                className="w-full mt-1 px-3 py-2 border rounded-lg h-24 text-sm resize-none"
              />
              <p className="text-xs text-muted-foreground mt-1">{prompt.length}/1000</p>
            </div>

            {/* Use Reference */}
            {selectedImageUrl && (
              <label className="flex items-center gap-2 p-3 border rounded-lg cursor-pointer hover:bg-muted/50">
                <input
                  type="checkbox"
                  checked={useReference}
                  onChange={(e) => setUseReference(e.target.checked)}
                  className="rounded"
                />
                <div className="flex-1">
                  <p className="text-sm font-medium">Использовать как референс</p>
                  <p className="text-xs text-muted-foreground">Стиль и композиция из выбранного изображения</p>
                </div>
              </label>
            )}

            <p className="text-sm font-medium">Модель: GPT Image 2 (OpenAI)</p>

            {/* Aspect Ratio */}
            <div>
              <label className="text-sm font-medium">Пропорции</label>
              <div className="flex gap-2 mt-1 flex-wrap">
                {(['3:4', '1:1', '4:3', '9:16', '16:9'] as const).map((ratio) => (
                  <button
                    key={ratio}
                    onClick={() => setAspectRatio(ratio)}
                    className={`px-3 py-1.5 text-xs border rounded ${
                      aspectRatio === ratio ? 'border-primary bg-primary/5' : ''
                    }`}
                  >
                    {ratio}
                  </button>
                ))}
              </div>
            </div>

            {/* Variants */}
            <div>
              <label className="text-sm font-medium">Количество вариантов</label>
              <div className="flex gap-2 mt-1">
                {([1, 2, 4] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setVariants(v)}
                    className={`flex-1 py-2 text-sm border rounded ${
                      variants === v ? 'border-primary bg-primary/5' : ''
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>

            <p className="rounded-lg bg-indigo-50 p-3 text-sm text-indigo-900">Сервис бесплатный. Генерация оплачивается с вашего счёта OpenAI. <a href="/settings/ai" className="underline">Подключить ключ</a></p>
            <button
              onClick={handleGenerate}
              disabled={isLoading || !prompt.trim()}
              className="w-full py-3 bg-purple-500 text-white rounded-lg hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <Sparkles className="w-4 h-4" />
              Сгенерировать
            </button>


          </div>
        )}
      </div>
    </div>
  );
}
