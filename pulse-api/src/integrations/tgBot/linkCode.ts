/**
 * Preserves the existing /start <code> link-binding flow from the
 * pre-grammY webhook handler (routes/telegramBot.ts). The legacy route
 * is being thinned to "validate secret + hand to grammY"; this is where
 * the binding logic now lives.
 *
 * Flow:
 *   1. User clicks "Привязать Telegram" in /settings/notifications.
 *   2. Frontend calls POST /telegram/link-code → receives { code, startUrl }.
 *   3. Frontend opens https://t.me/<bot>?start=<code> in Telegram.
 *   4. Telegram delivers `/start <code>` to the bot via webhook.
 *   5. We atomically consume the code and insert/update user_telegram_links.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';

export interface LinkResult {
  ok: boolean;
  reason?: 'expired_or_invalid' | 'duplicate' | 'db_error';
  userId?: number;
}

/**
 * Atomically consume a one-time link code and bind the chat to the
 * code's owner user.
 *
 * The UPDATE-RETURNING in a single statement is the atomic step — if
 * two webhook calls race the same code, only one of them will get a
 * RETURNING row.
 */
export async function consumeLinkCode(
  code: string,
  chatId: string,
  username: string | null,
): Promise<LinkResult> {
  try {
    const consumed = await db.execute(sql`
      UPDATE user_telegram_link_codes
         SET used_at = NOW()
       WHERE code = ${code}
         AND used_at IS NULL
         AND expires_at > NOW()
      RETURNING user_id;
    `);
    const row = consumed.rows[0] as any;
    if (!row) return { ok: false, reason: 'expired_or_invalid' };
    const userId = Number(row.user_id);

    // Upsert: a user can re-link from a different chat (rotated devices,
    // old chat blocked). Unique index on tg_chat_id means two different
    // users can't share one chat — drizzle/pg will surface that as a
    // duplicate-key error which we map to a friendly message.
    await db.execute(sql`
      INSERT INTO user_telegram_links (user_id, tg_chat_id, tg_username, linked_at)
      VALUES (${userId}, ${chatId}, ${username}, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET tg_chat_id = EXCLUDED.tg_chat_id,
            tg_username = EXCLUDED.tg_username,
            linked_at = NOW();
    `);
    return { ok: true, userId };
  } catch (err: any) {
    if (String(err?.message ?? '').includes('user_telegram_links_chat_uniq')) {
      return { ok: false, reason: 'duplicate' };
    }
    return { ok: false, reason: 'db_error' };
  }
}

export async function unlinkByChatId(chatId: string): Promise<{ ok: boolean; removed: number }> {
  const result = await db.execute(sql`
    DELETE FROM user_telegram_links WHERE tg_chat_id = ${chatId} RETURNING user_id;
  `);
  return { ok: true, removed: result.rows.length };
}
