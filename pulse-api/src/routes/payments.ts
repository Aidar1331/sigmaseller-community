/**
 * YooKassa (ЮКасса) payment routes
 * 
 * Flow:
 * 1. POST /payments/create - создать платёж, получить URL для оплаты
 * 2. User redirects to YooKassa payment page
 * 3. YooKassa sends webhook to POST /payments/webhook
 * 4. User redirects to return_url (success page)
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workspaceSubscriptions, workspaces, workspacePayments } from '../db/schema.js';
import { env } from '../env.js';
import { UnauthorizedError, BadRequestError, ForbiddenError } from '../lib/errors.js';
import { requireRole } from '../plugins/roleCheck.js';
import { isYooKassaIP, isAdminUserAsync } from '../lib/security.js';
import { invalidateSubscriptionCache } from '../plugins/subscription.js';

// YooKassa API base URL
const YOOKASSA_API = 'https://api.yookassa.ru/v3';

// Subscription plans.
//
// Single paid tier `standard` (4900₽/мес). Free tier intentionally removed
// per product decision 2026-04-22. The separate AI-token top-up flow lives
// at POST /payments/topup and pays into `ai_token_balance`, not the
// subscription.
const PLANS = {
  standard: {
    amount: env.SUBSCRIPTION_MONTHLY_PRICE || 4900,
    days: env.SUBSCRIPTION_MONTHLY_DAYS || 30,
    description: 'Sigma Seller — подписка на 30 дней',
  },
} as const;

type PlanType = keyof typeof PLANS;

// Allowed top-up amounts for the AI-token deposit (rubles).
// Amount is not free-form so a compromised client can't mint an arbitrary
// balance by posting a larger number to YooKassa's "create payment" call
// and then having the webhook credit that amount to the workspace.
const TOPUP_AMOUNTS_RUB = [500, 1000, 3000, 10000] as const;
type TopupAmountRub = (typeof TOPUP_AMOUNTS_RUB)[number];

interface YooKassaPayment {
  id: string;
  status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
  amount: { value: string; currency: string };
  confirmation?: { type: string; confirmation_url?: string };
  metadata?: Record<string, string>;
}

/**
 * Verify payment by fetching it directly from YooKassa API
 * This is the recommended verification method instead of HMAC signatures
 */
export async function verifyPaymentWithYooKassa(paymentId: string): Promise<YooKassaPayment | null> {
  const shopId = env.YOOKASSA_SHOP_ID;
  const secretKey = env.YOOKASSA_SECRET_KEY;

  if (!shopId || !secretKey) {
    return null;
  }

  const auth = Buffer.from(`${shopId}:${secretKey}`).toString('base64');

  try {
    const response = await fetch(`${YOOKASSA_API}/payments/${paymentId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    return response.json() as Promise<YooKassaPayment>;
  } catch {
    return null;
  }
}

interface CreatePaymentOpts {
  /** If true, ask YooKassa to save the payment method for recurring charges. */
  savePaymentMethod?: boolean;
  /** VAT code for the 54-ФЗ receipt line. 1 = «без НДС». */
  vatCode?: number;
  /** Receipt line item description (<=128 chars). Defaults to `description`. */
  receiptItem?: string;
}

async function createYooKassaPayment(
  amount: number,
  description: string,
  metadata: Record<string, string>,
  idempotenceKey: string,
  opts: CreatePaymentOpts = {}
): Promise<YooKassaPayment> {
throw new BadRequestError('Sigmaseller бесплатен. Подключите собственный ключ ИИ в настройках.');
}

export const paymentsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /payments/create
   * Create a payment for subscription
   */
  app.post('/payments/create', {
    preHandler: requireRole('manager'),
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  }, async (req) => {
    const user = (req as any).user;
    if (!user) throw new UnauthorizedError('Not authenticated');

    const body = z.object({
      workspaceId: z.number().int().positive(),
      // Single tier for now; keep the field for forward-compat with future plans.
      plan: z.enum(['standard']).default('standard'),
    }).parse(req.body);

    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.workspaceId, body.workspaceId))
      .limit(1);

    if (!ws) {
      throw new BadRequestError('Workspace not found');
    }

    const plan = PLANS[body.plan];
    const { randomUUID } = await import('node:crypto');
    const idempotenceKey = randomUUID();

    const payment = await createYooKassaPayment(
      plan.amount,
      plan.description,
      {
        kind: 'subscription',
        workspace_id: String(body.workspaceId),
        user_id: String(user.userId),
        email: user.email || '',
        plan: body.plan,
        days: String(plan.days),
      },
      idempotenceKey,
      { savePaymentMethod: true }, // needed for /subscriptions renewal cron
    );

    return {
      paymentId: payment.id,
      confirmationUrl: payment.confirmation?.confirmation_url,
      amount: plan.amount,
      plan: body.plan,
    };
  });

  /**
   * POST /payments/topup
   * Create a YooKassa payment that deposits money into the workspace
   * AI-token balance. The balance is credited only after the webhook
   * confirms `payment.succeeded`.
   */
  app.post('/payments/topup', {
    preHandler: requireRole('manager'),
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  }, async (req) => {
    const user = (req as any).user;
    if (!user) throw new UnauthorizedError('Not authenticated');

    const body = z.object({
      workspaceId: z.number().int().positive(),
      amountRub: z
        .number()
        .int()
        .refine((v) => (TOPUP_AMOUNTS_RUB as readonly number[]).includes(v), {
          message: `amountRub must be one of ${TOPUP_AMOUNTS_RUB.join(', ')}`,
        }),
    }).parse(req.body);

    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.workspaceId, body.workspaceId))
      .limit(1);
    if (!ws) throw new BadRequestError('Workspace not found');

    const { randomUUID } = await import('node:crypto');
    const idempotenceKey = randomUUID();

    const payment = await createYooKassaPayment(
      body.amountRub,
      `Sigma Seller — пополнение баланса AI (${body.amountRub} ₽)`,
      {
        kind: 'topup',
        workspace_id: String(body.workspaceId),
        user_id: String(user.userId),
        email: user.email || '',
        amount_rub: String(body.amountRub),
      },
      idempotenceKey,
      { receiptItem: `Пополнение баланса AI ${body.amountRub} ₽` },
    );

    return {
      paymentId: payment.id,
      confirmationUrl: payment.confirmation?.confirmation_url,
      amountRub: body.amountRub,
      kind: 'topup' as const,
    };
  });

  /**
   * POST /payments/refund
   * Admin-only. Refunds a previous YooKassa payment fully or partially.
   * The actual bookkeeping (marking workspace_payments.status = 'refunded'
   * and revoking the subscription on full refund) happens in the
   * `refund.succeeded` branch of the webhook so manual refunds initiated
   * from the YooKassa dashboard stay in sync.
   */
  app.post('/payments/refund', {
    preHandler: requireRole('owner'), // tightened: only workspace owner + admin
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute' },
    },
  }, async (req) => {
    const user = (req as any).user;
    if (!user) throw new UnauthorizedError('Not authenticated');
    // `req.user` shape is `{ userId, email, sessionId }` — no `isAdmin` field.
    // Earlier code read `user.isAdmin` (always undefined) → endpoint was effectively dead.
    // Use the DB-backed check from lib/security.ts which also honours the
    // ADMIN_USER_IDS env var and a 60s cache.
    if (!(await isAdminUserAsync(user.userId))) throw new ForbiddenError('Admin only');

    const body = z.object({
      providerPaymentId: z.string().min(8),
      amountRub: z.number().positive().optional(), // omit = full refund
      reason: z.string().max(500).optional(),
    }).parse(req.body);

    const [original] = await db
      .select()
      .from(workspacePayments)
      .where(
        and(
          eq(workspacePayments.provider, 'yookassa'),
          eq(workspacePayments.providerPaymentId, body.providerPaymentId),
        ),
      )
      .limit(1);
    if (!original) throw new BadRequestError('Payment not found');
    if (original.status === 'refunded') {
      throw new BadRequestError('Payment already refunded');
    }

    const shopId = env.YOOKASSA_SHOP_ID;
    const secretKey = env.YOOKASSA_SECRET_KEY;
    if (!shopId || !secretKey) throw new Error('YooKassa credentials not configured');
    const auth = Buffer.from(`${shopId}:${secretKey}`).toString('base64');

    // YooKassa refund amount defaults to the full original amount if
    // omitted; we pass it explicitly so partial refunds are auditable.
    const amountRub = body.amountRub ?? original.amountKopecks / 100;
    const { randomUUID } = await import('node:crypto');

    const response = await fetch(`${YOOKASSA_API}/refunds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
        'Idempotence-Key': randomUUID(),
      },
      body: JSON.stringify({
        payment_id: body.providerPaymentId,
        amount: { value: amountRub.toFixed(2), currency: 'RUB' },
        description: body.reason?.slice(0, 250),
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      app.log.error({ providerPaymentId: body.providerPaymentId, errText }, 'YooKassa refund failed');
      throw new Error(`YooKassa refund error: ${response.status} ${errText}`);
    }

    const refund = (await response.json()) as { id: string; status: string };
    app.log.info(
      { providerPaymentId: body.providerPaymentId, refundId: refund.id, amountRub },
      'Refund initiated',
    );

    // The refund.succeeded webhook will flip workspace_payments.status and
    // deactivate the subscription; here we just return the refund id.
    return { refundId: refund.id, status: refund.status, amountRub };
  });

  /**
   * POST /payments/webhook
   * YooKassa webhook for payment notifications
   * 
   * Security: We verify webhooks by:
   * 1. Checking IP is in YooKassa allowed ranges
   * 2. Fetching payment directly from YooKassa API to confirm status
   * 
   * This is more reliable than HMAC signature verification (which YooKassa v4 doesn't use)
   */
  app.post('/payments/webhook', async (req, reply) => {
    // Security: Verify request comes from YooKassa IP range
    const clientIp = req.ip || req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim();
    if (!isYooKassaIP(clientIp)) {
      app.log.warn({ ip: clientIp }, 'YooKassa webhook from unauthorized IP');
      throw new ForbiddenError('Unauthorized IP');
    }

    // Parse webhook payload
    const payload = req.body as any;
    
    if (!payload?.event || !payload?.object?.id) {
      return reply.code(400).send({ error: 'Invalid webhook payload' });
    }

    const event = payload.event;
    const webhookPaymentId = payload.object.id as string;

    // Security: Verify payment by fetching it directly from YooKassa API
    // This confirms the payment exists and its actual status
    const payment = await verifyPaymentWithYooKassa(webhookPaymentId);
    
    if (!payment) {
      app.log.warn({ paymentId: webhookPaymentId }, 'YooKassa webhook: payment not found via API');
      throw new ForbiddenError('Payment verification failed');
    }

    app.log.info({ event, paymentId: payment.id, status: payment.status, ip: clientIp }, 'YooKassa webhook verified via API');

    // ── refund.succeeded ──
    // Payload shape: event='refund.succeeded', object is the refund with
    // `payment_id` referencing the original YooKassa payment.
    if (event === 'refund.succeeded') {
      const refundObj = payload.object as {
        id: string;
        status: string;
        payment_id?: string;
        amount?: { value: string; currency: string };
      };
      const originalPaymentId = refundObj.payment_id;
      if (!originalPaymentId) {
        app.log.warn({ refundId: refundObj.id }, 'refund.succeeded missing payment_id');
        return { ok: true, processed: false, reason: 'missing payment_id' };
      }

      const [original] = await db
        .select()
        .from(workspacePayments)
        .where(
          and(
            eq(workspacePayments.provider, 'yookassa'),
            eq(workspacePayments.providerPaymentId, originalPaymentId),
          ),
        )
        .limit(1);
      if (!original) {
        app.log.warn({ originalPaymentId }, 'refund.succeeded for unknown payment');
        return { ok: true, processed: false, reason: 'original not found' };
      }

      await db
        .update(workspacePayments)
        .set({ status: 'refunded' })
        .where(eq(workspacePayments.paymentId, original.paymentId));

      // H17: invalidate the subscription cache on ANY refund (full or partial).
      // The cache holds derived state that may include this payment; even when
      // the subscription itself isn't cancelled (partial refund), downstream
      // entitlement logic could otherwise serve up-to-5-min-stale "still paid"
      // verdicts. Cheap to invalidate, expensive to under-invalidate.
      await invalidateSubscriptionCache(original.workspaceId);

      // Full refund → deactivate subscription if this payment was a subscription.
      const refundedKop = refundObj.amount
        ? Math.round(parseFloat(refundObj.amount.value) * 100)
        : original.amountKopecks;
      const isFullRefund = refundedKop >= original.amountKopecks;
      if (isFullRefund && original.subscriptionType) {
        await db
          .update(workspaceSubscriptions)
          .set({
            status: 'cancelled',
            cancelAtPeriodEnd: true,
            updatedAt: new Date(),
          })
          .where(eq(workspaceSubscriptions.workspaceId, original.workspaceId));
        // (already invalidated above — extra call is a no-op due to single
        // bust per workspace.)
      }

      app.log.info(
        { originalPaymentId, refundId: refundObj.id, workspaceId: original.workspaceId, isFullRefund },
        'Refund applied',
      );
      return { ok: true, processed: true, kind: 'refund' };
    }

    // ── payment.succeeded ──
    if (event !== 'payment.succeeded' || payment.status !== 'succeeded') {
      return { ok: true, processed: false, reason: 'not a successful payment' };
    }

    const metadata = payment.metadata;
    if (!metadata?.workspace_id) {
      app.log.warn({ paymentId: payment.id }, 'Payment missing workspace_id metadata');
      return { ok: true, processed: false, reason: 'missing metadata' };
    }

    const workspaceId = Number(metadata.workspace_id);
    const kind = metadata.kind || (metadata.plan ? 'subscription' : null);
    if (!kind) {
      app.log.warn({ paymentId: payment.id }, 'Payment missing kind metadata');
      return { ok: true, processed: false, reason: 'missing kind' };
    }

    // Idempotency: webhook may be delivered multiple times. The unique index
    // on (provider, provider_payment_id) guarantees at most one row per
    // payment, so a pre-check here avoids a second subscription extension.
    const [existingPayment] = await db
      .select({ paymentId: workspacePayments.paymentId })
      .from(workspacePayments)
      .where(
        and(
          eq(workspacePayments.provider, 'yookassa'),
          eq(workspacePayments.providerPaymentId, payment.id),
        ),
      )
      .limit(1);

    if (existingPayment) {
      app.log.info({ paymentId: payment.id }, 'Webhook already processed, skipping');
      return { ok: true, processed: false, reason: 'already_processed' };
    }

    const amountKopecks = Math.round(parseFloat(payment.amount.value) * 100);
    const now = new Date();

    if (kind === 'topup') {
      // AI-token deposit. The amount was whitelisted when the payment was
      // created, but re-validate here against the trusted server-side list
      // so a tampered metadata.amount_rub can never inflate the balance.
      const declaredAmountRub = Number(metadata.amount_rub || 0);
      const actualAmountRub = amountKopecks / 100;
      if (
        !(TOPUP_AMOUNTS_RUB as readonly number[]).includes(declaredAmountRub) ||
        Math.abs(declaredAmountRub - actualAmountRub) > 0.01
      ) {
        app.log.warn(
          { paymentId: payment.id, declaredAmountRub, actualAmountRub },
          'Top-up amount mismatch or not in whitelist',
        );
        return { ok: true, processed: false, reason: 'invalid topup amount' };
      }

      await db.insert(workspacePayments).values({
        workspaceId,
        provider: 'yookassa',
        providerPaymentId: payment.id,
        amountKopecks,
        currency: payment.amount.currency,
        subscriptionType: 'topup',
        daysAdded: 0,
        status: 'completed',
        paidAt: now,
      });

      // Credit the AI-token balance. Using a raw UPSERT keeps the read and
      // the write in the same statement so two concurrent webhooks can't
      // overwrite each other's increment.
      await db.execute(sql`
        INSERT INTO ai_token_balance (workspace_id, balance_kopecks, total_topped_up_kopecks, updated_at, created_at)
        VALUES (${workspaceId}, ${amountKopecks}, ${amountKopecks}, NOW(), NOW())
        ON CONFLICT (workspace_id) DO UPDATE SET
          balance_kopecks = ai_token_balance.balance_kopecks + EXCLUDED.balance_kopecks,
          total_topped_up_kopecks = ai_token_balance.total_topped_up_kopecks + EXCLUDED.balance_kopecks,
          updated_at = NOW()
      `);

      app.log.info({ workspaceId, amountKopecks }, 'AI-token top-up applied');
      return { ok: true, processed: true, kind: 'topup' };
    }

    // kind === 'subscription'
    if (!metadata.plan || !metadata.days) {
      app.log.warn({ paymentId: payment.id }, 'Subscription payment missing plan/days metadata');
      return { ok: true, processed: false, reason: 'missing subscription metadata' };
    }
    const MAX_SUBSCRIPTION_DAYS = 3650;
    const days = Math.min(Math.max(1, Number(metadata.days) || 30), MAX_SUBSCRIPTION_DAYS);

    await db.insert(workspacePayments).values({
      workspaceId,
      provider: 'yookassa',
      providerPaymentId: payment.id,
      amountKopecks,
      currency: payment.amount.currency,
      subscriptionType: metadata.plan,
      daysAdded: days,
      status: 'completed',
      paidAt: now,
    });

    const currentPeriodStart = now;
    const currentPeriodEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const [existing] = await db
      .select()
      .from(workspaceSubscriptions)
      .where(eq(workspaceSubscriptions.workspaceId, workspaceId))
      .limit(1);

    // YooKassa returns the saved payment-method id on the verified payment
    // object (`payment_method.saved === true`). We stash the id in
    // workspace_subscriptions.meta so the renewal cron can charge it.
    const paymentMethodId: string | null =
      (payment as any)?.payment_method?.id && (payment as any)?.payment_method?.saved
        ? String((payment as any).payment_method.id)
        : null;

    if (existing) {
      const newEnd = existing.currentPeriodEnd && existing.currentPeriodEnd > now
        ? new Date(existing.currentPeriodEnd.getTime() + days * 24 * 60 * 60 * 1000)
        : currentPeriodEnd;

      await db
        .update(workspaceSubscriptions)
        .set({
          status: 'active',
          planCode: metadata.plan,
          provider: 'yookassa',
          currentPeriodEnd: newEnd,
          autoRenew: true,
          cancelAtPeriodEnd: false,
          meta: {
            ...(existing.meta as Record<string, unknown>),
            ...(paymentMethodId ? { yookassa_payment_method_id: paymentMethodId } : {}),
            lastPaymentId: payment.id,
          },
          updatedAt: now,
        })
        .where(eq(workspaceSubscriptions.workspaceId, workspaceId));

      app.log.info({ workspaceId, newEnd }, 'Subscription extended');
    } else {
      await db.insert(workspaceSubscriptions).values({
        workspaceId,
        status: 'active',
        planCode: metadata.plan,
        provider: 'yookassa',
        currentPeriodStart,
        currentPeriodEnd,
        autoRenew: true,
        cancelAtPeriodEnd: false,
        meta: {
          ...(paymentMethodId ? { yookassa_payment_method_id: paymentMethodId } : {}),
          lastPaymentId: payment.id,
        },
        createdAt: now,
        updatedAt: now,
      });

      app.log.info({ workspaceId, currentPeriodEnd }, 'Subscription created');
    }

    await invalidateSubscriptionCache(workspaceId);
    return { ok: true, processed: true, kind: 'subscription' };
  });

  /**
   * GET /payments/status/:workspaceId
   * Check subscription status
   */
  app.get('/payments/status/:workspaceId', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.params);

    // When subscription enforcement is disabled, always return active
    if (env.SUBSCRIPTION_ENFORCE === '0') {
      return {
        hasSubscription: true,
        status: 'active',
        expiresAt: null,
        isActive: true,
        daysLeft: 999,
      };
    }

    const [sub] = await db
      .select()
      .from(workspaceSubscriptions)
      .where(eq(workspaceSubscriptions.workspaceId, params.workspaceId))
      .limit(1);

    if (!sub) {
      return {
        hasSubscription: false,
        status: null,
        expiresAt: null,
        isActive: false,
      };
    }

    const now = new Date();
    const status = (sub.status || '').toLowerCase();
    const isActive = (status === 'active' || status === 'trialing') && 
      sub.currentPeriodEnd && 
      sub.currentPeriodEnd > now;

    return {
      hasSubscription: true,
      status: sub.status,
      expiresAt: sub.currentPeriodEnd?.toISOString() || null,
      isActive,
      daysLeft: isActive && sub.currentPeriodEnd
        ? Math.ceil((sub.currentPeriodEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
        : 0,
    };
  });

  /**
   * GET /payments/plans
   * Subscription plan catalogue + whitelisted AI top-up amounts.
   * Public: used by the signed-out /pricing landing page, so no preHandler.
   */
  app.get('/payments/plans', async () => {
    return {
      plans: [
        {
          id: 'standard',
          name: 'Подписка Sigma Seller',
          amount: PLANS.standard.amount,
          currency: 'RUB',
          days: PLANS.standard.days,
          description: PLANS.standard.description,
        },
      ],
      topupAmountsRub: TOPUP_AMOUNTS_RUB,
    };
  });
};

// ──────────────────────────────────────────────────────────────────────
// Recurring subscription renewal helper.
//
// Exported for use by the daily cron (`jobs/subscriptionRenewal.ts`).
// Given a workspace with a saved `yookassa_payment_method_id`, charges the
// stored method for one subscription period and, on success, extends
// `current_period_end`. The webhook still handles bookkeeping, so on success
// we just return the new YooKassa payment id; the webhook takes it from there.
// ──────────────────────────────────────────────────────────────────────
export async function chargeSubscriptionRenewal(
  workspaceId: number,
): Promise<
  | { ok: true; paymentId: string; status: string }
  | { ok: false; reason: 'no_method' | 'no_subscription' | 'yookassa_error'; detail?: string }
> {
throw new Error('Subscription renewal is disabled in community edition');
}
