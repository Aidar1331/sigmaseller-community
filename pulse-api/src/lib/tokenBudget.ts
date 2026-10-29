/**
 * Token Budget — enforce daily AI usage limits per workspace.
 *
 * Checks ai_usage_events table for today's total and compares against
 * agentSettings.maxTokensPerDay. Returns 429 if budget exceeded.
 */

import { db } from '../db/client.js';
import { aiUsageEvents, agentSettings } from '../db/schema.js';
import { eq, and, sql, gte } from 'drizzle-orm';
import { log } from './logger.js';

const DEFAULT_MAX_TOKENS_PER_DAY = 500_000; // ~$5/day at Claude Sonnet rates

/**
 * Check if workspace has remaining token budget for AI calls.
 * Returns { allowed, used, limit, remaining }.
 */
export async function checkTokenBudget(wsId: number): Promise<{
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
}> {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Get today's usage
    const [usage] = await db.select({
      totalTokens: sql<number>`COALESCE(SUM(${aiUsageEvents.totalTokens}), 0)`.mapWith(Number),
    })
      .from(aiUsageEvents)
      .where(and(
        eq(aiUsageEvents.workspaceId, wsId),
        gte(aiUsageEvents.createdAt, todayStart),
      ));

    const used = usage?.totalTokens ?? 0;

    // Get workspace limit
    const [settings] = await db.select({
      maxTokensPerDay: agentSettings.agentMaxTokensPerDay,
    })
      .from(agentSettings)
      .where(eq(agentSettings.workspaceId, wsId))
      .limit(1);

    const limit = (settings?.maxTokensPerDay as number) ?? DEFAULT_MAX_TOKENS_PER_DAY;
    const remaining = Math.max(0, limit - used);

    return {
      allowed: used < limit,
      used,
      limit,
      remaining,
    };
  } catch (err) {
    log.warn({ err, wsId }, 'Failed to check token budget — allowing request');
    // Fail open to avoid blocking users when DB is slow
    return { allowed: true, used: 0, limit: DEFAULT_MAX_TOKENS_PER_DAY, remaining: DEFAULT_MAX_TOKENS_PER_DAY };
  }
}
