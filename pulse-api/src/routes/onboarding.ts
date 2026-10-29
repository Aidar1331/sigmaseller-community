import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { marketplaceShops, wbCards, wbFunnelDaily, wbSyncRuns } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';

export const onboardingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/onboarding/:workspaceId/status', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const shops = await db
      .select({ shopId: marketplaceShops.shopId })
      .from(marketplaceShops)
      .where(and(eq(marketplaceShops.workspaceId, params.workspaceId), eq(marketplaceShops.platform, 'wb'), eq(marketplaceShops.isActive, true)))
      .limit(1);

    if (!shops.length) {
      return { workspaceId: params.workspaceId, status: 'no_shop' } as const;
    }

    const runs = await db
      .select()
      .from(wbSyncRuns)
      .where(eq(wbSyncRuns.workspaceId, params.workspaceId))
      .orderBy(desc(wbSyncRuns.createdAt))
      .limit(1);

    const [cardsRow] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(wbCards)
      .where(eq(wbCards.workspaceId, params.workspaceId));

    const [funnelRow] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(wbFunnelDaily)
      .where(and(eq(wbFunnelDaily.workspaceId, params.workspaceId), eq(wbFunnelDaily.source, 'products')));

    const run = runs[0] ?? null;
    const cardsCount = cardsRow?.count ?? 0;
    const funnelCount = funnelRow?.count ?? 0;

    const hasData = cardsCount > 0 || funnelCount > 0;
    const stage = run?.stage ?? (hasData ? 'done' : 'queued');

    if (stage === 'done' || stage === 'completed') {
      return { workspaceId: params.workspaceId, status: 'ready', stage, cardsCount, funnelCount, run } as const;
    }

    return { workspaceId: params.workspaceId, status: 'syncing', stage, cardsCount, funnelCount, run } as const;
  });
};
