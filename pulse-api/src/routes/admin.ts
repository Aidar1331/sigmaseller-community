import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  aiUsageEvents,
  workspaces,
  workspacePayments,
  workspaceSubscriptions,
  users,
  workspaceMembers,
} from '../db/schema.js';
import { listProviderSettingsForAdmin, upsertProviderSettings } from '../services/aiSettings.js';
import { requireAdmin } from '../plugins/roleCheck.js';

function escapeIlike(input: string): string {
  return input.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get('/admin/overview', { preHandler: requireAdmin() },async () => {

    const now = new Date();

    const [workspacesRow] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(workspaces);

    const [subsRow] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(workspaceSubscriptions);

    const [activeRow] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(workspaceSubscriptions)
      .where(and(eq(workspaceSubscriptions.status, 'active'), gt(workspaceSubscriptions.currentPeriodEnd, now)));

    const [paymentsRow] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(workspacePayments);

    const [paymentsSumRow] = await db
      .select({ sum: sql<number>`coalesce(sum(${workspacePayments.amountKopecks}),0)`.mapWith(Number) })
      .from(workspacePayments);

    return {
      workspaces: workspacesRow?.count ?? 0,
      subscriptions: subsRow?.count ?? 0,
      subscriptionsActive: activeRow?.count ?? 0,
      payments: paymentsRow?.count ?? 0,
      paymentsSumKopecks: paymentsSumRow?.sum ?? 0,
    };
  });

  app.get('/admin/subscriptions', { preHandler: requireAdmin() },async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().positive().max(200).optional(),
        offset: z.coerce.number().int().nonnegative().optional(),
        status: z.string().optional(),
        workspaceId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);

    const where: any[] = [];
    if (q.status) where.push(eq(workspaceSubscriptions.status, q.status));
    if (q.workspaceId) where.push(eq(workspaceSubscriptions.workspaceId, q.workspaceId));

    const rows = await db
      .select({
        workspaceId: workspaceSubscriptions.workspaceId,
        status: workspaceSubscriptions.status,
        planCode: workspaceSubscriptions.planCode,
        currentPeriodStart: workspaceSubscriptions.currentPeriodStart,
        currentPeriodEnd: workspaceSubscriptions.currentPeriodEnd,
        autoRenew: workspaceSubscriptions.autoRenew,
        cancelAtPeriodEnd: workspaceSubscriptions.cancelAtPeriodEnd,
        createdAt: workspaceSubscriptions.createdAt,
        updatedAt: workspaceSubscriptions.updatedAt,
        workspaceName: workspaces.name,
      })
      .from(workspaceSubscriptions)
      .leftJoin(workspaces, eq(workspaces.workspaceId, workspaceSubscriptions.workspaceId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(workspaceSubscriptions.updatedAt))
      .limit(q.limit ?? 50)
      .offset(q.offset ?? 0);

    return { rows };
  });

  app.get('/admin/payments', { preHandler: requireAdmin() },async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().positive().max(200).optional(),
        offset: z.coerce.number().int().nonnegative().optional(),
        workspaceId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);

    const where: any[] = [];
    if (q.workspaceId) where.push(eq(workspacePayments.workspaceId, q.workspaceId));

    const rows = await db
      .select({
        paymentId: workspacePayments.paymentId,
        workspaceId: workspacePayments.workspaceId,
        provider: workspacePayments.provider,
        providerPaymentId: workspacePayments.providerPaymentId,
        amountKopecks: workspacePayments.amountKopecks,
        currency: workspacePayments.currency,
        subscriptionType: workspacePayments.subscriptionType,
        daysAdded: workspacePayments.daysAdded,
        status: workspacePayments.status,
        paidAt: workspacePayments.paidAt,
        createdAt: workspacePayments.createdAt,
        workspaceName: workspaces.name,
      })
      .from(workspacePayments)
      .leftJoin(workspaces, eq(workspaces.workspaceId, workspacePayments.workspaceId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(workspacePayments.createdAt))
      .limit(q.limit ?? 50)
      .offset(q.offset ?? 0);

    return { rows };
  });

  app.get('/admin/ai-settings', { preHandler: requireAdmin() },async () => {
    return listProviderSettingsForAdmin();
  });

  app.put('/admin/ai-settings', { preHandler: requireAdmin() },async (req) => {
    const body = z
      .object({
        providers: z
          .array(
            z.object({
              provider: z.enum(['llm', 'web_search']),
              apiKey: z.string().optional().nullable(),
              baseUrl: z.string().optional().nullable(),
              model: z.string().optional().nullable(),
              promptPricePer1mUsd: z.coerce.number().optional().nullable(),
              completionPricePer1mUsd: z.coerce.number().optional().nullable(),
            })
          )
          .min(1),
      })
      .parse((req as any).body ?? {});

    await upsertProviderSettings(body.providers as any);
    return listProviderSettingsForAdmin();
  });

  app.get('/admin/ai-usage/summary', { preHandler: requireAdmin() },async (req) => {
    const q = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        workspaceId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);

    const fromDate = q.from ? new Date(q.from) : null;
    const toDate = q.to ? new Date(q.to) : null;

    const conds: any[] = [];
    if (q.workspaceId) conds.push(eq(aiUsageEvents.workspaceId, q.workspaceId));
    if (fromDate && !Number.isNaN(fromDate.getTime())) conds.push(gte(aiUsageEvents.createdAt, fromDate));
    if (toDate && !Number.isNaN(toDate.getTime())) conds.push(lte(aiUsageEvents.createdAt, toDate));

    const rows = await db
      .select({
        workspaceId: aiUsageEvents.workspaceId,
        workspaceName: workspaces.name,
        requests: sql<number>`count(*)`.mapWith(Number),
        promptTokens: sql<number>`coalesce(sum(${aiUsageEvents.promptTokens}),0)`.mapWith(Number),
        completionTokens: sql<number>`coalesce(sum(${aiUsageEvents.completionTokens}),0)`.mapWith(Number),
        totalTokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}),0)`.mapWith(Number),
        costMicros: sql<number>`coalesce(sum(${aiUsageEvents.costMicros}),0)`.mapWith(Number),
      })
      .from(aiUsageEvents)
      .leftJoin(workspaces, eq(workspaces.workspaceId, aiUsageEvents.workspaceId))
      .where(conds.length ? and(...conds) : undefined)
      .groupBy(aiUsageEvents.workspaceId, workspaces.name)
      .orderBy(desc(sql`coalesce(sum(${aiUsageEvents.costMicros}),0)`));

    const [totals] = await db
      .select({
        requests: sql<number>`count(*)`.mapWith(Number),
        promptTokens: sql<number>`coalesce(sum(${aiUsageEvents.promptTokens}),0)`.mapWith(Number),
        completionTokens: sql<number>`coalesce(sum(${aiUsageEvents.completionTokens}),0)`.mapWith(Number),
        totalTokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}),0)`.mapWith(Number),
        costMicros: sql<number>`coalesce(sum(${aiUsageEvents.costMicros}),0)`.mapWith(Number),
      })
      .from(aiUsageEvents)
      .where(conds.length ? and(...conds) : undefined);

    return { rows, totals: totals ?? { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costMicros: 0 } };
  });

  // ─── Users Management ───

  app.get('/admin/users', { preHandler: requireAdmin() }, async (req) => {
    const q = z.object({
      limit: z.coerce.number().int().positive().max(200).default(50),
      offset: z.coerce.number().int().nonnegative().default(0),
      search: z.string().optional(),
    }).parse(req.query);

    const conds: any[] = [];
    if (q.search) {
      conds.push(ilike(users.email, `%${escapeIlike(q.search)}%`));
    }

    const rows = await db
      .select({
        userId: users.userId,
        email: users.email,
        isAdmin: users.isAdmin,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(users.createdAt))
      .limit(q.limit)
      .offset(q.offset);

    // Get workspace memberships for each user
    const userIds = rows.map(r => r.userId);
    const memberships = userIds.length > 0 ? await db
      .select({
        userId: workspaceMembers.userId,
        workspaceId: workspaceMembers.workspaceId,
        workspaceName: workspaces.name,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .leftJoin(workspaces, eq(workspaces.workspaceId, workspaceMembers.workspaceId))
      .where(inArray(workspaceMembers.userId, userIds)) : [];

    const membershipsByUser = new Map<number, typeof memberships>();
    for (const m of memberships) {
      const arr = membershipsByUser.get(m.userId) ?? [];
      arr.push(m);
      membershipsByUser.set(m.userId, arr);
    }

    return {
      rows: rows.map(r => ({
        ...r,
        workspaces: membershipsByUser.get(r.userId) ?? [],
      })),
    };
  });

  app.patch('/admin/users/:userId', { preHandler: requireAdmin() }, async (req) => {
    const params = z.object({
      userId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const body = z.object({
      isAdmin: z.boolean().optional(),
    }).parse((req as any).body ?? {});

    if (body.isAdmin !== undefined) {
      await db.update(users)
        .set({ isAdmin: body.isAdmin })
        .where(eq(users.userId, params.userId));
    }

    const [user] = await db.select({
      userId: users.userId,
      email: users.email,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
    }).from(users).where(eq(users.userId, params.userId));
    return user ?? { error: 'User not found' };
  });

  // ─── Subscription Management ───

  app.patch('/admin/subscriptions/:workspaceId', { preHandler: requireAdmin() }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const body = z.object({
      status: z.enum(['active', 'canceled', 'expired', 'trial']).optional(),
      planCode: z.string().optional(),
      currentPeriodEnd: z.string().optional(), // ISO date
      autoRenew: z.boolean().optional(),
      cancelAtPeriodEnd: z.boolean().optional(),
    }).parse((req as any).body ?? {});

    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (body.status !== undefined) updateData.status = body.status;
    if (body.planCode !== undefined) updateData.planCode = body.planCode;
    if (body.currentPeriodEnd !== undefined) updateData.currentPeriodEnd = new Date(body.currentPeriodEnd);
    if (body.autoRenew !== undefined) updateData.autoRenew = body.autoRenew;
    if (body.cancelAtPeriodEnd !== undefined) updateData.cancelAtPeriodEnd = body.cancelAtPeriodEnd;

    await db.update(workspaceSubscriptions)
      .set(updateData)
      .where(eq(workspaceSubscriptions.workspaceId, params.workspaceId));

    const [sub] = await db
      .select()
      .from(workspaceSubscriptions)
      .where(eq(workspaceSubscriptions.workspaceId, params.workspaceId));

    return sub ?? { error: 'Subscription not found' };
  });
};
