import { env } from '../env.js';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt } from 'drizzle-orm';

// Single paid tier: 'standard' (4900₽ / 30 дней). 'custom' kept so the
// internal activation endpoint can still back-date grants with arbitrary
// days (admin tooling). Legacy 'monthly'/'yearly' codes still resolve to
// 'standard' so pre-refactor rows don't orphan.
export type SubscriptionPlanCode = 'standard' | 'custom';

export type SubscriptionPlan = {
  code: SubscriptionPlanCode;
  title: string;
  days: number;
  currency: string;
  priceRub: number;
  priceKopecks: number;
};

export const subscriptionCurrency = env.SUBSCRIPTION_CURRENCY || 'RUB';

const standardPlan = {
  code: 'standard' as const,
  title: 'Подписка Sigma Seller',
  days: env.SUBSCRIPTION_MONTHLY_DAYS ?? 30,
  priceRub: env.SUBSCRIPTION_MONTHLY_PRICE ?? 4900,
};

export const toKopecks = (rub: number) => Math.round(rub * 100);

export function listSubscriptionPlans(): { currency: string; plans: SubscriptionPlan[] } {
  return { currency: subscriptionCurrency, plans: [] }; 
}

export function resolvePlan(code?: string | null): SubscriptionPlan | null {
  // Legacy codes map to standard for backwards compatibility with older rows.
  if (code === 'standard' || code === 'monthly' || code === 'yearly' || code == null) {
    return {
      code: standardPlan.code,
      title: standardPlan.title,
      days: standardPlan.days,
      currency: subscriptionCurrency,
      priceRub: standardPlan.priceRub,
      priceKopecks: toKopecks(standardPlan.priceRub),
    };
  }
  return null;
}

export const addDays = (start: Date, days: number) => new Date(start.getTime() + days * 24 * 60 * 60 * 1000);

export function buildTelegramPaymentPayload(workspaceId: number, planCode: string) {
  return `pulse:${workspaceId}:${planCode}`;
}

export function parseTelegramPaymentPayload(payload?: string | null): { workspaceId: number; planCode: string } | null {
  if (!payload) return null;
  const parts = payload.split(':');
  if (parts.length !== 3) return null;
  if (parts[0] !== 'pulse') return null;
  const workspaceId = Number(parts[1]);
  const planCode = parts[2];
  if (!Number.isFinite(workspaceId) || workspaceId <= 0) return null;
  if (!planCode) return null;
  return { workspaceId, planCode };
}
