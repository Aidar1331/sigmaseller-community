/**
 * Per-route rate-limit configs for expensive endpoints.
 *
 * The global rate-limit registered in server.ts (100 req/min per IP) protects
 * against generic flood attacks. These per-route configs add a stricter,
 * workspace-scoped quota on operations that:
 *
 *   - cost real money on every call (LLM generate, supply slot, image gen)
 *   - hold significant CPU/memory (heavy CSV exports, multi-day aggregations)
 *   - burn upstream-WB quota faster than the per-endpoint Redis bucket would
 *     by themselves (Top-100 lookups loop over N keywords)
 *
 * Key strategy: `${workspaceId}:${userId}` so one greedy member doesn't
 * lock the whole workspace, but two members in the same workspace each get
 * their own bucket. Falls back to IP if request hasn't been authed yet
 * (shouldn't happen — these routes are gated by requireRole).
 */

import type { FastifyRequest } from 'fastify';

function workspaceUserKey(req: FastifyRequest): string {
  const userId = (req as any).user?.userId ?? (req as any).userId;
  const workspaceId =
    Number((req.params as any)?.workspaceId) ||
    Number((req.query as any)?.workspaceId);
  if (workspaceId && userId) return `${workspaceId}:${userId}`;
  return req.ip; // global rate-limit shape
}

const RL_AI_BATCH = { max: 10, timeWindow: '1 minute', keyGenerator: workspaceUserKey } as const;
const RL_AI_SINGLE = { max: 20, timeWindow: '1 minute', keyGenerator: workspaceUserKey } as const;
const RL_AI_VIDEO = { max: 5, timeWindow: '1 minute', keyGenerator: workspaceUserKey } as const;
const RL_REPORT_HEAVY = { max: 6, timeWindow: '1 minute', keyGenerator: workspaceUserKey } as const;

/** AI batch operations: feedback reply generate-batch, SEO bulk generate, etc. */
export const aiBatchRateLimit = { rateLimit: RL_AI_BATCH };

/** Single AI generate (image, prompt suggest, slide content). */
export const aiSingleRateLimit = { rateLimit: RL_AI_SINGLE };

/** AI video — heavier and more expensive. */
export const aiVideoRateLimit = { rateLimit: RL_AI_VIDEO };

/** Heavy CSV / cross-day aggregations (search-report, sales-funnel, history). */
export const heavyReportRateLimit = { rateLimit: RL_REPORT_HEAVY };

/**
 * True iff (dateTo − dateFrom) ≤ `maxDays`. Used to cap analytics-report
 * periods that would otherwise load N days × M rows into memory and risk
 * OOM-ing the api process under bursts. Accepts ISO YYYY-MM-DD strings.
 *
 * Returns false on invalid input so the caller can reject with 400.
 */
export function isWithinDayCap(dateFrom: string, dateTo: string, maxDays: number): boolean {
  const from = Date.parse(dateFrom);
  const to = Date.parse(dateTo);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  if (to < from) return false;
  const days = (to - from) / (24 * 60 * 60 * 1000);
  return days <= maxDays;
}
