/**
 * WB API Rate Limit Orchestrator
 * 
 * In-memory token bucket per domain.
 * Call `await rateLimiter.acquire(domain)` before each WB API request.
 * 
 * ⚠️ IMPORTANT: Verify these limits against current WB API documentation before deploying.
 * Limits may change without notice.
 */

import log from '../../lib/logger.js';

const logger = log.child({ module: 'wbRateLimiter' });

// ============================================================================
// Domain Rate Limits Configuration
// ============================================================================

export interface DomainLimit {
  /** Requests per minute */
  rpm: number;
  /** Burst capacity (max concurrent tokens) */
  burst: number;
}

/**
 * WB API rate limits by domain
 * Source: WB API documentation (verify before deployment!)
 */
const DOMAIN_LIMITS: Record<string, DomainLimit> = {
  // Advertising API - generous limits
  'advert-api.wildberries.ru': { rpm: 300, burst: 20 },
  
  // Analytics API - VERY strict (3 req/min for some endpoints!)
  'seller-analytics-api.wildberries.ru': { rpm: 3, burst: 3 },
  
  // Marketplace API (FBS, orders)
  'marketplace-api.wildberries.ru': { rpm: 300, burst: 20 },
  
  // Statistics API - reports are slow, 1/min
  'statistics-api.wildberries.ru': { rpm: 1, burst: 1 },
  
  // Content API (cards, media)
  'content-api.wildberries.ru': { rpm: 100, burst: 10 },
  
  // Feedbacks API (reviews, questions, chats, returns)
  'feedbacks-api.wildberries.ru': { rpm: 60, burst: 10 },
  
  // Prices API
  'discounts-prices-api.wildberries.ru': { rpm: 60, burst: 10 },
  
  // Documents API - 1/10sec = 6/min
  'documents-api.wildberries.ru': { rpm: 6, burst: 5 },
  
  // Promotions calendar
  'dp-calendar-api.wildberries.ru': { rpm: 60, burst: 10 },
  
  // Supplies API
  'supplies-api.wildberries.ru': { rpm: 60, burst: 10 },
  
  // Common API (tariffs)
  'common-api.wildberries.ru': { rpm: 60, burst: 10 },
  
  // Finance API
  'finance-api.wildberries.ru': { rpm: 60, burst: 10 },
};

// Default limit for unknown domains
const DEFAULT_LIMIT: DomainLimit = { rpm: 60, burst: 10 };

// ============================================================================
// Token Bucket Implementation
// ============================================================================

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  rpm: number;
  burst: number;
  /**
   * Configured (steady-state) rpm. While `throttleUntil > Date.now()` the
   * effective `rpm` is reduced to `rpm * THROTTLE_FACTOR`. Once cooldown
   * expires, `rpm` is restored from this baseline.
   */
  baseRpm: number;
  /**
   * Wall-clock ms until which `rpm` should be treated as reduced. Set by
   * `notifyThrottled` when WB returns 429 — we honoured our local bucket
   * but WB still pushed back, so we suspect another process (cron, second
   * pod, parallel manual refresh) is sharing the same token. Backing off
   * locally is the only safe response since the bucket is per-process.
   */
  throttleUntil: number;
}

/**
 * When WB returns 429, slow this domain to THROTTLE_FACTOR × baseRpm for
 * THROTTLE_COOLDOWN_MS. 0.2 = 20% of normal throughput; tuned to leave
 * headroom for the offending neighbour to drain its budget.
 */
const THROTTLE_FACTOR = 0.2;
const THROTTLE_COOLDOWN_MS = 5 * 60_000;

/**
 * Per-domain cumulative counters surfaced by `getStats()`. Lets the
 * perf-audit script and /health attribute total latency between "real
 * WB work" and "our own rate-limit waits". Without this we'd have to
 * guess from sync-run durations alone.
 */
interface DomainStats {
  acquireCount: number;
  waitCount: number;
  waitTotalMs: number;
  waitMaxMs: number;
}

class RateLimiter {
  private buckets: Map<string, TokenBucket> = new Map();
  private waitQueues: Map<string, Array<() => void>> = new Map();
  private stats: Map<string, DomainStats> = new Map();

  private bumpStats(domain: string, waitMs: number): void {
    let s = this.stats.get(domain);
    if (!s) {
      s = { acquireCount: 0, waitCount: 0, waitTotalMs: 0, waitMaxMs: 0 };
      this.stats.set(domain, s);
    }
    s.acquireCount += 1;
    if (waitMs > 0) {
      s.waitCount += 1;
      s.waitTotalMs += waitMs;
      if (waitMs > s.waitMaxMs) s.waitMaxMs = waitMs;
    }
  }

  /** Snapshot of cumulative wait stats per domain. Counters are additive
   * since process start; callers that want a window should sample twice
   * and subtract. */
  getStats(): Record<string, DomainStats> {
    return Object.fromEntries(this.stats);
  }

  /** Zero all counters — used by the perf-audit script to measure a
   * single refresh run in isolation. */
  resetStats(): void {
    this.stats.clear();
  }

  /**
   * Get or create a bucket for domain
   */
  private getBucket(domain: string): TokenBucket {
    let bucket = this.buckets.get(domain);

    if (!bucket) {
      const limit = DOMAIN_LIMITS[domain] || DEFAULT_LIMIT;
      bucket = {
        tokens: limit.burst,
        lastRefill: Date.now(),
        rpm: limit.rpm,
        burst: limit.burst,
        baseRpm: limit.rpm,
        throttleUntil: 0,
      };
      this.buckets.set(domain, bucket);
    }

    // Restore rpm to baseline once cooldown expires. Cheap to check on every
    // acquire — no separate timer needed.
    if (bucket.throttleUntil > 0 && Date.now() >= bucket.throttleUntil) {
      bucket.throttleUntil = 0;
      bucket.rpm = bucket.baseRpm;
    }

    return bucket;
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refillTokens(bucket: TokenBucket): void {
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefill;
    const elapsedMinutes = elapsedMs / 60000;
    
    // Calculate tokens to add based on RPM
    const tokensToAdd = elapsedMinutes * bucket.rpm;
    
    if (tokensToAdd >= 1) {
      bucket.tokens = Math.min(bucket.burst, bucket.tokens + Math.floor(tokensToAdd));
      bucket.lastRefill = now;
    }
  }

  /**
   * Calculate wait time until a token is available
   */
  private getWaitTime(bucket: TokenBucket): number {
    if (bucket.tokens >= 1) return 0;
    
    // Time to generate 1 token
    const msPerToken = 60000 / bucket.rpm;
    const tokensNeeded = 1 - bucket.tokens;
    return Math.ceil(tokensNeeded * msPerToken);
  }

  /**
   * Acquire a token for the domain.
   * Waits if rate limit is exhausted.
   * 
   * @param domain - WB API domain (e.g., 'advert-api.wildberries.ru')
   * @returns Promise that resolves when token is acquired
   */
  async acquire(domain: string): Promise<void> {
    const bucket = this.getBucket(domain);

    // Refill based on elapsed time
    this.refillTokens(bucket);

    // Check if we can proceed immediately
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.bumpStats(domain, 0);
      return;
    }

    // Need to wait
    const waitTime = this.getWaitTime(bucket);

    logger.info({ domain, waitMs: waitTime }, 'Rate limited, waiting');

    await this.sleep(waitTime);

    // Refill and take token after wait
    this.refillTokens(bucket);
    bucket.tokens = Math.max(0, bucket.tokens - 1);
    this.bumpStats(domain, waitTime);
  }

  /**
   * Try to acquire without waiting
   * @returns true if acquired, false if rate limited
   */
  tryAcquire(domain: string): boolean {
    const bucket = this.getBucket(domain);
    this.refillTokens(bucket);
    
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    
    return false;
  }

  /**
   * Get current status for a domain
   */
  getStatus(domain: string): { tokens: number; rpm: number; burst: number } {
    const bucket = this.getBucket(domain);
    this.refillTokens(bucket);
    return {
      tokens: bucket.tokens,
      rpm: bucket.rpm,
      burst: bucket.burst,
    };
  }

  /**
   * Get status for all domains
   */
  getAllStatus(): Record<string, { tokens: number; rpm: number; burst: number }> {
    const result: Record<string, { tokens: number; rpm: number; burst: number }> = {};
    
    const domains = Array.from(this.buckets.keys());
    for (const domain of domains) {
      result[domain] = this.getStatus(domain);
    }
    
    return result;
  }

  /**
   * Reset rate limiter (for testing)
   */
  reset(): void {
    this.buckets.clear();
    this.waitQueues.clear();
  }

  /**
   * Update limit for a domain (for dynamic configuration)
   */
  setLimit(domain: string, limit: DomainLimit): void {
    const bucket = this.getBucket(domain);
    bucket.rpm = limit.rpm;
    bucket.burst = limit.burst;
    bucket.baseRpm = limit.rpm;
    bucket.tokens = Math.min(bucket.tokens, limit.burst);
  }

  /**
   * Signal that WB returned 429 for this domain even though our local bucket
   * thought it had budget. Likely cause: another process (cron, parallel
   * manual refresh, second pod) is sharing the same WB token. Slow this
   * domain to a fraction of its configured rpm for a cooldown window so the
   * neighbour can drain.
   *
   * @param domain - WB API domain that returned 429
   * @param retryAfterMs - Optional Retry-After header value. If provided,
   *   cooldown lasts at least that long (WB rarely sends it, but honour it).
   */
  notifyThrottled(domain: string, retryAfterMs?: number): void {
    const bucket = this.getBucket(domain);
    const cooldown = Math.max(THROTTLE_COOLDOWN_MS, retryAfterMs ?? 0);
    bucket.throttleUntil = Date.now() + cooldown;
    bucket.rpm = Math.max(1, Math.floor(bucket.baseRpm * THROTTLE_FACTOR));
    bucket.tokens = 0;
    logger.warn(
      { domain, baseRpm: bucket.baseRpm, throttledRpm: bucket.rpm, cooldownMs: cooldown },
      'WB returned 429 — applying local cooldown',
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/**
 * Global rate limiter instance
 */
export const wbRateLimiter = new RateLimiter();

/**
 * Extract domain from URL
 */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // If URL parsing fails, return empty string (will use default limit)
    return '';
  }
}

/**
 * Get configured limit for a domain
 */
export function getDomainLimit(domain: string): DomainLimit {
  return DOMAIN_LIMITS[domain] || DEFAULT_LIMIT;
}

/**
 * List all configured domains
 */
export function getConfiguredDomains(): string[] {
  return Object.keys(DOMAIN_LIMITS);
}
