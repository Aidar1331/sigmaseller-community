import { runWithAiWorkspace } from '../../lib/sellerAiContext.js';
import { requireSellerAiKey } from '../../services/sellerAiCredentials.js';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../env.js';
import { db } from '../../db/client.js';
import { knowledgeEntries, feedbackReplyLog, agentSettings, marketplaceReplyDrafts, documentChunks, documents } from '../../db/schema.js';
import { eq, and, sql, inArray, isNull } from 'drizzle-orm';
import { TONE_CONFIGS, type FeedbackTone } from './tones.js';
import { computeCostMicros, recordAiUsage } from '../../services/aiSettings.js';
import { logFeedback as logger } from '../../lib/logger.js';

// Types
interface FeedbackInput {
  feedbackId: string;
  feedbackText: string;
  rating: number; // 1-5
  nmId: number;
  productTitle?: string;
  userName?: string;
}

interface FeedbackPipelineResult {
  replyText: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  toneUsed: FeedbackTone;
  kbEntriesUsed: number[];
  crossSellIncluded: boolean;
}

// Step 1: Classify sentiment
function classifySentiment(rating: number, text: string): 'positive' | 'neutral' | 'negative' {
  if (rating >= 4) return 'positive';
  if (rating <= 2) return 'negative';
  // Rating 3 — check text
  const negWords = ['плох', 'ужас', 'разочаров', 'брак', 'обман', 'не рекомен', 'отврат'];
  const lower = text.toLowerCase();
  if (negWords.some(w => lower.includes(w))) return 'negative';
  return 'neutral';
}

// Step 2: Search Knowledge Base
async function searchKB(wsId: number, nmId: number, sentiment: string, feedbackText: string): Promise<Array<{ entryId: number; content: string }>> {
  // Search by nmId match and category relevance
  const entries = await db.select({
    entryId: knowledgeEntries.entryId,
    content: knowledgeEntries.content,
    title: knowledgeEntries.title,
    category: knowledgeEntries.category,
    nmIds: knowledgeEntries.nmIds,
    priority: knowledgeEntries.priority,
  })
  .from(knowledgeEntries)
  .where(and(
    eq(knowledgeEntries.workspaceId, wsId),
    eq(knowledgeEntries.isActive, true),
  ))
  .limit(50);

  // Score entries by relevance
  const scored = entries.map(e => {
    let score = e.priority ?? 0;
    const nmIds = (e.nmIds as number[]) ?? [];
    if (nmIds.includes(nmId)) score += 10;
    if (nmIds.length === 0) score += 3; // general entries

    // Text match (simple keyword)
    const lower = feedbackText.toLowerCase();
    const titleLower = (e.title ?? '').toLowerCase();
    const contentLower = (e.content ?? '').toLowerCase();
    if (lower.split(' ').some(w => w.length > 3 && (titleLower.includes(w) || contentLower.includes(w)))) {
      score += 5;
    }

    // Category match for negative
    if (sentiment === 'negative' && e.category === 'complaint_solution') score += 8;
    if (e.category === 'faq') score += 2;

    return { ...e, score };
  });

  const kbResults = scored
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(e => ({ entryId: e.entryId, content: e.content }));

  // Also search Document Hub documents marked as knowledge base
  try {
    const docChunks = await db.select({
      chunkId: documentChunks.chunkId,
      content: documentChunks.content,
      title: documents.title,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.documentId))
    .where(and(
      eq(documentChunks.workspaceId, wsId),
      eq(documents.isKnowledgeBase, true),
      isNull(documents.deletedAt),
    ))
    .limit(50);

    const lower = feedbackText.toLowerCase();
    const docScored = docChunks.map(c => {
      let score = 0;
      const contentLower = c.content.toLowerCase();
      const titleLower = (c.title ?? '').toLowerCase();
      for (const w of lower.split(' ').filter(w => w.length > 3)) {
        if (titleLower.includes(w)) score += 3;
        if (contentLower.includes(w)) score += 1;
      }
      return { entryId: c.chunkId, content: c.content.slice(0, 500), score };
    });

    const topDocChunks = docScored
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    // Merge results, KB entries first
    return [...kbResults, ...topDocChunks].slice(0, 5);
  } catch {
    // Document Hub tables may not exist yet — fallback to KB only
    return kbResults;
  }
}

// Step 3: Check cross-sell eligibility
async function getCrossSellText(wsId: number, nmId: number, settings: any): Promise<string | null> {
  const freq = settings?.replyCrossSellFrequency ?? 3;
  const products = (settings?.replyCrossSellProducts as number[]) ?? [];
  if (products.length === 0) return null;

  // Check how many recent replies included cross-sell
  const [{ count }] = await db.select({
    count: sql<number>`count(*)`.mapWith(Number)
  })
  .from(feedbackReplyLog)
  .where(and(
    eq(feedbackReplyLog.workspaceId, wsId),
    eq(feedbackReplyLog.crossSellIncluded, true),
  ));

  const [{ total }] = await db.select({
    total: sql<number>`count(*)`.mapWith(Number)
  })
  .from(feedbackReplyLog)
  .where(eq(feedbackReplyLog.workspaceId, wsId));

  // Check frequency threshold
  if (total > 0 && count / total >= 1 / freq) return null;

  // Pick a random product that's not the reviewed one
  const eligible = products.filter(p => p !== nmId);
  if (eligible.length === 0) return null;
  const picked = eligible[Math.floor(Math.random() * eligible.length)];

  return `Также рекомендуем обратить внимание на артикул ${picked} из нашего ассортимента.`;
}

// Step 4: Generate reply with LLM
async function generateReply(
  wsId: number,
  input: FeedbackInput,
  sentiment: string,
  tone: typeof TONE_CONFIGS[FeedbackTone],
  kbContext: string,
  crossSellText: string | null,
  forbiddenWords: string[],
): Promise<string> {
  const client = new Anthropic({ maxRetries: 0, apiKey: (await requireSellerAiKey('anthropic')) });

  const prompt = `Ты — менеджер магазина на Wildberries. Составь ответ на отзыв покупателя.

СТИЛЬ: ${tone.systemPromptPart}
${tone.emojiAllowed ? 'Можно использовать эмодзи.' : 'Без эмодзи.'}
Максимальная длина: ${tone.maxLength} символов.

ОТЗЫВ:
- Товар: ${input.productTitle ?? `Артикул ${input.nmId}`}
- Оценка: ${input.rating}/5
- Текст: "${input.feedbackText}"
- Автор: ${input.userName ?? 'Покупатель'}

ТОНАЛЬНОСТЬ ОТЗЫВА: ${sentiment}

${kbContext ? `БАЗА ЗНАНИЙ (используй для ответа):\n${kbContext}\n` : ''}
${crossSellText ? `КРОСС-ПРОДАЖА (вставь в конце если уместно):\n${crossSellText}\n` : ''}
${forbiddenWords.length > 0 ? `ЗАПРЕЩЁННЫЕ СЛОВА (никогда не используй): ${forbiddenWords.join(', ')}` : ''}

ПОДПИСЬ: ${tone.signOff}

Ответь ТОЛЬКО текстом ответа на отзыв. Без пояснений.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    temperature: 0.4,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content.find(c => c.type === 'text');
  const reply = text?.type === 'text' ? text.text : '';

  // Track usage
  const promptTokens = response.usage?.input_tokens ?? 0;
  const completionTokens = response.usage?.output_tokens ?? 0;
  if (promptTokens + completionTokens > 0) {
    try {
      await recordAiUsage({
        workspaceId: wsId,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        costMicros: computeCostMicros({ promptTokens, completionTokens, promptPricePer1mMicros: 3_000_000, completionPricePer1mMicros: 15_000_000 }),
        meta: { feature: 'feedback_reply' },
      });
    } catch (err) { logger.warn({ err }, 'Non-critical error in feedback graph'); }
  }

  return reply.slice(0, tone.maxLength);
}

// ── Main Pipeline ─────────────────────────────────────────

export async function runFeedbackPipeline(wsId: number, input: FeedbackInput): Promise<FeedbackPipelineResult> {
return runWithAiWorkspace(wsId, async () => {

  // Check dedup — both pipeline log AND legacy draft table
  const [existing] = await db.select({ logId: feedbackReplyLog.logId })
    .from(feedbackReplyLog)
    .where(and(eq(feedbackReplyLog.workspaceId, wsId), eq(feedbackReplyLog.feedbackId, input.feedbackId)))
    .limit(1);
  if (existing) throw new Error(`Feedback ${input.feedbackId} already replied`);

  // Cross-check legacy reply drafts to prevent double-reply
  const [legacyDraft] = await db.select({ draftId: marketplaceReplyDrafts.draftId })
    .from(marketplaceReplyDrafts)
    .where(and(
      eq(marketplaceReplyDrafts.workspaceId, wsId),
      eq(marketplaceReplyDrafts.itemId, String(input.feedbackId)),
    ))
    .limit(1);
  if (legacyDraft) throw new Error(`Feedback ${input.feedbackId} already has a draft reply`);

  // Load settings
  const [settings] = await db.select().from(agentSettings).where(eq(agentSettings.workspaceId, wsId)).limit(1);
  const toneName = (settings?.replyTone ?? 'friendly') as FeedbackTone;
  const tone = TONE_CONFIGS[toneName] ?? TONE_CONFIGS.friendly;
  const forbiddenWords = (settings?.replyForbiddenWords as string[]) ?? [];

  // Step 1: Classify
  const sentiment = classifySentiment(input.rating, input.feedbackText);

  // Step 2: Search KB
  const kbEntries = await searchKB(wsId, input.nmId, sentiment, input.feedbackText);
  const kbContext = kbEntries.map(e => `- ${e.content}`).join('\n');

  // Step 3: Cross-sell
  const crossSellText = sentiment === 'positive' ? await getCrossSellText(wsId, input.nmId, settings) : null;

  // Step 4: Generate
  const replyText = await generateReply(wsId, input, sentiment, tone, kbContext, crossSellText, forbiddenWords);

  // Log (with idempotency — onConflictDoNothing to prevent duplicate inserts)
  await db.insert(feedbackReplyLog).values({
    workspaceId: wsId,
    feedbackId: input.feedbackId,
    nmId: input.nmId,
    sentiment,
    toneUsed: toneName,
    kbEntriesUsed: kbEntries.map(e => e.entryId),
    crossSellIncluded: !!crossSellText,
    replyText,
    status: 'sent',
  }).onConflictDoNothing();

  return { replyText, sentiment, toneUsed: toneName, kbEntriesUsed: kbEntries.map(e => e.entryId), crossSellIncluded: !!crossSellText };

});
}
