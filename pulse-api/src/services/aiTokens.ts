/**
 * AI Token Balance Service
 *
 * Manages per-workspace AI token balance:
 * - Check balance before Claude API call
 * - Deduct cost after call
 * - Top up balance
 * - Query usage history
 */

import { db } from '../db/client.js';
import { aiTokenBalance, aiTokenTransactions, workspaceMembers } from '../db/schema.js';
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm';
import log from '../lib/logger.js';

const logger = log.child({ module: 'aiTokens' });

// Pricing: Anthropic cost × markup = user price
// Claude Sonnet 4.6: $3/1M input, $15/1M output
// Prompt caching tariffs (Anthropic):
//   cache_creation: 1.25× base input rate (written on first call, ~5-min TTL)
//   cache_read:     0.10× base input rate (served from cache)
// Markup: 2x (100% margin)
const INPUT_PRICE_PER_TOKEN_USD = 3 / 1_000_000;
const OUTPUT_PRICE_PER_TOKEN_USD = 15 / 1_000_000;
const CACHE_CREATION_MULT = 1.25;
const CACHE_READ_MULT = 0.10;
const MARKUP = 2;
const USD_TO_RUB = Number(process.env.AI_USD_TO_RUB) || 90;

/**
 * Calculate cost in kopecks for a given token usage.
 *
 * `inputTokens` is the uncached portion (what Anthropic bills at 1× base).
 * `cacheReadTokens` and `cacheCreationTokens` are optional and only apply
 * when prompt caching is active — they are billed separately at 0.10× and
 * 1.25× respectively so the workspace sees the real Anthropic charge, not
 * a phantom double-bill.
 */
export function calculateCostKopecks(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheCreationTokens: number = 0,
): {
  costKopecks: number;
  rawCostKopecks: number;
} {
  const inputUsd = inputTokens * INPUT_PRICE_PER_TOKEN_USD;
  const cacheReadUsd = cacheReadTokens * INPUT_PRICE_PER_TOKEN_USD * CACHE_READ_MULT;
  const cacheCreateUsd = cacheCreationTokens * INPUT_PRICE_PER_TOKEN_USD * CACHE_CREATION_MULT;
  const outputUsd = outputTokens * OUTPUT_PRICE_PER_TOKEN_USD;
  const rawCostUsd = inputUsd + cacheReadUsd + cacheCreateUsd + outputUsd;
  const userCostUsd = rawCostUsd * MARKUP;
  const rawCostKopecks = Math.ceil(rawCostUsd * USD_TO_RUB * 100);
  const costKopecks = Math.ceil(userCostUsd * USD_TO_RUB * 100);
  return { costKopecks, rawCostKopecks };
}

/**
 * Estimate cost for a request (before sending to Claude)
 * Uses conservative estimate: ~2000 input tokens, ~1000 output tokens
 */
export function estimateCostKopecks(): number {
  const { costKopecks } = calculateCostKopecks(2000, 1000);
  return costKopecks;
}

/**
 * Convert arbitrary USD cost (OpenAI images/video) into user-billed kopecks.
 *
 * Rounding per product decision:
 *   - USD → centsUp = Math.ceil(costUsd * 100)         — up to cent
 *   - rubExact = (centsUp/100) * MARKUP * USD_TO_RUB
 *   - rubUp    = Math.ceil(rubExact)                    — up to whole ruble
 *   - kopecks  = rubUp * 100                            — stored as kopecks, but always ×100
 *
 * This means the user always sees an integer-ruble charge.
 */
// Дефолтный markup для media: base ×2.0 + платформенная наценка +15% → 2.3.
// Для премиум-видео моделей (Veo*, Sora*) — отдельный пониженный markup 1.7,
// чтобы итоговая цена не становилась запретительно высокой. оператор, 2026-05-25.
const MEDIA_MARKUP = Number(process.env.AI_MEDIA_MARKUP) || 2.3;
const PREMIUM_VIDEO_MARKUP = Number(process.env.AI_PREMIUM_VIDEO_MARKUP) || 1.7;

/**
 * Resolve markup multiplier for a media model name. Premium video models
 * (Google Veo family, OpenAI Sora) use a reduced markup so their per-second
 * cost stays buy-able for sellers. Everything else falls back to MEDIA_MARKUP.
 */
export function markupForMediaModel(model?: string | null): number {
  if (!model) return MEDIA_MARKUP;
  const m = String(model).toLowerCase();
  if (m.startsWith('veo') || m.startsWith('sora')) return PREMIUM_VIDEO_MARKUP;
  return MEDIA_MARKUP;
}

export function calculateOpenAiCostKopecks(costUsd: number, markup?: number): {
  costKopecks: number;
  rawCostKopecks: number;
  costRub: number;
  costUsdRoundedUp: number;
} {
  const safeUsd = Math.max(0, costUsd);
  const centsUp = Math.ceil(safeUsd * 100);
  const costUsdRoundedUp = centsUp / 100;
  const rawRubExact = costUsdRoundedUp * USD_TO_RUB;
  const effectiveMarkup = typeof markup === 'number' && markup > 0 ? markup : MEDIA_MARKUP;
  const userRubExact = rawRubExact * effectiveMarkup;
  const rawRub = Math.ceil(rawRubExact);
  const userRub = Math.ceil(userRubExact);
  return {
    costKopecks: userRub * 100,
    rawCostKopecks: rawRub * 100,
    costRub: userRub,
    costUsdRoundedUp,
  };
}

/**
 * Deduct a pre-computed kopecks cost from balance (atomic) and log txn.
 * Used for non-Claude AI operations (OpenAI images / Sora / etc).
 */
export async function chargeWorkspaceKopecks(params: {
  workspaceId: number;
  userId: number;
  costKopecks: number;
  rawCostKopecks?: number;
  type: string;     // e.g. 'studio_image' | 'studio_video'
  model?: string;
  metadata?: Record<string, any>;
}): Promise<{ costKopecks: number; remainingBalanceKopecks: number }> {
  return { costKopecks: 0, remainingBalanceKopecks: 0 }; 
}

/**
 * Refund a previously-charged amount (e.g. when generation fails after pre-check passed).
 */
export async function refundWorkspaceKopecks(params: {
  workspaceId: number;
  userId: number;
  costKopecks: number;
  type: string;       // e.g. 'studio_image_refund'
  metadata?: Record<string, any>;
}): Promise<void> {
  // No internal charge is made in community edition. Historical records remain intact.
  return;
}

/**
 * Resolve the owner user_id for a workspace. Used as a fallback "billing
 * subject" when a background job (audit, agent tool) needs to deduct but has
 * no acting user in scope. Returns null if the workspace has no owner row
 * yet (shouldn't happen post-register, but we don't want to throw).
 */
export async function getWorkspaceOwnerId(workspaceId: number): Promise<number | null> {
  const [row] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.role, 'owner'),
    ))
    .limit(1);
  return row?.userId ?? null;
}

/**
 * Get or create balance for workspace
 */
export async function getBalance(workspaceId: number): Promise<{
  balanceKopecks: number;
  maxBudgetKopecks: number | null;
  totalSpentKopecks: number;
  totalToppedUpKopecks: number;
}> {
  return { balanceKopecks: 0, maxBudgetKopecks: null, totalSpentKopecks: 0, totalToppedUpKopecks: 0 }; 
}

/**
 * Check if workspace has enough balance for an AI request
 * Returns { allowed: true } or { allowed: false, reason, balance, estimatedCost }
 */
export async function checkBalance(workspaceId: number): Promise<
  | { allowed: true; balanceKopecks: number }
  | { allowed: false; reason: string; balanceKopecks: number; estimatedCostKopecks: number }
> {
  return { allowed: true, balanceKopecks: 0 }; 
}

/**
 * Deduct cost from workspace balance after a Claude API call
 */
export async function deductUsage(params: {
  workspaceId: number;
  userId: number;
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache tokens served from cache (billed at 0.10× input rate). */
  cacheReadTokens?: number;
  /** Prompt-cache tokens written this call (billed at 1.25× input rate). */
  cacheCreationTokens?: number;
  model?: string;
  toolsUsed?: string[];
  chatMessageId?: number;
}): Promise<{ costKopecks: number; remainingBalanceKopecks: number }> {
  return { costKopecks: 0, remainingBalanceKopecks: 0 }; 
}

/**
 * Top up workspace balance
 */
export async function topUp(params: {
  workspaceId: number;
  userId: number;
  amountKopecks: number;
}): Promise<{ newBalanceKopecks: number }> {
  throw new Error('Sigmaseller бесплатен. Оплата ИИ производится напрямую вашему провайдеру.');
}

/**
 * Get usage history for a workspace
 */
export async function getUsageHistory(params: {
  workspaceId: number;
  limit?: number;
  offset?: number;
  dateFrom?: string;
  dateTo?: string;
}): Promise<{ rows: any[]; total: number }> {
  const conditions: any[] = [eq(aiTokenTransactions.workspaceId, params.workspaceId)];
  if (params.dateFrom) conditions.push(gte(aiTokenTransactions.createdAt, new Date(params.dateFrom)));
  if (params.dateTo) conditions.push(lte(aiTokenTransactions.createdAt, new Date(params.dateTo)));

  const rows = await db
    .select()
    .from(aiTokenTransactions)
    .where(and(...conditions))
    .orderBy(desc(aiTokenTransactions.createdAt))
    .limit(params.limit ?? 50)
    .offset(params.offset ?? 0);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(aiTokenTransactions)
    .where(and(...conditions));

  return { rows, total: countResult?.count ?? 0 };
}
