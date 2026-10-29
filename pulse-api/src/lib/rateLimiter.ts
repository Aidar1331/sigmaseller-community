/**
 * Retry helper with exponential backoff.
 *
 * NOTE: Domain-specific WB API rate limiting is handled entirely by
 * `integrations/wb/wbRateLimiter.ts` (token bucket). This module only
 * provides the generic retry utility used by seoPositions, autoBidder, etc.
 */

import log from './logger.js';

const logger = log.child({ module: 'rateLimiter' });

/** Retry a function with exponential backoff and jitter. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
  } = options;

  let lastError: Error | null = null;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxAttempts) break;

      // Exponential backoff with jitter
      const jitter = Math.random() * 0.3 * delay;
      const waitTime = Math.min(delay + jitter, maxDelayMs);

      logger.warn({ attempt, maxAttempts, retryInMs: Math.round(waitTime), err: lastError }, 'Attempt failed, retrying');

      await new Promise(resolve => setTimeout(resolve, waitTime));
      delay *= 2;
    }
  }

  throw lastError;
}
