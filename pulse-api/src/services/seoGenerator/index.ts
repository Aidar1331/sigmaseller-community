import { runWithAiWorkspace } from '../../lib/sellerAiContext.js';
import { requireSellerAiKey } from '../sellerAiCredentials.js';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../../env.js';
import { db } from '../../db/client.js';
import { wbCards, seoKeywords, seoKeywordProducts } from '../../db/schema.js';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { computeCostMicros, recordAiUsage } from '../../services/aiSettings.js';
import { logSeo as logger } from '../../lib/logger.js';

type SeoTone = 'informative' | 'marketing' | 'premium';

interface SeoGeneratorInput {
  wsId: number;
  nmId: number;
  tone: SeoTone;
  keywords?: string[];
  competitorTexts?: string[];
  // Optional per-shop scope — the same nmId can exist in multiple shops of
  // the same workspace. Without this, SEO generation would pull a card from
  // the wrong shop.
  shopId?: number;
}

interface SeoGeneratorResult {
  title: string;
  description: string;
  originalTitle?: string;
  originalDescription?: string;
  keywordsUsed: string[];
  diff: { titleDiff: string; descDiff: string };
}

const TONE_PROMPTS: Record<SeoTone, string> = {
  informative: 'Пиши информативно. Факты, характеристики, точные данные. Без эмоциональных оценок.',
  marketing: 'Пиши продающе. Выгоды, эмоции, призыв к покупке. Используй триггеры.',
  premium: 'Пиши в стиле премиум-бренда. Элегантно, лаконично, подчёркивай статус и качество.',
};

function generateDiff(original: string, updated: string): string {
  if (!original) return `+ ${updated}`;
  if (original === updated) return '(без изменений)';

  const origWords = original.split(/\s+/);
  const newWords = updated.split(/\s+/);

  const parts: string[] = [];
  let i = 0, j = 0;
  while (i < origWords.length || j < newWords.length) {
    if (i < origWords.length && j < newWords.length && origWords[i] === newWords[j]) {
      parts.push(origWords[i]);
      i++; j++;
    } else if (j < newWords.length) {
      parts.push(`**+${newWords[j]}**`);
      j++;
    } else {
      parts.push(`~~${origWords[i]}~~`);
      i++;
    }
  }
  return parts.join(' ');
}

export async function generateSeoTexts(input: SeoGeneratorInput): Promise<SeoGeneratorResult> {
return runWithAiWorkspace(input.wsId, async () => {

  const client = new Anthropic({ maxRetries: 0, apiKey: (await requireSellerAiKey('anthropic')) });

  // Load current card (title from column, description from raw jsonb).
  // Scoped to shop when provided — same nmId can exist in multiple shops.
  const [card] = await db.select({ title: wbCards.title, raw: wbCards.raw })
    .from(wbCards)
    .where(and(
      eq(wbCards.workspaceId, input.wsId),
      eq(wbCards.nmId, input.nmId),
      ...(input.shopId != null ? [eq(wbCards.shopId, input.shopId)] : []),
    ))
    .limit(1);

  const cardTitle = card?.title ?? '';
  const cardDescription = (card?.raw as any)?.description ?? '';

  // Load top keywords for product
  let keywords = input.keywords ?? [];
  if (keywords.length === 0) {
    try {
      // Find keyword IDs linked to this product
      const linkedKws = await db.select({ keywordId: seoKeywordProducts.keywordId })
        .from(seoKeywordProducts)
        .where(eq(seoKeywordProducts.nmId, input.nmId))
        .limit(15);

      if (linkedKws.length > 0) {
        const kwIds = linkedKws.map(k => k.keywordId);
        const kws = await db.select({ keyword: seoKeywords.keyword })
          .from(seoKeywords)
          .where(and(
            eq(seoKeywords.workspaceId, input.wsId),
            ...(input.shopId != null ? [eq(seoKeywords.shopId, input.shopId)] : []),
            eq(seoKeywords.isActive, true),
            inArray(seoKeywords.keywordId, kwIds),
          ))
          .limit(15);
        keywords = kws.map(k => k.keyword);
      }
    } catch (err) { logger.warn({ err }, 'Non-critical error in SEO generator'); }
  }

  const prompt = `Ты — SEO-специалист для Wildberries. Создай оптимизированные заголовок и описание для товара.

ТЕКУЩИЙ ЗАГОЛОВОК: ${cardTitle || '(отсутствует)'}
ТЕКУЩЕЕ ОПИСАНИЕ: ${cardDescription || '(отсутствует)'}

СТИЛЬ: ${TONE_PROMPTS[input.tone]}

КЛЮЧЕВЫЕ СЛОВА (используй максимум в тексте, но естественно): ${keywords.join(', ') || 'не указаны'}

${input.competitorTexts?.length ? `ТЕКСТЫ КОНКУРЕНТОВ (для анализа, НЕ копируй):\n${input.competitorTexts.slice(0, 3).map((t, i) => `${i + 1}. ${t.slice(0, 300)}`).join('\n')}\n` : ''}

ТРЕБОВАНИЯ:
- Заголовок: до 100 символов, все основные ключевые слова
- Описание: 500-1500 символов, структурированное, с ключевыми словами
- Не дублируй ключевые слова подряд
- Wildberries SEO: ключевики в начале заголовка работают лучше

Формат ответа строго JSON:
{"title": "...", "description": "...", "keywordsUsed": ["..."]}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    temperature: 0.4,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content.find(c => c.type === 'text');
  const raw = text?.type === 'text' ? text.text : '{}';

  // Track usage
  const pt = response.usage?.input_tokens ?? 0;
  const ct = response.usage?.output_tokens ?? 0;
  if (pt + ct > 0) {
    try {
      await recordAiUsage({
        workspaceId: input.wsId, provider: 'anthropic', model: 'claude-sonnet-4-6',
        promptTokens: pt, completionTokens: ct, totalTokens: pt + ct,
        costMicros: computeCostMicros({ promptTokens: pt, completionTokens: ct, promptPricePer1mMicros: 3_000_000, completionPricePer1mMicros: 15_000_000 }),
        meta: { feature: 'seo_generator' },
      });
    } catch (err) { logger.warn({ err }, 'Non-critical error in SEO generator'); }
  }

  // Parse and validate JSON from LLM response
  const seoResponseSchema = z.object({
    title: z.string().default(''),
    description: z.string().default(''),
    keywordsUsed: z.array(z.string()).default([]),
  });

  let parsed: z.infer<typeof seoResponseSchema>;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const rawParsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    parsed = seoResponseSchema.parse(rawParsed);
  } catch {
    parsed = { title: '', description: '', keywordsUsed: [] };
  }

  return {
    title: parsed.title,
    description: parsed.description,
    originalTitle: cardTitle || undefined,
    originalDescription: cardDescription || undefined,
    keywordsUsed: parsed.keywordsUsed,
    diff: {
      titleDiff: generateDiff(cardTitle, parsed.title),
      descDiff: generateDiff(cardDescription, parsed.description),
    },
  };

});
}
