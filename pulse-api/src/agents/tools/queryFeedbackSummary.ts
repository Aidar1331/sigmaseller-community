/**
 * Tool: query_feedback_summary
 *
 * Aggregates customer feedback (reviews + questions) over a configurable
 * lookback window (default 30 days, max 120), runs them through Claude to
 * extract top problems / themes / sentiment, and returns a structured
 * report. Useful for "что ругают за квартал?" / "какие 3 темы самые
 * больные?" kind of questions from the seller.
 *
 * Source tables: marketplace_feedback_items (reviews + questions),
 * wb_cards (product titles for grouping by item).
 *
 * Cost guardrails:
 *  - Default 30 days; user can request up to 120.
 *  - Hard cap 600 items per LLM call (we sample worst-rated + most-recent if exceeded).
 *  - Result is cached in-memory per workspace+nmId+days for 30 minutes to
 *    avoid repeat-charge when the user re-asks within a session.
 */

import { and, eq, gte, desc, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { marketplaceFeedbackItems, wbCards } from '../../db/schema.js';
import { claudeChatJson } from '../../integrations/ai/anthropic.js';
import { sanitizeUserText } from './sanitizeUserText.js';

interface QueryFeedbackSummaryArgs {
  days?: number; // 1..120, default 30
  nmId?: number; // optional product filter
  itemType?: 'review' | 'question' | 'all'; // default 'all'
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

interface SummaryResult {
  period: string;
  scope: string;
  stats: {
    totalReviews: number;
    totalQuestions: number;
    avgRating: number | null;
    ratingsByStar: Record<string, number>;
    negativeCount: number; // rating ≤ 3
    answeredPct: number;
  };
  topProblems: Array<{
    theme: string;
    count: number;
    severity: 'low' | 'medium' | 'high';
    examples: string[];
    recommendation: string;
  }>;
  topPraise: Array<{ theme: string; count: number }>;
  trend: string;
  actionableInsights: string[];
}

const HARD_CAP = 600;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 120;
const CACHE_TTL_MS = 30 * 60 * 1000;

const cache = new Map<string, { ts: number; data: SummaryResult }>();

function cacheKey(wsId: number, days: number, shopId?: number, nmId?: number, itemType?: string): string {
  return `${wsId}:${shopId ?? 'all'}:${days}:${nmId ?? 'all'}:${itemType ?? 'all'}`;
}

export async function queryFeedbackSummary(args: QueryFeedbackSummaryArgs): Promise<string> {
  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const days = Math.min(Math.max(args.days ?? DEFAULT_DAYS, 1), MAX_DAYS);
  const itemType = args.itemType ?? 'all';
  const nmId = args.nmId;

  // Cache hit?
  const ck = cacheKey(wsId, days, args._shopId, nmId, itemType);
  const cached = cache.get(ck);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return JSON.stringify({ ...cached.data, cached: true });
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Pull items from DB
  const conds: any[] = [
    eq(marketplaceFeedbackItems.workspaceId, wsId),
    eq(marketplaceFeedbackItems.marketplace, 'wb'),
    gte(marketplaceFeedbackItems.createdAt, since),
  ];
  // Shop scope: when caller specified a shop, restrict to that shop only.
  // NULL shopId on the item means workspace-wide review (rare) — leave inclusive.
  if (args._shopId != null) {
    conds.push(eq(marketplaceFeedbackItems.shopId, args._shopId));
  }
  if (nmId != null) conds.push(eq(marketplaceFeedbackItems.nmId, BigInt(nmId) as any));
  if (itemType !== 'all') conds.push(eq(marketplaceFeedbackItems.itemType, itemType));

  const items = await db
    .select({
      itemType: marketplaceFeedbackItems.itemType,
      text: marketplaceFeedbackItems.text,
      pros: marketplaceFeedbackItems.pros,
      cons: marketplaceFeedbackItems.cons,
      rating: marketplaceFeedbackItems.rating,
      isAnswered: marketplaceFeedbackItems.isAnswered,
      productTitle: marketplaceFeedbackItems.productTitle,
      nmId: marketplaceFeedbackItems.nmId,
      createdAt: marketplaceFeedbackItems.createdAt,
    })
    .from(marketplaceFeedbackItems)
    .where(and(...conds))
    .orderBy(desc(marketplaceFeedbackItems.createdAt));

  if (items.length === 0) {
    const emptyScope: string[] = [];
    if (args._shopId) emptyScope.push(`магазин ${args._shopId}`);
    if (nmId) emptyScope.push(`товар ${nmId}`);
    const empty: SummaryResult = {
      period: `${days} дней`,
      scope: emptyScope.length ? emptyScope.join(', ') : 'все магазины и товары',
      stats: { totalReviews: 0, totalQuestions: 0, avgRating: null, ratingsByStar: {}, negativeCount: 0, answeredPct: 0 },
      topProblems: [],
      topPraise: [],
      trend: 'Отзывов и вопросов за указанный период не найдено.',
      actionableInsights: [],
    };
    return JSON.stringify(empty);
  }

  // Stats — compute deterministically (don't trust LLM)
  const reviews = items.filter((i) => i.itemType === 'review');
  const questions = items.filter((i) => i.itemType === 'question');
  const rated = reviews.filter((r) => typeof r.rating === 'number');
  const avgRating = rated.length > 0
    ? rated.reduce((s, r) => s + (r.rating as number), 0) / rated.length
    : null;
  const ratingsByStar: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  for (const r of rated) {
    const k = String(r.rating);
    if (k in ratingsByStar) ratingsByStar[k] += 1;
  }
  const negativeCount = rated.filter((r) => (r.rating as number) <= 3).length;
  const answered = items.filter((i) => i.isAnswered).length;
  const answeredPct = items.length > 0 ? Math.round((answered / items.length) * 100) : 0;

  // Sample items for LLM if we exceed the cap
  let llmItems = items;
  if (items.length > HARD_CAP) {
    // Priority: negatives + most-recent positives
    const negatives = items.filter((r) => r.itemType === 'review' && (r.rating as number | null) != null && (r.rating as number) <= 3);
    const positives = items.filter((r) => !negatives.includes(r));
    const negCap = Math.min(negatives.length, 300);
    const posCap = HARD_CAP - negCap;
    llmItems = [...negatives.slice(0, negCap), ...positives.slice(0, posCap)];
  }

  // Build the LLM payload — sanitize buyer text to prevent prompt injection
  const llmInput = llmItems.map((i) => ({
    type: i.itemType === 'review' ? 'отзыв' : 'вопрос',
    rating: i.rating,
    text: sanitizeUserText(i.text ?? '', 400),
    pros: i.pros ? sanitizeUserText(i.pros, 200) : null,
    cons: i.cons ? sanitizeUserText(i.cons, 200) : null,
    nmId: i.nmId != null ? Number(i.nmId) : null,
    product: i.productTitle ? sanitizeUserText(i.productTitle, 80) : null,
    date: i.createdAt?.toISOString().slice(0, 10) ?? null,
  }));

  const systemPrompt = `Ты — аналитик отзывов селлера на Wildberries. Твоя задача — извлечь из массива отзывов и вопросов покупателей конкретные повторяющиеся проблемы и темы, а не общие фразы. Цитируй короткие выдержки в examples.

Ответ должен быть СТРОГО валидным JSON по схеме:

{
  "topProblems": [
    {
      "theme": "короткая русская тема (например 'качество ткани', 'медленная доставка')",
      "count": 5,
      "severity": "low" | "medium" | "high",
      "examples": ["краткая цитата 1", "краткая цитата 2"],
      "recommendation": "конкретная рекомендация селлеру в одно предложение"
    }
  ],
  "topPraise": [
    { "theme": "что хвалят чаще всего", "count": 12 }
  ],
  "trend": "одно предложение о динамике (например 'количество жалоб на упаковку выросло относительно прошлых периодов')",
  "actionableInsights": [
    "конкретный шаг 1",
    "конкретный шаг 2"
  ]
}

Не выдумывай темы которых нет в данных. Не используй маркетинговый язык. Не пиши о товаре в целом — только о ПРОБЛЕМАХ из жалоб. Если негативных отзывов нет, верни topProblems: [].`;

  const userMsg = `Период: последние ${days} дней. Всего ${reviews.length} отзывов и ${questions.length} вопросов${items.length !== llmItems.length ? ` (для LLM выбрано ${llmItems.length} самых релевантных)` : ''}. Средняя оценка: ${avgRating?.toFixed(1) ?? '?'}.\n\nДанные:\n${JSON.stringify(llmInput, null, 0)}\n\nВыдай JSON-сводку.`;

  let llmResult: Pick<SummaryResult, 'topProblems' | 'topPraise' | 'trend' | 'actionableInsights'>;
  try {
    const { data } = await claudeChatJson<typeof llmResult>(
      [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userMsg },
      ],
      {
        maxTokens: 2500,
        meta: { feature: 'query_feedback_summary', workspaceId: wsId, charge: true },
      },
    );
    llmResult = data;
  } catch (err) {
    return JSON.stringify({
      error: 'LLM error',
      message: err instanceof Error ? err.message : String(err),
      stats: {
        totalReviews: reviews.length,
        totalQuestions: questions.length,
        avgRating,
        ratingsByStar,
        negativeCount,
        answeredPct,
      },
    });
  }

  const scopeParts: string[] = [];
  if (args._shopId) scopeParts.push(`магазин ${args._shopId}`);
  if (nmId) scopeParts.push(`товар ${nmId}`);
  const scope = scopeParts.length ? scopeParts.join(', ') : 'все магазины и товары';

  const result: SummaryResult = {
    period: `${days} дней`,
    scope,
    stats: {
      totalReviews: reviews.length,
      totalQuestions: questions.length,
      avgRating: avgRating != null ? Number(avgRating.toFixed(2)) : null,
      ratingsByStar,
      negativeCount,
      answeredPct,
    },
    topProblems: Array.isArray(llmResult.topProblems) ? llmResult.topProblems.slice(0, 10) : [],
    topPraise: Array.isArray(llmResult.topPraise) ? llmResult.topPraise.slice(0, 5) : [],
    trend: typeof llmResult.trend === 'string' ? llmResult.trend : '',
    actionableInsights: Array.isArray(llmResult.actionableInsights)
      ? llmResult.actionableInsights.slice(0, 7)
      : [],
  };

  cache.set(ck, { ts: Date.now(), data: result });

  return JSON.stringify(result);
}
