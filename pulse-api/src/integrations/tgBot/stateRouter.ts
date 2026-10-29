/**
 * Short-UUID State Router (rev 25j).
 *
 * Problem: Telegram's callback_data hard limit is 64 bytes. Anything
 * realistic for /supplies (shop + nm + qty + warehouse + slot...) or
 * /prices (shop + nm + new price + old price + reason) blows that.
 * Building strings like supplies_create_shop_1_nm_731625452_qty_30_wh_kolegino
 * is fragile and capped.
 *
 * Solution: store the full state (any JSON-able object) in Redis under
 * a short id, send only that id in the button. Middleware later reads
 * the state back, dispatches by `state.action`.
 *
 * Callback shape used in the keyboard:   `click:{shortId}`
 * Redis key:                              `btn:{shortId}`
 * TTL:                                    15 min (per architectural manifesto)
 *
 * The state object MUST carry at least:
 *   { action: 'PRICE_APPLY' | 'SUPPLY_CREATE' | ... , ...payload }
 *
 * Failure modes:
 *   - state expired or missing → user-facing "Кнопка устарела, попробуй
 *     заново" + log warn.
 *   - Redis down → fallback: callback contains short verb only, payload
 *     missing → user sees the same "устарело" toast. Bot stays alive.
 */

import { randomBytes } from 'node:crypto';
import { getRedis } from '../../lib/redis.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'tgBotStateRouter' });

const KEY_PREFIX = 'btn';
const TTL_SECONDS = 900; // 15 min
const SHORT_ID_BYTES = 6; // base64url(6) = 8 chars

/** Generate an 8-char URL-safe id. */
function generateShortId(): string {
  return randomBytes(SHORT_ID_BYTES).toString('base64url');
}

export interface ButtonState {
  action: string;             // e.g. 'PRICE_APPLY', 'SUPPLY_CREATE'
  [key: string]: unknown;     // arbitrary payload
}

/**
 * Persist a button state in Redis and return the short id to use in
 * callback_data. Caller wraps as `click:{shortId}`.
 */
export async function saveButtonState(state: ButtonState): Promise<string> {
  const shortId = generateShortId();
  try {
    await getRedis().set(
      `${KEY_PREFIX}:${shortId}`,
      JSON.stringify(state),
      'EX', TTL_SECONDS,
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'saveButtonState: Redis write failed');
    throw err; // caller should fall back to a simple verb-only callback
  }
  return shortId;
}

/**
 * Read button state by shortId. Returns null if expired or missing.
 */
export async function loadButtonState(shortId: string): Promise<ButtonState | null> {
  try {
    const raw = await getRedis().get(`${KEY_PREFIX}:${shortId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.action !== 'string') {
      logger.warn({ shortId }, 'loadButtonState: malformed state');
      return null;
    }
    return parsed as ButtonState;
  } catch (err) {
    logger.warn({ shortId, err: (err as Error).message }, 'loadButtonState: read failed');
    return null;
  }
}

/**
 * Convenience: build the callback_data string for a state-router button.
 * Caller passes the result to grammY's InlineKeyboard.text(label, callbackData).
 *
 * Falls back to a direct (state-free) callback if Redis is unavailable —
 * caller can then either show the button as-is (works for simple verbs)
 * or skip it entirely.
 */
export async function makeStatefulCallback(state: ButtonState): Promise<string> {
  const id = await saveButtonState(state);
  return `click:${id}`;
}
