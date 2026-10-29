/**
 * Per-user Telegram binding.
 *
 * UX flow:
 *   1. User clicks "Привязать Telegram" in /settings.
 *   2. Frontend calls POST /telegram/link-code → receives { code, startUrl }.
 *   3. User opens startUrl (t.me/<bot>?start=<code>) OR sends
 *      `/start <code>` to the bot manually.
 *   4. Telegram delivers the update to POST /telegram/bot-webhook.
 *   5. Webhook matches the code, writes user_telegram_links, replies
 *      in-chat with a confirmation.
 *   6. Frontend polls GET /telegram/status and flips the badge to "bound".
 *
 * Security:
 *   - `/telegram/link-code`, `/status`, `/unlink` require the user session.
 *   - `/bot-webhook` is public but validated via
 *     `X-Telegram-Bot-Api-Secret-Token` header (TELEGRAM_WEBHOOK_SECRET).
 *   - Codes are single-use, 10-min TTL, 8 chars (40 bits). Brute-forcing
 *     would take on the order of 10^12 / (Telegram rate limits) which is
 *     infeasible before expiry; plus the attacker would have to hit the
 *     bot, not our API directly.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../db/client.js';
import {
  userTelegramLinks,
  userTelegramLinkCodes,
} from '../db/schema.js';
import { env } from '../env.js';
import { UnauthorizedError, ForbiddenError, BadRequestError } from '../lib/errors.js';
import { sendTelegramMessage } from '../integrations/telegram.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'telegramBot' });

const CODE_TTL_MS = 10 * 60 * 1000;

/** 8-char url-safe code. randomBytes(6) → base64url → crop to 8. */
function generateCode(): string {
  return randomBytes(6).toString('base64url').slice(0, 8);
}

export const telegramBotRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /telegram/link-code
   * Authenticated. Issues a fresh code for the current user, expiring in
   * 10 min. Also cleans up this user's expired codes so the table stays
   * bounded.
   */
  app.post('/telegram/link-code', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req) => {
    const user = (req as any).user;
    if (!user) throw new UnauthorizedError('Not authenticated');

    // Opportunistic cleanup: drop expired/consumed codes for this user.
    await db
      .delete(userTelegramLinkCodes)
      .where(
        and(
          eq(userTelegramLinkCodes.userId, user.userId),
          lt(userTelegramLinkCodes.expiresAt, new Date()),
        ),
      );

    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);

    await db.insert(userTelegramLinkCodes).values({
      code,
      userId: user.userId,
      expiresAt,
    });

    const botUsername = env.TELEGRAM_BOT_USERNAME;
    const startUrl = botUsername ? `https://t.me/${botUsername}?start=${code}` : null;

    return {
      code,
      startUrl,
      expiresAt: expiresAt.toISOString(),
      botUsername: botUsername ?? null,
    };
  });

  /**
   * GET /telegram/status
   * Returns whether the current user has Telegram bound.
   */
  app.get('/telegram/status', async (req) => {
    const user = (req as any).user;
    if (!user) throw new UnauthorizedError('Not authenticated');

    const [row] = await db
      .select({
        tgChatId: userTelegramLinks.tgChatId,
        tgUsername: userTelegramLinks.tgUsername,
        linkedAt: userTelegramLinks.linkedAt,
      })
      .from(userTelegramLinks)
      .where(eq(userTelegramLinks.userId, user.userId))
      .limit(1);

    return {
      linked: Boolean(row),
      tgUsername: row?.tgUsername ?? null,
      linkedAt: row?.linkedAt?.toISOString() ?? null,
    };
  });

  /**
   * DELETE /telegram/link
   * Unbinds Telegram for the current user.
   */
  app.delete('/telegram/link', async (req) => {
    const user = (req as any).user;
    if (!user) throw new UnauthorizedError('Not authenticated');

    await db.delete(userTelegramLinks).where(eq(userTelegramLinks.userId, user.userId));
    return { ok: true };
  });

  /**
   * POST /telegram/bot-webhook
   * Public endpoint — Telegram posts updates here. We validate via the
   * `X-Telegram-Bot-Api-Secret-Token` header that Telegram echoes back from
   * setWebhook's `secret_token` parameter. If TELEGRAM_WEBHOOK_SECRET is
   * unset we refuse to process (insecure default).
   *
   * Handles:
   *   - /start <code>  → bind the chat to the user behind the code.
   *   - /start         → friendly greeting.
   *   - /unlink        → let the user sever the binding from the bot side.
   *
   * Everything else is ignored (best-effort; bot is only for auth binding
   * here, not a full command interface).
   */
  app.post('/telegram/bot-webhook', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET;
    if (!expectedSecret) {
      logger.warn('TELEGRAM_WEBHOOK_SECRET not configured — refusing webhook');
      throw new ForbiddenError('Webhook not configured');
    }

    const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (receivedSecret !== expectedSecret) {
      logger.warn({ ip: req.ip }, 'telegram webhook with invalid secret token');
      throw new ForbiddenError('Invalid webhook secret');
    }

    // Delegate to grammY bot (commands, callbacks, link-binding). All
    // update parsing, handler dispatch, and reply logic is now in
    // integrations/tgBot/. Errors inside handlers are caught there so a
    // malformed update doesn't 5xx the webhook (Telegram retries 5xx
    // aggressively, which amplifies any handler bug).
    const { handleTelegramUpdate } = await import('../integrations/tgBot/index.js');
    await handleTelegramUpdate(req.body);
    return reply.code(200).send({ ok: true });
  });
};
