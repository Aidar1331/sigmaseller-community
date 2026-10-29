/**
 * Pending-action middleware (rev 26d).
 *
 * Write tools the LLM can propose (e.g. set_price) don't fire immediately —
 * they go through a confirmation card. Each proposal gets a short nonce
 * stored in Redis with the full payload; the user taps "Применить" and the
 * actual action runs, or "Отменить" and we drop the nonce.
 *
 * Why Redis rather than PG: pending actions are ephemeral (10-min TTL),
 * scoped to one user, and shouldn't survive a Redis flush — better than
 * leaving stale "Apply?" buttons that fire arbitrary work months later.
 */

import { getRedis } from '../../lib/redis.js';
import { randomBytes } from 'node:crypto';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'tgBot/pendingActions' });

const KEY_PREFIX = 'tg:pending';
const TTL_SECONDS = 600; // 10 min

export type PendingAction =
  | {
      type: 'set_price';
      userId: number;
      workspaceId: number;
      shopId: number;
      nmId: number;
      newPriceRub: number;
      oldPriceRub: number | null;
      productTitle: string;
      reason?: string;
    };

export function newNonce(): string {
  return randomBytes(4).toString('base64url'); // ~6 chars, plenty of entropy for 10-min window
}

export async function savePending(nonce: string, action: PendingAction): Promise<void> {
  try {
    await getRedis().set(
      `${KEY_PREFIX}:${action.userId}:${nonce}`,
      JSON.stringify(action),
      'EX',
      TTL_SECONDS,
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'savePending failed');
  }
}

export async function loadPending(userId: number, nonce: string): Promise<PendingAction | null> {
  try {
    const raw = await getRedis().get(`${KEY_PREFIX}:${userId}:${nonce}`);
    if (!raw) return null;
    return JSON.parse(raw) as PendingAction;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'loadPending failed');
    return null;
  }
}

export async function dropPending(userId: number, nonce: string): Promise<void> {
  try {
    await getRedis().del(`${KEY_PREFIX}:${userId}:${nonce}`);
  } catch { /* ok */ }
}

/**
 * Build the confirmation card body for a pending action. Returns HTML
 * suitable for ctx.reply (parse_mode HTML).
 */
export function renderConfirmationCard(action: PendingAction): string {
  if (action.type === 'set_price') {
    const lines: string[] = [];
    lines.push('⚠️ <b>Хочу применить:</b>');
    lines.push('');
    lines.push(`• Изменить цену на «${escapeHtml(action.productTitle)}»`);
    lines.push(`• Новая цена: <b>${action.newPriceRub} ₽</b>`);
    if (action.oldPriceRub != null && action.oldPriceRub > 0) {
      const deltaPct = ((action.newPriceRub - action.oldPriceRub) / action.oldPriceRub) * 100;
      const arrow = deltaPct >= 0 ? '↗' : '↘';
      lines.push(`• Текущая: ${action.oldPriceRub} ₽ (${arrow}${Math.abs(deltaPct).toFixed(1)}%)`);
    }
    lines.push(`• <a href="https://www.wildberries.ru/catalog/${action.nmId}/detail.aspx">Артикул ${action.nmId}</a>`);
    if (action.reason) {
      lines.push('');
      lines.push(`<i>Причина: ${escapeHtml(action.reason)}</i>`);
    }
    lines.push('');
    lines.push('<i>Действие не выполнится без твоего подтверждения.</i>');
    return lines.join('\n');
  }
  return 'Неизвестное действие';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
