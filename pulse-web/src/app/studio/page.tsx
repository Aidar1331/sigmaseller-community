'use client';

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { useWorkspaceStore } from '@/store/workspace';
import { apiFetch } from '@/lib/api';
import {
  Sparkles,
  Image as ImageIcon,
  Loader2,
  Download,
  Coins,
  Video,
  Upload,
  X,
  Filter,
  Package,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { PromptSuggestionsPanel } from '@/components/studio/PromptSuggestionsPanel';
import type { SuggestedPrompt } from '@/components/studio/PromptSuggestionsPanel';
import { PromptHistoryTab } from '@/components/studio/PromptHistoryTab';
import { RichContentTab } from '@/components/studio/RichContentTab';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';
import { History } from 'lucide-react';
import { useStudioTaskStore } from '@/store/studioTask';

type Kind = 'image' | 'video';
type TopView = 'generator' | 'history' | 'rich';

type ImageModel =
  | 'gpt-image-2' | 'gpt-image-1.5'
  | 'gen4_image' | 'gen4_image_turbo' | 'gemini_2.5_flash'
  | 'gpt_image_2';
type Quality = 'auto' | 'low' | 'medium' | 'high';
type AspectRatio = '1:1' | '3:4' | '4:3' | '9:16' | '16:9';

type VideoModel =
  | 'sora-2-pro' | 'sora-2'
  | 'gen4.5' | 'gen4_turbo' | 'gen4_aleph'
  | 'gen3a_turbo' | 'act_two'
  | 'veo3'
  | 'veo3.1_audio' | 'veo3.1_noaudio'
  | 'veo3.1_fast_audio' | 'veo3.1_fast_noaudio';

type VideoSize =
  | '1280x720' | '720x1280'
  | '1024x1024'
  | '1920x1080' | '1080x1920'
  | '1280x768' | '768x1280';

interface GenerationTask {
  taskId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number;
  output?: {
    images?: Array<{ url: string; assetId: number }>;
    video?: { url: string; assetId: number; seconds: number; size: string };
  };
  error?: string;
}

interface Asset {
  assetId: number;
  url: string;
  name: string | null;
  type: string;
  createdAt: string;
  metadata?: { kind?: 'image' | 'video'; model?: string; prompt?: string };
}

const IMAGE_MODELS: { value: ImageModel; label: string; provider: 'openai' | 'runway' }[] = [
  // 2 модели: одна от OpenAI (текст, инфографика), одна от Google (image-to-image
  // с сохранением товара). Технически gemini_2.5_flash и gpt_image_2 идут
  // через Runway-аккаунт, но пользователю это не релевантно — показываем
  // имя поставщика самой модели.
  { value: 'gpt_image_2',      label: 'GPT Image 2 (OpenAI)',     provider: 'runway' },
  { value: 'gemini_2.5_flash', label: 'Nano Banana (Google)',     provider: 'runway' },
];

const VIDEO_MODELS: { value: VideoModel; label: string; provider: 'openai' | 'runway'; requiresImage?: boolean; note?: string }[] = [
  // Кураторский набор из трёх: Gen-4 Turbo (хорошая анимация, image-to-video),
  // премиум Veo с аудио, OpenAI Sora. Gen-4 Turbo не позиционируется как
  // "дешёвый" (хотя так и есть) — это качественная анимация фото, которую
  // покупатель будет видеть на карточке. Остальные модели (gen4.5/aleph/
  // 3a/act_two/sora-pro/veo3 base/...) поддержаны на бэке и в pricing-table.
  { value: 'gen4_turbo',     label: 'Runway Gen-4 Turbo (хорошая анимация)', provider: 'runway' },
  { value: 'veo3.1_audio',   label: 'Google Veo 3.1 (с аудио, премиум)',     provider: 'runway' },
  { value: 'sora-2',         label: 'OpenAI Sora 2 (премиум)',               provider: 'openai' },
];

const ASPECT_RATIOS: { value: AspectRatio; label: string }[] = [
  { value: '3:4', label: 'Карточка WB — 3:4' },
  { value: '9:16', label: 'Мобильное / Сторис — 9:16' },
  { value: '1:1', label: 'Квадрат — 1:1' },
  { value: '4:3', label: 'Альбом — 4:3' },
  { value: '16:9', label: 'Горизонтальное — 16:9' },
];

const VIDEO_SIZES: { value: VideoSize; label: string; providers: ('openai' | 'runway')[] }[] = [
  // Подписи переписаны 2026-05-25 на понятные пользователю формулировки:
  // "горизонтальное / квадрат / мобильное (сторис)" вместо технического
  // "вертикаль" и сырых соотношений 16:9.6, которые ничего не говорят.
  { value: '1280x720',  label: 'Горизонтальное HD — 1280×720',                providers: ['openai'] },
  { value: '1920x1080', label: 'Горизонтальное Full HD — 1920×1080',          providers: ['openai', 'runway'] },
  { value: '1280x768',  label: 'Горизонтальное (Runway) — 1280×768',          providers: ['runway'] },
  { value: '1024x1024', label: 'Квадрат — 1024×1024',                         providers: ['openai', 'runway'] },
  { value: '720x1280',  label: 'Мобильное / Сторис — 720×1280',               providers: ['openai'] },
  { value: '768x1280',  label: 'Мобильное / Сторис (Runway) — 768×1280',      providers: ['runway'] },
  { value: '1080x1920', label: 'Мобильное / Сторис Full HD — 1080×1920',      providers: ['openai', 'runway'] },
];

const QUALITIES: { value: Quality; label: string }[] = [
  { value: 'auto',   label: 'Авто' },
  { value: 'low',    label: 'Low (черновик / 720p Runway)' },
  { value: 'medium', label: 'Medium' },
  { value: 'high',   label: 'High (финал / 1080p Runway)' },
];

// Phase 3 fix 2026-05-07: Next.js 15 fails the build when useSearchParams()
// is called inside a default export without a Suspense boundary. Pattern:
// rename the body to `*Inner` and wrap with <Suspense> in the exported page.
function StudioPageInner() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);

  const [kind, setKind] = useState<Kind>('image');
  const [topView, setTopView] = useState<TopView>('generator');
  const [prompt, setPrompt] = useState('');

  // image state
  const [imageModel, setImageModel] = useState<ImageModel>('gemini_2.5_flash');
  const [quality, setQuality] = useState<Quality>('auto');
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('1:1');
  const [variants, setVariants] = useState<1 | 2 | 4>(1);

  // video state
  const [videoModel, setVideoModel] = useState<VideoModel>('gen4_turbo');
  const [videoSize, setVideoSize] = useState<VideoSize>('1280x768');
  const [videoSeconds, setVideoSeconds] = useState<number>(5);

  // product fidelity mode — adds preservation prefix to prompt when ref image uploaded
  const [productMode, setProductMode] = useState(true);

  // history refresh trigger — increments on generation complete to force PromptHistoryTab re-fetch
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  // stores the prompt used for the last generation (for history record)
  const lastPromptRef = useRef<{ prompt: string; model: string; kind: string; nmId?: number; aspectRatio?: string; referenceImageUrl?: string } | null>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // reference image for image-to-video
  const [refImageFile, setRefImageFile] = useState<File | null>(null);
  const [refImageUrl, setRefImageUrl] = useState<string | null>(null);
  const [uploadingRef, setUploadingRef] = useState(false);

  // Активная задача — из глобального zustand store (живёт выше страницы,
  // polling идёт из AppShell → при навигации не теряется).
  const storeActiveTask = useStudioTaskStore((s) => s.activeTask);
  const setStoreActiveTask = useStudioTaskStore((s) => s.setActiveTask);
  const currentTask = storeActiveTask as GenerationTask | null;
  const setCurrentTask = (task: GenerationTask | null) => setStoreActiveTask(task as any);
  const generating = !!currentTask && (currentTask.status === 'pending' || currentTask.status === 'processing');
  const setGenerating = (_: boolean) => { /* derived from currentTask */ };

  const [error, setError] = useState<string | null>(null);

  const [balance, setBalance] = useState<number | null>(null);
  const [estimate, setEstimate] = useState<{ rub: number; usd: number } | null>(null);

  // Library
  const [library, setLibrary] = useState<Asset[]>([]);
  const [libFilter, setLibFilter] = useState<'all' | 'image' | 'video'>('all');
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // Product / prompts
  const [nmIdInput, setNmIdInput] = useState('');
  const [showPromptsPanel, setShowPromptsPanel] = useState(false);
  const [auditSource, setAuditSource] = useState<number | null>(null);

  const searchParams = useSearchParams();

  const refreshBalance = useCallback(() => {
    if (!workspaceId) return;
    apiFetch<{ balanceRub: number }>(`/ai/${workspaceId}/balance`)
      .then((r) => setBalance(r.balanceRub))
      .catch(() => {});
  }, [workspaceId]);

  const refreshLibrary = useCallback(() => {
    if (!workspaceId) return;
    apiFetch<{ assets: Asset[] }>(`/studio/assets?workspaceId=${workspaceId}&limit=200&scope=mine`)
      .then((r) => setLibrary(r.assets ?? []))
      .catch(() => {});
  }, [workspaceId]);

  // Two-step confirm: первый клик ставит id в "pending delete", второй — удаляет.
  // Без modal'a, чтобы не плодить лишних диалогов в гриде.
  const [pendingDeleteAssetId, setPendingDeleteAssetId] = useState<number | null>(null);
  const handleDeleteAsset = useCallback(async (assetId: number) => {
    try {
      await apiFetch(`/studio/assets/${assetId}`, { method: 'DELETE' });
      setLibrary((prev) => prev.filter((a) => a.assetId !== assetId));
      setPendingDeleteAssetId(null);
    } catch (e: any) {
      setError(`Не удалось удалить: ${e?.message ?? e}`);
    }
  }, []);

  useEffect(() => { refreshBalance(); }, [refreshBalance]);
  useEffect(() => { refreshLibrary(); }, [refreshLibrary]);

  // Deep-link: ?prompt=...&nmId=...&model=...&kind=image|video&source=audit&auditId=N&aspectRatio=...&refImage=...
  useEffect(() => {
    const p = searchParams.get('prompt');
    const nm = searchParams.get('nmId');
    const model = searchParams.get('model');
    const k = searchParams.get('kind');
    const src = searchParams.get('source');
    const audit = searchParams.get('auditId');
    const ar = searchParams.get('aspectRatio');
    const ref = searchParams.get('refImage');

    if (p) setPrompt(p);
    if (nm) setNmIdInput(nm);
    if (k === 'video' || k === 'image') setKind(k);
    if (model) {
      if (k === 'video' || (!k && model.includes('sora') || model.includes('gen4.') || model.includes('veo'))) {
        setVideoModel(model as VideoModel);
      } else {
        setImageModel(model as ImageModel);
      }
    }
    if (ar === '1:1' || ar === '3:4' || ar === '4:3' || ar === '9:16' || ar === '16:9') setAspectRatio(ar);
    if (ref) setRefImageUrl(ref);
    if (src === 'audit' && audit) setAuditSource(Number(audit));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const videoProvider = useMemo(
    () => VIDEO_MODELS.find((m) => m.value === videoModel)?.provider ?? 'runway',
    [videoModel]
  );
  const modelRequiresImage = useMemo(
    () => VIDEO_MODELS.find((m) => m.value === videoModel)?.requiresImage ?? false,
    [videoModel]
  );

  // Auto-correct size when switching provider
  useEffect(() => {
    const allowed = VIDEO_SIZES.filter((s) => s.providers.includes(videoProvider));
    if (!allowed.some((s) => s.value === videoSize)) {
      setVideoSize(allowed[0]?.value ?? '1280x720');
    }
  }, [videoProvider, videoSize]);

  // Fetch live estimate on settings change
  useEffect(() => {
    if (!workspaceId) return;
    const params = kind === 'image'
      ? { kind: 'image', model: imageModel, quality, aspectRatio, variants }
      : { kind: 'video', model: videoModel, seconds: videoSeconds, size: videoSize };
    const h = setTimeout(() => {
      apiFetch<{ rub: number; usd: number }>(`/studio/ai/estimate?workspaceId=${workspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
        .then(setEstimate)
        .catch(() => setEstimate(null));
    }, 150);
    return () => clearTimeout(h);
  }, [workspaceId, kind, imageModel, quality, aspectRatio, variants, videoModel, videoSeconds, videoSize]);

  // Poll task — полинг теперь в AppShell (useStudioTaskPolling), здесь только
  // реакция на статус: показать ошибку в UI, обновить баланс/библиотеку на завершении.
  useEffect(() => {
    if (!currentTask) return;
    if (currentTask.status === 'completed') {
      setGenerating(false);
      refreshBalance();
      refreshLibrary();
      // История пишется на backend в worker (studioQueue.ts) — надёжно при обрыве
      // связи. Здесь только триггерим refetch вкладки "История промптов".
      setHistoryRefreshKey((k) => k + 1);
      lastPromptRef.current = null;
    } else if (currentTask.status === 'failed') {
      setGenerating(false);
      setError(currentTask.error || 'Ошибка генерации');
      lastPromptRef.current = null;
    }
  }, [currentTask?.status, currentTask?.error, refreshBalance, refreshLibrary]);

  // Ref image upload
  const handleRefImageChange = useCallback(async (file: File | null) => {
    setRefImageFile(file);
    setRefImageUrl(null);
    if (!file || !workspaceId) return;
    setUploadingRef(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiFetch<{ asset: { url: string } }>(
        `/studio/assets/upload?workspaceId=${workspaceId}&type=reference`,
        { method: 'POST', body: fd },
      );
      setRefImageUrl(res.asset.url);
    } catch (e: any) {
      setError(`Не удалось загрузить изображение: ${e?.message || e}`);
      setRefImageFile(null);
    } finally {
      setUploadingRef(false);
    }
  }, [workspaceId]);

  const clearRefImage = useCallback(() => { setRefImageFile(null); setRefImageUrl(null); }, []);

  const totalRub = estimate?.rub ?? 0;

  const refMissing = kind === 'video' && modelRequiresImage && !refImageUrl;

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) return;
    if (refMissing) { setError('Для этой модели нужно загрузить опорное изображение'); return; }
    setError(null);
    setGenerating(true);
    const basePrompt = prompt.trim();
    lastPromptRef.current = {
      prompt: basePrompt,
      model: kind === 'image' ? imageModel : videoModel,
      kind,
      nmId: Number(nmIdInput) > 0 ? Number(nmIdInput) : undefined,
      aspectRatio: kind === 'image' ? aspectRatio : undefined,
      referenceImageUrl: refImageUrl || undefined,
    };
    // Product-fidelity: @product — это Runway-tag из referenceImages (см.
    // runwayImage.ts). Модель удерживает внешний вид товара строже, чем по
    // одному только uri. Префикс короткий (Runway promptText ≤1000 chars).
    const PRODUCT_FIDELITY_PREFIX =
      'STRICT: @product must stay IDENTICAL — exact shape, colors, materials, labels, logos unchanged. Change ONLY scene/background/lighting.';
    const rawPrompt = kind === 'image' && productMode && refImageUrl
      ? `@product ${basePrompt}\n\n${PRODUCT_FIDELITY_PREFIX}`
      : basePrompt;
    // Runway (и большинство image-API) режет promptText на 1000 символах → режем сами
    // с запасом до 980, иначе backend получит 400. Сохраняем конец — именно там
    // описание сцены, которое даёт вариативность.
    const finalPrompt = rawPrompt.length > 980 ? rawPrompt.slice(0, 977) + '...' : rawPrompt;
    try {
      if (kind === 'image') {
        const result = await apiFetch<{ taskId: string }>(`/studio/ai/generate?workspaceId=${workspaceId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: finalPrompt,
            model: imageModel,
            aspectRatio,
            quality,
            variants,
            referenceImageUrl: refImageUrl || undefined,
            nmId: Number(nmIdInput) > 0 ? Number(nmIdInput) : undefined,
          }),
        });
        setStoreActiveTask({
          taskId: result.taskId,
          status: 'pending',
          kind: 'image',
          prompt: prompt.trim(),
          model: imageModel,
          startedAt: Date.now(),
        });
      } else {
        const result = await apiFetch<{ taskId: string }>(`/studio/ai/generate-video?workspaceId=${workspaceId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: prompt.trim(),
            model: videoModel,
            size: videoSize,
            seconds: videoSeconds,
            referenceImageUrl: refImageUrl || undefined,
          }),
        });
        setStoreActiveTask({
          taskId: result.taskId,
          status: 'pending',
          kind: 'video',
          prompt: prompt.trim(),
          model: videoModel,
          startedAt: Date.now(),
        });
      }
    } catch (err: any) {
      setGenerating(false);
      setError(err?.message || 'Ошибка запроса');
    }
  }, [kind, prompt, imageModel, aspectRatio, quality, variants, videoModel, videoSize, videoSeconds, refImageUrl, refMissing, workspaceId]);

  const taskOutputImages = currentTask?.output?.images ?? [];
  const taskOutputVideo = currentTask?.output?.video;

  const filteredLibrary = useMemo(() => {
    if (libFilter === 'all') return library;
    return library.filter((a) => a.metadata?.kind === libFilter);
  }, [library, libFilter]);

  return (
    <AppShell title="AI Студия">
      <div className="max-w-5xl mx-auto space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">AI-генерация</h2>
          <a href="/settings/ai" className="text-sm text-indigo-600 underline">Мои ключи ИИ</a>
        </div>

        {/* Top tabs: Generator (Фото / Видео) / История. На мобиле — скролл,
            а не перенос строки: 4 таба не влезают в 375px и текст ломался. */}
        <div className="overflow-x-auto -mx-1 px-1">
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
            <button
              className={cn('flex shrink-0 items-center gap-2 rounded-md px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                topView === 'generator' && kind === 'image' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50')}
              onClick={() => { setTopView('generator'); setKind('image'); setCurrentTask(null); clearRefImage(); }}
              disabled={generating}
            >
              <ImageIcon className="h-4 w-4" /> Фото
            </button>
            <button
              className={cn('flex shrink-0 items-center gap-2 rounded-md px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                topView === 'generator' && kind === 'video' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50')}
              onClick={() => { setTopView('generator'); setKind('video'); setCurrentTask(null); clearRefImage(); }}
              disabled={generating}
            >
              <Video className="h-4 w-4" /> Видео
            </button>
            <button
              className={cn('flex shrink-0 items-center gap-2 rounded-md px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                topView === 'history' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50')}
              onClick={() => setTopView('history')}
            >
              <History className="h-4 w-4" /> История промптов
            </button>
            <button
              className={cn('flex shrink-0 items-center gap-2 rounded-md px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                topView === 'rich' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50')}
              onClick={() => setTopView('rich')}
              disabled={generating}
            >
              <Sparkles className="h-4 w-4" /> Рич контент
            </button>
          </div>
        </div>

        {/* Rich Content view */}
        {topView === 'rich' && workspaceId && (
          <RichContentTab workspaceId={workspaceId} />
        )}

        {/* History view */}
        {topView === 'history' && workspaceId && (
          <PromptHistoryTab
            workspaceId={workspaceId}
            refreshKey={historyRefreshKey}
            onOpenInStudio={(p, nmId) => {
              setTopView('generator');
              setPrompt(p.promptText);
              setNmIdInput(String(nmId));
              if (p.kind.startsWith('video_')) setKind('video');
              else setKind('image');
              if (p.referenceImageUrl) setRefImageUrl(p.referenceImageUrl);
            }}
          />
        )}

        {/* Generator form — visible only in generator view */}
        {topView === 'generator' && (
        <div className="space-y-6">

        <div className="rounded-xl border border-gray-200 bg-white p-6 space-y-5">
          {/* Source badge: if opened from audit */}
          {auditSource && (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-indigo-50 border border-indigo-200 px-3 py-2 text-xs">
              <div className="flex items-center gap-2 text-indigo-800">
                <Sparkles className="h-3.5 w-3.5" />
                <span>Промпт получен из аудита #{auditSource}</span>
              </div>
              <a href={`/creative-audit`} className="text-indigo-600 hover:underline font-medium">← К аудиту</a>
            </div>
          )}

          {/* Product / prompt suggester */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="flex items-start gap-2">
              <Package className="h-4 w-4 text-gray-500 mt-2.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <label className="block text-xs font-medium text-gray-700 mb-1">Товар WB (опционально)</label>
                {/* На мобиле — стопкой, поле + кнопка ниже на всю ширину.
                    На sm+ — в строку, кнопка справа. До правки кнопка налезала
                    на инпут и поиск был не доступен. */}
                <div className="flex flex-col gap-2 sm:flex-row">
                  {workspaceId ? (
                    <div className="flex-1 min-w-0">
                      <ProductSearchInput
                        workspaceId={workspaceId}
                        value={nmIdInput}
                        onChange={setNmIdInput}
                        single
                        placeholder="Поиск по названию, артикулу или бренду…"
                      />
                    </div>
                  ) : (
                    <div className="flex-1 text-xs text-gray-500 py-2">Выберите workspace</div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      const n = Number(nmIdInput);
                      if (Number.isFinite(n) && n > 0) setShowPromptsPanel(true);
                      else setError('Выберите товар из списка');
                    }}
                    disabled={!nmIdInput || generating}
                    className="w-full sm:w-auto shrink-0 inline-flex items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                  >
                    🎯 Подсказать промпты
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-gray-500">
                  Найдите товар словами или по Артикулу — AI подберёт готовые промпты для фото/видео по вашей карточке.
                </p>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Промпт</label>
            <textarea
              ref={promptTextareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={kind === 'image'
                ? 'Опишите изображение, которое хотите сгенерировать...'
                : 'Опишите видеоролик (сцена, движение камеры, стиль)...'}
              className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 resize-none"
              rows={4}
              disabled={generating}
            />
            <p className="mt-1 text-[11px] text-gray-500">
              💡 Промпт не сбрасывается после генерации — отредактируйте и сгенерируйте снова.
            </p>
          </div>

          {/* Reference image upload (image-to-video or image-to-image) */}
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Опорное изображение {refMissing && <span className="text-red-500">*</span>}
                </label>
                <p className="text-xs text-gray-500 mt-0.5">
                  {kind === 'video'
                    ? modelRequiresImage
                      ? 'Обязательно для выбранной модели — даёт анимацию исходной картинки.'
                      : 'Опционально. Для image-to-video — анимирует загруженное изображение.'
                    : '📦 Загрузите фото вашего товара — AI сохранит его точный вид на новом фоне/сцене.'}
                </p>
              </div>
              {refImageUrl ? (
                <button onClick={clearRefImage} className="flex items-center gap-1 text-xs text-gray-600 hover:text-red-600">
                  <X className="h-3 w-3" /> Убрать
                </button>
              ) : (
                <label className="flex items-center gap-1.5 cursor-pointer rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                  <Upload className="h-3.5 w-3.5" />
                  {uploadingRef ? 'Загрузка...' : 'Загрузить'}
                  <input type="file" accept="image/*" className="hidden" disabled={uploadingRef || generating}
                    onChange={(e) => handleRefImageChange(e.target.files?.[0] ?? null)} />
                </label>
              )}
            </div>
            {refImageUrl && (
              <div className="mt-3">
                <img src={refImageUrl} alt="ref" className="h-24 rounded-md border border-gray-200 object-cover" />
              </div>
            )}
          </div>

          {kind === 'image' && refImageUrl && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 space-y-2">
              <label className="flex items-start gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={productMode}
                  onChange={(e) => setProductMode(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-indigo-600 mt-0.5"
                />
                <div>
                  <div className="text-sm font-semibold text-indigo-900">
                    🎯 Режим точного сохранения товара
                  </div>
                  <div className="text-[11px] text-indigo-800/80 mt-0.5 leading-relaxed">
                    AI получит инструкцию воспроизвести товар 1-в-1 по опорному фото: форма,
                    цвета, материалы, логотипы, швы — без изменений. Меняется только сцена и фон.
                  </div>
                </div>
              </label>
              {productMode && !['gemini_2.5_flash', 'gen4_image', 'gen4_image_turbo', 'gpt_image_2'].includes(imageModel) && (
                <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900">
                  <span className="text-sm">⚠️</span>
                  <div>
                    <strong>Текущая модель ({imageModel}) плохо сохраняет товар с опорного фото.</strong>
                    <br />
                    Для точного соответствия рекомендуется <strong>Gemini 2.5 Flash</strong> или <strong>Runway Gen-4</strong> —
                    они используют image-to-image и держат товар идентичным референсу.
                    <button
                      type="button"
                      onClick={() => setImageModel('gemini_2.5_flash')}
                      className="ml-2 underline font-semibold hover:text-amber-950"
                    >
                      Переключить на Gemini 2.5 Flash
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {kind === 'image' ? (
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Модель</label>
                <select value={imageModel} onChange={(e) => setImageModel(e.target.value as ImageModel)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm bg-white" disabled={generating}>
                  {IMAGE_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Качество</label>
                <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm bg-white" disabled={generating}>
                  {QUALITIES.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Формат</label>
                <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm bg-white" disabled={generating}>
                  {ASPECT_RATIOS.map((ar) => <option key={ar.value} value={ar.value}>{ar.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Вариантов</label>
                <select value={variants} onChange={(e) => setVariants(Number(e.target.value) as 1 | 2 | 4)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm bg-white" disabled={generating}>
                  <option value={1}>1</option><option value={2}>2</option><option value={4}>4</option>
                </select>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Модель</label>
                <select value={videoModel} onChange={(e) => setVideoModel(e.target.value as VideoModel)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm bg-white" disabled={generating}>
                  {VIDEO_MODELS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}{m.note ? ` — ${m.note}` : ''}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Размер</label>
                <select value={videoSize} onChange={(e) => setVideoSize(e.target.value as VideoSize)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm bg-white" disabled={generating}>
                  {VIDEO_SIZES.filter((s) => s.providers.includes(videoProvider))
                    .map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Длительность</label>
                <select value={videoSeconds} onChange={(e) => setVideoSeconds(Number(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm bg-white" disabled={generating}>
                  {videoProvider === 'runway' ? (
                    <><option value={4}>4 сек</option><option value={5}>5 сек</option><option value={8}>8 сек</option><option value={10}>10 сек</option></>
                  ) : (
                    <><option value={4}>4 сек</option><option value={8}>8 сек</option><option value={12}>12 сек</option></>
                  )}
                </select>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm text-gray-500">
              Оплата генерации — с вашего счёта у провайдера. Итоговую стоимость определяет провайдер.
              {/* USD-эквивалент скрыт по запросу 2026-05-25 — пользователю показываем только рубли. */}
              {kind === 'image' && (
                <span className="ml-2 text-xs text-gray-500">обычно занимает 5 мин</span>
              )}
              {kind === 'video' && (
                <span className="ml-2 text-xs text-gray-500">
                  {videoProvider === 'runway' ? 'Runway: 1-3 мин' : 'Sora: 2-5 мин'}
                </span>
              )}
            </span>
            <button
              onClick={handleGenerate}
              disabled={generating || !prompt.trim() || refMissing || uploadingRef}
              className={cn(
                'flex items-center gap-2 rounded-lg px-6 py-2.5 text-sm font-medium text-white transition-colors',
                generating || !prompt.trim() || refMissing || uploadingRef
                  ? 'bg-gray-300 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-700'
              )}
            >
              {generating ? (<><Loader2 className="h-4 w-4 animate-spin" /> Генерация...</>) : (<><Sparkles className="h-4 w-4" /> Сгенерировать</>)}
            </button>
          </div>

          {error && <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>}
        </div>

        {currentTask && currentTask.status !== 'failed' && (
          <div className="rounded-xl border border-gray-200 bg-white p-6">
            {currentTask.status === 'completed' ? (
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-4">Результат</h3>
                {taskOutputImages.length > 0 && (
                  <div className={taskOutputImages.length === 1 ? 'flex justify-center' : 'grid grid-cols-2 sm:grid-cols-4 gap-4'}>
                    {taskOutputImages.map((img, i) => (
                      <div key={i} className="group relative rounded-lg overflow-hidden border border-gray-200 bg-white">
                        <img src={img.url} alt={`Вариант ${i + 1}`} className="w-full object-contain" style={{ maxHeight: '400px' }} />
                        <a href={img.url} download target="_blank" rel="noreferrer"
                          className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Download className="h-6 w-6 text-white" />
                        </a>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex items-center justify-between text-xs">
                  <span className="text-gray-500">
                    Текущий промпт сохранён в поле выше — отредактируйте и нажмите «Сгенерировать».
                  </span>
                  <button
                    onClick={() => {
                      setCurrentTask(null);
                      // Прокрутка к textarea + фокус
                      requestAnimationFrame(() => {
                        promptTextareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        promptTextareaRef.current?.focus();
                      });
                    }}
                    className="text-indigo-600 hover:text-indigo-800 hover:underline font-medium whitespace-nowrap ml-3"
                  >
                    ✏️ Редактировать промпт
                  </button>
                </div>
                {taskOutputVideo && (
                  <div className="rounded-lg overflow-hidden border border-gray-200">
                    <video src={taskOutputVideo.url} controls className="w-full" />
                    <div className="flex items-center justify-between p-3 text-xs text-gray-500">
                      <span>{taskOutputVideo.seconds} сек · {taskOutputVideo.size}</span>
                      <a href={taskOutputVideo.url} download className="flex items-center gap-1 text-indigo-600 hover:underline">
                        <Download className="h-3 w-3" /> Скачать
                      </a>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <Loader2 className="h-5 w-5 text-indigo-500 animate-spin" />
                <div>
                  <div className="text-sm font-medium text-gray-700">
                    {currentTask.status === 'pending' ? 'В очереди...' : 'Генерация...'}
                  </div>
                  {currentTask.progress != null && (
                    <div className="mt-2 w-64 h-2 rounded-full bg-gray-100">
                      <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${currentTask.progress}%` }} />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Library — per user */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-800">Моя библиотека</h3>
            <div className="flex items-center gap-2 text-xs">
              <Filter className="h-3 w-3 text-gray-500" />
              {(['all', 'image', 'video'] as const).map((f) => (
                <button key={f}
                  className={cn('rounded-md px-2.5 py-1 transition-colors',
                    libFilter === f ? 'bg-indigo-50 text-indigo-700' : 'text-gray-500 hover:bg-gray-50')}
                  onClick={() => setLibFilter(f)}
                >
                  {f === 'all' ? 'Все' : f === 'image' ? 'Фото' : 'Видео'}
                </button>
              ))}
            </div>
          </div>

          {filteredLibrary.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-10 text-center">
              <ImageIcon className="h-10 w-10 mx-auto text-gray-300 mb-3" />
              <p className="text-sm text-gray-500">Ваши сохранённые генерации появятся здесь</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
              {filteredLibrary.map((asset) => {
                const isVideo = asset.metadata?.kind === 'video' || /\.mp4($|\?)/i.test(asset.url);
                return (
                  <div key={asset.assetId} className="group relative rounded-lg overflow-hidden border border-gray-200 aspect-square bg-gray-50">
                    {isVideo ? (
                      <video src={asset.url} muted loop className="w-full h-full object-cover" />
                    ) : (
                      <img
                        src={asset.url}
                        alt={asset.name || 'Генерация'}
                        className="w-full h-full object-contain bg-gray-50 cursor-zoom-in"
                        onClick={() => setLightboxUrl(asset.url)}
                      />
                    )}
                    {/* Top-right controls: download + delete. На мобиле hover'a
                        нет, поэтому показываем всегда (без opacity-0). */}
                    <div className="absolute top-1 right-1 flex gap-1">
                      <a
                        href={asset.url}
                        download
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        title="Скачать"
                        className="rounded-md bg-black/60 p-1 text-white opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity hover:bg-black/80"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </a>
                      {pendingDeleteAssetId === asset.assetId ? (
                        <>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleDeleteAsset(asset.assetId); }}
                            title="Подтвердить удаление"
                            className="rounded-md bg-red-600 px-1.5 text-[10px] font-medium text-white hover:bg-red-700"
                          >
                            Да
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setPendingDeleteAssetId(null); }}
                            title="Отмена"
                            className="rounded-md bg-black/60 px-1.5 text-[10px] font-medium text-white hover:bg-black/80"
                          >
                            Нет
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setPendingDeleteAssetId(asset.assetId); }}
                          title="Удалить"
                          className="rounded-md bg-black/60 p-1 text-white opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity hover:bg-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    {asset.metadata?.model && (
                      <div className="absolute bottom-0 left-0 right-0 text-[10px] bg-black/60 text-white px-1 py-0.5 truncate opacity-0 group-hover:opacity-100 pointer-events-none">
                        {asset.metadata.model}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
        </div>
        )}
      </div>

      {/* Prompt suggestions panel (Task 2) */}
      {showPromptsPanel && workspaceId && Number(nmIdInput) > 0 && (
        <PromptSuggestionsPanel
          nmId={Number(nmIdInput)}
          workspaceId={workspaceId}
          onClose={() => setShowPromptsPanel(false)}
          onGenerated={() => setHistoryRefreshKey((k) => k + 1)}
          onOpenInStudio={(p: SuggestedPrompt) => {
            setPrompt(p.promptText);
            if (p.kind.startsWith('video_')) setKind('video');
            else setKind('image');
            if (p.referenceImageUrl) setRefImageUrl(p.referenceImageUrl);
            setShowPromptsPanel(false);
          }}
        />
      )}

      {/* Lightbox для просмотра фото из библиотеки без скачивания */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 cursor-zoom-out"
          onClick={() => setLightboxUrl(null)}
        >
          <img
            src={lightboxUrl}
            alt="preview"
            className="max-h-full max-w-full object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            className="absolute top-4 right-4 rounded-full bg-white/90 p-2 shadow-lg hover:bg-white"
            onClick={() => setLightboxUrl(null)}
          >
            <X className="h-5 w-5" />
          </button>
          <a
            href={lightboxUrl}
            download
            target="_blank"
            rel="noreferrer"
            className="absolute top-4 right-16 rounded-full bg-white/90 p-2 shadow-lg hover:bg-white"
            onClick={(e) => e.stopPropagation()}
            title="Скачать"
          >
            <Download className="h-5 w-5" />
          </a>
        </div>
      )}
    </AppShell>
  );
}

export default function StudioPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-[var(--content-muted)]">Загрузка студии…</div>}>
      <StudioPageInner />
    </Suspense>
  );
}
