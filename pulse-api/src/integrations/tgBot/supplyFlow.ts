/**
 * Per-user multi-step conversation state for the /supplies create flow
 * (rev 25p). Stored in Redis under `tg:supply_flow:{userId}` with 30-min
 * TTL — long enough that a user can pause-and-resume, short enough that
 * abandoned flows clean themselves up.
 *
 * v0 is a single-step flow (just "quantity") so the state machine is
 * almost trivial. Kept as its own module + step enum so v0.5 can add
 * warehouse + date steps without churning the calling code.
 *
 * Why not @grammyjs/conversations? It's a fine plugin but pulls a fair
 * amount of memory state per chat — the Redis approach degrades safely
 * (lose the key → user just starts over) and matches the back-stack /
 * state-router pattern already in this module.
 */

import { getRedis } from '../../lib/redis.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'tgBotSupplyFlow' });

const KEY_PREFIX = 'tg:supply_flow';
const TTL_SECONDS = 1800; // 30 min

export type SupplyFlowStep = 'quantity';

export interface SupplyFlowState {
  step: SupplyFlowStep;
  workspaceId: number;
  shopId: number | null;
  nmId: number;
  productTitle: string;
  currentStock: number | null;
  avgDaily: number | null;
}

function key(userId: number): string {
  return `${KEY_PREFIX}:${userId}`;
}

export async function startSupplyFlow(userId: number, state: SupplyFlowState): Promise<void> {
  try {
    await getRedis().set(key(userId), JSON.stringify(state), 'EX', TTL_SECONDS);
  } catch (err) {
    logger.warn({ userId, err: (err as Error).message }, 'startSupplyFlow failed');
  }
}

export async function getSupplyFlow(userId: number): Promise<SupplyFlowState | null> {
  try {
    const raw = await getRedis().get(key(userId));
    if (!raw) return null;
    return JSON.parse(raw) as SupplyFlowState;
  } catch {
    return null;
  }
}

export async function clearSupplyFlow(userId: number): Promise<void> {
  try { await getRedis().del(key(userId)); } catch { /* ok */ }
}
