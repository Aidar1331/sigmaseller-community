import type { FastifyPluginAsync } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { workspacePayments, workspaceSubscriptions } from '../db/schema.js';
import { createTelegramInvoiceLink } from '../integrations/telegram.js';
import {
  addDays,
  buildTelegramPaymentPayload,
  listSubscriptionPlans,
  resolvePlan,
  subscriptionCurrency,
  toKopecks,
} from '../services/subscriptions.js';
import { requireRole } from '../plugins/roleCheck.js';
import { isValidApiKey } from '../lib/security.js';
import { ForbiddenError, BadRequestError } from '../lib/errors.js';
import { verifyPaymentWithYooKassa } from './payments.js';

// Accept legacy 'monthly'/'yearly' for backwards compat with existing
// rows; resolvePlan() collapses all of them to 'standard'.
const planSchema = z.enum(['standard', 'monthly', 'yearly', 'custom']);

export const subscriptionsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'POST' && !req.url.includes('/cancel')) return reply.code(409).send({ error: 'SERVICE_IS_FREE', message: 'Sigmaseller бесплатен, подписка не требуется.' });
  });
  app.get('/subscriptions/plans', { preHandler: requireRole('viewer') },async () => listSubscriptionPlans());

  app.get('/subscriptions/:workspaceId', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const q = z
      .object({
        paymentsLimit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);


    const rows = await db
      .select()
      .from(workspaceSubscriptions)
      .where(eq(workspaceSubscriptions.workspaceId, params.workspaceId))
      .limit(1);

    const subscription = rows[0] ?? null;
    const now = new Date();
    const currentEnd = subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
    const isActive = true;
    const daysLeft = 0;

    let payments: any[] = [];
    if (q.paymentsLimit && q.paymentsLimit > 0) {
      payments = await db
        .select()
        .from(workspacePayments)
        .where(eq(workspacePayments.workspaceId, params.workspaceId))
        .orderBy(desc(workspacePayments.createdAt))
        .limit(q.paymentsLimit);
    }

    return {
      workspaceId: params.workspaceId,
      subscription: subscription
        ? {
            ...subscription,
            isActive,
            daysLeft,
          }
        : null,
      isActive,
      daysLeft,
      payments,
    };
  });

  app.get('/subscriptions/:workspaceId/payments', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const q = z
      .object({
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);

    const rows = await db
      .select()
      .from(workspacePayments)
      .where(eq(workspacePayments.workspaceId, params.workspaceId))
      .orderBy(desc(workspacePayments.createdAt))
      .limit(q.limit ?? 50);

    return { rows };
  });

  app.post('/subscriptions/:workspaceId/pay/telegram', { preHandler: requireRole('manager') },async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        planCode: planSchema.optional().default('standard'),
      })
      .parse((req as any).body ?? {});

    const plan = resolvePlan(body.planCode);
    if (!plan) {
      return reply.code(400).send({ ok: false, error: 'unknown_plan' });
    }

    const payload = buildTelegramPaymentPayload(params.workspaceId, plan.code);
    const url = await createTelegramInvoiceLink({
      title: plan.title,
      description: `Подписка Sigma Seller на ${plan.days} дней`,
      payload,
      currency: plan.currency,
      prices: [{ label: plan.title, amount: plan.priceKopecks }],
    });

    return { ok: true, url };
  });

  /**
   * POST /subscriptions/:workspaceId/activate
   * Internal-only endpoint to activate subscription after payment verification
   * 
   * SECURITY: Only accessible via API key (internal services, webhooks)
   * Regular users cannot call this endpoint - they must go through payment flow
   */
  app.post('/subscriptions/:workspaceId/activate', async (req, reply) => {
    // SECURITY: This endpoint is internal-only (API key required)
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey !== 'string' || !isValidApiKey(apiKey)) {
      throw new ForbiddenError('This endpoint requires API key authentication');
    }

    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        planCode: planSchema.optional(),
        days: z.coerce.number().int().positive().max(365 * 5).optional(), // Max 5 years
        amountKopecks: z.coerce.number().int().positive().optional(), // Must be positive (no free activations)
        amountRub: z.coerce.number().positive().optional(), // Must be positive
        currency: z.string().optional(),
        provider: z.string().optional(),
        providerPaymentId: z.string().optional(),
        status: z.enum(['pending', 'completed', 'failed']).optional(),
        recordPayment: z.boolean().optional().default(true),
      })
      .parse((req as any).body ?? {});

    // SECURITY: Require payment proof - either amountKopecks or amountRub must be positive
    const amountKopecks = body.amountKopecks ?? (body.amountRub !== undefined ? toKopecks(body.amountRub) : undefined);
    if (!amountKopecks || amountKopecks <= 0) {
      throw new BadRequestError('Payment amount is required and must be positive');
    }

    // SECURITY: Verify payment with YooKassa if providerPaymentId provided
    if (body.providerPaymentId && body.provider === 'yookassa') {
      const verified = await verifyPaymentWithYooKassa(body.providerPaymentId);
      if (!verified || verified.status !== 'succeeded') {
        throw new BadRequestError('Payment verification failed — payment not confirmed by YooKassa');
      }
    }

    const plan = resolvePlan(body.planCode);
    const days = body.days ?? plan?.days;
    if (!days || days <= 0) {
      throw new BadRequestError('Days is required and must be positive');
    }

    const now = new Date();
    const rows = await db
      .select()
      .from(workspaceSubscriptions)
      .where(eq(workspaceSubscriptions.workspaceId, params.workspaceId))
      .limit(1);
    const existing = rows[0];

    const currentEnd = existing?.currentPeriodEnd ? new Date(existing.currentPeriodEnd) : null;
    const isActive = Boolean(existing && existing.status === 'active' && currentEnd && currentEnd > now);

    const nextStart = isActive && existing?.currentPeriodStart ? new Date(existing.currentPeriodStart) : now;
    const baseEnd = isActive && currentEnd ? currentEnd : now;
    const nextEnd = addDays(baseEnd, days);

    if (existing) {
      await db
        .update(workspaceSubscriptions)
        .set({
          status: 'active',
          planCode: body.planCode ?? existing.planCode ?? 'custom',
          currentPeriodStart: nextStart,
          currentPeriodEnd: nextEnd,
          cancelAtPeriodEnd: false,
          updatedAt: now,
        })
        .where(eq(workspaceSubscriptions.workspaceId, params.workspaceId));
    } else {
      await db.insert(workspaceSubscriptions).values({
        workspaceId: params.workspaceId,
        status: 'active',
        planCode: body.planCode ?? 'custom',
        currentPeriodStart: nextStart,
        currentPeriodEnd: nextEnd,
        autoRenew: true,
        cancelAtPeriodEnd: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (body.recordPayment) {
      await db
        .insert(workspacePayments)
        .values({
          workspaceId: params.workspaceId,
          provider: body.provider ?? 'manual',
          providerPaymentId: body.providerPaymentId,
          amountKopecks,
          currency: body.currency ?? subscriptionCurrency,
          subscriptionType: body.planCode ?? 'custom',
          daysAdded: days,
          status: body.status ?? 'completed',
          paidAt: now,
          createdAt: now,
        })
        .onConflictDoNothing();
    }

    // Бонус: 2000 ₽ на баланс AI-инструментов за каждую активацию/продление
    // тарифа standard. Из 4900 ₽ тарифа 2000 ₽ возвращаются на AI-кредиты.
    // Используем владельца/любого участника workspace как actor (FK на users).
    if (body.status !== 'failed' && (body.planCode === 'standard' || body.planCode == null)) {
      try {
        const { workspaceMembers } = await import('../db/schema.js');
        const member = await db
          .select({ userId: workspaceMembers.userId })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.workspaceId, params.workspaceId))
          .limit(1);
        const actorUserId = member[0]?.userId;
        if (actorUserId) {
          const { topUp } = await import('../services/aiTokens.js');
          await topUp({
            workspaceId: params.workspaceId,
            userId: Number(actorUserId),
            amountKopecks: 200_000, // 2000 ₽ в копейках
          });
        }
      } catch (err) {
        // bonus — soft dep: лог, но не валим активацию подписки
        req.log.warn({ err, workspaceId: params.workspaceId }, 'failed to grant AI bonus on subscription activation');
      }
    }

    const updated = await db
      .select()
      .from(workspaceSubscriptions)
      .where(eq(workspaceSubscriptions.workspaceId, params.workspaceId))
      .limit(1);

    return { ok: true, subscription: updated[0] ?? null };
  });

  app.post('/subscriptions/:workspaceId/cancel', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        cancelAtPeriodEnd: z.boolean().optional().default(true),
      })
      .parse((req as any).body ?? {});

    await db
      .update(workspaceSubscriptions)
      .set({
        cancelAtPeriodEnd: body.cancelAtPeriodEnd,
        updatedAt: new Date(),
      })
      .where(eq(workspaceSubscriptions.workspaceId, params.workspaceId));

    return { ok: true };
  });

  // BUG-1.2 fix: auto-renew toggle endpoint was missing
  app.patch('/subscriptions/:workspaceId/auto-renew', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        autoRenew: z.boolean(),
      })
      .parse((req as any).body ?? {});

    await db
      .update(workspaceSubscriptions)
      .set({
        autoRenew: body.autoRenew,
        updatedAt: new Date(),
      })
      .where(eq(workspaceSubscriptions.workspaceId, params.workspaceId));

    return { ok: true };
  });

  app.post('/subscriptions/:workspaceId/payments', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        provider: z.string().optional(),
        providerPaymentId: z.string().optional(),
        amountKopecks: z.coerce.number().int().nonnegative().optional(),
        amountRub: z.coerce.number().nonnegative().optional(),
        currency: z.string().optional(),
        subscriptionType: z.string().optional(),
        daysAdded: z.coerce.number().int().nonnegative().optional(),
        status: z.enum(['pending', 'completed', 'failed']).optional(),
        paidAt: z.string().datetime().optional(),
      })
      .parse((req as any).body ?? {});

    const amountKopecks = body.amountKopecks ?? (body.amountRub !== undefined ? toKopecks(body.amountRub) : 0);
    const paidAt = body.paidAt ? new Date(body.paidAt) : new Date();

    const rows = await db
      .insert(workspacePayments)
      .values({
        workspaceId: params.workspaceId,
        provider: body.provider ?? 'manual',
        providerPaymentId: body.providerPaymentId,
        amountKopecks,
        currency: body.currency ?? subscriptionCurrency,
        subscriptionType: body.subscriptionType,
        daysAdded: body.daysAdded,
        status: body.status ?? 'completed',
        paidAt,
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();

    return { ok: true, payment: rows[0] ?? null };
  });
};
