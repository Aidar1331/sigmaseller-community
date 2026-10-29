/**
 * Cash Flow (ДДС) API
 * 
 * Track income/expenses and forecast cash gaps
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, gte, lte, sql, between } from 'drizzle-orm';
import { db } from '../db/client.js';
import { extractShopId } from '../plugins/shopFilter.js';
import {
  cashflowSettings,
  cashflowPlannedItems,
  cashflowEntries,
  cashflowWbPayouts,
  cashflowCategories,
  wbFinanceDaily,
} from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';
import { getFinanceReportsByPeriod } from '../services/financeReports.js';

// Schemas
// Validate ISO date string (YYYY-MM-DD) and ensure it parses to a valid Date
const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата должна быть в формате YYYY-MM-DD').refine(
  (s) => !isNaN(new Date(s).getTime()),
  'Некорректная дата',
);

const plannedItemSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.enum(['purchase', 'salary', 'rent', 'ads', 'tax', 'other_expense', 'other_income']),
  amount: z.number(), // positive = income, negative = expense
  isRecurring: z.boolean().default(false),
  recurrenceType: z.enum(['daily', 'weekly', 'monthly', 'yearly']).optional(),
  recurrenceDay: z.number().min(1).max(31).optional(),
  startDate: isoDateString,
  endDate: isoDateString.optional(),
  plannedDate: isoDateString.optional(),
  notes: z.string().optional(),
  // shopId — привязка к магазину. Без него GET с ?shopId=N не вернёт
  // создание обратно → «не учитывается».
  shopId: z.number().int().positive().optional(),
}).refine(
  (data) => !data.endDate || new Date(data.endDate) >= new Date(data.startDate),
  { message: 'endDate не может быть раньше startDate', path: ['endDate'] },
);

const entrySchema = z.object({
  date: isoDateString,
  category: z.string(),
  description: z.string().optional(),
  amount: z.number(),
  shopId: z.number().int().positive().optional(),
});

const settingsSchema = z.object({
  forecastWeeks: z.number().min(1).max(52).optional(),
  includePlanned: z.boolean().optional(),
  wbPayoutDay: z.number().min(1).max(7).optional(),
  wbPayoutDelayDays: z.number().min(0).max(30).optional(),
  alertThreshold: z.number().nullable().optional(),
  alertTelegram: z.boolean().optional(),
  telegramChatId: z.string().nullable().optional(),
});

const categoryLabels: Record<string, string> = {
  purchase: 'Закупки',
  salary: 'Зарплата',
  rent: 'Аренда',
  ads: 'Реклама',
  tax: 'Налоги',
  other_expense: 'Прочие расходы',
  other_income: 'Прочие доходы',
  wb_payout: 'Выплата WB',
};

import { buildShopFilter } from './pulse/helpers.js';
export const cashflowRoutes: FastifyPluginAsync = async (app) => {
  // ─────────────────────────────────────────────
  // GET /cashflow/:workspaceId/settings
  // Get settings
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
  }>('/cashflow/:workspaceId/settings', {
    preHandler: requireRole('supervisor'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);

    const [settings] = await db
      .select()
      .from(cashflowSettings)
      .where(eq(cashflowSettings.workspaceId, workspaceId))
      .limit(1);

    return settings || {
      workspaceId,
      forecastWeeks: 8,
      includePlanned: true,
      wbPayoutDay: 4,
      wbPayoutDelayDays: 7,
      alertThreshold: null,
      alertTelegram: false,
    };
  });

  // ─────────────────────────────────────────────
  // PATCH /cashflow/:workspaceId/settings
  // Update settings
  // ─────────────────────────────────────────────
  app.patch<{
    Params: { workspaceId: string };
    Body: z.infer<typeof settingsSchema>;
  }>('/cashflow/:workspaceId/settings', {
    preHandler: requireRole('manager'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const body = settingsSchema.parse(request.body);

    const updates: any = { updatedAt: new Date() };
    if (body.forecastWeeks !== undefined) updates.forecastWeeks = body.forecastWeeks;
    if (body.includePlanned !== undefined) updates.includePlanned = body.includePlanned;
    if (body.wbPayoutDay !== undefined) updates.wbPayoutDay = body.wbPayoutDay;
    if (body.wbPayoutDelayDays !== undefined) updates.wbPayoutDelayDays = body.wbPayoutDelayDays;
    if (body.alertThreshold !== undefined) updates.alertThreshold = body.alertThreshold?.toString() || null;
    if (body.alertTelegram !== undefined) updates.alertTelegram = body.alertTelegram;
    if (body.telegramChatId !== undefined) updates.telegramChatId = body.telegramChatId;

    const [existing] = await db
      .select()
      .from(cashflowSettings)
      .where(eq(cashflowSettings.workspaceId, workspaceId))
      .limit(1);

    if (existing) {
      const [updated] = await db
        .update(cashflowSettings)
        .set(updates)
        .where(eq(cashflowSettings.workspaceId, workspaceId))
        .returning();
      return updated;
    }

    const [created] = await db
      .insert(cashflowSettings)
      .values({ workspaceId, ...updates })
      .returning();
    return created;
  });

  // ─────────────────────────────────────────────
  // GET /cashflow/:workspaceId/planned
  // List planned items
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
    Querystring: { includeCompleted?: string; shopId?: string };
  }>('/cashflow/:workspaceId/planned', {
    preHandler: requireRole('supervisor'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const includeCompleted = request.query.includeCompleted === 'true';
    const shopId = request.query.shopId ? Number(request.query.shopId) : undefined;

    const conditions = [eq(cashflowPlannedItems.workspaceId, workspaceId)];
    const plannedShopFilter = buildShopFilter(cashflowPlannedItems.shopId, shopId);
    if (plannedShopFilter) conditions.push(plannedShopFilter);
    if (!includeCompleted) {
      conditions.push(eq(cashflowPlannedItems.isCompleted, false));
    }

    const items = await db
      .select()
      .from(cashflowPlannedItems)
      .where(and(...conditions))
      .orderBy(desc(cashflowPlannedItems.startDate));

    return { items };
  });

  // ─────────────────────────────────────────────
  // POST /cashflow/:workspaceId/planned
  // Create planned item
  // ─────────────────────────────────────────────
  app.post<{
    Params: { workspaceId: string };
    Body: z.infer<typeof plannedItemSchema>;
  }>('/cashflow/:workspaceId/planned', {
    preHandler: requireRole('manager'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const body = plannedItemSchema.parse(request.body);

    // Fallback shopId из query — UI шлёт `?shopId=N` через apiFetch
    // авто-инжектор, даже если в body не положили.
    const shopIdQuery = Number((request.query as any)?.shopId);
    const shopId = body.shopId ?? (Number.isFinite(shopIdQuery) && shopIdQuery > 0 ? shopIdQuery : null);

    const [item] = await db
      .insert(cashflowPlannedItems)
      .values({
        workspaceId,
        // shopId привязывает расход к магазину. Без этого GET с ?shopId=N
        // фильтр (buildShopFilter) не покажет запись обратно → юзер думает
        // «не учитывается». Тот же баг встречался в kanban/ab-photo/plans.
        shopId,
        name: body.name,
        category: body.category,
        amount: body.amount.toString(),
        isRecurring: body.isRecurring,
        recurrenceType: body.recurrenceType || null,
        recurrenceDay: body.recurrenceDay || null,
        startDate: new Date(body.startDate),
        endDate: body.endDate ? new Date(body.endDate) : null,
        plannedDate: body.plannedDate ? new Date(body.plannedDate) : null,
        notes: body.notes || null,
      })
      .returning();

    return item;
  });

  // ─────────────────────────────────────────────
  // PATCH /cashflow/:workspaceId/planned/:itemId
  // Update planned item
  // ─────────────────────────────────────────────
  app.patch<{
    Params: { workspaceId: string; itemId: string };
    Body: Partial<z.infer<typeof plannedItemSchema>> & { isCompleted?: boolean; actualAmount?: number };
  }>('/cashflow/:workspaceId/planned/:itemId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const itemId = Number(request.params.itemId);
    const body = request.body;

    const [existing] = await db
      .select()
      .from(cashflowPlannedItems)
      .where(and(
        eq(cashflowPlannedItems.itemId, itemId),
        eq(cashflowPlannedItems.workspaceId, workspaceId)
      ))
      .limit(1);

    if (!existing) {
      return reply.status(404).send({ error: 'Item not found' });
    }

    const updates: any = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.category !== undefined) updates.category = body.category;
    if (body.amount !== undefined) updates.amount = body.amount.toString();
    if (body.isRecurring !== undefined) updates.isRecurring = body.isRecurring;
    if (body.recurrenceType !== undefined) updates.recurrenceType = body.recurrenceType;
    if (body.recurrenceDay !== undefined) updates.recurrenceDay = body.recurrenceDay;
    if (body.notes !== undefined) updates.notes = body.notes;
    if (body.isCompleted !== undefined) {
      updates.isCompleted = body.isCompleted;
      updates.completedAt = body.isCompleted ? new Date() : null;
    }
    if (body.actualAmount !== undefined) updates.actualAmount = body.actualAmount.toString();

    const [updated] = await db
      .update(cashflowPlannedItems)
      .set(updates)
      .where(eq(cashflowPlannedItems.itemId, itemId))
      .returning();

    return updated;
  });

  // ─────────────────────────────────────────────
  // DELETE /cashflow/:workspaceId/planned/:itemId
  // Delete planned item
  // ─────────────────────────────────────────────
  app.delete<{
    Params: { workspaceId: string; itemId: string };
  }>('/cashflow/:workspaceId/planned/:itemId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const itemId = Number(request.params.itemId);

    const result = await db
      .delete(cashflowPlannedItems)
      .where(and(
        eq(cashflowPlannedItems.itemId, itemId),
        eq(cashflowPlannedItems.workspaceId, workspaceId)
      ))
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Item not found' });
    }

    return { success: true };
  });

  // ─────────────────────────────────────────────
  // GET /cashflow/:workspaceId/entries
  // List actual entries
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
    Querystring: { from?: string; to?: string; dateFrom?: string; dateTo?: string; limit?: string; shopId?: string };
  }>('/cashflow/:workspaceId/entries', {
    preHandler: requireRole('supervisor'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    // Support both from/to (legacy) and dateFrom/dateTo (used by frontend)
    const from = (request.query.dateFrom || request.query.from) ? new Date(request.query.dateFrom || request.query.from!) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const to = (request.query.dateTo || request.query.to) ? new Date(request.query.dateTo || request.query.to!) : new Date();
    const limit = Math.min(Number(request.query.limit) || 200, 1000);
    const shopId = request.query.shopId ? Number(request.query.shopId) : undefined;

    const entriesConds: any[] = [
      eq(cashflowEntries.workspaceId, workspaceId),
      gte(cashflowEntries.date, from),
      lte(cashflowEntries.date, to),
    ];
    const entriesShopFilter = buildShopFilter(cashflowEntries.shopId, shopId);
    if (entriesShopFilter) entriesConds.push(entriesShopFilter);

    const entries = await db
      .select()
      .from(cashflowEntries)
      .where(and(...entriesConds))
      .orderBy(desc(cashflowEntries.date))
      .limit(limit);

    return { entries };
  });

  // ─────────────────────────────────────────────
  // POST /cashflow/:workspaceId/entries
  // Add manual entry
  // ─────────────────────────────────────────────
  app.post<{
    Params: { workspaceId: string };
    Body: z.infer<typeof entrySchema>;
  }>('/cashflow/:workspaceId/entries', {
    preHandler: requireRole('manager'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const body = entrySchema.parse(request.body);
    const queryShopId = (request.query as any)?.shopId
      ? Number((request.query as any).shopId)
      : undefined;
    const effectiveShopId = body.shopId ?? queryShopId ?? null;

    const [entry] = await db
      .insert(cashflowEntries)
      .values({
        workspaceId,
        shopId: effectiveShopId,
        date: new Date(body.date),
        category: body.category,
        description: body.description || null,
        amount: body.amount.toString(),
        source: 'manual',
      })
      .returning();

    return entry;
  });

  // ─────────────────────────────────────────────
  // GET /cashflow/:workspaceId/forecast
  // Get cash flow forecast
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
    Querystring: { weeks?: string; shopId?: string };
  }>('/cashflow/:workspaceId/forecast', {
    preHandler: requireRole('supervisor'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const weeks = Number(request.query.weeks) || 8;
    const shopId = request.query.shopId ? Number(request.query.shopId) : undefined;

    // Get settings
    const [settings] = await db
      .select()
      .from(cashflowSettings)
      .where(eq(cashflowSettings.workspaceId, workspaceId))
      .limit(1);

    // Get current balance (sum of all entries) — scoped to shop when set
    const balanceConds: any[] = [eq(cashflowEntries.workspaceId, workspaceId)];
    const balanceShopFilter = buildShopFilter(cashflowEntries.shopId, shopId);
    if (balanceShopFilter) balanceConds.push(balanceShopFilter);

    const balanceResult = await db
      .select({ total: sql<string>`sum(amount::numeric)` })
      .from(cashflowEntries)
      .where(and(...balanceConds));

    const currentBalance = parseFloat(balanceResult[0]?.total || '0');

    // Get planned items
    const now = new Date();
    const endDate = new Date(Date.now() + weeks * 7 * 24 * 60 * 60 * 1000);

    const plannedConds: any[] = [
      eq(cashflowPlannedItems.workspaceId, workspaceId),
      eq(cashflowPlannedItems.isCompleted, false),
      lte(cashflowPlannedItems.startDate, endDate),
    ];
    const plannedShopFilter2 = buildShopFilter(cashflowPlannedItems.shopId, shopId);
    if (plannedShopFilter2) plannedConds.push(plannedShopFilter2);

    const plannedItems = await db
      .select()
      .from(cashflowPlannedItems)
      .where(and(...plannedConds));

    // Generate weekly forecast
    const forecast: Array<{
      weekStart: string;
      weekEnd: string;
      income: number;
      expenses: number;
      netFlow: number;
      balance: number;
      items: Array<{ name: string; amount: number; category: string }>;
    }> = [];

    let runningBalance = currentBalance;

    for (let w = 0; w < weeks; w++) {
      const weekStart = new Date(now.getTime() + w * 7 * 24 * 60 * 60 * 1000);
      const weekEnd = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000);

      const weekItems: Array<{ name: string; amount: number; category: string }> = [];

      // Add planned items for this week
      for (const item of plannedItems) {
        const itemDate = item.plannedDate || item.startDate;
        if (!itemDate) continue;

        const d = new Date(itemDate);
        if (d >= weekStart && d <= weekEnd) {
          const amount = parseFloat(item.amount);
          weekItems.push({
            name: item.name,
            amount,
            category: item.category,
          });
        }

        // Handle recurring items
        if (item.isRecurring && item.recurrenceType) {
          const amount = parseFloat(item.amount);
          const itemKey = `${item.name}-recurring`;
          
          // Check each day of the week for recurring matches
          for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
            const checkDate = new Date(weekStart.getTime() + dayOffset * 24 * 60 * 60 * 1000);
            let shouldAdd = false;
            
            switch (item.recurrenceType) {
              case 'daily':
                // Daily: add every day
                shouldAdd = true;
                break;
                
              case 'weekly':
                // Weekly: recurrenceDay is day of week (1=Mon, 7=Sun)
                const checkDayOfWeek = checkDate.getDay() || 7; // Convert 0 (Sun) to 7
                const targetDayOfWeek = item.recurrenceDay || 1;
                shouldAdd = checkDayOfWeek === targetDayOfWeek;
                break;
                
              case 'monthly':
                // Monthly: recurrenceDay is day of month (1-31)
                const targetDayOfMonth = item.recurrenceDay || 1;
                shouldAdd = checkDate.getDate() === targetDayOfMonth;
                break;
                
              case 'yearly':
                // Yearly: recurrenceDay is day of month, recurrenceMonth is month (1-12)
                const targetYearDay = item.recurrenceDay || 1;
                const targetMonth = (item as any).recurrenceMonth || 1;
                shouldAdd = checkDate.getDate() === targetYearDay && 
                           (checkDate.getMonth() + 1) === targetMonth;
                break;
            }
            
            if (shouldAdd) {
              // For daily, only add once per week to avoid duplicates in weekly view
              if (item.recurrenceType === 'daily') {
                if (dayOffset === 0) {
                  // Add daily items as a weekly sum (7x amount)
                  weekItems.push({
                    name: `${item.name} (ежедневно)`,
                    amount: amount * 7,
                    category: item.category,
                  });
                }
                break; // Don't add more for daily
              } else {
                // For weekly/monthly/yearly, add if not already added this week
                if (!weekItems.find(i => i.name === item.name)) {
                  weekItems.push({
                    name: item.name,
                    amount,
                    category: item.category,
                  });
                }
              }
            }
          }
        }
      }

      const income = weekItems.filter(i => i.amount > 0).reduce((s, i) => s + i.amount, 0);
      const expenses = Math.abs(weekItems.filter(i => i.amount < 0).reduce((s, i) => s + i.amount, 0));
      const netFlow = income - expenses;
      runningBalance += netFlow;

      forecast.push({
        weekStart: weekStart.toISOString().slice(0, 10),
        weekEnd: weekEnd.toISOString().slice(0, 10),
        income,
        expenses,
        netFlow,
        balance: runningBalance,
        items: weekItems,
      });
    }

    // Find cash gaps
    const alertThreshold = settings?.alertThreshold ? parseFloat(settings.alertThreshold) : 0;
    const cashGaps = forecast.filter(f => f.balance < alertThreshold);

    // === Statistical forecast based on historical entries ===
    // Analyze last 12 weeks of actual data to project trends
    const histWeeks = 12;
    const histStart = new Date(now.getTime() - histWeeks * 7 * 24 * 60 * 60 * 1000);

    const histConds: any[] = [
      eq(cashflowEntries.workspaceId, workspaceId),
      gte(cashflowEntries.date, histStart),
    ];
    const histShopFilter = buildShopFilter(cashflowEntries.shopId, shopId);
    if (histShopFilter) histConds.push(histShopFilter);

    const weeklyHistory = await db
      .select({
        weekStart: sql<string>`date_trunc('week', date)::date`,
        income: sql<string>`sum(case when amount::numeric > 0 then amount::numeric else 0 end)`,
        expenses: sql<string>`sum(case when amount::numeric < 0 then abs(amount::numeric) else 0 end)`,
      })
      .from(cashflowEntries)
      .where(and(...histConds))
      .groupBy(sql`date_trunc('week', date)`)
      .orderBy(sql`date_trunc('week', date)`);

    // Weighted moving average (recent weeks have higher weight)
    const histIncomes = weeklyHistory.map(w => parseFloat(w.income || '0'));
    const histExpenses = weeklyHistory.map(w => parseFloat(w.expenses || '0'));

    function weightedAvg(vals: number[]): number {
      if (!vals.length) return 0;
      let weightSum = 0, valSum = 0;
      for (let i = 0; i < vals.length; i++) {
        const weight = i + 1; // More recent = higher weight
        weightSum += weight;
        valSum += vals[i] * weight;
      }
      return valSum / weightSum;
    }

    function linearTrend(vals: number[]): { slope: number; intercept: number } {
      if (vals.length < 2) return { slope: 0, intercept: vals[0] ?? 0 };
      const n = vals.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      for (let i = 0; i < n; i++) {
        sumX += i; sumY += vals[i]; sumXY += i * vals[i]; sumX2 += i * i;
      }
      const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
      const intercept = (sumY - slope * sumX) / n;
      return { slope: Number.isFinite(slope) ? slope : 0, intercept: Number.isFinite(intercept) ? intercept : 0 };
    }

    const avgIncome = weightedAvg(histIncomes);
    const avgExpenses = weightedAvg(histExpenses);
    const incomeTrend = linearTrend(histIncomes);
    const expenseTrend = linearTrend(histExpenses);
    const baseIdx = histIncomes.length;

    // Build statistical forecast
    const statForecast: Array<{
      weekStart: string;
      weekEnd: string;
      predictedIncome: number;
      predictedExpenses: number;
      predictedNetFlow: number;
      predictedBalance: number;
      confidence: 'high' | 'medium' | 'low';
    }> = [];

    let statBalance = currentBalance;
    for (let w = 0; w < weeks; w++) {
      const weekStart = new Date(now.getTime() + w * 7 * 24 * 60 * 60 * 1000);
      const weekEnd = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000);

      // Blend weighted average with trend projection
      const trendIncome = Math.max(0, incomeTrend.intercept + incomeTrend.slope * (baseIdx + w));
      const trendExpenses = Math.max(0, expenseTrend.intercept + expenseTrend.slope * (baseIdx + w));

      // Blend: 60% trend, 40% weighted average
      const blendWeight = histIncomes.length >= 4 ? 0.6 : 0.3;
      const predictedIncome = Math.round(trendIncome * blendWeight + avgIncome * (1 - blendWeight));
      const predictedExpenses = Math.round(trendExpenses * blendWeight + avgExpenses * (1 - blendWeight));
      const predictedNetFlow = predictedIncome - predictedExpenses;
      statBalance += predictedNetFlow;

      // Confidence degrades with distance
      const confidence = w < 2 ? 'high' : w < 5 ? 'medium' : 'low';

      statForecast.push({
        weekStart: weekStart.toISOString().slice(0, 10),
        weekEnd: weekEnd.toISOString().slice(0, 10),
        predictedIncome,
        predictedExpenses,
        predictedNetFlow,
        predictedBalance: Math.round(statBalance),
        confidence,
      });
    }

    return {
      currentBalance,
      forecast,
      cashGaps,
      alertThreshold,
      // Statistical forecast data
      statForecast,
      historicalWeekly: weeklyHistory.map(w => ({
        weekStart: w.weekStart,
        income: parseFloat(w.income || '0'),
        expenses: parseFloat(w.expenses || '0'),
      })),
      trends: {
        avgWeeklyIncome: Math.round(avgIncome),
        avgWeeklyExpenses: Math.round(avgExpenses),
        incomeSlope: Math.round(incomeTrend.slope),
        expenseSlope: Math.round(expenseTrend.slope),
        incomeTrend: incomeTrend.slope > 50 ? 'growing' : incomeTrend.slope < -50 ? 'declining' : 'stable',
        expenseTrend: expenseTrend.slope > 50 ? 'growing' : expenseTrend.slope < -50 ? 'declining' : 'stable',
      },
    };
  });

  // ─────────────────────────────────────────────
  // GET /cashflow/:workspaceId/summary
  // Get summary stats
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
    Querystring: { days?: string; dateFrom?: string; dateTo?: string; shopId?: string };
  }>('/cashflow/:workspaceId/summary', {
    preHandler: requireRole('supervisor'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    // Period: dateFrom/dateTo приоритет, иначе days (default 30).
    const toIso = (d: Date) => d.toISOString().slice(0, 10);
    const dateTo = request.query.dateTo ?? toIso(new Date());
    const dateFrom = request.query.dateFrom
      ?? toIso(new Date(Date.now() - (Number(request.query.days) || 30) * 24 * 60 * 60 * 1000));
    const sinceDate = new Date(dateFrom + 'T00:00:00Z');

    const shopId = request.query.shopId ? Number(request.query.shopId) : undefined;
    const shopCond = (col: any) => shopId != null ? [eq(col, shopId)] : [];

    // 1. ВБ-часть — accrual из wb_finance_reports (= xlsx ЛК ВБ копейка-в-копейку),
    //    + adv/v1/upd для рекламы, + cogs из wb_cogs×wb_finance_daily_products, + per-shop налог/НДС.
    //    Один источник правды с /finance/reports.
    const { totals: wbTotals } = await getFinanceReportsByPeriod(workspaceId, shopId, dateFrom, dateTo);

    // forPay — доход (deduction уже вычтен у ВБ → так оно и приходит к нам).
    // marginRub — итоговая чистая прибыль за период по ВБ (после всех вычетов + COGS + налог + НДС).

    // 2. Ручные записи cashflow_entries — только не-WB (зарплата, аренда, прочее).
    //    WB-категории (`ads`) больше не пишем сюда автоматически (sync-ads-spend deprecated).
    const manualTotals = await db
      .select({
        income: sql<string>`sum(case when amount::numeric > 0 then amount::numeric else 0 end)`,
        expenses: sql<string>`sum(case when amount::numeric < 0 then abs(amount::numeric) else 0 end)`,
      })
      .from(cashflowEntries)
      .where(and(
        eq(cashflowEntries.workspaceId, workspaceId),
        ...shopCond(cashflowEntries.shopId),
        gte(cashflowEntries.date, sinceDate)
      ));

    const byCategory = await db
      .select({
        category: cashflowEntries.category,
        total: sql<string>`sum(amount::numeric)`,
      })
      .from(cashflowEntries)
      .where(and(
        eq(cashflowEntries.workspaceId, workspaceId),
        ...shopCond(cashflowEntries.shopId),
        gte(cashflowEntries.date, sinceDate)
      ))
      .groupBy(cashflowEntries.category);

    const balanceResult = await db
      .select({ total: sql<string>`sum(amount::numeric)` })
      .from(cashflowEntries)
      .where(and(eq(cashflowEntries.workspaceId, workspaceId), ...shopCond(cashflowEntries.shopId)));

    const manualIncome = parseFloat(manualTotals[0]?.income || '0');
    const manualExpenses = parseFloat(manualTotals[0]?.expenses || '0');
    const manualBalance = parseFloat(balanceResult[0]?.total || '0');

    // 3. Категории к выдаче.
    const categoryResults: Array<{ category: string; label: string; total: number }> = [];

    // ВБ — accrual из финансовых отчётов.
    if (wbTotals.forPayRub !== 0) {
      categoryResults.push({ category: 'wb_for_pay', label: '💰 Выручка к перечислению (forPay)', total: wbTotals.forPayRub });
    }
    if (wbTotals.advRub !== 0) {
      categoryResults.push({ category: 'wb_ads', label: '🛒 Реклама (Баланс)', total: -wbTotals.advRub });
    }
    if (wbTotals.deliveryServiceRub !== 0) {
      categoryResults.push({ category: 'wb_delivery', label: '📦 Логистика', total: -wbTotals.deliveryServiceRub });
    }
    if (wbTotals.paidStorageRub !== 0) {
      categoryResults.push({ category: 'wb_storage', label: '📦 Хранение', total: -wbTotals.paidStorageRub });
    }
    if (wbTotals.paidAcceptanceRub !== 0) {
      categoryResults.push({ category: 'wb_acceptance', label: '📦 Приёмка', total: -wbTotals.paidAcceptanceRub });
    }
    if (wbTotals.penaltyRub !== 0) {
      categoryResults.push({ category: 'wb_penalty', label: '⚠️ Штрафы', total: -wbTotals.penaltyRub });
    }
    if (wbTotals.deductionRub !== 0) {
      categoryResults.push({ category: 'wb_deduction', label: '⚠️ Прочие удержания', total: -wbTotals.deductionRub });
    }
    if (wbTotals.additionalPaymentRub !== 0) {
      categoryResults.push({ category: 'wb_additional', label: '💵 Доплаты', total: wbTotals.additionalPaymentRub });
    }
    if (wbTotals.cogsRub !== 0) {
      categoryResults.push({ category: 'cogs', label: '📐 Себестоимость (COGS)', total: -wbTotals.cogsRub });
    }
    if (wbTotals.taxRub !== 0) {
      categoryResults.push({ category: 'tax', label: '💸 Налог (УСН)', total: -wbTotals.taxRub });
    }
    if (wbTotals.vatRub !== 0) {
      categoryResults.push({ category: 'vat', label: '💸 НДС', total: -wbTotals.vatRub });
    }

    // Ручные категории (не-WB) — добавляем как есть.
    for (const c of byCategory) {
      categoryResults.push({
        category: c.category,
        label: categoryLabels[c.category] || c.category,
        total: parseFloat(c.total || '0'),
      });
    }

    // 4. Сводные числа.
    // Доход: forPay (= деньги от ВБ к перечислению) + ручные доходы.
    // Расход: всё ВБ-удержанное + COGS + налог + НДС + реклама + ручные расходы.
    const wbIncome = Math.max(0, wbTotals.forPayRub) + Math.max(0, wbTotals.additionalPaymentRub);
    const wbExpenses =
      wbTotals.advRub +
      wbTotals.deliveryServiceRub +
      wbTotals.paidStorageRub +
      wbTotals.paidAcceptanceRub +
      wbTotals.penaltyRub +
      wbTotals.deductionRub +
      wbTotals.cogsRub +
      wbTotals.taxRub +
      wbTotals.vatRub;

    const totalIncome = wbIncome + manualIncome;
    const totalExpenses = wbExpenses + manualExpenses;
    const netProfit = wbTotals.marginRub + manualIncome - manualExpenses;

    return {
      period: { since: sinceDate.toISOString(), dateFrom, dateTo },
      income: totalIncome,
      expenses: totalExpenses,
      netFlow: totalIncome - totalExpenses,
      netProfit, // accrual чистая прибыль (по wb_finance_reports + внешние)
      currentBalance: manualBalance, // только из ручных entries (cashflowWbPayouts больше не считаем)
      byCategory: categoryResults,
      wb: wbTotals, // полная развёрстка ВБ — для UI/отладки
    };
  });

  // ═══════════════════════════════════════════════
  // CATEGORIES
  // ═══════════════════════════════════════════════

  // GET /cashflow/:workspaceId/categories
  app.get<{
    Params: { workspaceId: string };
    Querystring: { type?: 'income' | 'expense' };
  }>('/cashflow/:workspaceId/categories', {
    preHandler: requireRole('supervisor'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const type = request.query.type;

    let conditions = [
      eq(cashflowCategories.workspaceId, workspaceId),
      eq(cashflowCategories.isActive, true),
    ];
    if (type) conditions.push(eq(cashflowCategories.type, type));

    const categories = await db
      .select()
      .from(cashflowCategories)
      .where(and(...conditions))
      .orderBy(cashflowCategories.sortOrder);

    // Build hierarchy
    const rootCategories = categories.filter(c => !c.parentCode);
    const childMap = new Map<string, typeof categories>();
    for (const c of categories) {
      if (c.parentCode) {
        const children = childMap.get(c.parentCode) || [];
        children.push(c);
        childMap.set(c.parentCode, children);
      }
    }

    return rootCategories.map(c => ({
      ...c,
      children: childMap.get(c.code) || [],
    }));
  });

  // POST /cashflow/:workspaceId/categories
  app.post<{
    Params: { workspaceId: string };
    Body: {
      code: string;
      name: string;
      type: 'income' | 'expense';
      parentCode?: string;
      icon?: string;
      color?: string;
    };
  }>('/cashflow/:workspaceId/categories', {
    preHandler: requireRole('manager'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { code, name, type, parentCode, icon, color } = request.body;

    // Get max sort order
    const maxSort = await db
      .select({ max: sql<number>`max(sort_order)` })
      .from(cashflowCategories)
      .where(eq(cashflowCategories.workspaceId, workspaceId));

    const [category] = await db
      .insert(cashflowCategories)
      .values({
        workspaceId,
        code: code.toLowerCase().replace(/\s+/g, '_'),
        name,
        type,
        parentCode,
        icon,
        color,
        sortOrder: (maxSort[0]?.max || 0) + 1,
      })
      .returning();

    return category;
  });

  // PATCH /cashflow/:workspaceId/categories/:categoryId
  app.patch<{
    Params: { workspaceId: string; categoryId: string };
    Body: {
      name?: string;
      icon?: string;
      color?: string;
      sortOrder?: number;
      isActive?: boolean;
    };
  }>('/cashflow/:workspaceId/categories/:categoryId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const categoryId = Number(request.params.categoryId);
    const body = request.body;

    const [category] = await db
      .update(cashflowCategories)
      .set({
        ...(body.name && { name: body.name }),
        ...(body.icon !== undefined && { icon: body.icon }),
        ...(body.color !== undefined && { color: body.color }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        
      })
      .where(and(
        eq(cashflowCategories.categoryId, categoryId),
        eq(cashflowCategories.workspaceId, workspaceId)
      ))
      .returning();

    if (!category) {
      return reply.status(404).send({ error: 'Category not found' });
    }
    return category;
  });

  // DELETE /cashflow/:workspaceId/categories/:categoryId
  app.delete<{
    Params: { workspaceId: string; categoryId: string };
  }>('/cashflow/:workspaceId/categories/:categoryId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const categoryId = Number(request.params.categoryId);

    // Check if system category
    const [existing] = await db
      .select()
      .from(cashflowCategories)
      .where(and(
        eq(cashflowCategories.categoryId, categoryId),
        eq(cashflowCategories.workspaceId, workspaceId)
      ));

    if (!existing) {
      return reply.status(404).send({ error: 'Category not found' });
    }

    if (existing.isSystem) {
      return reply.status(400).send({ error: 'Cannot delete system category' });
    }

    await db
      .delete(cashflowCategories)
      .where(eq(cashflowCategories.categoryId, categoryId));

    return { deleted: true };
  });

  // ─────────────────────────────────────────────
  // GET /cashflow/:workspaceId/wb-finance
  // Get WB finance data for ДДС
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
    Querystring: { from?: string; to?: string; shopId?: string };
  }>('/cashflow/:workspaceId/wb-finance', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const shopId = request.query.shopId ? Number(request.query.shopId) : undefined;
    const from = request.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = request.query.to || new Date().toISOString().slice(0, 10);

    // Daily финансы (accrual по дате реализации, wb_finance_daily).
    const financeData = await db
      .select()
      .from(wbFinanceDaily)
      .where(and(
        eq(wbFinanceDaily.workspaceId, workspaceId),
        buildShopFilter(wbFinanceDaily.shopId, shopId),
        gte(wbFinanceDaily.date, from),
        lte(wbFinanceDaily.date, to)
      ))
      .orderBy(desc(wbFinanceDaily.date));

    // Реклама daily (/adv/v1/upd → wb_adv_finance) — единственный «точный» источник
    // расходов на рекламу, совпадающий с xlsx «История затрат».
    const advRaw: any = await db.execute(sql`
      SELECT upd_date::text AS date, COALESCE(SUM(upd_sum_kopecks), 0) AS adv_kop
      FROM wb_adv_finance
      WHERE workspace_id = ${workspaceId}
        ${shopId ? sql`AND shop_id = ${shopId}` : sql``}
        AND upd_date BETWEEN ${from} AND ${to}
      GROUP BY upd_date
    `);
    const advByDate = new Map<string, number>(
      ((advRaw.rows ?? advRaw) as any[]).map((r) => [String(r.date), Number(r.adv_kop) || 0])
    );

    const toRub = (kop: number | null | undefined) => Math.round((kop || 0) / 100);

    type DailyRow = {
      date: string;
      // Доход
      forPayRub: number;            // forPay = retail - комиссия (главный доход за день)
      additionalPaymentRub: number; // доплаты ВБ
      // Расход
      commissionRub: number;        // удержанная комиссия (retail - forPay)
      logisticsRub: number;         // логистика + возвратная
      storageRub: number;           // платное хранение
      paidAcceptanceRub: number;    // платная приёмка
      penaltyRub: number;           // штрафы
      acquiringRub: number;         // эквайринг
      otherHoldRub: number;         // прочие удержания
      advRub: number;               // реклама (daily из /adv/v1/upd)
      // Итоги
      incomeRub: number;            // forPay + доплаты
      expensesRub: number;          // все вычеты + реклама
      netRub: number;               // incomeRub − expensesRub
      // Прочее
      retailRub: number;
      payoutRub: number;
      salesCount: number;
      returnsCount: number;
    };

    const daily: DailyRow[] = financeData.map((row) => {
      const date = String(row.date);
      const retailRub = toRub(row.retailKopecks);
      const payoutRub = toRub(row.payoutKopecks);
      const forPayRub = payoutRub; // payout_kopecks = forPay (после комиссии)
      const commissionRub = Math.max(0, retailRub - forPayRub);
      const logisticsRub = toRub((row.logisticsKopecks || 0) + (row.returnLogisticsKopecks || 0));
      const storageRub = toRub(row.storageKopecks);
      const paidAcceptanceRub = toRub(row.paidAcceptanceKopecks);
      const penaltyRub = toRub(row.penaltyKopecks);
      const acquiringRub = toRub(row.acquiringKopecks);
      const otherHoldRub = toRub(row.otherHoldKopecks);
      const additionalPaymentRub = toRub(row.additionalPaymentKopecks);
      const advRub = Math.round((advByDate.get(date) || 0) / 100);

      const incomeRub = Math.max(0, forPayRub) + Math.max(0, additionalPaymentRub);
      const expensesRub = commissionRub + logisticsRub + storageRub + paidAcceptanceRub
        + penaltyRub + acquiringRub + otherHoldRub + advRub;

      return {
        date,
        forPayRub,
        additionalPaymentRub,
        commissionRub,
        logisticsRub,
        storageRub,
        paidAcceptanceRub,
        penaltyRub,
        acquiringRub,
        otherHoldRub,
        advRub,
        incomeRub,
        expensesRub,
        netRub: incomeRub - expensesRub,
        retailRub,
        payoutRub,
        salesCount: Number(row.lines || 0),
        returnsCount: Number(row.returnsCount || 0),
      };
    });

    const totals = daily.reduce((acc, r) => ({
      forPayRub: acc.forPayRub + r.forPayRub,
      additionalPaymentRub: acc.additionalPaymentRub + r.additionalPaymentRub,
      commissionRub: acc.commissionRub + r.commissionRub,
      logisticsRub: acc.logisticsRub + r.logisticsRub,
      storageRub: acc.storageRub + r.storageRub,
      paidAcceptanceRub: acc.paidAcceptanceRub + r.paidAcceptanceRub,
      penaltyRub: acc.penaltyRub + r.penaltyRub,
      acquiringRub: acc.acquiringRub + r.acquiringRub,
      otherHoldRub: acc.otherHoldRub + r.otherHoldRub,
      advRub: acc.advRub + r.advRub,
      incomeRub: acc.incomeRub + r.incomeRub,
      expensesRub: acc.expensesRub + r.expensesRub,
      netRub: acc.netRub + r.netRub,
      retailRub: acc.retailRub + r.retailRub,
      payoutRub: acc.payoutRub + r.payoutRub,
      salesCount: acc.salesCount + r.salesCount,
      returnsCount: acc.returnsCount + r.returnsCount,
    }), {
      forPayRub: 0, additionalPaymentRub: 0, commissionRub: 0, logisticsRub: 0,
      storageRub: 0, paidAcceptanceRub: 0, penaltyRub: 0, acquiringRub: 0,
      otherHoldRub: 0, advRub: 0, incomeRub: 0, expensesRub: 0, netRub: 0,
      retailRub: 0, payoutRub: 0, salesCount: 0, returnsCount: 0,
    });

    return {
      period: { from, to },
      days: daily.length,
      totals,
      daily,
    };
  });

  // ─────────────────────────────────────────────
  // POST /cashflow/:workspaceId/sync-wb-payouts
  // Sync WB payouts from finance data
  // ─────────────────────────────────────────────
  app.post<{
    Params: { workspaceId: string };
    Body: { from?: string; to?: string; shopId?: number };
  }>('/cashflow/:workspaceId/sync-wb-payouts', {
    preHandler: requireRole('manager'),
  }, async (_request, reply) => {
    // Deprecated: /cashflow/:ws/summary теперь читает данные на лету из wb_finance_reports.
    // Никакой синхронизации в cashflow_wb_payouts больше не требуется.
    return reply.code(410).send({
      ok: false,
      deprecated: true,
      message: 'sync-wb-payouts отключён. /cashflow/summary теперь считает на лету из wb_finance_reports (accrual). Cron sync финансов уже наполняет wb_finance_reports.',
    });
  });

  // ─────────────────────────────────────────────
  // GET /cashflow/:workspaceId/wb-payouts
  // List WB payouts
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
    Querystring: { limit?: string; shopId?: string };
  }>('/cashflow/:workspaceId/wb-payouts', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const limit = Number(request.query.limit) || 20;
    const payoutShopId = request.query.shopId ? Number(request.query.shopId) : undefined;

    const payoutConds: any[] = [eq(cashflowWbPayouts.workspaceId, workspaceId)];
    const payoutShopFilter = buildShopFilter(cashflowWbPayouts.shopId, payoutShopId);
    if (payoutShopFilter) payoutConds.push(payoutShopFilter);

    const payouts = await db
      .select()
      .from(cashflowWbPayouts)
      .where(and(...payoutConds))
      .orderBy(desc(cashflowWbPayouts.payoutDate))
      .limit(limit);

    const total = payouts.reduce((sum, p) => sum + Number(p.amount || 0), 0);

    return {
      payouts: payouts.map(p => ({
        ...p,
        amount: Number(p.amount),
        saleAmount: Number(p.saleAmount),
        commissionAmount: Number(p.commissionAmount),
        deliveryAmount: Number(p.deliveryAmount),
        penaltyAmount: Number(p.penaltyAmount),
        storageAmount: Number(p.storageAmount),
      })),
      total,
      count: payouts.length,
    };
  });

  // ─────────────────────────────────────────────
  // POST /cashflow/:workspaceId/sync-ads-spend
  // Sync advertising spend from WB Advert API
  // ─────────────────────────────────────────────
  app.post<{
    Params: { workspaceId: string };
    Body: { from?: string; to?: string };
  }>('/cashflow/:workspaceId/sync-ads-spend', {
    preHandler: requireRole('manager'),
  }, async (_request, reply) => {
    // Deprecated: эти данные брались из /v1/promotion/count + /v1/fullstats —
    // это метрики РК, а не списания. Расходились с xlsx «История затрат» в 2×.
    // Реклама теперь берётся из wb_adv_finance (/adv/v1/upd), который автоматически
    // подмешивается в /cashflow/summary и /finance/reports.
    return reply.code(410).send({
      ok: false,
      deprecated: true,
      message: 'sync-ads-spend отключён. Реклама автоматически берётся из wb_adv_finance (/adv/v1/upd) — совпадает с xlsx «История затрат» копейка-в-копейку.',
    });
  });
};
