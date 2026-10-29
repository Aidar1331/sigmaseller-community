import { claudeChatJson } from '../../../integrations/ai/anthropic.js';
import { TextAgentOutput, type TextAgentOutputT } from '../schemas.js';
import { TEXT_SYSTEM_PROMPT } from '../prompts/textSystem.js';
import log from '../../../lib/logger.js';

const logger = log.child({ module: 'audit-council/text-agent' });

export interface TextAgentInput {
  nmId: number;
  workspaceId: number;
  title: string | null;
  description: string | null;
  characteristics: Array<{ name: string; value: string }>;
  subjectName: string | null;
  brandName: string | null;
  vendorCode: string | null;
}

function buildUserPrompt(input: TextAgentInput): string {
  return `Проанализируй текст карточки Wildberries.

КОНТЕКСТ КАРТОЧКИ:
- nmId: ${input.nmId}
- Заголовок (title, текущая длина ${(input.title ?? '').length} символов): ${input.title ?? '(пустой)'}
- Артикул продавца (vendorCode): ${input.vendorCode ?? '(пустой)'}
- Бренд: ${input.brandName ?? '(пустой)'}
- Категория (subjectName): ${input.subjectName ?? '(неизвестна)'}

ОПИСАНИЕ (текущая длина ${(input.description ?? '').length} символов):
${input.description ?? '(пустое)'}

ХАРАКТЕРИСТИКИ (всего ${input.characteristics.length}):
${input.characteristics.map((c) => `- ${c.name}: ${c.value}`).join('\n') || '(не заполнены)'}

ТВОЯ ЗАДАЧА:
Выдай SEO-анализ + готовое переписанное описание в hook/body/cta.
Ответ — только JSON по схеме из системного промпта.`;
}

export async function runTextAgent(input: TextAgentInput): Promise<TextAgentOutputT> {
  logger.info({ nmId: input.nmId }, 'TextAgent: start');

  const userPrompt = buildUserPrompt(input);

  const result = await claudeChatJson<unknown>(
    [
      { role: 'system', content: TEXT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    {
      temperature: 0.3,
      model: 'claude-sonnet-4-6',
      maxTokens: 16384,
      meta: {
        workspaceId: input.workspaceId,
        feature: 'audit-council-text',
        itemType: 'wb_card',
        itemId: String(input.nmId),
        charge: true,
      },
    },
  );

  // Zod-валидация выхода
  const parsed = TextAgentOutput.safeParse(result.data);
  if (!parsed.success) {
    logger.error({ nmId: input.nmId, errors: parsed.error.flatten() }, 'TextAgent: invalid JSON output');
    throw new Error(`TextAgent output failed Zod validation: ${parsed.error.message.slice(0, 300)}`);
  }

  logger.info(
    { nmId: input.nmId, seoStrength: parsed.data.seoAnalysis.seoStrength, confidence: parsed.data.confidence },
    'TextAgent: done',
  );

  return parsed.data;
}
