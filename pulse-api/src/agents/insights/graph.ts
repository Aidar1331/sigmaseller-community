import { runWithAiWorkspace } from '../../lib/sellerAiContext.js';
import { requireSellerAiKey } from '../../services/sellerAiCredentials.js';
/**
 * Insights Agent — "Morning Briefing" & Smart Insights.
 *
 * Multi-step agent that collects data from multiple sources,
 * analyzes it with LLM, and produces a structured briefing.
 *
 * Uses Anthropic SDK directly (claude-sonnet-4-6) for single-shot analysis,
 * not LangGraph — this is a pipeline, not a conversational agent.
 *
 * Scenarios:
 *   C1. "Утренний брифинг" — daily summary with priorities
 *   C6. "Аналитик возвратов" — weekly return patterns
 *   C8. "Детектор проблем" — continuous monitoring alerts
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../env.js';
import { db } from '../../db/client.js';
import { agentConversations, agentMessages, wbFunnelDailyProducts, wbStocksCurrent,
  wbAdvDailyProducts, wbFinanceDailyProducts, wbReturns, wbCards } from '../../db/schema.js';
import { eq, and, gte, lte, sql, desc } from 'drizzle-orm';
import { computeCostMicros, recordAiUsage } from '../../services/aiSettings.js';

interface InsightResult {
  conversationId: number;
  title: string;
  content: string; // markdown
  priority: 'critical' | 'important' | 'info';
  metrics: Record<string, unknown>;
}

// ── Data Collection ──────────────────────────────────────────

async function collectBriefingData(wsId: number) {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  const d7ago = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const d14ago = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  // Source: funnel (WB Analytics). До 2026-06-01 алерты/брифинги брались
  // из Statistics — числа расходились с дашбордом, пользователь видел
  // одно в Pulse и другое в утренних инсайтах. orderSum/buyoutSum в funnel
  // в рублях, поэтому *100 для копеек.

  // Yesterday's sales
  const [salesYesterday] = await db
    .select({
      ordersCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderCount}), 0)`.mapWith(Number),
      ordersRub: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderSum}) * 100, 0)`.mapWith(Number),
      salesCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutCount}), 0)`.mapWith(Number),
    })
    .from(wbFunnelDailyProducts)
    .where(and(
      eq(wbFunnelDailyProducts.workspaceId, wsId),
      eq(wbFunnelDailyProducts.date, yesterday),
    ));

  // Last 7 days sales (for comparison)
  const [salesWeek] = await db
    .select({
      ordersCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderCount}), 0)`.mapWith(Number),
      ordersRub: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderSum}) * 100, 0)`.mapWith(Number),
    })
    .from(wbFunnelDailyProducts)
    .where(and(
      eq(wbFunnelDailyProducts.workspaceId, wsId),
      gte(wbFunnelDailyProducts.date, d7ago),
      lte(wbFunnelDailyProducts.date, today),
    ));

  // Previous 7 days (for week-over-week comparison)
  const [salesPrevWeek] = await db
    .select({
      ordersCount: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderCount}), 0)`.mapWith(Number),
      ordersRub: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderSum}) * 100, 0)`.mapWith(Number),
    })
    .from(wbFunnelDailyProducts)
    .where(and(
      eq(wbFunnelDailyProducts.workspaceId, wsId),
      gte(wbFunnelDailyProducts.date, d14ago),
      lte(wbFunnelDailyProducts.date, d7ago),
    ));

  // Stock alerts (zero + low)
  const stocks = await db
    .select({
      nmId: wbStocksCurrent.nmId,
      totalQty: sql<number>`coalesce(sum(${wbStocksCurrent.quantity}), 0)`.mapWith(Number),
    })
    .from(wbStocksCurrent)
    .where(eq(wbStocksCurrent.workspaceId, wsId))
    .groupBy(wbStocksCurrent.nmId);

  const zeroStock = stocks.filter((s) => s.totalQty === 0);
  const lowStock = stocks.filter((s) => s.totalQty > 0 && s.totalQty < 10);

  // Ad spend yesterday
  const [advYesterday] = await db
    .select({
      spendKop: sql<number>`coalesce(sum(${wbAdvDailyProducts.spendKopecks}), 0)`.mapWith(Number),
      orders: sql<number>`coalesce(sum(${wbAdvDailyProducts.ordersCount}), 0)`.mapWith(Number),
      revenueKop: sql<number>`coalesce(sum(${wbAdvDailyProducts.sumPriceKopecks}), 0)`.mapWith(Number),
    })
    .from(wbAdvDailyProducts)
    .where(and(
      eq(wbAdvDailyProducts.workspaceId, wsId),
      eq(wbAdvDailyProducts.date, yesterday),
    ));

  // Finance (last 7 days)
  const [financeWeek] = await db
    .select({
      revenueKop: sql<number>`coalesce(sum(${wbFinanceDailyProducts.revenueKopecks}), 0)`.mapWith(Number),
      logisticsKop: sql<number>`coalesce(sum(${wbFinanceDailyProducts.logisticsKopecks}), 0)`.mapWith(Number),
      commissionKop: sql<number>`coalesce(sum(${wbFinanceDailyProducts.commissionKopecks}), 0)`.mapWith(Number),
      penaltiesKop: sql<number>`coalesce(sum(${wbFinanceDailyProducts.penaltiesKopecks}), 0)`.mapWith(Number),
    })
    .from(wbFinanceDailyProducts)
    .where(and(
      eq(wbFinanceDailyProducts.workspaceId, wsId),
      gte(wbFinanceDailyProducts.date, d7ago),
      lte(wbFinanceDailyProducts.date, today),
    ));

  // Recent returns
  const [returnsWeek] = await db
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(wbReturns)
    .where(and(
      eq(wbReturns.workspaceId, wsId),
      gte(wbReturns.createdAt, new Date(d7ago)),
    ));

  // Get product names for context
  const nmIdsForNames = [...zeroStock.slice(0, 5), ...lowStock.slice(0, 5)].map((s) => s.nmId);
  const cards = nmIdsForNames.length > 0
    ? await db.select({ nmId: wbCards.nmId, title: wbCards.title }).from(wbCards).where(eq(wbCards.workspaceId, wsId))
    : [];
  const cardMap = new Map(cards.map((c) => [c.nmId, c.title]));

  return {
    yesterday,
    sales: {
      yesterday: salesYesterday,
      week: salesWeek,
      prevWeek: salesPrevWeek,
    },
    stocks: {
      total: stocks.length,
      zeroStock: zeroStock.map((s) => ({ nmId: s.nmId, name: cardMap.get(s.nmId) ?? `${s.nmId}` })),
      lowStock: lowStock.map((s) => ({ nmId: s.nmId, qty: s.totalQty, name: cardMap.get(s.nmId) ?? `${s.nmId}` })),
    },
    advertising: advYesterday,
    finance: financeWeek,
    returns: returnsWeek,
  };
}

// ── LLM Analysis ─────────────────────────────────────────────

async function analyzeWithLlm(data: any, wsId: number): Promise<string> {
  const apiKey = (await requireSellerAiKey('anthropic'));
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const client = new Anthropic({ maxRetries: 0, apiKey });

  const advDrr = data.advertising?.revenueKop > 0
    ? ((data.advertising.spendKop / data.advertising.revenueKop) * 100).toFixed(1)
    : '0';

  const weekChange = data.sales.prevWeek?.ordersRub > 0
    ? (((data.sales.week.ordersRub - data.sales.prevWeek.ordersRub) / data.sales.prevWeek.ordersRub) * 100).toFixed(1)
    : 'N/A';

  const prompt = `Ты — аналитик Pulse AI. Составь утренний брифинг для продавца Wildberries.

ДАННЫЕ ЗА ВЧЕРА (${data.yesterday}):
- Заказы: ${data.sales.yesterday?.ordersCount ?? 0} шт на ${Math.round((data.sales.yesterday?.ordersRub ?? 0) / 100)} ₽
- Продажи (выкупы): ${data.sales.yesterday?.salesCount ?? 0} шт

ЗА НЕДЕЛЮ:
- Заказы: ${data.sales.week?.ordersCount ?? 0} шт на ${Math.round((data.sales.week?.ordersRub ?? 0) / 100)} ₽
- Динамика WoW: ${weekChange}%
- Финансы: выручка ${Math.round((data.finance?.revenueKop ?? 0) / 100)} ₽, логистика ${Math.round((data.finance?.logisticsKop ?? 0) / 100)} ₽, комиссия ${Math.round((data.finance?.commissionKop ?? 0) / 100)} ₽

ОСТАТКИ:
- Товаров всего: ${data.stocks.total}
- Нулевой остаток: ${data.stocks.zeroStock.length} товаров${data.stocks.zeroStock.length > 0 ? ` (${data.stocks.zeroStock.slice(0, 3).map((s: any) => s.name).join(', ')})` : ''}
- Критически мало: ${data.stocks.lowStock.length} товаров

РЕКЛАМА ВЧЕРА:
- Расход: ${Math.round((data.advertising?.spendKop ?? 0) / 100)} ₽
- Заказов с рекламы: ${data.advertising?.orders ?? 0}
- ДРР: ${advDrr}%

ВОЗВРАТЫ ЗА НЕДЕЛЮ: ${data.returns?.count ?? 0}

ФОРМАТ ОТВЕТА:
1. Краткая сводка (2-3 предложения — главное)
2. Приоритеты на сегодня (список, отсортированный по важности, с пометками КРИТИЧНО/ВАЖНО/РЕКОМЕНДОВАНО)
3. Рекомендации (конкретные действия)

Используй markdown. Числа форматируй с пробелами (1 234 567 ₽). Будь конкретен — не общие фразы, а конкретные цифры и товары.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    temperature: 0.3,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = message.content.find((c) => c.type === 'text');
  const content = textBlock?.type === 'text' ? textBlock.text : 'Не удалось сформировать брифинг.';

  // Track usage
  const promptTokens = message.usage?.input_tokens ?? 0;
  const completionTokens = message.usage?.output_tokens ?? 0;

  if (promptTokens + completionTokens > 0) {
    try {
      await recordAiUsage({
        workspaceId: wsId,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        costMicros: computeCostMicros({
          promptTokens,
          completionTokens,
          promptPricePer1mMicros: 3_000_000,
          completionPricePer1mMicros: 15_000_000,
        }),
        meta: { feature: 'insights_briefing' },
      });
    } catch { /* ignore */ }
  }

  return content;
}

// ── Public API ───────────────────────────────────────────────

export async function runMorningBriefing(wsId: number, userId?: number): Promise<InsightResult> {
return runWithAiWorkspace(wsId, async () => {

  // Collect data
  const data = await collectBriefingData(wsId);

  // Analyze with LLM
  const content = await analyzeWithLlm(data, wsId);

  // Determine priority
  let priority: 'critical' | 'important' | 'info' = 'info';
  if (data.stocks.zeroStock.length > 0 || (data.advertising && Number(data.advertising.spendKop) > 0 && data.advertising.orders === 0)) {
    priority = 'critical';
  } else if (data.stocks.lowStock.length > 3) {
    priority = 'important';
  }

  // Save as conversation
  const [conv] = await db.insert(agentConversations).values({
    workspaceId: wsId,
    userId: userId ?? null,
    agentType: 'assistant',
    title: `Утренний брифинг ${data.yesterday}`,
    status: 'ready',
    threadId: `briefing-${wsId}-${data.yesterday}`,
  }).returning();

  await db.insert(agentMessages).values({
    conversationId: conv.conversationId,
    role: 'assistant',
    content,
  });

  return {
    conversationId: conv.conversationId,
    title: `Утренний брифинг ${data.yesterday}`,
    content,
    priority,
    metrics: {
      ordersYesterday: data.sales.yesterday?.ordersCount ?? 0,
      revenueYesterdayRub: Math.round((data.sales.yesterday?.ordersRub ?? 0) / 100),
      zeroStockCount: data.stocks.zeroStock.length,
      lowStockCount: data.stocks.lowStock.length,
      advSpendRub: Math.round((data.advertising?.spendKop ?? 0) / 100),
      returnsWeek: data.returns?.count ?? 0,
    },
  };

});
}
