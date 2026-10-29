/**
 * CSRF double-submit guard.
 *
 * The cookie path:
 *   - On login/register/refresh (routes/auth.ts) we issue a random `csrf`
 *     cookie. It is NOT httpOnly, so JavaScript in pulse-web can read it.
 *   - Browser code echoes the value as `X-CSRF-Token` on mutating
 *     requests (POST/PUT/PATCH/DELETE). An attacker on another origin
 *     can send the request but cannot read our cookie (same-origin
 *     policy), so they cannot forge the matching header.
 *
 * Scope:
 *   - Only enforced on session-cookie auth. Requests authenticated via
 *     `X-API-Key` (scripts, webhooks, agent-to-agent) are exempt — the
 *     API key itself is the credential.
 *   - YooKassa webhook is exempt (external origin, no cookies at all,
 *     IP-allowlist guards the route separately).
 *   - Safe methods (GET/HEAD/OPTIONS) are never checked.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ForbiddenError } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Paths that don't go through the cookie-auth flow at all.
const EXEMPT_PATHS = new Set<string>([
  '/mcp', '/oauth/register', '/oauth/token', '/oauth/revoke',
  '/payments/webhook',
  '/telegram/bot-webhook',
  // Login family: there's no session yet when these fire.
  '/auth/login',
  '/auth/register',
  '/auth/refresh',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/reset-with-code',
  '/auth/verify-email',
  '/auth/logout', // idempotent and destructive of attacker's target anyway
]);

function isExempt(req: FastifyRequest): boolean {
  if (SAFE_METHODS.has(req.method)) return true;

  // API-key authenticated requests skip CSRF — the key itself is the proof.
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) return true;

  const path = req.url.split('?')[0];
  if (EXEMPT_PATHS.has(path)) return true;

  return false;
}

const csrfPluginImpl: FastifyPluginAsync = async (app) => {
  app.log.info('CSRF double-submit enforced on mutating cookie-auth requests');

  app.addHook('preHandler', async (req) => {
    if (isExempt(req)) return;

    // Only enforce on cookie-auth sessions. If no cookie, auth plugin
    // will 401 first — nothing for us to protect.
    const sessionCookie = req.cookies?.session;
    if (!sessionCookie) return;

    const csrfCookie = req.cookies?.csrf;
    const headerRaw = req.headers['x-csrf-token'];
    const headerValue = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;

    if (!csrfCookie || !headerValue || csrfCookie !== headerValue) {
      throw new ForbiddenError('CSRF token missing or invalid');
    }
  });
};

export default fp(csrfPluginImpl, { name: 'csrf-plugin' });
