/**
 * Prompt Suggester — генерирует готовые промпты для Studio (image + video)
 * на основе данных товара из WB.
 *
 * Вход — Артикул (nmId). Опционально auditId обогащает контекст «что слабо».
 *
 * Точка входа: `nmId` — товара БЕЗ аудита тоже поддерживаем.
 * Если есть audit — LLM видит проблемы → генерирует таргетированные промпты.
 * Если нет — базовый набор «полный комплект для карточки»:
 *   main image → infographic → lifestyle → scale → detail → packaging → video demo
 *
 * Кэш Redis 30 мин по (nmId, auditId ?? null). Haiku ~2₽/вызов.
 */

import { db } from '../db/client.js';
import { creativeAuditRunsFinal, wbCards, studioPromptSuggestions } from '../db/schema.js';
import { and, eq, desc, isNull, sql } from 'drizzle-orm';
import { claudeChatJson } from '../integrations/ai/anthropic.js';
import logger from '../lib/logger.js';

export type PromptKind =
  | 'main_image' | 'lifestyle' | 'infographic' | 'scale' | 'detail' | 'packaging'
  | 'video_demo' | 'rewrite_title' | 'rewrite_description';

export interface SuggestedPrompt {
  kind: PromptKind;
  title: string;
  reasoning: string;
  promptText: string;
  targetModel: string;
  dimensions?: string;
  aspectRatio?: '1:1' | '3:4' | '16:9';
  estimatedCostRub?: number;
  referenceImageUrl?: string;
}

export interface ProductContext {
  title: string;
  category: string;
  brand?: string;
  photosCount: number;
  hasAudit: boolean;
}

export interface PromptSuggestionsResult {
  prompts: SuggestedPrompt[];
  productContext: ProductContext;
}

// Dedup: в течение этого окна для одинакового (nmId, auditId) возвращаем
// последнюю строку из studio_prompt_suggestions вместо повторного вызова
// Claude. Это защищает от случайного double-click (React StrictMode, дрожание
// кнопки) и одновременно сохраняет историю для преднамеренных регенераций
// через минут 5+.
const DEDUP_WINDOW_MINUTES = 5;
// Используем основную модель проекта — Sonnet 4.6 стабильна на 4k output JSON.
const MODEL = 'claude-sonnet-4-6';

const STUDIO_MODELS_HINT = `
Доступные модели Studio (выбирай самую подходящую для каждого промпта):

IMAGE (ВАЖНО: gpt-image-2 требует verified OpenAI organization — НЕ используй его по умолчанию):
- gemini_2.5_flash (Nano Banana Pro / Gemini 3 Pro Image через Runway) — ⭐ ДЕФОЛТ для большинства кейсов. Лидер по reference-image consistency. Из 1 фото товара → набор из 7+ кадров с идентичным видом. Не требует верификации. Цена ~$0.05-0.13/img.
- gen4_image (Runway Gen-4 Image) — ⭐ для замены фона реального фото (image-to-image), фотореализм. Не требует верификации.
- gen4_image_turbo — быстрая версия Runway Image. Не требует верификации.
- gpt-image-1.5 — OpenAI без verification (в отличие от gpt-image-2). Хорошо с текстом на картинке. Цена ~$0.05-0.10/img.
- gpt-image-2 — ⚠️ ТРЕБУЕТ verified OpenAI organization. Используй ТОЛЬКО если пользователь явно подтвердил verification (упоминает "верифицировал аккаунт"). В любом другом случае предпочитай gemini_2.5_flash или gpt-image-1.5.

VIDEO:
- gen4.5 (Runway Gen-4.5) — #1 на Artificial Analysis Video Arena. Лучший контроль камеры, multi-shot, до 60 сек. Для product rotation, lifestyle.
- sora-2-pro — лучшая кинематографичная физика, до 20 сек. Для сложных lifestyle сцен с людьми.
- sora-2 — дешевле.
- veo3.1_audio — Google Veo 3.1 со звуком, per-second billing ~$0.15/сек.
- veo3.1_noaudio — без звука, самая сильная scene consistency.
- veo3.1_fast_audio / noaudio — быстрая дешёвая версия.
- gen4_turbo — быстрый Runway для Wibes (WB Shorts) и соцсетей.
- act_two — видео из опорной картинки (performance transfer).
`.trim();

const SYSTEM_PROMPT = `Ты арт-директор фото/видео для маркетплейса Wildberries (и Ozon — у них одинаковый формат 3:4 с марта 2025). Твоя задача — для конкретного товара сгенерировать набор ГОТОВЫХ промптов для AI-генерации контента.

Ответ — СТРОГО JSON (без комментариев снаружи):

{
  "prompts": [
    {
      "kind": "main_image",
      "title": "Главное фото — замена текущего",
      "reasoning": "Почему этот промпт нужен (1 предложение)",
      "promptText": "Полный готовый к копипасту промпт",
      "targetModel": "gemini_2.5_flash",
      "dimensions": "900x1200",
      "aspectRatio": "3:4"
    }
  ]
}

ТРЕБОВАНИЯ WB (ФАКТ, НЕ МИФ):
- Минимум 700×900, рекомендуется 900×1200+ для зума
- Формат JPG/PNG/WEBP, до 10 МБ
- Аспект 3:4 (вертикаль) — стандарт, 1:1 допустимо
- Фон: нет жёсткого требования белого. Чистый нейтральный (белый/светлый) — рекомендуется для главного фото. Lifestyle и инфографика — любой подходящий фон.
- Запреты: логотипы других маркетплейсов, контакты, QR на сторонние ресурсы, водяные знаки других платформ
- sRGB цветовой профиль

УНИВЕРСАЛЬНАЯ ФОРМУЛА (для всех image-промптов):
[Shot type] + [Product: material/color/key feature] + [Placement: background/scene] +
[Lighting: studio softbox / natural golden hour / dramatic side light] +
[Camera: lens mm, aperture, ISO] + [Composition: centered fills 85-90%, rule of thirds] +
[Mood] + [Text on image: exact text in quotes OR "no text"] +
[Constraints: no watermark, no invented glyphs, no props not included, sRGB]

ВАЖНО: НЕ включай в promptText размеры (900x1200, 3:4), имена моделей (gemini, gpt-image-*) и
технические параметры формата — пользователь настраивает их в дашборде самостоятельно.
В promptText — только творческое описание кадра. Технические параметры указывай ТОЛЬКО в полях
aspectRatio / dimensions / targetModel JSON-структуры.

КОНКРЕТНЫЕ ШАБЛОНЫ ПО ТИПАМ:

1. main_image — каталожное главное фото:
   "[ТОВАР] on pure white seamless background (#FFFFFF). Centered, fills ~85-90%. Studio: two softboxes at 45°, subtle contact shadow. 85mm prime, f/8, ISO 100. sRGB. No props, no text, no logos, no watermark. Sharp focus, material texture visible."
   → модель: gemini_2.5_flash (дефолт, не требует verification) или gpt-image-1.5

2. infographic — с текстом, bullet-выгодами, иконками:
   "Infographic card for [ТОВАР]. Layout: product centered-left, benefit callouts on right with icons. Benefits: [5 пунктов с точным текстом и иконкой]. Font: Inter Bold for headlines (24pt), Regular for body (16pt). Colors: background [HEX], accent [HEX]. Clean modern, sharp readable text."
   → модель: gpt-image-1.5 (text-in-image без verification) или gemini_2.5_flash
   → ВАЖНО: для кириллицы точность ~85%+. Если важна 100% точность — рекомендуй пользователю сгенерить фон и наложить текст в Canva/Figma.

3. lifestyle — в использовании, в интерьере:
   "[ТОВАР] in [СЦЕНА]. [HUMAN INTERACTION]. Warm afternoon sunlight, soft golden highlights. 35mm lens, f/2.8, shallow DoF. Cozy, aspirational. No text, no watermark. Professional photography style."
   → модель: gemini_2.5_flash (с reference image — лидер по consistency) или gpt-image-1.5

4. scale — масштаб с эталонным предметом:
   "[ТОВАР] ([РАЗМЕРЫ]) placed next to [500ml bottle / smartphone / hand]. Light wooden surface or clean background. Overhead or 45° angle, even soft lighting. True relative scale. Professional e-commerce photography."
   → модель: gen4_image (Runway, image-to-image) или gemini_2.5_flash

5. detail — макро на текстуру/шов/материал:
   "Extreme close-up macro of [FEATURE] on [ТОВАР]. Raking side light from left, emphasizes texture. 100mm macro, f/4, very shallow DoF. Background melts into soft dark bokeh. Ultra-sharp focus on detail."
   → модель: gemini_2.5_flash или gpt-image-1.5

6. packaging — коробка/упаковка:
   "[ТОВАР] partially pulled from branded retail box. Box [цвет и стиль], label text reads exactly '[БРЕНД ТОЧНО]'. White surface, two softboxes. Text must be sharp and legible. Commercial photography style."
   → модель: gpt-image-1.5 (хорошо с текстом, без verification) или gemini_2.5_flash

7. video_demo — 5-15 сек клип:
   Описывай ФИЗИКУ и ДВИЖЕНИЕ, не только визуал. Для 360° rotation: "Smooth clockwise camera rotation around [ТОВАР] on turntable, full circle in 8 seconds, consistent studio lighting". Для lifestyle: описывай что человек делает и почему.
   → модель: gen4.5 (product rotation), sora-2-pro (lifestyle с людьми), veo3.1_noaudio (scene consistency)

ANTI-PATTERNS (избегай):
- НЕ включай в promptText: размеры (900x1200), аспект (3:4), имена моделей — это технические параметры дашборда.
- НЕ используй слова "photorealistic, realistic, photorealism" — парадоксально дают более цифровой результат. Вместо — конкретное оборудование: "Hasselblad X2D 80mm f/5.6" / "shot on Canon R5".
- НЕ описывай каждую деталь товара — модель работает лучше с кратким описанием + reference image.
- ВСЕГДА добавляй negative constraints в promptText: "no watermark, no text (кроме явно указанного), no invented glyphs" — иначе модели добавляют стилизованный мусор.

ЭТАЛОННЫЕ ПРОМПТЫ (используй как образец детализации, ритма и силы инструкций — повторяй стиль):

ОБРАЗЕЦ A — Hero «человек держит товар с наполнением» (доказательство вместимости через реальный контекст). Подходит для kind=lifestyle/scale, аспект 3:4 или 9:16:

"Cinematic product photography for marketplace. A man in a brown-and-yellow plaid flannel shirt and dark jeans is standing in a dimly lit garage, holding an open black quilted leather trunk organizer at chest height. The organizer is filled to the top with twenty 1-liter red-and-white plastic soda bottles, neatly arranged. The mans face is cropped out, we see only torso and hands. Dramatic side lighting from the left creates strong shadows. Background is a dark teal-blue concrete wall, blurred. Shot from slightly low angle to make the organizer look spacious. Hyperrealistic, 8K product photography, sharp focus on the organizer and bottles. No text, no letters, no logos, no watermarks anywhere in the image."

ОБРАЗЕЦ B — Hero «товар в реальном контексте использования» (открытый багажник, без людей). Подходит для kind=main_image/lifestyle, аспект 3:4:

"Cinematic product photography for marketplace. A closed black quilted leather trunk organizer with a diamond-stitched pattern is sitting flat in the center of an open car trunk. The trunk interior is visible: rear seats raised in the background, plastic side panels, matching quilted floor mat. The trunk lid is open, framing the scene from above. Background outside the trunk is a dark moody gradient (deep grey to black), out of focus. Dramatic key light from above-left highlights the quilted texture and casts a soft shadow behind the organizer. The organizer is closed with leather flap and metal carabiner clip visible on top. Empty trunk except for the organizer. Shot at eye-level from the rear of the car, slightly elevated. Hyperrealistic, 8K product photography, sharp focus on the organizer with detailed stitching visible. No text, no letters, no logos, no watermarks, no labels anywhere in the image."

ЧТО ВЗЯТЬ ИЗ ОБРАЗЦОВ:
- Структура: SCENE (где/кто/как) → LIGHTING (направление + интенсивность) → CAMERA (угол, расстояние) → STYLE (gritty/cinematic/8K) → EXCLUDE (явный negative).
- Конкретика, а не общие слова: «brown-and-yellow plaid flannel» вместо «casual shirt», «twenty 1-liter bottles» вместо «filled with items», «dark teal-blue concrete wall» вместо «studio background».
- Драматический свет указывается направлением: «side lighting from the left», «key light from above-left».
- Низкая точка съёмки или 45° — для героев. Eye-level — для контекста.
- Лицо вырезано из кадра — снимает зависимость модели от рендера лиц и фокусирует на товаре.
- В конце ОБЯЗАТЕЛЬНО: «No text, no letters, no logos, no watermarks». Это спасает от мусора кириллицы и поддельных брендов.

ИНФОГРАФИКА (kind=infographic) — пиши с явным указанием каждого элемента, шрифтов, hex-цветов:

ОБРАЗЕЦ C — Полная инфографика с заголовком + печатью + USP-плашкой + бейджами:

"Premium Russian marketplace product card design (Wildberries style), vertical 9:16. Cinematic product photography meets editorial infographic. SCENE: [описание основной сцены]. INFOGRAPHIC OVERLAY (must be rendered as part of the image): 1. HEADLINE at the top — large bold sans-serif Russian text '[ЗАГОЛОВОК]', all caps, white fill with 3px dark-grey outline and soft drop shadow, condensed grotesque font (Druk-style or Tactic Sans). 2. CIRCULAR RED SEAL on the right of the product — solid crimson red circle, white ring border inside, three lines stacked: '[МАЛЫЙ ТЕКСТ]', '[ЦИФРА]' huge bold, '[ЕДИНИЦА]', tilted 5 degrees. 3. USP STRIP at bottom — dark crimson plate with subtle drop shadow, inset photo of [ДЕТАЛЬ ТОВАРА] on left, bold white '[USP-ТЕКСТ]' on right with smaller subline. 4. CORNER BADGES (top-right) — three pill-shaped icons stacked: leaf 'ЭКОКОЖА', shield 'ДЕРЖИТ ФОРМУ', ruler '[ГАБАРИТЫ]'. TYPOGRAPHY: Russian Cyrillic only, must be spelled correctly, no garbled letters. Pure white (#FFFFFF) and crimson red (#B91C1C) accents. STYLE: cinematic editorial, dramatic chiaroscuro on photo layer, graphic layer crisp high-contrast. 8K hyperrealistic. EXCLUDE: no fake brand logos, no marketplace UI bars, no English text, no nonsense gibberish letters."

Когда генеришь infographic — обязательно перечисляй ВСЕ элементы (headline, seal, USP, badges) с шрифтами и hex-цветами по аналогии с образцом C.

${STUDIO_MODELS_HINT}

ЛОГИКА ГЕНЕРАЦИИ:
- Если есть контекст аудита (что плохо, чего не хватает) — генерируй ТАРГЕТИРОВАННЫЕ промпты под конкретные проблемы («замена фото #3 с бликами», «новая инфографика потому что её нет в gallery.missingFrames»).
- Если аудита нет — базовый комплект 6-8 штук: main_image + infographic + lifestyle + scale + detail + packaging + video_demo.
- promptText для image моделей — на английском (модели понимают лучше). Для video можно русский/английский.
- Для title и reasoning — русский язык, кратко.
- aspectRatio: **3:4** для всех image (стандарт WB/Ozon), 1:1 только если категория явно квадратная. Для video: 9:16 (вертикаль для Wibes/Reels) или 3:4.
- dimensions: рекомендуй 900x1200 или 1024x1024 (gpt-image минимум), для премиальных — 2000x2667 (2K).
- targetModel подбирай под тип (БЕЗ gpt-image-2 по умолчанию!): текст-в-картинке → gpt-image-1.5, серия с reference или любое дефолтное → gemini_2.5_flash, замена фона реального фото → gen4_image, видео 360° → gen4.5, lifestyle видео с людьми → sora-2-pro.`;

function buildUserPrompt(params: {
  nmId: number;
  product: {
    title: string;
    brand?: string;
    subjectName?: string;
    vendorCode?: string;
    characteristics?: string;
    photosCount: number;
    mainPhotoUrl?: string;
  };
  auditContext?: {
    detailedPhotos?: Array<Record<string, unknown>>;
    missingFrames?: string[];
    topIssues?: unknown[];
    mainProblem?: string;
  };
  count: number;
  kinds?: string[];
}): string {
  const lines: string[] = [
    `Товар (Артикул ${params.nmId}): ${params.product.title}`,
    params.product.brand ? `Бренд: ${params.product.brand}` : '',
    params.product.subjectName ? `Категория: ${params.product.subjectName}` : '',
    params.product.vendorCode ? `Артикул поставщика: ${params.product.vendorCode}` : '',
    params.product.characteristics ? `Характеристики:\n${params.product.characteristics}` : '',
    `Текущее количество фото: ${params.product.photosCount}`,
    params.product.mainPhotoUrl ? `URL главного фото (можно использовать как reference): ${params.product.mainPhotoUrl}` : '',
    '',
  ];

  if (params.auditContext) {
    lines.push('КОНТЕКСТ АУДИТА:');
    if (params.auditContext.mainProblem) {
      lines.push(`Главная проблема: ${params.auditContext.mainProblem}`);
    }
    const issues = params.auditContext.topIssues ?? [];
    if (Array.isArray(issues) && issues.length) {
      lines.push('Главные проблемы:');
      issues.slice(0, 5).forEach((i) => {
        lines.push(`  - ${typeof i === 'string' ? i : JSON.stringify(i)}`);
      });
    }
    const detailedPhotos = params.auditContext.detailedPhotos ?? [];
    if (detailedPhotos.length) {
      lines.push('Существующие кадры и их оценки:');
      detailedPhotos.forEach((p, i) => {
        const role = p.role ?? 'unknown';
        const score = p.score ?? '—';
        const probl = Array.isArray(p.issues) ? (p.issues as string[]).slice(0, 2).join('; ') : '';
        lines.push(`  #${i}: role=${role}, ${score}/100${probl ? `, issues: ${probl}` : ''}`);
      });
    }
    const missing = params.auditContext.missingFrames ?? [];
    if (missing.length) lines.push(`Отсутствующие ракурсы: ${missing.join(', ')}`);
    lines.push('');
  } else {
    lines.push('Аудита нет — генерируй базовый набор для полной карточки товара.');
    lines.push('');
  }

  lines.push(`Сгенерируй ${params.count} промптов.`);
  if (params.kinds?.length) {
    lines.push(`Разрешённые kind: ${params.kinds.join(', ')}`);
  }
  return lines.filter(Boolean).join('\n');
}

export async function suggestPromptsForProduct(params: {
  workspaceId: number;
  nmId: number;
  shopId?: number | null;
  auditId?: number | null;
  userId?: number | null;
  count?: number;
  kinds?: string[];
  forceFresh?: boolean;
}): Promise<PromptSuggestionsResult> {
  const count = Math.max(3, Math.min(15, params.count ?? 8));
  const auditId = params.auditId ?? null;

  // DB-dedup (5 мин) — если уже был запрос в это окно, не дёргаем Claude
  // повторно, ЗАТО всё равно сохраняем новую строку истории (копируем данные
  // из кэш-строки). Это даёт пользователю видимую историю на каждое нажатие
  // «Подсказать промпты» без повторных трат токенов на identical запросы.
  // forceFresh=true (кнопка «Ещё») — всегда дёргаем Claude, игнорируя кэш.
  if (!params.forceFresh) {
    const dedupConds = [
      eq(studioPromptSuggestions.workspaceId, params.workspaceId),
      eq(studioPromptSuggestions.nmId, params.nmId),
      sql`${studioPromptSuggestions.createdAt} >= NOW() - (${DEDUP_WINDOW_MINUTES}::int * INTERVAL '1 minute')`,
    ];
    if (auditId != null) dedupConds.push(eq(studioPromptSuggestions.auditId, auditId));
    else dedupConds.push(isNull(studioPromptSuggestions.auditId));

    const [recent] = await db
      .select({
        promptsJson: studioPromptSuggestions.promptsJson,
        productContextJson: studioPromptSuggestions.productContextJson,
      })
      .from(studioPromptSuggestions)
      .where(and(...dedupConds))
      .orderBy(desc(studioPromptSuggestions.createdAt))
      .limit(1);

    if (recent) {
      logger.info({ nmId: params.nmId, auditId, window: DEDUP_WINDOW_MINUTES }, 'prompt-suggest: dedup hit, skipping Claude but still saving history row');
      const prompts = (recent.promptsJson ?? []) as SuggestedPrompt[];
      const productContext = (recent.productContextJson ?? {}) as ProductContext;
      // Зеркалим строку в историю — чтобы каждый пользовательский клик был виден
      try {
        await db.insert(studioPromptSuggestions).values({
          workspaceId: params.workspaceId,
          shopId: params.shopId ?? null,
          nmId: params.nmId,
          auditId: auditId ?? null,
          userId: params.userId ?? null,
          promptsJson: prompts as any,
          productContextJson: productContext as any,
          modelUsed: MODEL,
          label: 'duplicated_from_cache',
        });
      } catch (err) {
        logger.error({ err, nmId: params.nmId }, 'failed to mirror dedup-cache row into history');
      }
      return { prompts, productContext };
    }
  }

  // Product data
  const cardConds = [
    eq(wbCards.workspaceId, params.workspaceId),
    eq(wbCards.nmId, params.nmId),
  ];
  if (params.shopId != null) cardConds.push(eq(wbCards.shopId, params.shopId));

  const [card] = await db
    .select({
      title: wbCards.title,
      brand: wbCards.brandName,
      subjectName: wbCards.subjectName,
      vendorCode: wbCards.vendorCode,
      photos: wbCards.photos,
      mainPhotoUrl: wbCards.mainPhotoUrl,
      raw: wbCards.raw,
    })
    .from(wbCards)
    .where(and(...cardConds))
    .limit(1);

  if (!card) {
    throw new Error(`Товар с Артикулом ${params.nmId} не найден в этом магазине/воркспейсе.`);
  }

  // Characteristics
  let characteristics = '';
  try {
    const raw = (card.raw ?? {}) as Record<string, unknown>;
    const chars = (raw.characteristics ?? raw.imtCharacteristics ?? []) as Array<Record<string, unknown>>;
    if (Array.isArray(chars) && chars.length) {
      characteristics = chars
        .slice(0, 15)
        .map((c) => `${c.name ?? c.attributeName ?? '?'}: ${c.value ?? ''}`)
        .filter((line) => !line.endsWith(': '))
        .join('\n');
    }
  } catch {}

  const photosArr = Array.isArray(card.photos) ? card.photos : [];
  const photosCount = photosArr.length;

  // Audit context (optional)
  let auditContext: Parameters<typeof buildUserPrompt>[0]['auditContext'];
  let hasAudit = false;
  if (auditId) {
    const [audit] = await db
      .select({ finalJson: creativeAuditRunsFinal.finalJson })
      .from(creativeAuditRunsFinal)
      .where(and(
        eq(creativeAuditRunsFinal.id, auditId),
        eq(creativeAuditRunsFinal.workspaceId, params.workspaceId),
      ))
      .limit(1);
    if (audit?.finalJson) {
      hasAudit = true;
      const fj = audit.finalJson as Record<string, unknown>;
      const photos = (fj.photos ?? {}) as Record<string, unknown>;
      auditContext = {
        detailedPhotos: (photos.detailedPhotos ?? photos.detailed_photos ?? []) as Array<Record<string, unknown>>,
        missingFrames: ((photos.gallery as Record<string, unknown> | undefined)?.missingFrames ?? []) as string[],
        topIssues: (fj.topIssues ?? []) as unknown[],
        mainProblem: ((fj.verdict as Record<string, unknown> | undefined)?.mainProblem ?? '') as string,
      };
    }
  }

  const userPrompt = buildUserPrompt({
    nmId: params.nmId,
    product: {
      title: card.title ?? `Товар ${params.nmId}`,
      brand: card.brand ?? undefined,
      subjectName: card.subjectName ?? undefined,
      vendorCode: card.vendorCode ?? undefined,
      characteristics,
      photosCount,
      mainPhotoUrl: card.mainPhotoUrl ?? undefined,
    },
    auditContext,
    count,
    kinds: params.kinds,
  });

  const result = await claudeChatJson<{ prompts: SuggestedPrompt[] }>(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    {
      model: MODEL,
      temperature: 0.5,
      maxTokens: 4096,
      meta: {
        workspaceId: params.workspaceId,
        feature: 'prompt_suggester',
        itemType: 'product',
        itemId: String(params.nmId),
        charge: true,
      },
    },
  );

  const prompts = Array.isArray(result.data?.prompts) ? result.data.prompts : [];

  // Enrich referenceImageUrl with main photo if not set by LLM
  for (const p of prompts) {
    if (!p.referenceImageUrl && card.mainPhotoUrl) {
      p.referenceImageUrl = card.mainPhotoUrl;
    }
  }

  const out: PromptSuggestionsResult = {
    prompts,
    productContext: {
      title: card.title ?? `Товар ${params.nmId}`,
      category: card.subjectName ?? '—',
      brand: card.brand ?? undefined,
      photosCount,
      hasAudit,
    },
  };

  // История: ВСЕГДА сохраняем в БД. Это одновременно источник для вкладки
  // «История промптов» и механизм dedup на следующий 5-минутный хит.
  // Ошибку логируем как `error` — если INSERT падает, это баг схемы/FK,
  // его надо видеть.
  try {
    await db.insert(studioPromptSuggestions).values({
      workspaceId: params.workspaceId,
      shopId: params.shopId ?? null,
      nmId: params.nmId,
      auditId: auditId ?? null,
      userId: params.userId ?? null,
      promptsJson: prompts as any,
      productContextJson: out.productContext as any,
      modelUsed: MODEL,
      inputTokens: result.usage?.promptTokens ?? null,
      outputTokens: result.usage?.completionTokens ?? null,
    });
  } catch (err) {
    logger.error({ err, nmId: params.nmId, workspaceId: params.workspaceId }, 'FAILED to persist prompt suggestion history — check schema/FK');
  }

  return out;
}

/**
 * Вернуть сохранённые генерации промптов. Если nmId не указан — возвращаем
 * все строки workspace (для отдельной вкладки «История» в Studio).
 */
export async function getPromptHistoryForProduct(params: {
  workspaceId: number;
  nmId?: number | null;
  shopId?: number | null;
  limit?: number;
}): Promise<Array<{
  id: number;
  nmId: number;
  createdAt: Date;
  auditId: number | null;
  userId: number | null;
  modelUsed: string;
  label: string | null;
  prompts: SuggestedPrompt[];
  productContext: ProductContext;
}>> {
  const limit = Math.max(1, Math.min(100, params.limit ?? 5));
  const conds = [eq(studioPromptSuggestions.workspaceId, params.workspaceId)];
  if (params.nmId != null) conds.push(eq(studioPromptSuggestions.nmId, params.nmId));
  if (params.shopId != null) conds.push(eq(studioPromptSuggestions.shopId, params.shopId));

  const rows = await db
    .select({
      id: studioPromptSuggestions.id,
      nmId: studioPromptSuggestions.nmId,
      createdAt: studioPromptSuggestions.createdAt,
      auditId: studioPromptSuggestions.auditId,
      userId: studioPromptSuggestions.userId,
      modelUsed: studioPromptSuggestions.modelUsed,
      label: studioPromptSuggestions.label,
      promptsJson: studioPromptSuggestions.promptsJson,
      productContextJson: studioPromptSuggestions.productContextJson,
    })
    .from(studioPromptSuggestions)
    .where(and(...conds))
    .orderBy(desc(studioPromptSuggestions.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: Number(r.id),
    nmId: Number(r.nmId),
    createdAt: r.createdAt as Date,
    auditId: r.auditId != null ? Number(r.auditId) : null,
    userId: r.userId != null ? Number(r.userId) : null,
    modelUsed: r.modelUsed,
    label: r.label,
    prompts: (r.promptsJson ?? []) as SuggestedPrompt[],
    productContext: (r.productContextJson ?? {}) as ProductContext,
  }));
}
