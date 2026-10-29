/**
 * Pricing Engine routes.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { pricingStrategies, pricingDecisions } from '../db/schema.js';
import { eq, and, desc, count } from 'drizzle-orm';
import { requireRole } from '../plugins/roleCheck.js';
import { buildShopFilter } from './pulse/helpers.js';

export const pricingEngineRoutes: FastifyPluginAsync = async (app) => {
  // List strategies
  app.get('/pricing/strategies', { preHandler: requireRole('viewer') }, async (req) => {
    const q = z.object({
      workspaceId: z.coerce.number().int().positive(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const shopFilter = buildShopFilter(pricingStrategies.shopId, q.shopId);
    const conds = [eq(pricingStrategies.workspaceId, q.workspaceId), eq(pricingStrategies.isActive, true)];
    if (shopFilter) conds.push(shopFilter);

    const strats = await db.select().from(pricingStrategies)
      .where(and(...conds))
      .orderBy(pricingStrategies.nmId);

    return { strategies: strats };
  });

  // Create/update strategy
  app.post('/pricing/strategies', { preHandler: requireRole('manager') }, async (req) => {
    const q = z.object({
      workspaceId: z.coerce.number().int().positive(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);
    const body = z.object({
      nmId: z.number(),
      shopId: z.coerce.number().int().positive().optional(),
      strategyType: z.enum([
        'maximize_profit', 'hold_supply', 'demand_up', 'demand_down',
        'turnover', 'negative_reviews', 'atc_optimize', 'aggressive_sale', 'oos_protection',
      ]),
      config: z.record(z.string(), z.unknown()).optional().default({}),
    }).parse(req.body);

    const shopId = body.shopId ?? q.shopId ?? null;

    const [strat] = await db.insert(pricingStrategies).values({
      workspaceId: q.workspaceId,
      shopId,
      nmId: body.nmId,
      strategyType: body.strategyType,
      config: body.config,
    }).onConflictDoUpdate({
      target: [pricingStrategies.workspaceId, pricingStrategies.nmId, pricingStrategies.strategyType],
      set: { config: body.config, isActive: true, shopId, updatedAt: new Date() },
    }).returning();

    return { strategy: strat };
  });

  // Delete strategy
  app.delete('/pricing/strategies/:id', { preHandler: requireRole('manager') }, async (req) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const stratId = Number((req.params as any).id);

    await db.update(pricingStrategies)
      .set({ isActive: false })
      .where(and(eq(pricingStrategies.strategyId, stratId), eq(pricingStrategies.workspaceId, wsId)));

    return { ok: true };
  });

  // List decisions (paginated)
  app.get('/pricing/decisions', { preHandler: requireRole('viewer') }, async (req) => {
    const q = z.object({
      workspaceId: z.coerce.number().int().positive(),
      shopId: z.coerce.number().int().positive().optional(),
      offset: z.coerce.number().int().min(0).optional().default(0),
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    }).parse(req.query);

    const shopFilter = buildShopFilter(pricingDecisions.shopId, q.shopId);
    const conds = [eq(pricingDecisions.workspaceId, q.workspaceId)];
    if (shopFilter) conds.push(shopFilter);

    const [totalRow] = await db.select({ count: count() }).from(pricingDecisions)
      .where(and(...conds));

    const decisions = await db.select().from(pricingDecisions)
      .where(and(...conds))
      .orderBy(desc(pricingDecisions.createdAt))
      .offset(q.offset)
      .limit(q.limit);

    return { decisions, total: totalRow.count, offset: q.offset, limit: q.limit };
  });

  // Evaluate pricing for a product
  app.post('/pricing/evaluate', { preHandler: requireRole('manager') }, async (req) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const body = z.object({
      nmId: z.number(),
      currentPriceKop: z.number(),
    }).parse(req.body);

    const { evaluateProductPricing } = await import('../services/pricingEngine/index.js');
    const evaluations = await evaluateProductPricing(wsId, body.nmId, body.currentPriceKop);
    return { evaluations };
  });
};
