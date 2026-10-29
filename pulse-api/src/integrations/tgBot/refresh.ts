/**
 * Manual per-shop data refresh (rev 26a).
 *
 * Triggered from the shop dashboard's "🔄 Обновить данные" button. Spawns
 * orders/sales + stocks syncs for ONE shop (override the workspace-wide
 * sync's resolution path), bypassing the min-interval guard since the user
 * explicitly asked. The 60s per-user+shop redis lock prevents accidental
 * double-clicks from hammering WB API.
 */
import { getRedis } from '../../lib/redis.js';
import {
  startOrdersSalesSyncForWorkspace,
  getOrdersSalesSyncConfig,
} from '../../jobs/ordersSalesDailySync.js';
import { runStocksSnapshotForWorkspace } from '../../jobs/stocksDailySnapshot.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'tgBot/refresh' });

const LOCK_PREFIX = 'tg:refresh';
const LOCK_TTL_SECONDS = 60;

export type RefreshStatus = 'queued' | 'ok' | 'fail';

export interface RefreshLineState {
  label: string;
  status: RefreshStatus;
  detail?: string;
}

/**
 * Attempt to claim the per-user+shop refresh lock. Returns true if the
 * caller may proceed; false means another refresh is already in flight or
 * fired in the last LOCK_TTL_SECONDS.
 */
export async function tryAcquireRefreshLock(userId: number, shopId: number): Promise<boolean> {
  try {
    const r = getRedis();
    const ok = await r.set(`${LOCK_PREFIX}:${userId}:${shopId}`, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    return ok === 'OK';
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'refresh lock acquire failed; allowing');
    return true;
  }
}

export async function releaseRefreshLock(userId: number, shopId: number): Promise<void> {
  try {
    await getRedis().del(`${LOCK_PREFIX}:${userId}:${shopId}`);
  } catch { /* ok */ }
}

/**
 * Run orders+sales sync for one shop, ignoring the workspace-wide
 * minInterval. Returns the line state to render in the status block.
 */
export async function refreshOrdersSales(
  workspaceId: number,
  shopId: number,
): Promise<RefreshLineState> {
  const baseCfg = getOrdersSalesSyncConfig();
  // Force enabled + zero interval for manual run; daysBack stays at default
  // (typically 2 — enough to catch "today" + yesterday corrections).
  const cfg = { ...baseCfg, enabled: true, minIntervalHours: 0 };
  try {
    const res = await startOrdersSalesSyncForWorkspace(workspaceId, 'manual-refresh', cfg, shopId);
    return { label: 'Заказы и продажи', status: 'ok', detail: res.message };
  } catch (err) {
    const msg = (err as Error).message || 'unknown';
    return { label: 'Заказы и продажи', status: 'fail', detail: shorten(msg) };
  }
}

export async function refreshStocks(
  workspaceId: number,
  shopId: number,
): Promise<RefreshLineState> {
  try {
    const res = await runStocksSnapshotForWorkspace(workspaceId, 'manual-refresh', 0, shopId);
    return { label: 'Остатки', status: res.ran ? 'ok' : 'fail', detail: res.message };
  } catch (err) {
    const msg = (err as Error).message || 'unknown';
    return { label: 'Остатки', status: 'fail', detail: shorten(msg) };
  }
}

function shorten(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? oneLine.slice(0, 79) + '…' : oneLine;
}

const STATUS_ICON: Record<RefreshStatus, string> = {
  queued: '▫️',
  ok: '✅',
  fail: '❌',
};

export function renderRefreshStatus(lines: RefreshLineState[], shopName: string): string {
  const out: string[] = [];
  out.push(`⏳ <b>Обновляю данные · ${shopName}</b>`);
  out.push('');
  for (const l of lines) {
    const icon = STATUS_ICON[l.status];
    const detail = l.status === 'fail' && l.detail ? ` — <i>${escapeHtml(l.detail)}</i>` : '';
    out.push(`${icon} ${l.label}${detail}`);
  }
  return out.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
