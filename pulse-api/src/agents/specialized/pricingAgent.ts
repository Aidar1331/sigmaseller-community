import { runWithAiWorkspace } from '../../lib/sellerAiContext.js';
import { requireSellerAiKey } from '../../services/sellerAiCredentials.js';
/**
 * Pricing Agent -- evaluates products and suggests price changes.
 * Uses Pricing Engine service under the hood.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../env.js';
import { db } from '../../db/client.js';
import { pricingStrategies, wbCards, wbPricesHistory } from '../../db/schema.js';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { logPricing as logger } from '../../lib/logger.js';
import { evaluateProductPricing, type PricingEvaluation } from '../../services/pricingEngine/index.js';
import { computeCostMicros, recordAiUsage } from '../../services/aiSettings.js';

interface PricingAgentResult {
  summary: string;
  evaluations: Array<{
    nmId: number;
    productTitle: string;
    currentPriceRub: number;
    proposedPriceRub: number;
    strategy: string;
    reason: string;
    constraintsApplied: string[];
    priority: number;
  }>;
}

export async function runPricingAgent(wsId: number, shopId?: number): Promise<PricingAgentResult> {
return runWithAiWorkspace(wsId, async () => {

  // Get all products with active strategies (scoped to shop when provided)
  const strategies = await db.select()
    .from(pricingStrategies)
    .where(and(
      eq(pricingStrategies.workspaceId, wsId),
      eq(pricingStrategies.isActive, true),
      ...(shopId != null ? [eq(pricingStrategies.shopId, shopId)] : []),
    ));

  const uniqueNmIds = [...new Set(strategies.map(s => s.nmId))];
  if (uniqueNmIds.length === 0) {
    return { summary: 'Нет товаров с активными ценовыми стратегиями.', evaluations: [] };
  }

  // Get current card info (scoped to shop when provided)
  const cards = await db.select({ nmId: wbCards.nmId, title: wbCards.title })
    .from(wbCards)
    .where(and(
      eq(wbCards.workspaceId, wsId),
      ...(shopId != null ? [eq(wbCards.shopId, shopId)] : []),
    ));
  const cardMap = new Map(cards.map(c => [c.nmId, c]));

  // Get latest prices for products (bulk query; scoped to shop when provided)
  const allPrices = await db.select({
    nmId: wbPricesHistory.nmId,
    price: wbPricesHistory.price,
  }).from(wbPricesHistory)
    .where(and(
      eq(wbPricesHistory.workspaceId, wsId),
      inArray(wbPricesHistory.nmId, uniqueNmIds.slice(0, 50)),
      ...(shopId != null ? [eq(wbPricesHistory.shopId, shopId)] : []),
    ))
    .orderBy(wbPricesHistory.nmId, desc(wbPricesHistory.date));

  // Deduplicate to get latest price per nmId
  const priceMap = new Map<number, number>();
  for (const p of allPrices) {
    if (!priceMap.has(p.nmId) && p.price && p.price > 0) priceMap.set(p.nmId, p.price);
  }

  if (priceMap.size === 0) {
    return { summary: 'Нет товаров с известными ценами для оценки.', evaluations: [] };
  }

  // Evaluate each product through the pricing engine
  const allEvals: PricingAgentResult['evaluations'] = [];

  for (const [nmId, currentPriceKop] of priceMap) {
    const evals = await evaluateProductPricing(wsId, nmId, currentPriceKop);
    for (const ev of evals) {
      if (ev.constrainedPriceKop !== currentPriceKop) {
        allEvals.push({
          nmId,
          productTitle: cardMap.get(nmId)?.title ?? `${nmId}`,
          currentPriceRub: currentPriceKop / 100,
          proposedPriceRub: ev.constrainedPriceKop / 100,
          strategy: ev.strategyType,
          reason: ev.reason,
          constraintsApplied: ev.violations,
          priority: ev.confidence,
        });
      }
    }
  }

  if (allEvals.length === 0) {
    return { summary: 'Ценовой анализ: все цены в рамках стратегий, изменений не требуется.', evaluations: [] };
  }

  // Generate summary with LLM
  const client = new Anthropic({ maxRetries: 0, apiKey: (await requireSellerAiKey('anthropic')) });
  const summaryPrompt = `Ты ценовой аналитик Wildberries. Подведи итог ценового анализа.

Предложено изменений: ${allEvals.length}
${allEvals.slice(0, 10).map(e => `- ${e.productTitle}: ${e.currentPriceRub} -> ${e.proposedPriceRub} руб (${e.strategy}: ${e.reason})`).join('\n')}

Сделай краткую сводку (3-5 предложений): что рекомендуешь, на что обратить внимание, общий вектор ценообразования.`;

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 2048, temperature: 0.3,
    messages: [{ role: 'user', content: summaryPrompt }],
  });

  const textBlock = resp.content.find(c => c.type === 'text');
  const summary = textBlock?.type === 'text' ? textBlock.text : 'Анализ завершён.';

  // Track usage
  const pt = resp.usage?.input_tokens ?? 0;
  const ct = resp.usage?.output_tokens ?? 0;
  try {
    await recordAiUsage({
      workspaceId: wsId, provider: 'anthropic', model: 'claude-sonnet-4-6',
      promptTokens: pt, completionTokens: ct, totalTokens: pt + ct,
      costMicros: computeCostMicros({ promptTokens: pt, completionTokens: ct, promptPricePer1mMicros: 3_000_000, completionPricePer1mMicros: 15_000_000 }),
      meta: { feature: 'pricing_agent' },
    });
  } catch (err) { logger.warn({ err }, 'Non-critical error in pricing agent'); }

  return { summary, evaluations: allEvals };

});
}
