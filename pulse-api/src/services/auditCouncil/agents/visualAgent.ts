import { claudeVisionJson, claudeChatJson, type ContentBlock } from '../../../integrations/ai/anthropic.js';
import { VisualAgentOutput, type VisualAgentOutputT } from '../schemas.js';
import { VISUAL_SYSTEM_PROMPT, VISUAL_FALLBACK_USER_PROMPT } from '../prompts/visualSystem.js';
import log from '../../../lib/logger.js';

const logger = log.child({ module: 'audit-council/visual-agent' });

export interface VisualAgentInput {
  nmId: number;
  workspaceId: number;
  title: string | null;
  subjectName: string | null;
  brandName: string | null;
  description: string | null;
  photoUrls: string[];
}

const MAX_PHOTOS_FOR_VISION = 5; // как в v3 — каждый фото = ~1.6k токенов

function buildVisionUserPrompt(input: VisualAgentInput): string {
  return `Проанализируй фотографии карточки Wildberries.

КОНТЕКСТ (для понимания товара):
- Заголовок: ${input.title ?? '(пустой)'}
- Бренд: ${input.brandName ?? '(пустой)'}
- Категория: ${input.subjectName ?? '(неизвестна)'}
- Всего фото в карточке: ${input.photoUrls.length}, передано тебе: первые ${Math.min(input.photoUrls.length, MAX_PHOTOS_FOR_VISION)}

Описание (для контекста, не оцениваешь):
${(input.description ?? '').slice(0, 800)}

ЗАДАЧА:
Оцени:
1. Первое фото — критичный кадр для CTR.
2. Каждое переданное фото отдельно — что видишь, тип из ENUM, оценка.
3. Галерею как воронку.
4. Инфографику — читаемость, мобильная адаптация.
5. PriceValueFit — выглядит ли товар дороже/на уровне/дешевле своей цены.

Чего не хватает в галерее (по обязательным типам для категории "${input.subjectName ?? 'неизвестная'}") — отметь в gallery.missingFrames с designerBrief.

Ответ — только JSON по схеме.`;
}

export async function runVisualAgent(input: VisualAgentInput): Promise<VisualAgentOutputT> {
  logger.info({ nmId: input.nmId, photosCount: input.photoUrls.length }, 'VisualAgent: start');

  if (input.photoUrls.length === 0) {
    return runFallback(input);
  }

  try {
    const photoUrlsForVision = input.photoUrls.slice(0, MAX_PHOTOS_FOR_VISION);

    const photoBlocks: ContentBlock[] = photoUrlsForVision.map((url) => ({
      type: 'image' as const,
      source: { type: 'url' as const, url },
    }));

    const userContent: ContentBlock[] = [
      { type: 'text' as const, text: buildVisionUserPrompt(input) },
      ...photoBlocks,
    ];

    const result = await claudeVisionJson<unknown>(
      [
        { role: 'system', content: VISUAL_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      {
        temperature: 0.3,
        model: 'claude-sonnet-4-6',
        maxTokens: 16384,
        meta: {
          workspaceId: input.workspaceId,
          feature: 'audit-council-visual',
          itemType: 'wb_card',
          itemId: String(input.nmId),
          charge: true,
        },
      },
    );

    const parsed = VisualAgentOutput.safeParse(result.data);
    if (!parsed.success) {
      logger.error({ nmId: input.nmId, errors: parsed.error.flatten() }, 'VisualAgent: invalid JSON, falling back');
      return runFallback(input);
    }

    logger.info(
      { nmId: input.nmId, overallVisualQuality: parsed.data.scores.overallVisualQuality },
      'VisualAgent: done (vision mode)',
    );
    return parsed.data;
  } catch (err) {
    logger.warn(
      { nmId: input.nmId, err: (err as Error).message },
      'VisualAgent: vision failed, falling back to text mode',
    );
    return runFallback(input);
  }
}

async function runFallback(input: VisualAgentInput): Promise<VisualAgentOutputT> {
  // Когда Vision недоступен или нет фото — генерим скелет с confidence 30.
  const result = await claudeChatJson<unknown>(
    [
      { role: 'system', content: VISUAL_SYSTEM_PROMPT },
      {
        role: 'user',
        content: VISUAL_FALLBACK_USER_PROMPT(input.photoUrls.length, false, input.subjectName),
      },
    ],
    {
      temperature: 0.3,
      model: 'claude-sonnet-4-6',
      maxTokens: 8192,
      meta: {
        workspaceId: input.workspaceId,
        feature: 'audit-council-visual-fallback',
        itemType: 'wb_card',
        itemId: String(input.nmId),
        charge: true,
      },
    },
  );

  const parsed = VisualAgentOutput.safeParse(result.data);
  if (!parsed.success) {
    logger.error({ nmId: input.nmId, errors: parsed.error.flatten() }, 'VisualAgent fallback: invalid JSON');
    // Возвращаем skeleton чтобы синтезатор не упал.
    return makeEmptyVisualOutput(input);
  }
  return parsed.data;
}

function makeEmptyVisualOutput(input: VisualAgentInput): VisualAgentOutputT {
  return {
    firstImage: {
      score: 0,
      description: 'Данные не предоставлены — VisualAgent упал.',
      attentionGrab: 'Данные не предоставлены',
      offerClarity: 'Данные не предоставлены',
      strengths: [],
      issues: ['VisualAgent не смог проанализировать фото'],
      conversionBarriers: [],
      algorithmicMechanism: '',
      designerBrief: '',
    },
    detailedPhotos: [],
    gallery: {
      score: 0,
      currentSequenceLogic: 'Данные не предоставлены',
      logicProblems: [],
      recommendedSequence: [],
      missingFrames: [],
    },
    infographics: {
      score: 0,
      strengths: [],
      issues: [],
      textReadabilityMobile: 'Данные не предоставлены',
      dataToShow: [],
    },
    videoRecommendation: {
      needed: false,
      priority: 'низкий',
      content: 'Данные не предоставлены',
      duration: '',
      brief: '',
    },
    priceValueFit: {
      perceivedQualityVsPrice: 'соответствует',
      visualReasoning: 'Данные не предоставлены',
    },
    scores: {
      firstImageStrength: 0,
      visualDifferentiation: 0,
      mobileReadability: 0,
      infographicQuality: 0,
      overallVisualQuality: 0,
    },
    confidence: 0,
    missingData: ['VisualAgent fallback skeleton — фото не были проанализированы'],
  };
}
