'use client';

/**
 * Rich Content Editor — конструктор бесшовного лендинга для карточки товара.
 *
 * WB Rich Content специфика (факт, проверено в документации продавца WB):
 *   — до 10 блоков на товар
 *   — оптимальная ширина 1080 px, JPG/PNG до 2,5 МБ, sRGB
 *   — высота произвольная, но чаще 720-1440 px (чтобы пройти 2,5 МБ на 1080w)
 *   — форматы блоков: 16:9 (1920×1080), 3:2 (1080×720), 1:1 (1080×1080), 3:4 (1080×1440)
 *
 * Workflow:
 *   1. Загружается ОПОРНОЕ фото товара — критично для единого вида продукта.
 *   2. Пользователь задаёт общий стиль (backdrop/lighting/tone) — суффикс для всех
 *      промптов → визуальная связность блоков как у единого лендинга.
 *   3. Выбирает набор блоков из шаблонов (обложка, фичи, деталь, lifestyle, cta...).
 *   4. Каждый блок имеет РЕДАКТИРУЕМЫЙ: заголовок оверлея, подзаголовок, AI-промпт.
 *   5. Генерация — один запрос на блок с общим styleSuffix + locked referenceImage.
 *   6. После готовности — превью как стопка landing-блоков с text-оверлеями (CSS),
 *      возможность пере-генерации отдельного блока, удаления, редактирования текста.
 */

import { useState, useCallback, useMemo } from 'react';
import { Sparkles, Loader2, Download, Upload, X, RefreshCw, Trash2, Pencil, Eye, Plus, GripVertical } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';
import { cn } from '@/lib/cn';

type AspectRatio = '1:1' | '3:4' | '4:3' | '16:9';
type BlockStatus = 'idle' | 'pending' | 'processing' | 'completed' | 'failed';

interface Block {
  id: string;
  templateKey: string;
  label: string;
  emoji: string;
  aspectRatio: AspectRatio;
  heading: string;
  body: string;
  promptCore: string;           // base creative description
  imageUrl?: string;
  taskId?: string;
  status: BlockStatus;
  error?: string;
}

interface Props {
  workspaceId: number;
}

interface BlockTemplate {
  key: string;
  label: string;
  emoji: string;
  aspectRatio: AspectRatio;
  heading: string;
  body: string;
  promptCore: string;
}

// Шаблоны блоков Rich Content = главы одного лендинга. Каждый блок имеет
// явную narrative-роль (intro / proof / trust / emotion / decision) и
// прямо говорит модели "это часть одной серии, тот же товар, тот же свет".
// Без этого получается 7 красивых, но независимых картинок; с этим —
// связная история, по которой можно скроллить как по одному лендингу.
const TEMPLATES: BlockTemplate[] = [
  {
    key: 'cover',
    label: 'Обложка',
    emoji: '🎬',
    aspectRatio: '3:4',
    heading: 'Ваш товар',
    body: 'Уникальное решение для вашего дома',
    // Narrative-role: opening chapter. Устанавливает свет, палитру и тон,
    // которые остальные блоки наследуют.
    promptCore: 'Opening chapter of a product landing. Editorial hero shot of THE product placed slightly off-center on a calm surface, generous negative space above for headline, soft directional north-window light from the left casting a long subtle shadow — this becomes the established light direction for the entire landing. Considered composition in the spirit of an Aesop or Muji lookbook, organic natural shadows, 35mm look with shallow but believable depth of field, restrained tonal grade that the rest of the set will share',
  },
  {
    key: 'feature1',
    label: 'Ключевая фича #1',
    emoji: '⭐',
    aspectRatio: '16:9',
    heading: 'Главная фишка',
    body: 'Что делает товар особенным',
    // Narrative-role: first proof point. Тот же товар, та же световая логика
    // что и в cover, просто ближе к ключевой детали.
    promptCore: 'Proof chapter #1 of the same product landing. Three-quarter close angle on THE SAME product\'s distinctive feature, raking side light coming from the same direction as the cover shot, the rest of the product falls into gentle shadow. Modern commerce editorial composition with strong negative space on one side for caption. Identical tonal grade and surface family as the other blocks',
  },
  {
    key: 'feature2',
    label: 'Ключевая фича #2',
    emoji: '🌟',
    aspectRatio: '16:9',
    heading: 'Дополнительное преимущество',
    body: 'Вторая ключевая возможность',
    // Narrative-role: second proof point. Свежий угол, тот же визуальный язык.
    promptCore: 'Proof chapter #2 of the same product landing. Top-down or 45-degree angle of THE SAME product revealing a second benefit, paired with one supporting prop that hints at use, considered minimalist arrangement. Soft overhead light with crisp natural shadow consistent with the rest of the set, cinematic mood without artificial bokeh, same restrained color story across the landing',
  },
  {
    key: 'detail',
    label: 'Крупный план',
    emoji: '🔍',
    aspectRatio: '1:1',
    heading: 'Внимание к деталям',
    body: 'Качественные материалы и отделка',
    // Narrative-role: trust through craft. Макро тех же материалов что в cover.
    promptCore: 'Trust chapter of the same product landing — earned through craft. Macro detail of THE SAME product\'s material and finish — texture, weave, grain or stitching visible — extreme sharpness on the surface plane. Gentle raking light at 30 degrees from the established direction reveals micro-texture. Calm uncluttered backdrop in the same material family as the other blocks. Editorial macro photography',
  },
  {
    key: 'usage',
    label: 'Сценарий использования',
    emoji: '🏡',
    aspectRatio: '16:9',
    heading: 'В вашем интерьере',
    body: 'Как это выглядит в реальной жизни',
    // Narrative-role: emotional context. Жизнь, в которой товар живёт.
    promptCore: 'Emotion chapter of the same product landing — show the life the product lives in. Authentic in-use scene with THE SAME product naturally placed in a lived-in modern interior that matches the landing\'s tonal palette, warm directional daylight pouring through an unseen window in the same direction as the cover. Real life detail (a half-finished cup, soft fabric, slight visual imperfection) gives believability. Lifestyle editorial in the spirit of contemporary interior magazines, no overly perfect set-design',
  },
  {
    key: 'scale',
    label: 'Размер',
    emoji: '📏',
    aspectRatio: '3:4',
    heading: 'Удобный размер',
    body: 'Компактный или вместительный — как вам нужно',
    // Narrative-role: practical answer to "will it fit my life".
    promptCore: 'Practical chapter of the same product landing — answers "what size is it actually". THE SAME product photographed next to one familiar scale reference (a single hand, a glass, an A4 sheet) so its size reads instantly. Even soft light from the established direction, neutral calm backdrop from the same material family as other blocks. Honest unembellished framing focused on conveying proportion. Editorial product comparison style',
  },
  {
    key: 'cta',
    label: 'Призыв к действию',
    emoji: '🛒',
    aspectRatio: '16:9',
    heading: 'Добавить в корзину',
    body: 'Успейте заказать сегодня',
    // Narrative-role: closing/decision. Возврат к hero feel, чуть тёплее.
    promptCore: 'Closing chapter of the same product landing — confident final hero. THE SAME product as the single subject on a clean considered surface that echoes the cover backdrop. Accent color from the product itself echoed in the palette of the entire set. Soft volumetric light with a single warm highlight, slightly warmer than the cover for closing mood. Premium calm composition that feels desirable without shouting, modern commerce editorial finish — viewer should feel this is the same landing\'s final note',
  },
];

// Размеры в пикселях для подсказки пользователю.
// ВАЖНО: фиксированы под gen4_image_turbo whitelist (см. runwayImage.ts).
// Эта модель даёт крупнее картинки (1440-1920 px) — подходит для WB Rich Content.
// WB принимает блоки шириной 1080-1920 px, до 2.5 МБ JPG/PNG.
const ASPECT_PIXELS: Record<AspectRatio, string> = {
  '1:1': '1024×1024',
  '3:4': '1080×1440',
  '4:3': '1440×1080',
  '16:9': '1920×1080',
};

// Современный коммерческий backdrop — материальный, а не плоский цвет.
// Плоские заливки выдают "AI stock look"; реальная фактура (бумага, гипс,
// дерево, мрамор) даёт глубину и совпадает с эстетикой 2026.
const BACKDROPS = [
  { value: 'paper',    label: 'Бумага',     suffix: 'matte paper surface in soft off-white with the faintest grain' },
  { value: 'plaster',  label: 'Штукатурка', suffix: 'hand-troweled warm plaster wall with subtle hand texture' },
  { value: 'gradient', label: 'Градиент',   suffix: 'gentle two-tone gradient backdrop, neutral with a single warm undertone' },
  { value: 'wood',     label: 'Светлое дерево', suffix: 'pale natural oak surface with restrained wood grain' },
  { value: 'stone',    label: 'Камень',     suffix: 'cool matte stone or travertine surface with very subtle veining' },
] as const;

// Свет описан конкретно — направление + температура + поведение тени, а не
// "soft studio lighting" (даёт generic CGI-вид). Современный editorial =
// направленный свет с длинной мягкой тенью.
const LIGHTINGS = [
  { value: 'north-window', label: 'Окно с севера', suffix: 'cool soft north-window light from the left, long gentle shadow falling to the right' },
  { value: 'golden-hour',  label: 'Золотой час',   suffix: 'warm low-angle golden-hour light, elongated soft shadows, honey tonal grade' },
  { value: 'studio-soft',  label: 'Студийный мягкий', suffix: 'single large diffused softbox at 45 degrees, subtle controlled fill, organic shadow falloff' },
  { value: 'rim',          label: 'Контровой',     suffix: 'controlled rim light from behind separating the subject from the backdrop, gentle ambient fill in front' },
] as const;

// Tone задаёт общий mood. Современные пресеты — без слов типа "luxury",
// "premium" в лоб; вместо этого — узнаваемые визуальные коды (editorial,
// scandi, cinematic), которые модели лучше понимают.
const TONES = [
  { value: 'editorial',    label: 'Editorial',    suffix: 'modern commerce editorial style, considered negative space, restrained color palette, no over-styling' },
  { value: 'scandinavian', label: 'Скандинавский', suffix: 'scandinavian minimalist aesthetic, calm muted palette, natural materials, breathing room' },
  { value: 'cinematic',    label: 'Кинематографичный', suffix: 'cinematic composition with intentional negative space, soft volumetric atmosphere, gentle film-stock grade' },
  { value: 'warm-home',    label: 'Тёплый дом',   suffix: 'warm lived-in homely mood, golden ambient grade, soft imperfect texture, inviting and human' },
] as const;

// @product — это tag в referenceImages (см. runwayImage.ts). Когда промпт
// упоминает @product, Runway жёстче держит внешний вид товара из референса.
const PRODUCT_FIDELITY_PREFIX =
  'STRICT: @product must stay IDENTICAL — exact shape, colors, materials, labels, logos unchanged. Change ONLY scene/background/lighting.';

function uuid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function RichContentTab({ workspaceId }: Props) {
  const [nmIdInput, setNmIdInput] = useState('');
  const [refImageUrl, setRefImageUrl] = useState<string | null>(null);
  const [uploadingRef, setUploadingRef] = useState(false);
  const [backdrop, setBackdrop] = useState<typeof BACKDROPS[number]['value']>('paper');
  const [lighting, setLighting] = useState<typeof LIGHTINGS[number]['value']>('north-window');
  const [tone, setTone] = useState<typeof TONES[number]['value']>('editorial');
  const [blocks, setBlocks] = useState<Block[]>(() => makeDefaultBlocks());
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);

  function makeDefaultBlocks(): Block[] {
    return ['cover', 'feature1', 'detail', 'usage', 'cta'].map((key) => templateToBlock(key)!);
  }

  function templateToBlock(key: string): Block | null {
    const t = TEMPLATES.find((x) => x.key === key);
    if (!t) return null;
    return {
      id: uuid(),
      templateKey: t.key,
      label: t.label,
      emoji: t.emoji,
      aspectRatio: t.aspectRatio,
      heading: t.heading,
      body: t.body,
      promptCore: t.promptCore,
      status: 'idle',
    };
  }

  const styleSuffix = useMemo(() => {
    const parts = [
      BACKDROPS.find((b) => b.value === backdrop)?.suffix,
      LIGHTINGS.find((l) => l.value === lighting)?.suffix,
      TONES.find((t) => t.value === tone)?.suffix,
    ].filter(Boolean);
    // Anti-AI хвост — отгоняет узнаваемые провалы генеративных моделей 2025–26:
    // пластиковый блеск, переэкспонированный fill, фейковый bokeh, "ИИ-композиция".
    // Эти явные negatives заметно поднимают качество "из коробки".
    const antiAi = 'Avoid: plastic AI sheen, overly polished CGI look, fake bokeh, symmetrical centered AI composition, generic stock-photo feel, oversaturated colors.';
    // Narrative anchor — модели важно понимать что это не отдельная картинка,
    // а одна глава лендинга. Без этого блоки получаются красивыми, но между
    // ними нет визуальной связи (разный свет, разные палитры, разные mood'ы).
    const narrative = 'This image is one chapter of a single coherent product landing. ALL blocks of the landing share: the same exact product (identity, color, materials must match the reference), the same light direction and color temperature, the same surface and backdrop material family, the same tonal grade. Reader should feel they are scrolling one continuous landing page, not seven independent product photos.';
    return `${narrative} Shared visual language: ${parts.join(', ')}. Consistent color palette and tonal grade across all blocks. ${antiAi}`;
  }, [backdrop, lighting, tone]);

  const handleRefImageChange = useCallback(async (file: File | null) => {
    setRefImageUrl(null);
    if (!file) return;
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
    } finally {
      setUploadingRef(false);
    }
  }, [workspaceId]);

  function buildPromptForBlock(block: Block): string {
    // @product в начале промпта — Runway tag из referenceImages; жёстче держит товар.
    // Если нет refImage — tag не создаётся, @product не используется.
    const core = refImageUrl ? `@product ${block.promptCore}` : block.promptCore;
    const tail = refImageUrl ? ` ${PRODUCT_FIDELITY_PREFIX}` : '';
    const raw = `${core}. ${styleSuffix}${tail} No watermark, no text, no invented logos.`;
    // Runway promptText ≤1000 chars — backend тоже режет, но режем и тут
    return raw.length > 980 ? raw.slice(0, 977) + '...' : raw;
  }

  const pollTask = useCallback(async (taskId: string, blockId: string) => {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const t = await apiFetch<any>(`/studio/ai/task/${taskId}?workspaceId=${workspaceId}`);
        if (t.status === 'completed') {
          const url = t.output?.images?.[0]?.url;
          setBlocks((prev) => prev.map((b) => b.id === blockId ? { ...b, status: 'completed', imageUrl: url } : b));
          return;
        }
        if (t.status === 'failed') {
          setBlocks((prev) => prev.map((b) => b.id === blockId ? { ...b, status: 'failed', error: t.error || 'Ошибка' } : b));
          return;
        }
        setBlocks((prev) => prev.map((b) => b.id === blockId ? { ...b, status: t.status } : b));
      } catch {}
    }
    setBlocks((prev) => prev.map((b) => b.id === blockId ? { ...b, status: 'failed', error: 'Timeout' } : b));
  }, [workspaceId]);

  const generateBlock = useCallback(async (block: Block) => {
    setBlocks((prev) => prev.map((b) => b.id === block.id ? { ...b, status: 'pending', error: undefined } : b));
    try {
      const prompt = buildPromptForBlock(block);
      const res = await apiFetch<{ taskId: string }>(`/studio/ai/generate?workspaceId=${workspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          model: 'gen4_image_turbo',
          aspectRatio: block.aspectRatio,
          quality: 'auto',
          variants: 1,
          referenceImageUrl: refImageUrl || undefined,
          nmId: Number(nmIdInput) > 0 ? Number(nmIdInput) : undefined,
        }),
      });
      setBlocks((prev) => prev.map((b) => b.id === block.id ? { ...b, taskId: res.taskId, status: 'processing' } : b));
      await pollTask(res.taskId, block.id);
    } catch (e: any) {
      setBlocks((prev) => prev.map((b) => b.id === block.id ? { ...b, status: 'failed', error: e?.message || 'Ошибка запроса' } : b));
    }
  }, [refImageUrl, nmIdInput, workspaceId, pollTask, styleSuffix]);

  const handleGenerateAll = useCallback(async () => {
    if (blocks.length === 0) { setError('Добавьте хотя бы один блок'); return; }
    setError(null);
    setGenerating(true);
    // Генерация параллельно — все блоки идут через BullMQ, Runway обрабатывает concurrent OK
    await Promise.allSettled(blocks.map((b) => generateBlock(b)));
    setGenerating(false);
  }, [blocks, generateBlock]);

  const regenerateBlock = useCallback((blockId: string) => {
    const b = blocks.find((x) => x.id === blockId);
    if (b) void generateBlock(b);
  }, [blocks, generateBlock]);

  const deleteBlock = useCallback((blockId: string) => {
    setBlocks((prev) => prev.filter((b) => b.id !== blockId));
  }, []);

  const moveBlock = useCallback((blockId: string, direction: 'up' | 'down') => {
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === blockId);
      if (idx < 0) return prev;
      const target = direction === 'up' ? idx - 1 : idx + 1;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }, []);

  const updateBlock = useCallback((blockId: string, patch: Partial<Block>) => {
    setBlocks((prev) => prev.map((b) => b.id === blockId ? { ...b, ...patch } : b));
  }, []);

  const addBlockFromTemplate = useCallback((key: string) => {
    const b = templateToBlock(key);
    if (b) setBlocks((prev) => [...prev, b]);
  }, []);

  const completedCount = blocks.filter((b) => b.status === 'completed').length;
  const totalCount = blocks.length;
  const estimatedCost = totalCount * 11;

  return (
    <div className="space-y-6">
      {/* Product + ref + style controls */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">Настройка набора</h3>
          <button
            onClick={() => setPreviewMode((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800"
          >
            <Eye className="h-3.5 w-3.5" />
            {previewMode ? 'Режим редактирования' : 'Превью лендинга'}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Товар WB (опционально)</label>
            <ProductSearchInput
              workspaceId={workspaceId}
              value={nmIdInput}
              onChange={setNmIdInput}
              single
              placeholder="Артикул или название..."
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              📦 Опорное фото товара <span className="text-red-600">— обязательно для сохранения товара!</span>
            </label>
            {refImageUrl ? (
              <div className="flex items-center gap-3">
                <img src={refImageUrl} alt="ref" className="h-14 w-14 rounded-md border border-gray-200 object-contain bg-gray-50" />
                <button onClick={() => setRefImageUrl(null)} className="flex items-center gap-1 text-xs text-gray-600 hover:text-red-600">
                  <X className="h-3 w-3" /> Убрать
                </button>
              </div>
            ) : (
              <label className="inline-flex items-center gap-1.5 cursor-pointer rounded-lg border border-dashed border-red-300 bg-red-50/40 px-4 py-2 text-xs font-medium text-red-700 hover:bg-red-50">
                <Upload className="h-3.5 w-3.5" />
                {uploadingRef ? 'Загрузка...' : 'Загрузить фото товара'}
                <input type="file" accept="image/*" className="hidden" disabled={uploadingRef}
                  onChange={(e) => handleRefImageChange(e.target.files?.[0] ?? null)} />
              </label>
            )}
          </div>
        </div>

        {/* Shared style controls */}
        <div>
          <div className="text-xs font-medium text-gray-700 mb-2">
            Единый стиль всего набора — общий суффикс для каждого блока, так достигается бесшовность
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-[11px] text-gray-500 mb-1">Фон</label>
              <div className="flex flex-wrap gap-1">
                {BACKDROPS.map((b) => (
                  <button key={b.value} onClick={() => setBackdrop(b.value)}
                    className={cn('rounded px-2 py-1 text-[11px] border transition-colors',
                      backdrop === b.value ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}>
                    {b.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[11px] text-gray-500 mb-1">Освещение</label>
              <div className="flex flex-wrap gap-1">
                {LIGHTINGS.map((l) => (
                  <button key={l.value} onClick={() => setLighting(l.value)}
                    className={cn('rounded px-2 py-1 text-[11px] border transition-colors',
                      lighting === l.value ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}>
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[11px] text-gray-500 mb-1">Тон</label>
              <div className="flex flex-wrap gap-1">
                {TONES.map((t) => (
                  <button key={t.value} onClick={() => setTone(t.value)}
                    className={cn('rounded px-2 py-1 text-[11px] border transition-colors',
                      tone === t.value ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {error && <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>}

        <div className="flex items-center justify-between pt-2 border-t border-gray-100">
          <div className="text-xs text-gray-600">
            <div>{blocks.length} блоков. Генерация оплачивается напрямую провайдеру с вашего счёта.</div>
            <div className="text-[10px] text-gray-500 mt-0.5">WB Rich Content: до 10 блоков, ширина 1080 px, до 2,5 МБ</div>
          </div>
          <button onClick={handleGenerateAll} disabled={generating || blocks.length === 0}
            className={cn('flex items-center gap-2 rounded-lg px-6 py-2.5 text-sm font-medium text-white transition-colors',
              generating || blocks.length === 0 ? 'bg-gray-300 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700')}>
            {generating
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Генерирую {completedCount}/{totalCount}</>
              : <><Sparkles className="h-4 w-4" /> Создать весь набор</>}
          </button>
        </div>
      </div>

      {/* Blocks — edit mode */}
      {!previewMode && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">
              Блоки ({blocks.length}/10) {completedCount > 0 && <span className="text-gray-500 font-normal">· {completedCount} готово</span>}
            </h3>
            {blocks.length < 10 && (
              <details className="relative">
                <summary className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 cursor-pointer list-none">
                  <Plus className="h-3 w-3" /> Добавить блок
                </summary>
                <div className="absolute right-0 top-full mt-1 z-10 w-56 rounded-lg border border-gray-200 bg-white shadow-lg p-1">
                  {TEMPLATES.map((t) => (
                    <button key={t.key} onClick={() => addBlockFromTemplate(t.key)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-gray-50 text-left">
                      <span>{t.emoji}</span>
                      <span className="font-medium">{t.label}</span>
                      <span className="ml-auto text-[10px] text-gray-500">{t.aspectRatio}</span>
                    </button>
                  ))}
                </div>
              </details>
            )}
          </div>

          {blocks.map((block, i) => (
            <BlockEditor
              key={block.id}
              block={block}
              index={i}
              isEditing={editingBlockId === block.id}
              onStartEdit={() => setEditingBlockId(block.id)}
              onStopEdit={() => setEditingBlockId(null)}
              onUpdate={(patch) => updateBlock(block.id, patch)}
              onRegenerate={() => regenerateBlock(block.id)}
              onDelete={() => deleteBlock(block.id)}
              onMoveUp={i > 0 ? () => moveBlock(block.id, 'up') : undefined}
              onMoveDown={i < blocks.length - 1 ? () => moveBlock(block.id, 'down') : undefined}
            />
          ))}
        </div>
      )}

      {/* Preview — landing-style */}
      {previewMode && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="mx-auto max-w-[540px] bg-white shadow-sm">
            {blocks.map((block) => (
              <LandingPreviewBlock key={block.id} block={block} />
            ))}
          </div>
          <div className="mt-4 text-center text-[11px] text-gray-500">
            Превью ширина 540px ≈ как на мобильном WB. На реальной карточке блоки рендерятся в 1080px.
          </div>
        </div>
      )}

      {/* Download all */}
      {blocks.some((b) => b.imageUrl) && (
        <div className="flex justify-end">
          <button
            onClick={() => {
              blocks.filter((b) => b.imageUrl).forEach((b, idx) => {
                const a = document.createElement('a');
                a.href = b.imageUrl!;
                a.download = `rich-block-${idx + 1}-${b.templateKey}.png`;
                a.target = '_blank';
                a.click();
              });
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <Download className="h-3.5 w-3.5" /> Скачать все ({blocks.filter((b) => b.imageUrl).length})
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Block Editor — один блок с inline-редактированием
// ============================================================
interface BlockEditorProps {
  block: Block;
  index: number;
  isEditing: boolean;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onUpdate: (patch: Partial<Block>) => void;
  onRegenerate: () => void;
  onDelete: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

function BlockEditor({ block, index, isEditing, onStartEdit, onStopEdit, onUpdate, onRegenerate, onDelete, onMoveUp, onMoveDown }: BlockEditorProps) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs">
        <span className="flex items-center gap-1 text-gray-500">
          <GripVertical className="h-3 w-3" />
          <span className="font-mono">{index + 1}</span>
        </span>
        <span className="text-base">{block.emoji}</span>
        <span className="font-semibold text-gray-900">{block.label}</span>
        <span className="text-gray-500">· {block.aspectRatio} · {ASPECT_PIXELS[block.aspectRatio]}</span>
        <div className="ml-auto flex items-center gap-1">
          {onMoveUp && <button onClick={onMoveUp} title="Вверх" className="p-1 text-gray-500 hover:text-gray-800">↑</button>}
          {onMoveDown && <button onClick={onMoveDown} title="Вниз" className="p-1 text-gray-500 hover:text-gray-800">↓</button>}
          <button onClick={isEditing ? onStopEdit : onStartEdit} title="Редактировать" className="p-1 text-indigo-600 hover:text-indigo-800">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button onClick={onRegenerate} title="Пере-генерировать"
            disabled={block.status === 'pending' || block.status === 'processing'}
            className="p-1 text-gray-600 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed">
            <RefreshCw className={cn('h-3.5 w-3.5', (block.status === 'pending' || block.status === 'processing') && 'animate-spin')} />
          </button>
          <button onClick={onDelete} title="Удалить" className="p-1 text-red-500 hover:text-red-700">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[auto,1fr] gap-3 p-3">
        {/* Image preview */}
        <div className="flex-shrink-0" style={{ width: 140 }}>
          <AspectBox ratio={block.aspectRatio}>
            {block.status === 'completed' && block.imageUrl ? (
              <img src={block.imageUrl} alt={block.label} className="w-full h-full object-cover rounded" />
            ) : block.status === 'pending' || block.status === 'processing' ? (
              <div className="flex flex-col items-center justify-center h-full gap-1 text-indigo-600 text-[10px]">
                <Loader2 className="h-4 w-4 animate-spin" />
                {block.status}
              </div>
            ) : block.status === 'failed' ? (
              <div className="flex flex-col items-center justify-center h-full p-2 text-red-500 text-[10px] text-center">
                <X className="h-4 w-4" />
                {block.error?.slice(0, 40) || 'failed'}
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500 text-[10px]">не создано</div>
            )}
          </AspectBox>
        </div>

        {/* Text + prompt */}
        <div className="min-w-0 space-y-2">
          {isEditing ? (
            <>
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Заголовок оверлея</label>
                <input
                  type="text"
                  value={block.heading}
                  onChange={(e) => onUpdate({ heading: e.target.value })}
                  className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Подзаголовок</label>
                <input
                  type="text"
                  value={block.body}
                  onChange={(e) => onUpdate({ body: e.target.value })}
                  className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">AI-промпт (что на картинке)</label>
                <textarea
                  value={block.promptCore}
                  onChange={(e) => onUpdate({ promptCore: e.target.value })}
                  rows={2}
                  className="w-full rounded border border-gray-300 px-2 py-1 text-xs font-mono resize-y"
                />
              </div>
              <div className="flex gap-1">
                <select
                  value={block.aspectRatio}
                  onChange={(e) => onUpdate({ aspectRatio: e.target.value as AspectRatio })}
                  className="rounded border border-gray-300 px-2 py-1 text-[11px]"
                >
                  {(['1:1', '3:4', '4:3', '16:9'] as AspectRatio[]).map((r) => (
                    <option key={r} value={r}>{r} ({ASPECT_PIXELS[r]})</option>
                  ))}
                </select>
                <button onClick={onStopEdit} className="ml-auto rounded bg-indigo-600 px-3 py-1 text-[11px] text-white hover:bg-indigo-700">
                  Готово
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="text-sm font-semibold text-gray-900 truncate">{block.heading}</div>
              <div className="text-xs text-gray-600 line-clamp-2">{block.body}</div>
              <div className="text-[10px] text-gray-500 font-mono line-clamp-2">{block.promptCore}</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// AspectBox — контейнер с сохранением aspect-ratio
// ============================================================
function AspectBox({ ratio, children }: { ratio: AspectRatio; children: React.ReactNode }) {
  const [w, h] = ratio.split(':').map(Number);
  const paddingTop = `${(h / w) * 100}%`;
  return (
    <div className="relative w-full bg-gray-100 rounded overflow-hidden" style={{ paddingTop }}>
      <div className="absolute inset-0">{children}</div>
    </div>
  );
}

// ============================================================
// Landing Preview — имитация финального вида на странице WB
// ============================================================
function LandingPreviewBlock({ block }: { block: Block }) {
  return (
    <div className="relative w-full">
      {block.status === 'completed' && block.imageUrl ? (
        <img src={block.imageUrl} alt={block.label} className="w-full block" />
      ) : (
        <AspectBox ratio={block.aspectRatio}>
          <div className="flex flex-col items-center justify-center h-full text-gray-500 text-xs gap-1">
            {block.status === 'pending' || block.status === 'processing' ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-indigo-500" />
                <span>{block.status}</span>
              </>
            ) : block.status === 'failed' ? (
              <span className="text-red-500">{block.error?.slice(0, 40) || 'ошибка'}</span>
            ) : (
              <>
                <span className="text-2xl">{block.emoji}</span>
                <span>{block.label}</span>
              </>
            )}
          </div>
        </AspectBox>
      )}
      {/* Text overlay */}
      {(block.heading || block.body) && block.imageUrl && (
        <div className="absolute inset-0 flex flex-col justify-end p-4 bg-gradient-to-t from-black/60 via-black/20 to-transparent">
          <div className="text-white text-lg font-bold drop-shadow-lg leading-tight">{block.heading}</div>
          {block.body && <div className="text-white/90 text-xs mt-1 drop-shadow">{block.body}</div>}
        </div>
      )}
    </div>
  );
}
