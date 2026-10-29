/**
 * Per-user LLM conversation memory (rev 25l).
 *
 * Stores the last MAX_TURNS messages of a chat in Redis at
 * tg:chat_mem:{userId}. TTL 1h — long enough for natural follow-ups,
 * short enough that abandoned dialogues don't accumulate.
 *
 * Memory format:
 *   [
 *     { role: 'user', content: '<text>', t: 1234567890 },
 *     { role: 'assistant', content: '<text>', t: 1234567891 },
 *     ...
 *   ]
 *
 * On each turn:
 *   1. loadHistory(userId)  → existing turns (oldest-first)
 *   2. user-message appended via appendUser
 *   3. LLM called with [slimmed history + new user turn]
 *   4. appendAssistant(reply)
 *
 * Context slimming:
 *   For old messages (≥ SLIM_DEPTH turns ago), strip:
 *     - [BUTTON: ...] markers
 *     - <pre>...</pre> blocks longer than 200 chars (likely tables)
 *   This caps token growth on long dialogues. The most recent
 *   SLIM_DEPTH turns stay verbatim so the model still has full context.
 */

import { getRedis } from '../../lib/redis.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'tgBotChatMemory' });

const KEY_PREFIX = 'tg:chat_mem';
const TTL_SECONDS = 3600; // 1h
const MAX_TURNS = 6;       // max kept after each turn (slides forward)
const SLIM_DEPTH = 3;      // turns older than this get slimmed

export type ChatRole = 'user' | 'assistant';
export interface MemTurn {
  role: ChatRole;
  content: string;
  t: number; // ms epoch
}

function key(userId: number): string {
  return `${KEY_PREFIX}:${userId}`;
}

export async function loadHistory(userId: number): Promise<MemTurn[]> {
  try {
    const raw = await getRedis().get(key(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isMemTurn) : [];
  } catch (err) {
    logger.warn({ userId, err: (err as Error).message }, 'loadHistory failed');
    return [];
  }
}

function isMemTurn(x: any): x is MemTurn {
  return x && (x.role === 'user' || x.role === 'assistant')
    && typeof x.content === 'string' && typeof x.t === 'number';
}

async function persist(userId: number, turns: MemTurn[]): Promise<void> {
  // Always keep only the last MAX_TURNS turns
  const trimmed = turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns;
  try {
    await getRedis().set(key(userId), JSON.stringify(trimmed), 'EX', TTL_SECONDS);
  } catch (err) {
    logger.warn({ userId, err: (err as Error).message }, 'persist failed');
  }
}

export async function appendUser(userId: number, content: string): Promise<void> {
  const history = await loadHistory(userId);
  history.push({ role: 'user', content, t: Date.now() });
  await persist(userId, history);
}

export async function appendAssistant(userId: number, content: string): Promise<void> {
  const history = await loadHistory(userId);
  history.push({ role: 'assistant', content, t: Date.now() });
  await persist(userId, history);
}

export async function resetHistory(userId: number): Promise<void> {
  try { await getRedis().del(key(userId)); } catch { /* ok */ }
}

/**
 * Take the raw history and apply slimming rules — return what to feed
 * into the Anthropic API as `messages`. The most recent SLIM_DEPTH turns
 * stay verbatim; older turns get button-stripped and any large <pre>
 * block (>200 chars) replaced with "<i>[таблица]</i>".
 */
export function slimForLLM(history: MemTurn[]): Array<{ role: ChatRole; content: string }> {
  const sliceIdx = Math.max(0, history.length - SLIM_DEPTH);
  return history.map((turn, i) => {
    if (i >= sliceIdx) {
      // Recent — keep verbatim
      return { role: turn.role, content: turn.content };
    }
    return { role: turn.role, content: slimText(turn.content) };
  });
}

function slimText(text: string): string {
  return text
    // strip BUTTON markers
    .replace(/\[BUTTON:[^\]]*\]/g, '')
    // collapse large <pre> blocks
    .replace(/<pre>([\s\S]*?)<\/pre>/g, (_m, body) => {
      return body.length > 200 ? '<i>[таблица]</i>' : `<pre>${body}</pre>`;
    })
    // tidy multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
