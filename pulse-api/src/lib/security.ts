/**
 * Security utilities
 */

import crypto from 'node:crypto';
import { env } from '../env.js';
import log from './logger.js';

const logger = log.child({ module: 'security' });

// Legacy: Parse admin user IDs from env (fallback if DB check fails)
const ADMIN_USER_IDS_ENV: Set<number> = new Set(
  (env.ADMIN_USER_IDS || '')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n) && n > 0)
);

// Cache for DB-based admin checks (TTL: 60s)
const adminCache = new Map<number, { isAdmin: boolean; expiresAt: number }>();
const ADMIN_CACHE_TTL_MS = 60_000;

/**
 * Timing-safe comparison of two strings
 * Returns false for different lengths without leaking timing info
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  
  // Pad to same length to avoid timing leak on length comparison
  const maxLen = Math.max(a.length, b.length);
  const bufA = Buffer.alloc(maxLen);
  const bufB = Buffer.alloc(maxLen);
  bufA.write(a);
  bufB.write(b);
  
  // Compare with constant-time algorithm
  return a.length === b.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validate API key with timing-safe comparison
 */
export function isValidApiKey(apiKey: string | undefined): boolean {
  if (!apiKey || !env.API_KEY) {
    return false;
  }
  return timingSafeEqual(apiKey, env.API_KEY);
}

/**
 * Verify HMAC-SHA256 signature (for webhooks)
 */
export function verifyHmacSha256(
  payload: string | Buffer,
  signature: string,
  secret: string
): boolean {
  if (!signature || !secret) {
    return false;
  }
  
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  
  return timingSafeEqual(signature, expected);
}

/**
 * YooKassa webhook signature verification
 * YooKassa uses SHA-256 HMAC with the secret key
 */
export function verifyYooKassaSignature(
  body: string,
  signature: string | undefined
): boolean {
  const secret = env.YOOKASSA_WEBHOOK_SECRET;
  
  if (!secret) {
    // Webhook secret not configured — reject all webhooks
    // This is safer than accepting unverified webhooks
    return false;
  }
  
  if (!signature) {
    return false;
  }
  
  return verifyHmacSha256(body, signature, secret);
}

/**
 * Check if user is a system admin
 * Checks DB first (users.is_admin), falls back to ADMIN_USER_IDS env var
 * 
 * Note: For sync contexts, use isAdminUserSync() which only checks env/cache
 */
export function isAdminUser(userId: number | undefined | null): boolean {
  if (!userId || !Number.isFinite(userId)) return false;
  
  // Check cache first
  const cached = adminCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.isAdmin;
  }
  
  // Fallback to env var (sync check)
  return ADMIN_USER_IDS_ENV.has(userId);
}

/**
 * Async check for admin status (checks DB)
 * Use this when you can await
 */
export async function isAdminUserAsync(userId: number | undefined | null): Promise<boolean> {
  if (!userId || !Number.isFinite(userId)) return false;
  
  // Check cache first
  const cached = adminCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.isAdmin;
  }
  
  // Check DB
  try {
    const { db } = await import('../db/client.js');
    const { users } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    
    const [user] = await db
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);
    
    const isAdmin = user?.isAdmin ?? false;
    
    // Cache result
    adminCache.set(userId, { isAdmin, expiresAt: Date.now() + ADMIN_CACHE_TTL_MS });
    
    return isAdmin;
  } catch (e) {
    // DB error - fallback to env var
    logger.error({ err: e }, 'isAdminUserAsync DB error');
    return ADMIN_USER_IDS_ENV.has(userId);
  }
}

/**
 * Check if IP is in YooKassa allowed range
 * YooKassa IPs: 185.71.76.0/27, 185.71.77.0/27, 77.75.153.0/25
 */
export function isYooKassaIP(ip: string | undefined): boolean {
  if (!ip) return false;
  
  // Normalize IPv6-mapped IPv4
  const normalizedIp = ip.replace(/^::ffff:/, '');
  
  const allowedRanges = [
    { base: '185.71.76.', min: 0, max: 31 },
    { base: '185.71.77.', min: 0, max: 31 },
    { base: '77.75.153.', min: 0, max: 127 },
  ];
  
  for (const range of allowedRanges) {
    if (normalizedIp.startsWith(range.base)) {
      const lastOctet = parseInt(normalizedIp.slice(range.base.length), 10);
      if (!isNaN(lastOctet) && lastOctet >= range.min && lastOctet <= range.max) {
        return true;
      }
    }
  }
  
  return false;
}
