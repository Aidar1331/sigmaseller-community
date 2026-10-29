import { claudeVisionJson, claudeChatJson, type ContentBlock } from '../../../integrations/ai/anthropic.js';
import { PsychologyAgentOutput, type PsychologyAgentOutputT } from '../schemas.js';
import { PSYCHOLOGY_SYSTEM_PROMPT } from '../prompts/psychologySystem.js';
import log from '../../../lib/logger.js';

const logger = log.child({ module: 'audit-council/psychology-agent' });

export interface PsychologyAgentInput {
  nmId: number;
  workspaceId: number;
  title: string | null;
  description: string | null;
  subjectName: string | null;
  brandName: string | null;
  mainPhotoUrl: string | null;
}

function buildUserPrompt(input: PsychologyAgentInput): string {
  return `Сделай поведенческий анализ карточки Wildberries.

КОНТЕКСТ:
- Заголовок: ${input.title ?? '(пустой)'}
- Категория: ${input.subjectName ?? '(неизвестна)'}
- Бренд: ${input.brandName ?? '(пустой)'}

Описание (для оценки риторики):
${input.description ?? '(пустое)'}

Если приложено главное фото — учитывай его в perception gap и first2Seconds.

ЗАДАЧА:
1. Реконструируй perception gap (sellerThinks vs buyerActuallyFeels).
2. Симулируй полный путь покупателя (6 шагов).
3. Объясни pricingPsychology и дай howToJustifyCurrentPrice.

Ответ — только JSON по схеме.`;
}

export async function runPsychologyAgent(input: PsychologyAgentInput): Promise<PsychologyAgentOutputT> {
  logger.info({ nmId: input.nmId, hasMainPhoto: !!input.mainPhotoUrl }, 'PsychologyAgent: start');

  const userPrompt = buildUserPrompt(input);

  try {
    if (input.mainPhotoUrl) {
      // Vision-call с одним фото — должно успеть быстрее, чем VisualAgent с 5 фото.
      const userContent: ContentBlock[] = [
        { type: 'text' as const, text: userPrompt },
        { type: 'image' as const, source: { type: 'url' as const, url: input.mainPhotoUrl } },
      ];

      const result = await claudeVisionJson<unknown>(
        [
          { role: 'system', content: PSYCHOLOGY_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        {
          temperature: 0.3,
          model: 'claude-sonnet-4-6',
          maxTokens: 8192,
          meta: {
            workspaceId: input.workspaceId,
            feature: 'audit-council-psychology',
            itemType: 'wb_card',
            itemId: String(input.nmId),
            charge: true,
          },
        },
      );

      const parsed = PsychologyAgentOutput.safeParse(result.data);
      if (parsed.success) {
        logger.info({ nmId: input.nmId, confidence: parsed.data.confidence }, 'PsychologyAgent: done (vision)');
        return parsed.data;
      }
      logger.warn({ nmId: input.nmId, errors: parsed.error.flatten() }, 'PsychologyAgent vision: invalid JSON, fallback to text');
    }
  } catch (err) {
    logger.warn({ nmId: input.nmId, err: (err as Error).message }, 'PsychologyAgent vision failed, fallback to text');
  }

  // Fallback — text-only
  const result = await claudeChatJson<unknown>(
    [
      { role: 'system', content: PSYCHOLOGY_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt + '\n\n(Главное фото не передано — оценивай только по тексту.)' },
    ],
    {
      temperature: 0.3,
      model: 'claude-sonnet-4-6',
      maxTokens: 8192,
      meta: {
        workspaceId: input.workspaceId,
        feature: 'audit-council-psychology-text',
        itemType: 'wb_card',
        itemId: String(input.nmId),
        charge: true,
      },
    },
  );

  const parsed = PsychologyAgentOutput.safeParse(result.data);
  if (!parsed.success) {
    logger.error({ nmId: input.nmId, errors: parsed.error.flatten() }, 'PsychologyAgent text: invalid JSON');
    throw new Error(`PsychologyAgent output failed Zod validation: ${parsed.error.message.slice(0, 300)}`);
  }
  logger.info({ nmId: input.nmId, confidence: parsed.data.confidence }, 'PsychologyAgent: done (text fallback)');
  return parsed.data;
}
