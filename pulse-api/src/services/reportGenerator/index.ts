import { runWithAiWorkspace } from '../../lib/sellerAiContext.js';
import { requireSellerAiKey } from '../sellerAiCredentials.js';
/**
 * AI Report Generator — weekly/monthly reports with LLM analysis.
 *
 * Generates structured reports with:
 * - Sales summary & trends
 * - Advertising ROI analysis
 * - Stock & supply status
 * - Key recommendations
 *
 * Output: JSON structure ready for DOCX/PDF rendering.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../env.js';
import { db } from '../../db/client.js';
import { wbOrdersSalesDailyProducts, wbAdvDailyProducts, wbStocksCurrent, wbCards, wbFinanceDailyProducts } from '../../db/schema.js';
import { eq, and, sql, gte, lte, desc } from 'drizzle-orm';
import { computeCostMicros, recordAiUsage } from '../aiSettings.js';
import { log } from '../../lib/logger.js';

export type ReportPeriod = 'weekly' | 'monthly';

export interface ReportSection {
  title: string;
  content: string;
  metrics?: Record<string, string | number>;
}

export interface GeneratedReport {
  title: string;
  period: ReportPeriod;
  dateFrom: string;
  dateTo: string;
  generatedAt: string;
  sections: ReportSection[];
  summary: string;
  recommendations: string[];
}

/**
 * Collect data for the report period.
 */
async function collectReportData(wsId: number, dateFrom: string, dateTo: string) {
  // Sales totals
  const salesData = await db.select({
    totalOrders: sql<number>`COALESCE(SUM(${wbOrdersSalesDailyProducts.ordersCount}), 0)`.mapWith(Number),
    totalSales: sql<number>`COALESCE(SUM(${wbOrdersSalesDailyProducts.salesCount}), 0)`.mapWith(Number),
    totalRevenueKop: sql<number>`COALESCE(SUM(${wbOrdersSalesDailyProducts.ordersRub}), 0)`.mapWith(Number),
    totalReturns: sql<number>`0`.mapWith(Number),
    uniqueProducts: sql<number>`COUNT(DISTINCT ${wbOrdersSalesDailyProducts.nmId})`.mapWith(Number),
  })
    .from(wbOrdersSalesDailyProducts)
    .where(and(
      eq(wbOrdersSalesDailyProducts.workspaceId, wsId),
      gte(wbOrdersSalesDailyProducts.date, dateFrom),
      lte(wbOrdersSalesDailyProducts.date, dateTo),
    ));

  // Ad spend
  const advData = await db.select({
    totalSpendKop: sql<number>`COALESCE(SUM(${wbAdvDailyProducts.spendKopecks}), 0)`.mapWith(Number),
    totalAdvOrders: sql<number>`COALESCE(SUM(${wbAdvDailyProducts.ordersCount}), 0)`.mapWith(Number),
    totalClicks: sql<number>`COALESCE(SUM(${wbAdvDailyProducts.clicksCount}), 0)`.mapWith(Number),
    totalViews: sql<number>`COALESCE(SUM(${wbAdvDailyProducts.viewsCount}), 0)`.mapWith(Number),
  })
    .from(wbAdvDailyProducts)
    .where(and(
      eq(wbAdvDailyProducts.workspaceId, wsId),
      gte(wbAdvDailyProducts.date, dateFrom),
      lte(wbAdvDailyProducts.date, dateTo),
    ));

  // Current stocks
  const stockData = await db.select({
    totalStock: sql<number>`COALESCE(SUM(${wbStocksCurrent.quantity}), 0)`.mapWith(Number),
    zeroStockCount: sql<number>`COUNT(*) FILTER (WHERE ${wbStocksCurrent.quantity} = 0)`.mapWith(Number),
    productsInStock: sql<number>`COUNT(DISTINCT ${wbStocksCurrent.nmId})`.mapWith(Number),
  })
    .from(wbStocksCurrent)
    .where(eq(wbStocksCurrent.workspaceId, wsId));

  // Top products by revenue
  const topProducts = await db.select({
    nmId: wbOrdersSalesDailyProducts.nmId,
    orders: sql<number>`SUM(${wbOrdersSalesDailyProducts.ordersCount})`.mapWith(Number),
    revenueKop: sql<number>`SUM(${wbOrdersSalesDailyProducts.ordersRub})`.mapWith(Number),
  })
    .from(wbOrdersSalesDailyProducts)
    .where(and(
      eq(wbOrdersSalesDailyProducts.workspaceId, wsId),
      gte(wbOrdersSalesDailyProducts.date, dateFrom),
      lte(wbOrdersSalesDailyProducts.date, dateTo),
    ))
    .groupBy(wbOrdersSalesDailyProducts.nmId)
    .orderBy(desc(sql`SUM(${wbOrdersSalesDailyProducts.ordersRub})`))
    .limit(10);

  return {
    sales: salesData[0] ?? { totalOrders: 0, totalSales: 0, totalRevenueKop: 0, totalReturns: 0, uniqueProducts: 0 },
    adv: advData[0] ?? { totalSpendKop: 0, totalAdvOrders: 0, totalClicks: 0, totalViews: 0 },
    stock: stockData[0] ?? { totalStock: 0, zeroStockCount: 0, productsInStock: 0 },
    topProducts,
  };
}

/**
 * Generate a full report with AI analysis.
 */
export async function generateReport(wsId: number, period: ReportPeriod): Promise<GeneratedReport> {
return runWithAiWorkspace(wsId, async () => {

  // Calculate date range
  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now);
  if (period === 'weekly') {
    dateFrom.setDate(dateFrom.getDate() - 7);
  } else {
    dateFrom.setMonth(dateFrom.getMonth() - 1);
  }
  const dateFromStr = dateFrom.toISOString().slice(0, 10);

  // Collect data
  const data = await collectReportData(wsId, dateFromStr, dateTo);

  const revenueRub = Math.round(data.sales.totalRevenueKop / 100);
  const advSpendRub = Math.round(data.adv.totalSpendKop / 100);
  const drrPct = revenueRub > 0 ? ((advSpendRub / revenueRub) * 100).toFixed(1) : '0';
  const buyoutPct = data.sales.totalOrders > 0
    ? ((data.sales.totalSales / data.sales.totalOrders) * 100).toFixed(1)
    : '0';
  const ctr = data.adv.totalViews > 0
    ? ((data.adv.totalClicks / data.adv.totalViews) * 100).toFixed(2)
    : '0';

  const topProductsList = data.topProducts
    .map((p, i) => `${i + 1}. nmId ${p.nmId}: ${p.orders} заказов, ${Math.round(p.revenueKop / 100).toLocaleString()} ₽`)
    .join('\n');

  // Generate AI analysis
  const client = new Anthropic({ maxRetries: 0, apiKey: (await requireSellerAiKey('anthropic')) });
  const prompt = `Составь аналитический отчёт для магазина на Wildberries за ${period === 'weekly' ? 'неделю' : 'месяц'} (${dateFromStr} — ${dateTo}).

ДАННЫЕ:
- Заказы: ${data.sales.totalOrders}
- Продажи (выкуп): ${data.sales.totalSales}
- Выручка: ${revenueRub.toLocaleString()} ₽
- Возвраты: ${data.sales.totalReturns}
- % выкупа: ${buyoutPct}%
- Активных товаров: ${data.sales.uniqueProducts}

РЕКЛАМА:
- Расход: ${advSpendRub.toLocaleString()} ₽
- Заказы с рекламы: ${data.adv.totalAdvOrders}
- ДРР: ${drrPct}%
- CTR: ${ctr}%
- Клики: ${data.adv.totalClicks}

ОСТАТКИ:
- Общий запас: ${data.stock.totalStock} шт
- Товаров в наличии: ${data.stock.productsInStock}
- Нулевых остатков: ${data.stock.zeroStockCount}

ТОП-10 ТОВАРОВ:
${topProductsList || 'Нет данных'}

Формат ответа — JSON:
{
  "summary": "Краткое резюме за период (2-3 предложения)",
  "salesAnalysis": "Анализ продаж и трендов",
  "advAnalysis": "Анализ рекламы и эффективности",
  "stockAnalysis": "Анализ остатков и рисков",
  "recommendations": ["Рекомендация 1", "Рекомендация 2", "..."]
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    temperature: 0.3,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find(c => c.type === 'text');
  const responseText = textBlock?.type === 'text' ? textBlock.text : '{}';

  // Track AI usage
  const pt = response.usage?.input_tokens ?? 0;
  const ct = response.usage?.output_tokens ?? 0;
  if (pt + ct > 0) {
    try {
      await recordAiUsage({
        workspaceId: wsId, provider: 'anthropic', model: 'claude-sonnet-4-6',
        promptTokens: pt, completionTokens: ct, totalTokens: pt + ct,
        costMicros: computeCostMicros({ promptTokens: pt, completionTokens: ct, promptPricePer1mMicros: 3_000_000, completionPricePer1mMicros: 15_000_000 }),
        meta: { feature: 'report_generation', period },
      });
    } catch (err) { log.warn({ err }, 'Non-critical: AI usage tracking failed'); }
  }

  // Parse AI response
  let parsed: any = {};
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch { /* use empty */ }

  const sections: ReportSection[] = [
    {
      title: 'Обзор продаж',
      content: parsed.salesAnalysis ?? 'Данные недоступны',
      metrics: {
        'Заказы': data.sales.totalOrders,
        'Продажи': data.sales.totalSales,
        'Выручка': `${revenueRub.toLocaleString()} ₽`,
        'Выкуп': `${buyoutPct}%`,
        'Возвраты': data.sales.totalReturns,
      },
    },
    {
      title: 'Рекламная аналитика',
      content: parsed.advAnalysis ?? 'Данные недоступны',
      metrics: {
        'Расход': `${advSpendRub.toLocaleString()} ₽`,
        'ДРР': `${drrPct}%`,
        'CTR': `${ctr}%`,
        'Заказы с рекламы': data.adv.totalAdvOrders,
      },
    },
    {
      title: 'Остатки и логистика',
      content: parsed.stockAnalysis ?? 'Данные недоступны',
      metrics: {
        'Общий запас': `${data.stock.totalStock} шт`,
        'Товаров в наличии': data.stock.productsInStock,
        'Нулевых остатков': data.stock.zeroStockCount,
      },
    },
  ];

  return {
    title: `Отчёт за ${period === 'weekly' ? 'неделю' : 'месяц'}`,
    period,
    dateFrom: dateFromStr,
    dateTo,
    generatedAt: new Date().toISOString(),
    sections,
    summary: parsed.summary ?? 'Отчёт сгенерирован',
    recommendations: parsed.recommendations ?? [],
  };

});
}
