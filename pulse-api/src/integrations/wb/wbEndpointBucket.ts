/**
 * Redis-backed per-endpoint quota for WB API.
 *
 * Each (workspace, endpoint) pair gets a sliding bucket key in Redis.
 * INCR + EXPIRE pattern: first hit primes TTL, subsequent hits within the
 * window decrement remaining budget. When budget is gone we either wait
 * for TTL to expire (short windows ≤ 5 min) or throw an explicit
 * `WbQuotaExceededError` so the caller can degrade gracefully (long windows).
 *
 * Cross-process safe: pulse-api and pulse-workers share the same Redis,
 * so cron + on-demand requests count against one quota — same as WB's
 * server-side counter.
 *
 * Falls back to a no-op (acquire succeeds) if Redis is unreachable so that
 * a Redis outage doesn't take WB sync offline. The per-domain in-memory
 * bucket in wbRateLimiter.ts still applies as a second-line defence.
 */

import { getRedis } from '../../lib/redis.js';
import log from '../../lib/logger.js';
import { findEndpointLimit } from './wbEndpointLimits.js';

const logger = log.child({ module: 'wbEndpointBucket' });

/** If acquire() needs to wait more than this we throw instead, so the
 * caller can return a placeholder rather than blocking a request handler
 * for 30 minutes. */
const MAX_WAIT_MS = 5 * 60_000;

export class WbQuotaExceededError extends Error {
  retryAfterSec: number;
  endpoint: string;
  constructor(endpoint: string, retryAfterSec: number) {
    super(`WB endpoint quota exceeded for ${endpoint}; retry after ${retryAfterSec}s`);
    this.name = 'WbQuotaExceededError';
    this.endpoint = endpoint;
    this.retryAfterSec = retryAfterSec;
  }
}

function bucketKey(
  workspaceId: number | undefined,
  sellerId: string | undefined,
  host: string,
  label: string,
): string {
  // WB rate-limits PER SELLER ACCOUNT. The `sid` claim in a WB API JWT is the
  // unique seller-account id and is identical across multiple tokens issued
  // by the same seller (different scopes / lifetimes). So bucketing by sid
  // (extracted in wbClient.getWbSellerId) exactly matches WB's server-side
  // counter: shops sharing one WB seller share one bucket; shops belonging
  // to different sellers get independent buckets.
  //
  // Pre-2026-05-16 the bucket was per-workspace, which was correct only
  // under the single-WB-seller-per-workspace assumption. That broke for any
  // workspace that connected tokens from 2+ different WB sellers — pulse
  // over-throttled by Nx without need.
  //
  // Workspace=0 sentinel for callsites without a workspace (rare; usually
  // tariffs/catalog probes that work for any token). Seller=`global` when
  // the caller could not extract a JWT sid (legacy non-JWT keys, or the
  // catalog probes that pass empty apiKey) — we fall back to a workspace-
  // wide bucket to preserve previous behaviour for those edge cases.
  const ws = workspaceId ?? 0;
  const sid = sellerId ?? 'global';
  return `wb:rl:${ws}:${sid}:${host}:${label}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Acquire one slot from the endpoint-specific bucket for this workspace +
 * seller. Waits when the wait is short; throws WbQuotaExceededError when
 * it's long.
 *
 * `sellerId` should be the WB JWT `sid` claim — see bucketKey() above for
 * why this matches WB's actual server-side counter. Callers in wbClient.ts
 * compute it via getWbSellerId(apiKey). When undefined the bucket
 * collapses to workspace-only (matches pre-2026-05-16 behaviour).
 */
export async function acquireEndpoint(
  url: string,
  workspaceId?: number,
  sellerId?: string,
  method?: string,
): Promise<void> {
  const limit = findEndpointLimit(url, method);
  if (!limit) return; // No per-endpoint cap registered — defer to per-domain bucket.

  let host = '';
  try { host = new URL(url).host; } catch { return; }
  const key = bucketKey(workspaceId, sellerId, host, limit.label);

  let redis;
  try {
    redis = getRedis();
  } catch {
    return; // Redis unreachable — fall back to per-domain only.
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    let count: number;
    let ttl: number;
    try {
      // Atomic INCR; first hit primes the window TTL.
      count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, limit.windowSec);
      }
      if (count <= limit.count) return; // within quota
      ttl = await redis.ttl(key);
    } catch (err) {
      logger.warn({ err: (err as Error).message, key }, 'Redis bucket op failed; allowing request');
      return;
    }

    if (ttl <= 0) {
      // TTL races; one more loop will re-prime the key.
      continue;
    }
    const waitMs = ttl * 1000;
    if (waitMs > MAX_WAIT_MS) {
      // Roll back this slot reservation so we don't penalise the next caller
      // when the bucket eventually unlocks.
      try { await redis.decr(key); } catch { /* noop */ }
      throw new WbQuotaExceededError(`${host}:${limit.label}`, ttl);
    }
    logger.info({ key, waitMs, ttl }, 'WB endpoint quota: waiting');
    await sleep(waitMs + 250);
    // After the wait Redis will have expired the key on its own; loop and re-INCR.
  }

  // Should not reach here; final safety throw.
  throw new WbQuotaExceededError(`${host}`, limit.windowSec);
}

/**
 * Read-only inspection: how many slots remain in this bucket without consuming one.
 * Returns null if the URL has no per-endpoint limit, or Redis is unavailable.
 */
export async function inspectEndpoint(
  url: string,
  workspaceId?: number,
  sellerId?: string,
  method?: string,
): Promise<{ remaining: number; ttlSec: number; limit: number; label: string } | null> {
  const limit = findEndpointLimit(url, method);
  if (!limit) return null;

  let host = '';
  try { host = new URL(url).host; } catch { return null; }
  const key = bucketKey(workspaceId, sellerId, host, limit.label);

  let redis;
  try { redis = getRedis(); } catch { return null; }

  let count = 0;
  let ttl = 0;
  try {
    const v = await redis.get(key);
    count = v ? parseInt(v, 10) : 0;
    ttl = await redis.ttl(key);
  } catch { return null; }

  return {
    remaining: Math.max(0, limit.count - count),
    ttlSec: ttl > 0 ? ttl : 0,
    limit: limit.count,
    label: limit.label,
  };
}

/** Convenience for tests + admin tooling: drop bucket for a workspace+seller's endpoint. */
export async function resetEndpointBucket(
  url: string,
  workspaceId: number,
  sellerId?: string,
): Promise<void> {
  const limit = findEndpointLimit(url);
  if (!limit) return;
  let host = '';
  try { host = new URL(url).host; } catch { return; }
  const key = bucketKey(workspaceId, sellerId, host, limit.label);
  try { await getRedis().del(key); } catch { /* noop */ }
}
