/**
 * Advertising Bidder API
 * 
 * Manage bidder rules, settings, and view action history
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, gte, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bidderRules, bidderActions, bidderSettings, bidderKeywords, bidderKeywordAutoRules, bidderAlerts, wbCampaigns } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';
import { extractShopId } from '../plugins/shopFilter.js';
import { buildShopFilter } from './pulse/helpers.js';
import { syncCampaigns, getCampaignsFromDb } from '../integrations/wb/campaigns.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'bidder' });

// 60-second in-process cache for `/bidder/:ws/campaigns/stats`. WB Advert
// Analytics API caps requests at 3/min per token — without this cache the UI
// shows "превышен лимит запросов" on every second reload. Entries keyed by
// (workspace, shop, advertId, date-range); eviction is lazy (checked on read).
const campaignStatsCache = new Map<string, { at: number; payload: unknown }>();
// Prevent unbounded growth — evict expired entries every 5 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of campaignStatsCache) {
    if (now - v.at > 60_000) campaignStatsCache.delete(k);
  }
}, 5 * 60 * 1000).unref();

// Schemas
const createRuleSchema = z.object({
  name: z.string().min(1).max(100),
  shopId: z.number().optional(),
  targetType: z.enum(['all', 'search', 'catalog', 'auto']).default('all'),
  campaignIds: z.array(z.number()).optional(),
  ruleType: z.enum(['drr_target', 'position_target', 'budget_limit', 'time_schedule', 'cpm_range']),
  conditions: z.object({
    targetDrr: z.number().optional(), // target DRR %
    maxDrr: z.number().optional(),
    minDrr: z.number().optional(),
    targetPosition: z.number().optional(),
    maxBudget: z.number().optional(),
    minCpm: z.number().optional(),
    maxCpm: z.number().optional(),
  }),
  actionType: z.enum(['set', 'increase', 'decrease', 'increase_percent', 'decrease_percent']),
  actionValue: z.number().min(1),
  minBid: z.number().min(10).default(50),
  maxBid: z.number().max(100000).default(10000),
  maxChangePerHour: z.number().optional(),
  activeHours: z.array(z.number().min(0).max(23)).optional(),
  activeDays: z.array(z.number().min(1).max(7)).optional(),
});

const updateRuleSchema = createRuleSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const settingsSchema = z.object({
  isEnabled: z.boolean().optional(),
  checkIntervalMinutes: z.number().min(15).max(1440).optional(),
  globalMinBid: z.number().min(10).optional(),
  globalMaxBid: z.number().max(100000).optional(),
  globalMaxDailySpend: z.number().nullable().optional(),
  notifyTelegram: z.boolean().optional(),
  telegramChatId: z.string().nullable().optional(),
  notifyOnChange: z.boolean().optional(),
  notifyOnError: z.boolean().optional(),
});

export const bidderRoutes: FastifyPluginAsync = async (app) => {
  // ─────────────────────────────────────────────
  // GET /bidder/:workspaceId/settings
  // Get bidder settings
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
  }>('/bidder/:workspaceId/settings', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);

    const [settings] = await db
      .select()
      .from(bidderSettings)
      .where(eq(bidderSettings.workspaceId, workspaceId))
      .limit(1);

    return settings || {
      workspaceId,
      isEnabled: false,
      checkIntervalMinutes: 60,
      globalMinBid: 50,
      globalMaxBid: 10000,
      globalMaxDailySpend: null,
      killSwitchEnabled: false,
      notifyTelegram: false,
      notifyOnChange: true,
      notifyOnError: true,
    };
  });

  // ─────────────────────────────────────────────
  // PATCH /bidder/:workspaceId/settings
  // Update bidder settings
  // ─────────────────────────────────────────────
  app.patch<{
    Params: { workspaceId: string };
    Body: z.infer<typeof settingsSchema>;
  }>('/bidder/:workspaceId/settings', {
    preHandler: requireRole('manager'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const body = settingsSchema.parse(request.body);

    const [existing] = await db
      .select()
      .from(bidderSettings)
      .where(eq(bidderSettings.workspaceId, workspaceId))
      .limit(1);

    if (existing) {
      const [updated] = await db
        .update(bidderSettings)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(bidderSettings.workspaceId, workspaceId))
        .returning();
      return updated;
    }

    const [created] = await db
      .insert(bidderSettings)
      .values({ workspaceId, ...body })
      .returning();
    return created;
  });

  // ─────────────────────────────────────────────
  // POST /bidder/:workspaceId/kill-switch
  // Enable/disable kill switch
  // ─────────────────────────────────────────────
  app.post<{
    Params: { workspaceId: string };
    Body: { enabled: boolean; reason?: string };
  }>('/bidder/:workspaceId/kill-switch', {
    preHandler: requireRole('owner'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { enabled, reason } = request.body;

    // Use UPSERT to ensure settings exist before updating
    await db
      .insert(bidderSettings)
      .values({
        workspaceId,
        killSwitchEnabled: enabled,
        killSwitchReason: enabled ? (reason || 'Manual kill switch') : null,
        killSwitchAt: enabled ? new Date() : null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: bidderSettings.workspaceId,
        set: {
          killSwitchEnabled: enabled,
          killSwitchReason: enabled ? (reason || 'Manual kill switch') : null,
          killSwitchAt: enabled ? new Date() : null,
          updatedAt: new Date(),
        },
      });

    return { success: true, killSwitchEnabled: enabled };
  });

  // ─────────────────────────────────────────────
  // GET /bidder/:workspaceId/rules
  // List all rules
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
  }>('/bidder/:workspaceId/rules', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const shopId = extractShopId(request);

    const rules = await db
      .select()
      .from(bidderRules)
      .where(and(eq(bidderRules.workspaceId, workspaceId), buildShopFilter(bidderRules.shopId, shopId)))
      .orderBy(desc(bidderRules.priority), desc(bidderRules.createdAt));

    return { rules };
  });

  // ─────────────────────────────────────────────
  // POST /bidder/:workspaceId/rules
  // Create a new rule
  // ─────────────────────────────────────────────
  app.post<{
    Params: { workspaceId: string };
    Body: z.infer<typeof createRuleSchema>;
  }>('/bidder/:workspaceId/rules', {
    preHandler: requireRole('manager'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const body = createRuleSchema.parse(request.body);

    const [rule] = await db
      .insert(bidderRules)
      .values({
        workspaceId,
        shopId: body.shopId || null,
        name: body.name,
        targetType: body.targetType,
        campaignIds: body.campaignIds || null,
        ruleType: body.ruleType,
        conditions: body.conditions,
        actionType: body.actionType,
        actionValue: body.actionValue,
        minBid: body.minBid,
        maxBid: body.maxBid,
        maxChangePerHour: body.maxChangePerHour || null,
        activeHours: body.activeHours || null,
        activeDays: body.activeDays || null,
      })
      .returning();

    return rule;
  });

  // ─────────────────────────────────────────────
  // POST /bidder/:workspaceId/simulate
  // Симуляция эффекта правила биддера ДО создания.
  // Возвращает прогноз дневного расхода и %-экономии на основе
  // wb_adv_daily_products за последние 7 дней. См. services/bidderSimulator.ts.
  // ─────────────────────────────────────────────
  app.post<{
    Params: { workspaceId: string };
    Body: z.infer<typeof createRuleSchema>;
  }>('/bidder/:workspaceId/simulate', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const body = createRuleSchema.parse(request.body);

    const { simulateBidderRule } = await import('../services/bidderSimulator.js');
    return simulateBidderRule(workspaceId, {
      ruleType: body.ruleType,
      conditions: body.conditions,
      actionType: body.actionType,
      actionValue: body.actionValue,
      activeHours: body.activeHours,
      activeDays: body.activeDays,
      targetType: body.targetType,
    });
  });

  // ─────────────────────────────────────────────
  // PATCH /bidder/:workspaceId/rules/:ruleId
  // Update a rule
  // ─────────────────────────────────────────────
  app.patch<{
    Params: { workspaceId: string; ruleId: string };
    Body: z.infer<typeof updateRuleSchema>;
  }>('/bidder/:workspaceId/rules/:ruleId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const ruleId = Number(request.params.ruleId);
    const body = updateRuleSchema.parse(request.body);

    const [existing] = await db
      .select()
      .from(bidderRules)
      .where(and(eq(bidderRules.ruleId, ruleId), eq(bidderRules.workspaceId, workspaceId)))
      .limit(1);

    if (!existing) {
      return reply.status(404).send({ error: 'Rule not found' });
    }

    const updates: any = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.isActive !== undefined) updates.isActive = body.isActive;
    if (body.targetType !== undefined) updates.targetType = body.targetType;
    if (body.campaignIds !== undefined) updates.campaignIds = body.campaignIds || null;
    if (body.ruleType !== undefined) updates.ruleType = body.ruleType;
    if (body.conditions !== undefined) updates.conditions = body.conditions;
    if (body.actionType !== undefined) updates.actionType = body.actionType;
    if (body.actionValue !== undefined) updates.actionValue = body.actionValue;
    if (body.minBid !== undefined) updates.minBid = body.minBid;
    if (body.maxBid !== undefined) updates.maxBid = body.maxBid;
    if (body.maxChangePerHour !== undefined) updates.maxChangePerHour = body.maxChangePerHour;
    if (body.activeHours !== undefined) updates.activeHours = body.activeHours || null;
    if (body.activeDays !== undefined) updates.activeDays = body.activeDays || null;

    const [updated] = await db
      .update(bidderRules)
      .set(updates)
      .where(eq(bidderRules.ruleId, ruleId))
      .returning();

    return updated;
  });

  // ─────────────────────────────────────────────
  // DELETE /bidder/:workspaceId/rules/:ruleId
  // Delete a rule
  // ─────────────────────────────────────────────
  app.delete<{
    Params: { workspaceId: string; ruleId: string };
  }>('/bidder/:workspaceId/rules/:ruleId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const ruleId = Number(request.params.ruleId);

    const result = await db
      .delete(bidderRules)
      .where(and(eq(bidderRules.ruleId, ruleId), eq(bidderRules.workspaceId, workspaceId)))
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Rule not found' });
    }

    return { success: true };
  });

  // ─────────────────────────────────────────────
  // GET /bidder/:workspaceId/actions
  // Get action history
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
    Querystring: {
      campaignId?: string;
      ruleId?: string;
      status?: string;
      limit?: string;
      offset?: string;
    };
  }>('/bidder/:workspaceId/actions', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { campaignId, ruleId, status, limit: limitStr, offset: offsetStr } = request.query;

    const limit = Math.min(Number(limitStr) || 50, 200);
    const offset = Number(offsetStr) || 0;

    const conditions = [eq(bidderActions.workspaceId, workspaceId)];
    if (campaignId) conditions.push(eq(bidderActions.campaignId, Number(campaignId)));
    if (ruleId) conditions.push(eq(bidderActions.ruleId, Number(ruleId)));
    if (status) conditions.push(eq(bidderActions.status, status));

    const actions = await db
      .select()
      .from(bidderActions)
      .where(and(...conditions))
      .orderBy(desc(bidderActions.createdAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(bidderActions)
      .where(and(...conditions));

    return {
      actions,
      total: countResult[0]?.count || 0,
      limit,
      offset,
    };
  });

  // ─────────────────────────────────────────────
  // GET /bidder/:workspaceId/dashboard
  // Get bidder dashboard stats
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
  }>('/bidder/:workspaceId/dashboard', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Get settings
    const [settings] = await db
      .select()
      .from(bidderSettings)
      .where(eq(bidderSettings.workspaceId, workspaceId))
      .limit(1);

    // Count rules
    const ruleCount = await db
      .select({ 
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where is_active)::int`,
      })
      .from(bidderRules)
      .where(eq(bidderRules.workspaceId, workspaceId));

    // Count actions in last 24h
    const actionStats = await db
      .select({
        total: sql<number>`count(*)::int`,
        applied: sql<number>`count(*) filter (where status = 'applied')::int`,
        failed: sql<number>`count(*) filter (where status = 'failed')::int`,
      })
      .from(bidderActions)
      .where(and(
        eq(bidderActions.workspaceId, workspaceId),
        gte(bidderActions.createdAt, oneDayAgo)
      ));

    // ── Helium-10-style KPI: расход рекламы, ДРР, активных кампаний ───────
    // Берём из wb_adv_daily aggregate за вчера (свежие данные) + сравнение
    // со средним за 7 дней до этого.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);

    const advStats = await db.execute<{
      spend_yesterday_kop: number;
      revenue_yesterday_kop: number;
      orders_yesterday: number;
      avg_daily_spend_kop_week_ago: number;
      avg_daily_revenue_kop_week_ago: number;
      campaigns_active: number;
    }>(sql`
      WITH yday AS (
        SELECT
          COALESCE(SUM(spend_unified_kopecks + spend_kopecks + spend_manual_kopecks), 0)::bigint AS spend_kop,
          COALESCE(SUM(sum_price_unified_kopecks + sum_price_kopecks + sum_price_manual_kopecks), 0)::bigint AS revenue_kop,
          COALESCE(SUM(orders_unified_count + orders_count + orders_manual_count), 0)::int AS orders
        FROM wb_adv_daily
        WHERE workspace_id = ${workspaceId} AND date = ${yesterday}
      ),
      week_ago AS (
        SELECT
          COALESCE(SUM(spend_unified_kopecks + spend_kopecks + spend_manual_kopecks), 0)::bigint AS spend_kop,
          COALESCE(SUM(sum_price_unified_kopecks + sum_price_kopecks + sum_price_manual_kopecks), 0)::bigint AS revenue_kop
        FROM wb_adv_daily
        WHERE workspace_id = ${workspaceId}
          AND date >= ${eightDaysAgo}
          AND date <= ${twoDaysAgo}
      ),
      active AS (
        -- В wb_adv_daily_products нет колонки advert_id, поэтому считаем
        -- активных по числу уникальных товаров (nm_id) с расходом > 0
        -- за вчерашний день. Это близкий по смыслу прокси.
        SELECT COUNT(DISTINCT nm_id)::int AS cnt
        FROM wb_adv_daily_products
        WHERE workspace_id = ${workspaceId}
          AND date >= ${yesterday}
          AND (spend_unified_kopecks + spend_kopecks + spend_manual_kopecks) > 0
      )
      SELECT
        (SELECT spend_kop FROM yday) AS spend_yesterday_kop,
        (SELECT revenue_kop FROM yday) AS revenue_yesterday_kop,
        (SELECT orders FROM yday) AS orders_yesterday,
        (SELECT spend_kop FROM week_ago) / 7 AS avg_daily_spend_kop_week_ago,
        (SELECT revenue_kop FROM week_ago) / 7 AS avg_daily_revenue_kop_week_ago,
        (SELECT cnt FROM active) AS campaigns_active
    `);

    const s = ((advStats as any).rows ?? advStats)[0] ?? {};
    const spendYRub = Number(s.spend_yesterday_kop ?? 0) / 100;
    const revenueYRub = Number(s.revenue_yesterday_kop ?? 0) / 100;
    const ordersY = Number(s.orders_yesterday ?? 0);
    const avgSpendRub = Number(s.avg_daily_spend_kop_week_ago ?? 0) / 100;
    const avgRevenueRub = Number(s.avg_daily_revenue_kop_week_ago ?? 0) / 100;
    const drrY = revenueYRub > 0 ? (spendYRub / revenueYRub) * 100 : 0;
    const drrWeekAgo = avgRevenueRub > 0 ? (avgSpendRub / avgRevenueRub) * 100 : 0;

    return {
      isEnabled: settings?.isEnabled ?? false,
      killSwitchEnabled: settings?.killSwitchEnabled ?? false,
      lastRunAt: settings?.lastRunAt || null,
      rules: {
        total: ruleCount[0]?.total || 0,
        active: ruleCount[0]?.active || 0,
      },
      actionsLast24h: {
        total: actionStats[0]?.total || 0,
        applied: actionStats[0]?.applied || 0,
        failed: actionStats[0]?.failed || 0,
      },
      // Новые KPI (а-ля MP Manager) — расход / ДРР / активных кампаний
      spendYesterdayRub: Math.round(spendYRub),
      spendDeltaVsAvgWeekRub: Math.round(spendYRub - avgSpendRub),
      drrYesterdayPct: Math.round(drrY * 10) / 10,
      drrDeltaVsWeekPct: Math.round((drrY - drrWeekAgo) * 10) / 10,
      ordersYesterday: ordersY,
      campaignsActive: Number(s.campaigns_active ?? 0),
    };
  });

  // ─────────────────────────────────────────────
  // POST /bidder/:workspaceId/analyze-competitors
  // Analyze competitor bids for a keyword
  // ─────────────────────────────────────────────
  app.post<{
    Params: { workspaceId: string };
    Body: { keyword: string };
  }>('/bidder/:workspaceId/analyze-competitors', {
    preHandler: requireRole('viewer'),
  }, async (request, reply) => {
    const { keyword } = request.body;

    if (!keyword || keyword.length < 2) {
      return reply.code(400).send({ ok: false, error: 'Keyword must be at least 2 characters' });
    }

    const { getCompetitorBids } = await import('../services/autoBidder.js');
    const competitors = await getCompetitorBids(keyword);

    // Handle API error (null = failed to fetch)
    if (competitors === null) {
      return {
        ok: false,
        keyword,
        checkedAt: new Date().toISOString(),
        error: 'Failed to fetch competitor data from WB API',
        competitorCount: 0,
        competitors: [],
      };
    }

    return {
      ok: true,
      keyword,
      checkedAt: new Date().toISOString(),
      competitorCount: competitors.length,
      competitors: competitors.slice(0, 20), // Top 20
      avgCpm: competitors.length > 0 
        ? Math.round(competitors.reduce((sum, c) => sum + c.cpm, 0) / competitors.length)
        : 0,
      minCpm: competitors.length > 0 ? Math.min(...competitors.map(c => c.cpm)) : 0,
      maxCpm: competitors.length > 0 ? Math.max(...competitors.map(c => c.cpm)) : 0,
    };
  });

  // ─────────────────────────────────────────────
  // POST /bidder/:workspaceId/calculate-bid
  // Calculate optimal bid for target position
  // ─────────────────────────────────────────────
  app.post<{
    Params: { workspaceId: string };
    Body: {
      keyword: string;
      currentBid: number;
      currentPosition?: number;
      targetPosition?: number;
      targetDrr?: number;
      currentDrr?: number;
      minBid?: number;
      maxBid?: number;
    };
  }>('/bidder/:workspaceId/calculate-bid', {
    preHandler: requireRole('viewer'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const {
      keyword,
      currentBid,
      currentPosition = 0,
      targetPosition,
      targetDrr,
      currentDrr,
      minBid = 50,
      maxBid = 10000,
    } = request.body;

    if (!keyword || keyword.length < 2) {
      return reply.code(400).send({ ok: false, error: 'Keyword must be at least 2 characters' });
    }

    const { getCompetitorBids, calculateOptimalBid, calculateDrrBasedBid } = await import('../services/autoBidder.js');
    
    const competitors = await getCompetitorBids(keyword);

    // Handle API error (null = failed to fetch)
    if (competitors === null) {
      return {
        ok: false,
        error: 'Failed to fetch competitor data from WB API. Bid not changed.',
        keyword,
      };
    }

    let decision;
    
    if (targetPosition && targetPosition > 0) {
      decision = calculateOptimalBid({
        currentPosition,
        currentBid,
        targetPosition,
        minBid,
        maxBid,
        competitors,
      });
    } else if (targetDrr !== undefined && currentDrr !== undefined) {
      decision = calculateDrrBasedBid({
        currentBid,
        currentDrr,
        targetDrr,
        minBid,
        maxBid,
      });
    } else {
      return reply.code(400).send({ ok: false, error: 'Either targetPosition or targetDrr/currentDrr must be provided' });
    }

    return {
      ok: true,
      keyword,
      checkedAt: new Date().toISOString(),
      input: {
        currentBid,
        currentPosition,
        targetPosition,
        targetDrr,
        currentDrr,
        minBid,
        maxBid,
      },
      decision,
      competitors: competitors.slice(0, 10),
    };
  });

  // ─────────────────────────────────────────────
  // POST /bidder/:workspaceId/recommend-bids
  // Get recommended bids for multiple campaigns
  // ─────────────────────────────────────────────
  app.post<{
    Params: { workspaceId: string };
    Body: {
      campaigns: Array<{
        campaignId: number;
        keyword: string;
        currentBid: number;
        currentPosition?: number;
        targetPosition?: number;
        currentDrr?: number;
        targetDrr?: number;
      }>;
      minBid?: number;
      maxBid?: number;
    };
  }>('/bidder/:workspaceId/recommend-bids', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const { campaigns, minBid = 50, maxBid = 10000 } = request.body;

    if (!campaigns || campaigns.length === 0) {
      return reply.code(400).send({ ok: false, error: 'At least one campaign is required' });
    }

    if (campaigns.length > 20) {
      return reply.code(400).send({ ok: false, error: 'Maximum 20 campaigns per request' });
    }

    const { getRecommendedBids } = await import('../services/autoBidder.js');
    
    const recommendations = await getRecommendedBids({
      campaigns,
      minBid,
      maxBid,
    });

    const summary = {
      total: recommendations.length,
      shouldChange: recommendations.filter(r => r.decision.shouldChange).length,
      noChange: recommendations.filter(r => !r.decision.shouldChange).length,
      totalBidIncrease: recommendations
        .filter(r => r.decision.shouldChange && r.decision.newBid > campaigns.find(c => c.campaignId === r.campaignId)!.currentBid)
        .reduce((sum, r) => sum + (r.decision.newBid - campaigns.find(c => c.campaignId === r.campaignId)!.currentBid), 0),
      totalBidDecrease: recommendations
        .filter(r => r.decision.shouldChange && r.decision.newBid < campaigns.find(c => c.campaignId === r.campaignId)!.currentBid)
        .reduce((sum, r) => sum + (campaigns.find(c => c.campaignId === r.campaignId)!.currentBid - r.decision.newBid), 0),
    };

    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      summary,
      recommendations: recommendations.map(r => ({
        campaignId: r.campaignId,
        keyword: r.keyword,
        decision: r.decision,
        topCompetitors: r.competitors.slice(0, 5),
      })),
    };
  });

  // ═══════════════════════════════════════════════
  // KEYWORDS (whitelist / blacklist)
  // ═══════════════════════════════════════════════

  // GET /bidder/:workspaceId/keywords
  app.get<{
    Params: { workspaceId: string };
    Querystring: { listType?: string; campaignId?: string };
  }>('/bidder/:workspaceId/keywords', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const listType = request.query.listType;
    const campaignId = request.query.campaignId ? Number(request.query.campaignId) : undefined;

    let conditions = [eq(bidderKeywords.workspaceId, workspaceId)];
    if (listType) conditions.push(eq(bidderKeywords.listType, listType));
    if (campaignId) conditions.push(eq(bidderKeywords.campaignId, campaignId));

    return db
      .select()
      .from(bidderKeywords)
      .where(and(...conditions))
      .orderBy(desc(bidderKeywords.createdAt));
  });

  // POST /bidder/:workspaceId/keywords
  app.post<{
    Params: { workspaceId: string };
    Body: { 
      keyword: string;
      listType: 'whitelist' | 'blacklist';
      campaignId?: number;
      shopId?: number;
    };
    Querystring: { shopId?: string };
  }>('/bidder/:workspaceId/keywords', {
    preHandler: requireRole('manager'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { keyword, listType, campaignId } = request.body;
    const shopIdQuery = Number(request.query?.shopId);
    const shopId = request.body.shopId ?? (Number.isFinite(shopIdQuery) && shopIdQuery > 0 ? shopIdQuery : null);

    const [kw] = await db
      .insert(bidderKeywords)
      .values({
        workspaceId,
        shopId,
        keyword: keyword.toLowerCase().trim(),
        listType,
        campaignId: campaignId || null,
        source: 'manual',
      })
      .returning();

    return kw;
  });

  // POST /bidder/:workspaceId/keywords/bulk
  app.post<{
    Params: { workspaceId: string };
    Body: {
      keywords: string[];
      listType: 'whitelist' | 'blacklist';
      campaignId?: number;
      shopId?: number;
    };
    Querystring: { shopId?: string };
  }>('/bidder/:workspaceId/keywords/bulk', {
    preHandler: requireRole('manager'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { keywords, listType, campaignId } = request.body;
    const shopIdQuery = Number(request.query?.shopId);
    const shopId = request.body.shopId ?? (Number.isFinite(shopIdQuery) && shopIdQuery > 0 ? shopIdQuery : null);

    if (!keywords || keywords.length === 0) {
      return { added: 0 };
    }

    const values = keywords.map(k => ({
      workspaceId,
      shopId,
      keyword: k.toLowerCase().trim(),
      listType,
      campaignId: campaignId || null,
      source: 'manual' as const,
    }));

    const result = await db
      .insert(bidderKeywords)
      .values(values)
      .onConflictDoNothing()
      .returning();

    return { added: result.length };
  });

  // DELETE /bidder/:workspaceId/keywords/:keywordId
  app.delete<{
    Params: { workspaceId: string; keywordId: string };
  }>('/bidder/:workspaceId/keywords/:keywordId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const keywordId = Number(request.params.keywordId);

    const result = await db
      .delete(bidderKeywords)
      .where(and(
        eq(bidderKeywords.keywordId, keywordId),
        eq(bidderKeywords.workspaceId, workspaceId)
      ))
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Keyword not found' });
    }
    return { deleted: true };
  });

  // ═══════════════════════════════════════════════
  // KEYWORD AUTO-RULES
  // ═══════════════════════════════════════════════

  // GET /bidder/:workspaceId/keyword-rules
  app.get<{
    Params: { workspaceId: string };
  }>('/bidder/:workspaceId/keyword-rules', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);

    return db
      .select()
      .from(bidderKeywordAutoRules)
      .where(eq(bidderKeywordAutoRules.workspaceId, workspaceId))
      .orderBy(desc(bidderKeywordAutoRules.createdAt));
  });

  // POST /bidder/:workspaceId/keyword-rules
  app.post<{
    Params: { workspaceId: string };
    Body: {
      name: string;
      minImpressions?: number;
      minDays?: number;
      maxConversions?: number;
      maxDrrPct?: number;
      minCtrPct?: number;
      notifyOnly?: boolean;
      shopId?: number;
    };
    Querystring: { shopId?: string };
  }>('/bidder/:workspaceId/keyword-rules', {
    preHandler: requireRole('manager'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const body = request.body;
    const shopIdQuery = Number(request.query?.shopId);
    const shopId = body.shopId ?? (Number.isFinite(shopIdQuery) && shopIdQuery > 0 ? shopIdQuery : null);

    const [rule] = await db
      .insert(bidderKeywordAutoRules)
      .values({
        workspaceId,
        shopId,
        name: body.name,
        minImpressions: body.minImpressions ?? 100,
        minDays: body.minDays ?? 7,
        maxConversions: body.maxConversions ?? 0,
        maxDrrPct: body.maxDrrPct,
        minCtrPct: body.minCtrPct,
        notifyOnly: body.notifyOnly ?? false,
      })
      .returning();

    return rule;
  });

  // DELETE /bidder/:workspaceId/keyword-rules/:ruleId
  app.delete<{
    Params: { workspaceId: string; ruleId: string };
  }>('/bidder/:workspaceId/keyword-rules/:ruleId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const ruleId = Number(request.params.ruleId);

    const result = await db
      .delete(bidderKeywordAutoRules)
      .where(and(
        eq(bidderKeywordAutoRules.ruleId, ruleId),
        eq(bidderKeywordAutoRules.workspaceId, workspaceId)
      ))
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Rule not found' });
    }
    return { deleted: true };
  });

  // ═══════════════════════════════════════════════
  // ALERTS
  // ═══════════════════════════════════════════════

  // GET /bidder/:workspaceId/alerts
  app.get<{
    Params: { workspaceId: string };
    Querystring: { unreadOnly?: string; limit?: string };
  }>('/bidder/:workspaceId/alerts', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const unreadOnly = request.query.unreadOnly === 'true';
    const limit = request.query.limit ? Number(request.query.limit) : 50;

    let conditions = [eq(bidderAlerts.workspaceId, workspaceId)];
    if (unreadOnly) conditions.push(eq(bidderAlerts.isRead, false));

    return db
      .select()
      .from(bidderAlerts)
      .where(and(...conditions))
      .orderBy(desc(bidderAlerts.createdAt))
      .limit(limit);
  });

  // POST /bidder/:workspaceId/alerts/mark-read
  app.post<{
    Params: { workspaceId: string };
    Body: { alertIds: number[] };
  }>('/bidder/:workspaceId/alerts/mark-read', {
    preHandler: requireRole('manager'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { alertIds } = request.body;

    if (!alertIds || alertIds.length === 0) {
      return { updated: 0 };
    }

    const result = await db
      .update(bidderAlerts)
      .set({ isRead: true })
      .where(and(
        inArray(bidderAlerts.alertId, alertIds),
        eq(bidderAlerts.workspaceId, workspaceId)
      ))
      .returning();

    return { updated: result.length };
  });

  // ═══════════════════════════════════════════════
  // CAMPAIGN STATS (with per-product breakdown)
  // ═══════════════════════════════════════════════

  // GET /bidder/:workspaceId/campaigns/stats
  app.get<{
    Params: { workspaceId: string };
    Querystring: { advertId?: string; from?: string; to?: string; shopId?: string };
  }>('/bidder/:workspaceId/campaigns/stats', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { advertId, from, to, shopId: shopIdRaw } = request.query;
    const shopId = shopIdRaw ? Number(shopIdRaw) : undefined;

    // Get API key for this workspace (shop-scoped — WB analytics API has a
    // 3 req/min limit per token and shares the token across the whole
    // workspace when shopId is omitted, causing the UI to render a "WB API:
    // превышен лимит запросов" message for some campaigns).
    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getCampaignStats, extractProductStats, getCampaignCounts } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return { error: 'No WB API key configured for this workspace', campaigns: [] };
    }

    // Default date range: last 7 days
    const today = new Date();
    const dateTo = to || today.toISOString().slice(0, 10);
    const dateFrom = from || new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // 60s in-process cache to damp WB 3-req/min rate-limit bursts.
    // Key by (workspace, shop, advertId, date-range) so distinct campaigns
    // don't collide; TTL kept short enough that the UI still sees fresh
    // data after a user-initiated reload.
    const cacheKey = `stats:${workspaceId}:${shopId ?? 'ws'}:${advertId ?? 'all'}:${dateFrom}:${dateTo}`;
    const cached = campaignStatsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60_000) {
      return cached.payload;
    }

    try {
      // If specific advertId requested
      if (advertId) {
        const stats = await getCampaignStats(apiKey, Number(advertId), dateFrom, dateTo);
        
        // Extract per-product stats
        const result = stats.map((campaign) => ({
          advertId: campaign.advertId,
          days: campaign.days.map((day) => ({
            date: day.date,
            totals: {
              sum: day.sum,
              views: day.views,
              clicks: day.clicks,
              atbs: day.atbs,
              orders: day.orders,
              sum_price: day.sum_price,
            },
            products: extractProductStats(day),
          })),
        }));

        const payload = { campaigns: result };
        campaignStatsCache.set(cacheKey, { at: Date.now(), payload });
        return payload;
      }

      // Get all active campaigns from DB (faster than API call)
      const dbCampaigns = await getCampaignsFromDb(workspaceId, {});
      const activeAdverts = dbCampaigns
        .filter(c => c.status === 9 || c.status === 11)
        .map(c => c.campaignId);

      if (activeAdverts.length === 0) {
        return { campaigns: [], total: 0, fetched: 0 };
      }

      // v3 API supports multiple IDs in a single request
      const limitedAdverts = activeAdverts.slice(0, 50);
      try {
        const stats = await getCampaignStats(apiKey, limitedAdverts, dateFrom, dateTo);
        const allStats = stats.map((campaign) => ({
          advertId: campaign.advertId,
          days: (campaign.days || []).map((day) => ({
            date: day.date,
            totals: {
              sum: day.sum,
              views: day.views,
              clicks: day.clicks,
              atbs: day.atbs,
              orders: day.orders,
              sum_price: day.sum_price,
            },
            products: extractProductStats(day),
          })),
        }));

        const payload = {
          campaigns: allStats,
          total: activeAdverts.length,
          fetched: limitedAdverts.length,
        };
        campaignStatsCache.set(cacheKey, { at: Date.now(), payload });
        return payload;
      } catch (e: any) {
        logger.error({ err: e }, 'Failed to get campaign stats');
        return { campaigns: [], total: activeAdverts.length, fetched: 0, error: e.message };
      }
    } catch (e: any) {
      return { error: e.message, campaigns: [] };
    }
  });

  // ─────────────────────────────────────────────
  // GET /bidder/:workspaceId/campaigns
  // List all synced campaigns from DB
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
    Querystring: { status?: string; shopId?: string };
  }>('/bidder/:workspaceId/campaigns', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const status = request.query.status ? Number(request.query.status) : undefined;
    const shopId = request.query.shopId ? Number(request.query.shopId) : undefined;

    const campaigns = await getCampaignsFromDb(workspaceId, { status, shopId });

    return {
      campaigns,
      total: campaigns.length,
      statusCounts: {
        active: campaigns.filter(c => c.status === 9).length,
        paused: campaigns.filter(c => c.status === 11).length,
        ready: campaigns.filter(c => c.status === 4).length,
        finished: campaigns.filter(c => c.status === 7).length,
      },
    };
  });

  // ─────────────────────────────────────────────
  // POST /bidder/:workspaceId/campaigns/sync
  // Sync campaigns from WB API
  // ─────────────────────────────────────────────
  app.post<{
    Params: { workspaceId: string };
    Body: { shopId?: number };
  }>('/bidder/:workspaceId/campaigns/sync', {
    preHandler: requireRole('manager'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const shopId = request.body?.shopId;

    const result = await syncCampaigns(workspaceId, shopId);

    return {
      ok: result.errors.length === 0,
      ...result,
    };
  });

  // ═══════════════════════════════════════════════
  // NORMQUERY CLUSTERS (Поисковые кластеры)
  // ═══════════════════════════════════════════════

  // GET /bidder/:workspaceId/campaigns/:advertId/clusters
  // List normquery clusters for a campaign
  app.get<{
    Params: { workspaceId: string; advertId: string };
    Querystring: { active?: string };
  }>('/bidder/:workspaceId/campaigns/:advertId/clusters', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);
    const active = request.query.active === 'true' ? true : request.query.active === 'false' ? false : undefined;

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getNormqueryList } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) {
      return { error: 'No WB API key configured', clusters: [] };
    }

    // Get nmIds from DB for this campaign.
    // SECURITY: filter by workspaceId so a manager from tenant A can't query
    // tenant B's advert nmId list by guessing advertId.
    let nmIds: number[] = [];
    try {
      const [campaign] = await db
        .select({ nmIds: wbCampaigns.nmIds })
        .from(wbCampaigns)
        .where(and(
          eq(wbCampaigns.campaignId, advertId),
          eq(wbCampaigns.workspaceId, workspaceId)
        ))
        .limit(1);
      if (campaign?.nmIds && Array.isArray(campaign.nmIds)) {
        nmIds = campaign.nmIds as number[];
      }
    } catch (err) { app.log.error({ err }, 'bidder operation failed'); }

    try {
      const clusters = await getNormqueryList(apiKey, advertId, active, nmIds);
      return { clusters, total: clusters.length };
    } catch (e: any) {
      return { error: e.message, clusters: [] };
    }
  });

  // GET /bidder/:workspaceId/campaigns/:advertId/clusters/bids
  // Get bids for normquery clusters
  app.get<{
    Params: { workspaceId: string; advertId: string };
  }>('/bidder/:workspaceId/campaigns/:advertId/clusters/bids', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getNormqueryBids } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) {
      return { error: 'No WB API key configured', bids: [] };
    }

    try {
      const bids = await getNormqueryBids(apiKey, advertId);
      return { bids };
    } catch (e: any) {
      return { error: e.message, bids: [] };
    }
  });

  // POST /bidder/:workspaceId/campaigns/:advertId/clusters/bids
  // Set bids for normquery clusters
  app.post<{
    Params: { workspaceId: string; advertId: string };
    Body: { bids: Array<{ cluster: number; bid: number }> };
  }>('/bidder/:workspaceId/campaigns/:advertId/clusters/bids', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);
    const { bids } = request.body;

    if (!bids || !Array.isArray(bids) || bids.length === 0) {
      return reply.code(400).send({ error: 'bids array is required', ok: false });
    }

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { setNormqueryBids } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', ok: false });
    }

    try {
      await setNormqueryBids(apiKey, advertId, bids);
      return { ok: true, updated: bids.length };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });

  // DELETE /bidder/:workspaceId/campaigns/:advertId/clusters/bids
  // Reset bids for normquery clusters
  app.delete<{
    Params: { workspaceId: string; advertId: string };
    Body: { clusters: number[] };
  }>('/bidder/:workspaceId/campaigns/:advertId/clusters/bids', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);
    const { clusters } = request.body;

    if (!clusters || !Array.isArray(clusters) || clusters.length === 0) {
      return reply.code(400).send({ error: 'clusters array is required', ok: false });
    }

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { deleteNormqueryBids } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', ok: false });
    }

    try {
      await deleteNormqueryBids(apiKey, advertId, clusters);
      return { ok: true, reset: clusters.length };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });

  // GET /bidder/:workspaceId/campaigns/:advertId/clusters/minus
  // Get minus phrases for normquery
  app.get<{
    Params: { workspaceId: string; advertId: string };
  }>('/bidder/:workspaceId/campaigns/:advertId/clusters/minus', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getNormqueryMinus } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) {
      return { error: 'No WB API key configured', excluded: [] };
    }

    try {
      const excluded = await getNormqueryMinus(apiKey, advertId);
      return { excluded, total: excluded.length };
    } catch (e: any) {
      return { error: e.message, excluded: [] };
    }
  });

  // POST /bidder/:workspaceId/campaigns/:advertId/clusters/minus
  // Set minus phrases for normquery
  app.post<{
    Params: { workspaceId: string; advertId: string };
    Body: { excluded: string[] };
  }>('/bidder/:workspaceId/campaigns/:advertId/clusters/minus', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);
    const { excluded } = request.body;

    if (!excluded || !Array.isArray(excluded)) {
      return reply.code(400).send({ error: 'excluded array is required', ok: false });
    }

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { setNormqueryMinus } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', ok: false });
    }

    try {
      await setNormqueryMinus(apiKey, advertId, excluded);
      return { ok: true, set: excluded.length };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });

  // GET /bidder/:workspaceId/campaigns/:advertId/clusters/stats
  // Get cluster statistics
  app.get<{
    Params: { workspaceId: string; advertId: string };
    Querystring: { from?: string; to?: string; byDay?: string };
  }>('/bidder/:workspaceId/campaigns/:advertId/clusters/stats', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);
    const byDay = request.query.byDay === 'true';

    const today = new Date();
    const dateTo = request.query.to || today.toISOString().slice(0, 10);
    const dateFrom = request.query.from || new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getNormqueryStats, getNormqueryStatsByDay } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) {
      return { error: 'No WB API key configured', stats: [] };
    }

    try {
      if (byDay) {
        const stats = await getNormqueryStatsByDay(apiKey, advertId, dateFrom, dateTo);
        return { stats, dateFrom, dateTo };
      } else {
        const stats = await getNormqueryStats(apiKey, advertId, dateFrom, dateTo);
        return { stats, dateFrom, dateTo };
      }
    } catch (e: any) {
      return { error: e.message, stats: [] };
    }
  });

  // =========================================================================
  // CAMPAIGN CREATION
  // =========================================================================

  // POST /bidder/:workspaceId/campaigns/create
  // Create a new advertising campaign
  app.post<{
    Params: { workspaceId: string };
    Body: {
      type: 'auction' | 'auto' | 'search' | 'catalog';
      name: string;
      dailyBudget?: number;
      nmIds: number[];
      subjectId?: number;
      cpm?: number;
    };
  }>('/bidder/:workspaceId/campaigns/create', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const { type, name, dailyBudget, nmIds, subjectId, cpm } = request.body;

    if (!name || !nmIds?.length) {
      return reply.code(400).send({ error: 'name and nmIds are required', ok: false });
    }

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { createCampaign } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', ok: false });
    }

    try {
      const result = await createCampaign(apiKey, {
        type,
        name,
        dailyBudget,
        nmIds,
        subjectId,
        cpm,
      });

      // Sync campaigns to update local DB
      await syncCampaigns(workspaceId);

      return { ok: true, advertId: result.advertId };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      return reply.code(502).send({ error: msg, ok: false });
    }
  });

  // GET /bidder/:workspaceId/campaigns/types
  // Get available campaign types
  app.get<{
    Params: { workspaceId: string };
  }>('/bidder/:workspaceId/campaigns/types', {
    preHandler: requireRole('viewer'),
  }, async () => {
    const { getCampaignTypes } = await import('../integrations/wb/advert.js');
    return { types: getCampaignTypes() };
  });

  // =========================================================================
  // CAMPAIGN CONTROL (start / pause / stop)
  // =========================================================================

  // POST /bidder/:workspaceId/campaigns/:advertId/start
  app.post<{
    Params: { workspaceId: string; advertId: string };
  }>('/bidder/:workspaceId/campaigns/:advertId/start', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { startCampaign } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) return reply.code(400).send({ error: 'No WB API key configured', ok: false });

    try {
      await startCampaign(apiKey, advertId);
      // Update local DB status — workspaceId in WHERE is defence-in-depth
      // against a tenant accidentally flipping a sibling tenant's campaign row.
      await db.update(wbCampaigns).set({ status: 9, updatedAt: new Date() })
        .where(and(eq(wbCampaigns.campaignId, advertId), eq(wbCampaigns.workspaceId, workspaceId)));
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      // WB returns "Not Found: advert not found" → 404; everything else from WB → 502 (bad gateway).
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });

  // POST /bidder/:workspaceId/campaigns/:advertId/pause
  app.post<{
    Params: { workspaceId: string; advertId: string };
  }>('/bidder/:workspaceId/campaigns/:advertId/pause', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { pauseCampaign } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) return reply.code(400).send({ error: 'No WB API key configured', ok: false });

    try {
      await pauseCampaign(apiKey, advertId);
      await db.update(wbCampaigns).set({ status: 11, updatedAt: new Date() })
        .where(and(eq(wbCampaigns.campaignId, advertId), eq(wbCampaigns.workspaceId, workspaceId)));
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });

  // POST /bidder/:workspaceId/campaigns/:advertId/stop
  app.post<{
    Params: { workspaceId: string; advertId: string };
  }>('/bidder/:workspaceId/campaigns/:advertId/stop', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { stopCampaign } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) return reply.code(400).send({ error: 'No WB API key configured', ok: false });

    try {
      await stopCampaign(apiKey, advertId);
      await db.update(wbCampaigns).set({ status: 7, updatedAt: new Date() })
        .where(and(eq(wbCampaigns.campaignId, advertId), eq(wbCampaigns.workspaceId, workspaceId)));
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });

  // GET /bidder/:workspaceId/campaigns/:advertId/budget
  app.get<{
    Params: { workspaceId: string; advertId: string };
  }>('/bidder/:workspaceId/campaigns/:advertId/budget', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getCampaignBudget } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) return { error: 'No WB API key configured' };

    try {
      const budget = await getCampaignBudget(apiKey, advertId);
      return { ok: true, ...budget };
    } catch (e: any) {
      return { error: e.message, ok: false };
    }
  });

  // GET /bidder/:workspaceId/campaigns/:advertId/fullstats
  // Get full campaign stats with aggregated totals for the period
  app.get<{
    Params: { workspaceId: string; advertId: string };
    Querystring: { from?: string; to?: string };
  }>('/bidder/:workspaceId/campaigns/:advertId/fullstats', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);

    const today = new Date();
    const dateTo = request.query.to || today.toISOString().slice(0, 10);
    const dateFrom = request.query.from || new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getCampaignStats, extractProductStats } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) return { error: 'No WB API key configured', ok: false };

    try {
      const stats = await getCampaignStats(apiKey, advertId, dateFrom, dateTo);

      // Aggregate totals across all days
      let totalViews = 0, totalClicks = 0, totalOrders = 0, totalSpend = 0, totalRevenue = 0, totalAtbs = 0;
      const days: any[] = [];

      for (const campaign of stats) {
        for (const day of campaign.days) {
          totalViews += day.views || 0;
          totalClicks += day.clicks || 0;
          totalOrders += day.orders || 0;
          totalSpend += day.sum || 0;
          totalRevenue += day.sum_price || 0;
          totalAtbs += day.atbs || 0;
          days.push({
            date: day.date,
            views: day.views || 0,
            clicks: day.clicks || 0,
            orders: day.orders || 0,
            spend: day.sum || 0,
            revenue: day.sum_price || 0,
            atbs: day.atbs || 0,
            ctr: day.views > 0 ? ((day.clicks || 0) / day.views * 100) : 0,
            cpc: day.clicks > 0 ? ((day.sum || 0) / day.clicks) : 0,
            drr: day.sum_price > 0 ? ((day.sum || 0) / day.sum_price * 100) : 0,
          });
        }
      }

      const ctr = totalViews > 0 ? (totalClicks / totalViews * 100) : 0;
      const cpc = totalClicks > 0 ? (totalSpend / totalClicks) : 0;
      const drr = totalRevenue > 0 ? (totalSpend / totalRevenue * 100) : 0;
      const cr = totalClicks > 0 ? (totalOrders / totalClicks * 100) : 0;

      return {
        ok: true,
        dateFrom,
        dateTo,
        totals: {
          views: totalViews,
          clicks: totalClicks,
          orders: totalOrders,
          spend: Math.round(totalSpend * 100) / 100,
          revenue: Math.round(totalRevenue * 100) / 100,
          atbs: totalAtbs,
          ctr: Math.round(ctr * 100) / 100,
          cpc: Math.round(cpc * 100) / 100,
          drr: Math.round(drr * 100) / 100,
          cr: Math.round(cr * 100) / 100,
        },
        days,
      };
    } catch (e: any) {
      return { error: e.message, ok: false };
    }
  });

  // =========================================================================
  // CAMPAIGN PRODUCTS (товары с ставками)
  // =========================================================================

  // GET /bidder/:workspaceId/campaigns/:advertId/products
  app.get<{
    Params: { workspaceId: string; advertId: string };
  }>('/bidder/:workspaceId/campaigns/:advertId/products', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getCampaignProducts, getCampaignStats, getMinBids } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) return { error: 'No WB API key configured', products: [] };

    try {
      // Get products with bids
      const products = await getCampaignProducts(apiKey, advertId);
      const nmIds = products.map(p => p.nmId);

      // Get min bids
      let minBids: Record<number, number> = {};
      if (nmIds.length > 0) {
        try {
          const minBidResult = await getMinBids(apiKey, advertId, nmIds);
          for (const b of (minBidResult as any)?.bids || []) {
            minBids[b.nmId] = b.bid;
          }
        } catch (err) { app.log.error({ err }, 'bidder operation failed'); }
      }

      // Get stats for last 14 days
      const today = new Date();
      const dateTo = today.toISOString().slice(0, 10);
      const dateFrom = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      let productStats: Record<number, { views: number; clicks: number; orders: number; spend: number }> = {};
      try {
        const stats = await getCampaignStats(apiKey, advertId, dateFrom, dateTo);
        for (const campaign of stats) {
          for (const day of campaign.days) {
            const apps = (day as any).apps || (day as any).nm || [];
            for (const app of apps) {
              const nmId = app.nmId || app.nm_id;
              if (!productStats[nmId]) {
                productStats[nmId] = { views: 0, clicks: 0, orders: 0, spend: 0 };
              }
              productStats[nmId].views += app.views || 0;
              productStats[nmId].clicks += app.clicks || 0;
              productStats[nmId].orders += app.orders || 0;
              productStats[nmId].spend += app.sum || 0;
            }
          }
        }
      } catch (err) { app.log.error({ err }, 'bidder operation failed'); }

      // Get product info from wbCards
      const { wbCards } = await import('../db/schema.js');
      const cardsData = nmIds.length > 0 ? await db
        .select({
          nmId: wbCards.nmId,
          vendorCode: wbCards.vendorCode,
          title: wbCards.title,
          photoUrl: wbCards.mainPhotoUrl,
        })
        .from(wbCards)
        .where(inArray(wbCards.nmId, nmIds)) : [];
      const cardsMap: Record<number, any> = {};
      for (const c of cardsData) {
        cardsMap[c.nmId] = c;
      }

      // Combine data
      const result = products.map(p => {
        const stats = productStats[p.nmId] || { views: 0, clicks: 0, orders: 0, spend: 0 };
        const card = cardsMap[p.nmId] || {};
        const ctr = stats.views > 0 ? (stats.clicks / stats.views * 100) : 0;
        const drr = stats.spend > 0 && stats.orders > 0 ? 0 : 0; // need revenue for DRR
        return {
          nmId: p.nmId,
          vendorCode: card.vendorCode || null,
          title: card.title || null,
          photoUrl: card.mainPhotoUrl || null,
          bid: p.bid,
          minBid: minBids[p.nmId] || null,
          views: stats.views,
          clicks: stats.clicks,
          orders: stats.orders,
          spend: stats.spend,
          ctr: Math.round(ctr * 100) / 100,
          drr: 0,
        };
      });

      return { products: result };
    } catch (e: any) {
      return { error: e.message, products: [] };
    }
  });

  // PATCH /bidder/:workspaceId/campaigns/:advertId/bids
  // Set bids for products in campaign
  app.patch<{
    Params: { workspaceId: string; advertId: string };
    Body: { bids: Array<{ nmId: number; bid: number; placement?: string }> };
  }>('/bidder/:workspaceId/campaigns/:advertId/bids', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);
    const { bids } = request.body;

    if (!bids || !Array.isArray(bids) || bids.length === 0) {
      return reply.code(400).send({ error: 'bids array is required', ok: false });
    }

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { setBids } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) return reply.code(400).send({ error: 'No WB API key configured', ok: false });

    try {
      const bidRequests = bids.map(b => ({
        advertId,
        nmId: b.nmId,
        bid: b.bid,
        placement: (b.placement || 'combined') as 'combined' | 'search' | 'recommendations',
      }));
      await setBids(apiKey, bidRequests);
      return { ok: true, updated: bids.length };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });

  // =========================================================================
  // CAMPAIGN KEYWORDS (ключевые слова)
  // =========================================================================

  // GET /bidder/:workspaceId/campaigns/:advertId/keywords
  app.get<{
    Params: { workspaceId: string; advertId: string };
  }>('/bidder/:workspaceId/campaigns/:advertId/keywords', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getNormqueryList, getNormqueryMinus, getNormqueryStats } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) return { error: 'No WB API key configured', keywords: [], excluded: [] };

    // Get nmIds from DB.
    // SECURITY: filter by workspaceId to prevent cross-tenant nmId list leak
    // via a guessed advertId.
    let nmIds: number[] = [];
    try {
      const [campaign] = await db
        .select({ nmIds: wbCampaigns.nmIds })
        .from(wbCampaigns)
        .where(and(
          eq(wbCampaigns.campaignId, advertId),
          eq(wbCampaigns.workspaceId, workspaceId)
        ))
        .limit(1);
      if (campaign?.nmIds && Array.isArray(campaign.nmIds)) {
        nmIds = campaign.nmIds as number[];
      }
    } catch (err) { app.log.error({ err }, 'bidder operation failed'); }

    try {
      // Get clusters
      const clusters = await getNormqueryList(apiKey, advertId, undefined, nmIds);
      
      // Get minus phrases
      const excluded = await getNormqueryMinus(apiKey, advertId);

      // Get stats for keywords
      const today = new Date();
      const dateTo = today.toISOString().slice(0, 10);
      const dateFrom = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      
      let stats: Record<string, any> = {};
      try {
        const kwStats = await getNormqueryStats(apiKey, advertId, dateFrom, dateTo);
        for (const s of kwStats) {
          stats[s.phrase?.toLowerCase()] = s;
        }
      } catch (err) { app.log.error({ err }, 'bidder operation failed'); }

      // Map clusters to keywords with stats
      const keywords = clusters
        .filter(c => !c.excluded)
        .map(c => {
          const s = stats[c.phrase?.toLowerCase()] || {};
          return {
            phrase: c.phrase,
            views: s.views || c.views || 0,
            clicks: s.clicks || c.clicks || 0,
            ctr: s.ctr || c.ctr || 0,
            orders: s.orders || c.orders || 0,
            spend: s.sum || c.sum || 0,
            isExcluded: false,
          };
        });

      return { keywords, excluded };
    } catch (e: any) {
      return { error: e.message, keywords: [], excluded: [] };
    }
  });

  // POST /bidder/:workspaceId/campaigns/:advertId/minus-phrases
  app.post<{
    Params: { workspaceId: string; advertId: string };
    Body: { phrases: string[] };
  }>('/bidder/:workspaceId/campaigns/:advertId/minus-phrases', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);
    const { phrases } = request.body;

    if (!phrases || !Array.isArray(phrases)) {
      return reply.code(400).send({ error: 'phrases array is required', ok: false });
    }

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { setMinusPhrases } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) return reply.code(400).send({ error: 'No WB API key configured', ok: false });

    try {
      await setMinusPhrases(apiKey, advertId, phrases);
      return { ok: true, set: phrases.length };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });

  // =========================================================================
  // CAMPAIGN FINANCE
  // =========================================================================

  // GET /bidder/:workspaceId/campaigns/:advertId/finance
  app.get<{
    Params: { workspaceId: string; advertId: string };
  }>('/bidder/:workspaceId/campaigns/:advertId/finance', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getAdvertBalance, getCampaignBudget, getCampaignStats } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) return { error: 'No WB API key configured' };

    try {
      // Get balance
      let balance = 0;
      try {
        const balanceData = await getAdvertBalance(apiKey);
        balance = balanceData.balance || 0;
      } catch (err) { app.log.error({ err }, 'bidder operation failed'); }

      // Get budget
      let dailyLimit = 0;
      try {
        const budgetData = await getCampaignBudget(apiKey, advertId);
        dailyLimit = budgetData.dailyBudget || 0;
      } catch (err) { app.log.error({ err }, 'bidder operation failed'); }

      // Get stats for spending
      const today = new Date();
      const todayStr = today.toISOString().slice(0, 10);
      const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      let todaySpend = 0, weekSpend = 0, monthSpend = 0, monthRevenue = 0;
      try {
        const stats = await getCampaignStats(apiKey, advertId, monthAgo, todayStr);
        for (const campaign of stats) {
          for (const day of campaign.days) {
            const spend = day.sum || 0;
            const revenue = day.sum_price || 0;
            monthSpend += spend;
            monthRevenue += revenue;
            if (day.date === todayStr) todaySpend = spend;
            if (day.date >= weekAgo) weekSpend += spend;
          }
        }
      } catch (err) { app.log.error({ err }, 'bidder operation failed'); }

      const monthDrr = monthRevenue > 0 ? (monthSpend / monthRevenue * 100) : 0;
      const profitEstimate = monthRevenue * 0.25 - monthSpend; // rough margin estimate

      return {
        balance,
        dailyLimit,
        todaySpend,
        weekSpend,
        monthSpend,
        monthRevenue,
        monthDrr: Math.round(monthDrr * 10) / 10,
        profitEstimate: Math.round(profitEstimate),
      };
    } catch (e: any) {
      return { error: e.message };
    }
  });

  // PATCH /bidder/:workspaceId/campaigns/:advertId/budget
  // Set daily budget
  app.patch<{
    Params: { workspaceId: string; advertId: string };
    Body: { dailyLimit: number };
  }>('/bidder/:workspaceId/campaigns/:advertId/budget', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);
    const { dailyLimit } = request.body;

    if (dailyLimit === undefined || dailyLimit < 0) {
      return reply.code(400).send({ error: 'dailyLimit is required', ok: false });
    }

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { setCampaignDailyBudget } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) return reply.code(400).send({ error: 'No WB API key configured', ok: false });

    try {
      await setCampaignDailyBudget(apiKey, advertId, dailyLimit);
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });

  // GET /bidder/:workspaceId/campaigns/:advertId/stats
  // Get campaign stats with per-product breakdown
  app.get<{
    Params: { workspaceId: string; advertId: string };
    Querystring: { from?: string; to?: string };
  }>('/bidder/:workspaceId/campaigns/:advertId/stats', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const advertId = Number(request.params.advertId);

    const today = new Date();
    const dateTo = request.query.to || today.toISOString().slice(0, 10);
    const dateFrom = request.query.from || new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
    const { getCampaignStats, extractProductStats } = await import('../integrations/wb/advert.js');

    const apiKey = await getWbApiKey(workspaceId, Number((request.query as any)?.shopId) || undefined);
    if (!apiKey) return { error: 'No WB API key configured' };

    try {
      const stats = await getCampaignStats(apiKey, advertId, dateFrom, dateTo);

      // Aggregate
      let totalViews = 0, totalClicks = 0, totalOrders = 0, totalSpend = 0, totalRevenue = 0;
      const days: any[] = [];
      const productTotals: Record<number, any> = {};

      for (const campaign of stats) {
        for (const day of campaign.days) {
          totalViews += day.views || 0;
          totalClicks += day.clicks || 0;
          totalOrders += day.orders || 0;
          totalSpend += day.sum || 0;
          totalRevenue += day.sum_price || 0;

          days.push({
            date: day.date,
            views: day.views || 0,
            clicks: day.clicks || 0,
            orders: day.orders || 0,
            spend: day.sum || 0,
            revenue: day.sum_price || 0,
            ctr: day.views > 0 ? ((day.clicks || 0) / day.views * 100) : 0,
            cpc: day.clicks > 0 ? ((day.sum || 0) / day.clicks) : 0,
            drr: day.sum_price > 0 ? ((day.sum || 0) / day.sum_price * 100) : 0,
          });

          // Per-product stats
          const products = extractProductStats(day);
          for (const p of products) {
            if (!productTotals[p.nmId]) {
              productTotals[p.nmId] = { nmId: p.nmId, views: 0, clicks: 0, orders: 0, spend: 0 };
            }
            productTotals[p.nmId].views += p.views;
            productTotals[p.nmId].clicks += p.clicks;
            productTotals[p.nmId].orders += p.orders;
            productTotals[p.nmId].spend += p.sum;
          }
        }
      }

      const ctr = totalViews > 0 ? (totalClicks / totalViews * 100) : 0;
      const cpc = totalClicks > 0 ? (totalSpend / totalClicks) : 0;
      const drr = totalRevenue > 0 ? (totalSpend / totalRevenue * 100) : 0;
      const cr = totalClicks > 0 ? (totalOrders / totalClicks * 100) : 0;

      // Get product info
      const nmIds = Object.keys(productTotals).map(Number);
      let cardsMap: Record<number, any> = {};
      if (nmIds.length > 0) {
        const { wbCards } = await import('../db/schema.js');
        const cardsData = await db
          .select({ nmId: wbCards.nmId, vendorCode: wbCards.vendorCode })
          .from(wbCards)
          .where(inArray(wbCards.nmId, nmIds));
        for (const c of cardsData) {
          cardsMap[c.nmId] = c;
        }
      }

      const byProduct = Object.values(productTotals).map((p: any) => {
        const card = cardsMap[p.nmId] || {};
        return {
          nmId: p.nmId,
          vendorCode: card.vendorCode || null,
          views: p.views,
          clicks: p.clicks,
          orders: p.orders,
          spend: p.spend,
          ctr: p.views > 0 ? Math.round((p.clicks / p.views * 100) * 100) / 100 : 0,
          drr: 0,
        };
      });

      return {
        totals: {
          views: totalViews,
          clicks: totalClicks,
          orders: totalOrders,
          spend: Math.round(totalSpend * 100) / 100,
          revenue: Math.round(totalRevenue * 100) / 100,
          ctr: Math.round(ctr * 100) / 100,
          cpc: Math.round(cpc * 100) / 100,
          drr: Math.round(drr * 100) / 100,
          cr: Math.round(cr * 100) / 100,
        },
        days,
        byProduct,
      };
    } catch (e: any) {
      return { error: e.message };
    }
  });
};
