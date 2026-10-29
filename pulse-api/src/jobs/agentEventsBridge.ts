import { log } from '../lib/logger.js';
import { getRedis } from '../lib/redis.js';
import { bridgeAgentEvents } from '../services/eventBridge/agentEventsToWb.js';

const logger = log.child({ module: 'agentEventsBridge' });

const REDIS_KEY = 'jobs:agentEventsBridge:lastSyncAt';
const FALLBACK_LOOKBACK_HOURS = 24;

async function getLastSyncAt(): Promise<Date | null> {
  try {
    const redis = getRedis();
    const v = await redis.get(REDIS_KEY);
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  } catch (err) {
    logger.warn({ err }, 'failed to read last sync marker, falling back to lookback window');
    return null;
  }
}

async function setLastSyncAt(d: Date): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(REDIS_KEY, d.toISOString());
  } catch (err) {
    logger.warn({ err }, 'failed to write last sync marker (next tick will lookback)');
  }
}

// Race-safety overlap: when we advance the marker we deliberately rewind
// by this much so rows inserted between `startedAt` and the actual SELECT
// inside bridgeAgentEvents get re-scanned next tick. Fingerprint dedup
// makes the re-scan idempotent. See AUDIT-03 (2026-05-24).
const MARKER_OVERLAP_MS = 60_000;

export async function runAgentEventsBridge(): Promise<void> {
  const startedAt = new Date();
  const lastSync = await getLastSyncAt();

  const since = lastSync ?? new Date(Date.now() - FALLBACK_LOOKBACK_HOURS * 3600_000);
  logger.info({ since: since.toISOString(), hadMarker: !!lastSync }, 'bridging agent_events → wb_events');

  const result = await bridgeAgentEvents(since);

  if (result.errors === 0) {
    // Marker = startedAt − overlap. Idempotent (fingerprint uniq) so the
    // small replay window per tick is harmless and seals the race.
    const newMarker = new Date(startedAt.getTime() - MARKER_OVERLAP_MS);
    await setLastSyncAt(newMarker);
  } else {
    logger.warn(
      { result },
      'errors encountered, keeping previous marker so next tick re-scans the window',
    );
  }

  logger.info({ result, durationMs: Date.now() - startedAt.getTime() }, 'bridge tick done');
}
