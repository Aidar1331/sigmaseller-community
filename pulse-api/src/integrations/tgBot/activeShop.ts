/**
 * Per-user "active shop" scope (rev 27f).
 *
 * When the user opens a specific shop dashboard, we record that shop_id in
 * Redis. Subsequent /alerts /prices /feedback /supplies queries filter to
 * just that shop instead of fanning out across the whole workspace.
 *
 * TTL is 6h — long enough for a full work session, short enough that the
 * scope auto-clears overnight so the user isn't surprised the next morning
 * that "yesterday's shop" still scoped everything.
 *
 * Setting null/undefined clears the scope.
 */
import { getRedis } from '../../lib/redis.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'tgBot/activeShop' });

const KEY_PREFIX = 'tg:active_shop';
const TTL_SECONDS = 6 * 3600;

function key(userId: number): string {
  return `${KEY_PREFIX}:${userId}`;
}

export async function setActiveShop(userId: number, shopId: number | null): Promise<void> {
  try {
    if (shopId == null) {
      await getRedis().del(key(userId));
    } else {
      await getRedis().set(key(userId), String(shopId), 'EX', TTL_SECONDS);
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'setActiveShop failed');
  }
}

export async function getActiveShopId(userId: number): Promise<number | null> {
  try {
    const v = await getRedis().get(key(userId));
    if (!v) return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'getActiveShopId failed');
    return null;
  }
}

export async function clearActiveShop(userId: number): Promise<void> {
  await setActiveShop(userId, null);
}
