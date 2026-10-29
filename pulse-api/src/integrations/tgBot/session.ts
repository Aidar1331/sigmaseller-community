/**
 * Per-chat navigation session (rev 25g, completes v2.0-α).
 *
 * Stores a stack of "where the user is" so the `⬅️ Назад` button can
 * pop to the previous view, not jump to main menu. Backed by Redis with
 * a 24h TTL — long enough for users to come back after a break, short
 * enough that abandoned sessions don't accumulate.
 *
 * A NavFrame is a tagged callback-style route — verb + args. The bot
 * encodes each "where am I" using the same `verb:args` shape that
 * callback_data uses (e.g. {verb:'shop', args:['4','today']}), so the
 * dispatcher in handlers.ts can re-execute a frame just by feeding it
 * back into the existing switch — no special "re-render" code path.
 *
 * Stack size capped at MAX_DEPTH to bound Redis memory + protect
 * against pathological loops. Older frames roll off the bottom.
 */

import { getRedis } from '../../lib/redis.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'tgBotSession' });

const TTL_SECONDS = 172_800; // rev 27g: bumped to 48h so back-nav survives overnight sessions
const MAX_DEPTH = 12;
const KEY_PREFIX = 'tg:nav';

export interface NavFrame {
  verb: string;
  args: string[];
}

function key(chatId: number | string): string {
  return `${KEY_PREFIX}:${chatId}`;
}

export async function readStack(chatId: number | string): Promise<NavFrame[]> {
  try {
    const raw = await getRedis().get(key(chatId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f) => typeof f?.verb === 'string') : [];
  } catch (err) {
    logger.warn({ err: (err as Error).message, chatId }, 'session read failed');
    return [];
  }
}

export async function writeStack(chatId: number | string, stack: NavFrame[]): Promise<void> {
  try {
    const trimmed = stack.length > MAX_DEPTH ? stack.slice(stack.length - MAX_DEPTH) : stack;
    await getRedis().set(key(chatId), JSON.stringify(trimmed), 'EX', TTL_SECONDS);
  } catch (err) {
    logger.warn({ err: (err as Error).message, chatId }, 'session write failed');
  }
}

/** Push a new frame and persist. Returns the new stack (for tests). */
export async function pushFrame(chatId: number | string, frame: NavFrame): Promise<NavFrame[]> {
  const stack = await readStack(chatId);
  // De-dup: pushing the same frame twice (e.g. period-switch within shop
  // dashboard) replaces the top rather than growing the stack.
  const top = stack[stack.length - 1];
  if (top && top.verb === frame.verb && argsEqual(top.args, frame.args)) {
    // identical — no change
    return stack;
  }
  // Otherwise: REPLACE rather than push when the new frame is a sibling
  // VIEW of the top — meaning same verb AND same primary id (args[0]).
  // This collapses period-switches inside one shop (shop:4:today →
  // shop:4:7d) but PRESERVES drill-downs (alerts:list → alerts:stock_zero,
  // where args[0] differs).
  const sameView = top && top.verb === frame.verb
    && frame.args.length > 0 && top.args[0] === frame.args[0];
  if (sameView) {
    stack[stack.length - 1] = frame;
  } else {
    stack.push(frame);
  }
  await writeStack(chatId, stack);
  return stack;
}

/** Pop the top frame and persist. Returns the popped frame, or null. */
export async function popFrame(chatId: number | string): Promise<NavFrame | null> {
  const stack = await readStack(chatId);
  if (stack.length === 0) return null;
  const popped = stack.pop()!;
  await writeStack(chatId, stack);
  return popped;
}

/** Reset stack to the root (main menu). */
export async function resetStack(chatId: number | string): Promise<void> {
  try {
    await getRedis().del(key(chatId));
  } catch (err) {
    logger.warn({ err: (err as Error).message, chatId }, 'session reset failed');
  }
}

/** Peek at the previous frame WITHOUT popping. Used to compute the
 *  "back" target label inside menu builders. */
export async function peekPrev(chatId: number | string): Promise<NavFrame | null> {
  const stack = await readStack(chatId);
  return stack.length >= 2 ? stack[stack.length - 2] : null;
}

function argsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Serialise a frame to the callback_data shape (verb:args). Used by the
 *  back-handler to feed the previous frame back into the normal
 *  callback dispatcher. */
export function frameToCallback(frame: NavFrame): string {
  return frame.args.length === 0 ? frame.verb : `${frame.verb}:${frame.args.join(':')}`;
}
