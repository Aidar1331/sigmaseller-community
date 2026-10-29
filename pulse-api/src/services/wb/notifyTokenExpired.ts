/**
 * Notify the workspace owner that a WB shop's API token has expired.
 *
 * Triggered by refresh runners / cron jobs when a WB 401 surfaces as
 * `WbTokenExpiredError`. The message goes to the user's bound Telegram
 * chat (see integrations/telegram.ts:sendTelegramPerUser). Writes are
 * idempotent per (kind, shop_id, sent_date): a dead token won't spam
 * the user on every 4-hour cron tick — the user sees one message until
 * they rotate the key.
 *
 * The dedup row has `ON CONFLICT DO NOTHING`, so the outer sender skips
 * the Telegram fetch entirely if we've already sent today.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sendTelegramPerUser } from '../../integrations/telegram.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'notifyTokenExpired' });

const KIND = 'wb_token_expired';

interface NotifyArgs {
  workspaceId: number;
  shopId: number;
  /** Optional: display name of the shop for the Telegram text. */
  shopName?: string | null;
}

/**
 * Best-effort notification. Returns true if a new notification was
 * sent, false if it was deduped (already sent today) or skipped
 * silently on DB/Telegram failure.
 */
export async function notifyTokenExpired(args: NotifyArgs): Promise<boolean> {
  const { workspaceId, shopId } = args;

  // Find the workspace owner's userId. Under the single-user-per-
  // workspace model there's exactly one "owner" row; older rows may use
  // other role strings — order by createdAt as a tie-break.
  let ownerUserId: number | null = null;
  try {
    const r = await db.execute<{ user_id: number | string }>(sql`
      SELECT user_id FROM workspace_members
      WHERE workspace_id = ${workspaceId}
      ORDER BY
        CASE WHEN role = 'owner' THEN 0 ELSE 1 END,
        created_at ASC
      LIMIT 1
    `);
    const row = ((r as any).rows ?? r)[0];
    if (row) ownerUserId = Number(row.user_id) || null;
  } catch (err) {
    logger.warn({ err, workspaceId }, 'failed to resolve workspace owner');
    return false;
  }

  // Claim the dedup slot. If another process already claimed it today,
  // ON CONFLICT returns zero rows and we stop without sending.
  let claimed = false;
  try {
    const r = await db.execute<{ shop_id: number }>(sql`
      INSERT INTO notification_dedup (kind, shop_id, sent_date, user_id, sent_at)
      VALUES (${KIND}, ${shopId}, CURRENT_DATE, ${ownerUserId}, NOW())
      ON CONFLICT (kind, shop_id, sent_date) DO NOTHING
      RETURNING shop_id
    `);
    claimed = (((r as any).rows ?? r) as Array<unknown>).length > 0;
  } catch (err) {
    // Table missing (pre-0112) surfaces as 42P01 — degrade gracefully.
    if ((err as any)?.code !== '42P01') {
      logger.warn({ err, workspaceId, shopId }, 'dedup claim failed');
    }
    return false;
  }
  if (!claimed) return false;

  if (!ownerUserId) {
    logger.info({ workspaceId, shopId }, 'token expired, but no owner to notify');
    return false;
  }

  const shopLabel = args.shopName ? `«${args.shopName}»` : `ID ${shopId}`;
  const text =
    `⚠️ API-ключ магазина ${shopLabel} больше не работает (WB сообщает, что токен истёк).\n\n` +
    `Обновите ключ в кабинете WB и вставьте новый в раздел «Настройки магазинов» — ` +
    `синхронизация возобновится автоматически.\n\n` +
    `Пока ключ не обновлён, данные по этому магазину не актуализируются.`;

  try {
    await sendTelegramPerUser(ownerUserId, text);
    logger.info({ workspaceId, shopId, ownerUserId }, 'token-expired notice sent');
    return true;
  } catch (err) {
    // sendTelegramPerUser already swallows errors, but if it somehow
    // throws we don't want to propagate.
    logger.warn({ err }, 'telegram notify failed');
    return false;
  }
}
