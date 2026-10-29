import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gt } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { jwtVerify } from 'jose';
import { env } from '../env.js';
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js';
import { db } from '../db/client.js';
import { userSessions } from '../db/schema.js';
import { isValidApiKey } from '../lib/security.js';

const jwtSecret = new TextEncoder().encode(env.JWT_SECRET);

/**
 * IP allowlist for the X-Impersonate-User-Id header.
 *
 * Even with a valid API_KEY, allowing impersonation of any user from anywhere
 * is too broad: a leaked key turns into full-account takeover for every user.
 * Restrict to explicit IPs (CIDRs not supported here on purpose — keep it simple,
 * a single VPS or two should not be hard to enumerate).
 *
 * Configure via `IMPERSONATION_ALLOWED_IPS=127.0.0.1,::1,10.0.0.5` (env var).
 * In production, refusing all impersonation is a sane default — set the env to
 * empty string to disable the feature entirely.
 */
// M16: in production we REFUSE to fall back to a localhost-only default —
// the API runs behind nginx and req.ip is `127.0.0.1` for every legitimate
// request. The original `'127.0.0.1,::1'` default meant any SSRF / internal
// foothold could impersonate any user. Operators who genuinely need
// impersonation set `IMPERSONATION_ALLOWED_IPS` explicitly; absent it,
// the feature is disabled in production. Dev/test still get localhost
// for convenience.
const IMPERSONATION_IPS: Set<string> = new Set(
  (
    process.env.IMPERSONATION_ALLOWED_IPS
    ?? (process.env.NODE_ENV === 'production' ? '' : '127.0.0.1,::1')
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Public routes that never require auth. */
const PUBLIC_PATHS = [
  '/health',
  '/mcp', '/oauth/register', '/oauth/token', '/oauth/revoke',
  '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
  '/auth/login',
  '/auth/register',
  '/auth/waitlist',
  '/auth/refresh',
  '/auth/verify-email',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/reset-with-code',
  '/payments/webhook',
  '/payments/plans',
  '/telegram/bot-webhook',
];

/**
 * Префиксы которые всегда публичны.
 * `/storage/` — публичные UGC ассеты (фото для A/B-тестов которые WB должен
 * скачать при /content/v3/media/save; внешний маркетплейс не может пройти
 * нашу авторизацию). Защита от path traversal уже есть в самом route
 * server.ts:/storage/*. Найдено 2026-05-31: WB возвращал 403 не из-за scope
 * токена, а потому что не мог скачать фото — наш storage отдавал 401.
 */
const PUBLIC_PREFIXES = ['/storage/'];

/** Routes that are public in development only. */
const DEV_PUBLIC_PREFIXES = ['/docs', '/documentation'];

declare module 'fastify' {
  interface FastifyRequest {
    user?: { userId: number; email: string; sessionId: string };
  }
}

const authPluginImpl: FastifyPluginAsync = async (app) => {
  if (!env.API_KEY) {
    throw new Error('FATAL: API_KEY is not set. Server refuses to start without authentication.');
  }

  app.log.info('Auth enabled (JWT cookie + X-API-Key fallback)');

  app.addHook('onRequest', async (req) => {
    // Public routes
    if (PUBLIC_PATHS.includes(req.url.split('?')[0])) return;

    // Public prefixes (always)
    for (const prefix of PUBLIC_PREFIXES) {
      if (req.url.startsWith(prefix)) return;
    }

    // Dev-only public routes
    if (env.NODE_ENV !== 'production') {
      for (const prefix of DEV_PUBLIC_PREFIXES) {
        if (req.url.startsWith(prefix)) return;
      }
    }

    // Strategy 1: X-API-Key header (for scripts, cron, CI tests)
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      if (!isValidApiKey(apiKey)) {
        throw new ForbiddenError('Invalid API key');
      }
      // Optional: allow a trusted API key caller to act on behalf of a specific
      // user by supplying X-Impersonate-User-Id. Required for agent tools that
      // assertAgentAuth() against a real userId (prevents "missing userId" errors
      // in server-to-server flows like E2E tests and internal admin scripts).
      //
      // Security: gated by both API_KEY validity AND a source-IP allowlist.
      // A leaked API key alone is no longer enough to take over any account —
      // the attacker also has to be on a trusted host.
      const impHeader = req.headers['x-impersonate-user-id'];
      const impStr = Array.isArray(impHeader) ? impHeader[0] : impHeader;
      if (typeof impStr === 'string' && impStr.length > 0) {
        const callerIp = req.ip;
        if (!IMPERSONATION_IPS.has(callerIp)) {
          req.log.warn({ callerIp, impStr }, 'X-Impersonate-User-Id rejected: source IP not in allowlist');
          throw new ForbiddenError('Impersonation not allowed from this network');
        }
        const impId = Number(impStr);
        if (Number.isFinite(impId) && impId > 0) {
          // Audit log so any impersonation use is visible after the fact.
          req.log.info({ callerIp, impUserId: impId, route: req.url }, 'API-key impersonation accepted');
          req.user = { userId: impId, email: '', sessionId: 'api-key-impersonation' };
        }
      }
      // Either way, the request is authenticated; downstream RBAC still applies.
      return;
    }

    // Strategy 2: JWT cookie (for browser sessions)
    const token = req.cookies?.session;
    if (typeof token === 'string' && token.length > 0) {
      try {
        const { payload } = await jwtVerify(token, jwtSecret);

        const userId = Number(payload.sub);
        const sessionId = payload.sid as string | undefined;
        const email = payload.email as string | undefined;

        if (!userId || !sessionId) {
          throw new UnauthorizedError('Invalid token payload');
        }

        // Verify session is still valid in DB
        const [session] = await db
          .select()
          .from(userSessions)
          .where(
            and(
              eq(userSessions.sessionId, sessionId),
              eq(userSessions.userId, userId),
              gt(userSessions.expiresAt, new Date())
            )
          )
          .limit(1);

        if (!session) {
          throw new UnauthorizedError('Session expired or invalidated');
        }

        // Attach user to request
        req.user = { userId, email: email ?? '', sessionId };
        return;
      } catch (err) {
        if (err instanceof UnauthorizedError) throw err;
        throw new UnauthorizedError('Invalid or expired session');
      }
    }

    // No auth provided
    throw new UnauthorizedError('Authentication required. Provide X-API-Key header or session cookie.');
  });
};

// Export as non-encapsulated plugin so hooks apply globally.
export default fp(authPluginImpl, { name: 'auth-plugin' });
