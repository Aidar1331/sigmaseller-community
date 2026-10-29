/**
 * Photo brief enricher — дозапрашивает у Claude Haiku то, что не попало в
 * исходный creative_audit_runs_final.finalJson (старые аудиты, V3 без USPs):
 *   - 3-5 проработанных УТП товара
 *   - Копирайт для каждого фото (overlay текст + подписи)
 *   - Скрипт видео-закадра
 *   - Список запрещённого на фото
 *
 * Результат кэшируется в Redis 30 мин по auditId — повторные скачивания
 * PDF для того же аудита возвращают моментально без повторного вызова LLM.
 *
 * Стоимость ~2-3 ₽/аудит (Haiku + short input + structured JSON output).
 */

import { db } from '../db/client.js';
import { creativeAuditRunsFinal, wbCards } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { claudeChatJson } from '../integrations/ai/anthropic.js';
import { getRedis } from '../lib/redis.js';
import logger from '../lib/logger.js';

export interface PhotoCopy {
  photoIndex: number | null;       // null = новый (отсутствующий) кадр
  role: string;                    // 'main' | 'infographic' | 'lifestyle' | 'scale' | 'detail' | 'packaging' | 'video'
  overlayTitle?: string | null;    // крупный текст на фото (для инфографики / lifestyle)
  overlayBullets?: string[];       // короткие bullet-фразы (3-5 слов каждая)
  caption?: string | null;         // подпись под фото если нужна
}

export interface PhotoBriefEnrichment {
  usps: string[];                  // 3-5 проработанных УТП
  photoCopy: PhotoCopy[];          // копирайт по каждому существующему + недостающему кадру
  videoScript?: string | null;     // скрипт 15-30 сек если видео рекомендовано
  prohibitedList: string[];        // чего НЕ должно быть на фото (категорные + audit issues)
}

const CACHE_TTL_SECONDS = 30 * 60;
const CACHE_PREFIX = 'photo-brief-enrich:v1:';

// Используем основную модель проекта для стабильности JSON-вывода.
const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `Ты арт-директор маркетплейса Wildberries. Твоя задача — подготовить ТЕКСТОВОЕ наполнение для фото-ТЗ дизайнеру на основе аудита карточки товара.

Твой ответ — СТРОГО JSON следующей структуры (без пояснений до или после):

{
  "usps": [
    "УТП 1 — короткая продающая фраза до 60 символов",
    "УТП 2 — ...",
    "УТП 3 — ..."
  ],
  "photoCopy": [
    {
      "photoIndex": 0,
      "role": "main",
      "overlayTitle": "Складной органайзер",
      "overlayBullets": ["5 секций", "Складывается за 3 сек", "-40% места"],
      "caption": null
    },
    {
      "photoIndex": null,
      "role": "infographic",
      "overlayTitle": "3 причины выбрать",
      "overlayBullets": ["Плотная ткань", "Гарантия 1 год", "Доставка 2 дня"],
      "caption": "Инфографика ДОЛЖНА заменять фото #2"
    }
  ],
  "videoScript": "Сценарий 15-30 секунд с голосом за кадром: (0-3 сек) товар лежит сложенный — (3-7 сек) раскладка одной рукой — (7-15 сек) заполнение вещами — (15-20 сек) УТП и логотип. Текст за кадром...",
  "prohibitedList": [
    "Блики на плёнке — скрывают текстуру",
    "Водяные знаки других магазинов",
    "Избыточный Photoshop — теряется правдоподобие"
  ]
}

ПРАВИЛА:
- УТП формулируй как продающие сообщения, не как характеристики. «Складывается за 3 секунды» — хорошо. «Складной механизм» — плохо.
- Текст на фото (overlayBullets) строго 3-5 слов каждая фраза. Без воды.
- photoCopy должен покрывать КАЖДОЕ существующее фото из аудита + КАЖДЫЙ отсутствующий ракурс (gallery.missingFrames).
- Язык — русский. Короткий, цепкий, без канцелярита.
- Для WB фото не требуется белый фон — это миф. Упоминай фоны по контексту товара.
- prohibitedList — 3-5 пунктов, специфичных категории товара + ошибки из аудита.`;

function buildUserPrompt(params: {
  product: {
    title: string;
    brand?: string;
    subjectName?: string;
    vendorCode?: string;
    characteristics?: string;
  };
  finalJson: Record<string, unknown>;
}): string {
  const { product, finalJson } = params;
  const photos = (finalJson?.photos ?? {}) as Record<string, unknown>;
  const detailedPhotos = (photos.detailedPhotos ?? photos.detailed_photos ?? []) as Array<Record<string, unknown>>;
  const missingFrames = ((photos.gallery as Record<string, unknown> | undefined)?.missingFrames ?? []) as string[];
  const verdict = (finalJson?.verdict ?? {}) as Record<string, unknown>;
  const topIssues = (finalJson?.topIssues ?? []) as unknown[];
  const buyerPersp = ((finalJson?.perspectives as Record<string, unknown> | undefined)?.buyer ?? {}) as Record<string, unknown>;

  return [
    `Товар: ${product.title}`,
    product.brand ? `Бренд: ${product.brand}` : '',
    product.subjectName ? `Категория: ${product.subjectName}` : '',
    product.vendorCode ? `Артикул поставщика: ${product.vendorCode}` : '',
    product.characteristics ? `Характеристики:\n${product.characteristics}` : '',
    '',
    verdict.summary ? `Вердикт аудита: ${String(verdict.summary)}` : '',
    verdict.mainProblem ? `Главная проблема: ${String(verdict.mainProblem)}` : '',
    '',
    `Существующие фото (${detailedPhotos.length} шт):`,
    ...detailedPhotos.map((p, i) => {
      const role = p.role ?? 'unknown';
      const score = p.score ?? '—';
      const issues = Array.isArray(p.issues) ? (p.issues as string[]).slice(0, 3).join('; ') : '';
      return `  #${i}: role=${role}, score=${score}/100${issues ? `, issues: ${issues}` : ''}`;
    }),
    '',
    missingFrames.length ? `Отсутствующие ракурсы (нужно сгенерить / снять): ${missingFrames.join(', ')}` : '',
    '',
    Array.isArray(topIssues) && topIssues.length
      ? `Главные проблемы карточки:\n${topIssues.slice(0, 5).map((i) => `- ${typeof i === 'string' ? i : JSON.stringify(i)}`).join('\n')}`
      : '',
    '',
    buyerPersp.summary ? `Что говорит покупатель: ${String(buyerPersp.summary)}` : '',
    '',
    'Верни JSON с usps, photoCopy (по каждому существующему + каждому отсутствующему), videoScript (если есть смысл), prohibitedList.',
  ].filter(Boolean).join('\n');
}

export async function enrichPhotoBrief(
  workspaceId: number,
  auditId: number,
): Promise<PhotoBriefEnrichment> {
  const redis = getRedis();
  const cacheKey = `${CACHE_PREFIX}${workspaceId}:${auditId}`;

  // Redis может быть недоступен — race с 1с таймаутом.
  const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
    Promise.race([
      p.catch(() => fallback),
      new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);

  const cached = await withTimeout(redis.get(cacheKey).catch(() => null), 1000, null);
  if (cached) {
    try { return JSON.parse(cached) as PhotoBriefEnrichment; } catch { /* fall through */ }
  }

  // Load audit + product data
  const [audit] = await db
    .select({
      nmId: creativeAuditRunsFinal.nmId,
      finalJson: creativeAuditRunsFinal.finalJson,
    })
    .from(creativeAuditRunsFinal)
    .where(and(
      eq(creativeAuditRunsFinal.id, auditId),
      eq(creativeAuditRunsFinal.workspaceId, workspaceId),
    ))
    .limit(1);

  if (!audit) {
    throw new Error(`Audit ${auditId} not found in workspace ${workspaceId}`);
  }

  const [card] = await db
    .select({
      title: wbCards.title,
      brand: wbCards.brandName,
      subjectName: wbCards.subjectName,
      vendorCode: wbCards.vendorCode,
      raw: wbCards.raw,
    })
    .from(wbCards)
    .where(and(
      eq(wbCards.workspaceId, workspaceId),
      eq(wbCards.nmId, audit.nmId),
    ))
    .limit(1);

  // Characteristics: WB keeps them under raw.characteristics or raw.imtCharacteristics
  let characteristics = '';
  try {
    const raw = (card?.raw ?? {}) as Record<string, unknown>;
    const chars = (raw.characteristics ?? raw.imtCharacteristics ?? []) as Array<Record<string, unknown>>;
    if (Array.isArray(chars) && chars.length) {
      characteristics = chars
        .slice(0, 20)
        .map((c) => `${c.name ?? c.attributeName ?? '?'}: ${c.value ?? ''}`)
        .filter((line) => !line.endsWith(': '))
        .join('\n');
    }
  } catch {}

  const userPrompt = buildUserPrompt({
    product: {
      title: card?.title ?? `Товар ${audit.nmId}`,
      brand: card?.brand ?? undefined,
      subjectName: card?.subjectName ?? undefined,
      vendorCode: card?.vendorCode ?? undefined,
      characteristics,
    },
    finalJson: (audit.finalJson ?? {}) as Record<string, unknown>,
  });

  const result = await claudeChatJson<PhotoBriefEnrichment>(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    {
      model: MODEL,
      temperature: 0.4,
      maxTokens: 3500,
      meta: {
        workspaceId,
        feature: 'photo_brief_enrich',
        itemType: 'audit',
        itemId: String(auditId),
        charge: true,
      },
    },
  );

  const enriched: PhotoBriefEnrichment = {
    usps: Array.isArray(result.data?.usps) ? result.data.usps.slice(0, 5) : [],
    photoCopy: Array.isArray(result.data?.photoCopy) ? result.data.photoCopy : [],
    videoScript: result.data?.videoScript ?? null,
    prohibitedList: Array.isArray(result.data?.prohibitedList) ? result.data.prohibitedList.slice(0, 10) : [],
  };

  // Fire-and-forget с таймаутом
  void withTimeout(
    redis.set(cacheKey, JSON.stringify(enriched), 'EX', CACHE_TTL_SECONDS).catch(() => null),
    1000,
    null,
  );

  return enriched;
}
