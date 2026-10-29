import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentEvents, wbEvents } from '../../db/schema.js';
import { log } from '../../lib/logger.js';

const logger = log.child({ module: 'eventBridge:agent' });

const CATEGORY_BY_EVENT_TYPE: Record<string, string> = {
  oos_warning: 'stock',
  stock_forecast: 'stock',
  feedback_alert: 'review',
  order_drop: 'sales',
  margin_drop: 'sales',
  price_war: 'price',
  review_spike: 'review',
};

const SEVERITY_BY_AGENT: Record<string, 'info' | 'warn' | 'critical'> = {
  info: 'info',
  warning: 'warn',
  critical: 'critical',
};

const STATUS_BY_AGENT: Record<string, 'open' | 'ack' | 'resolved' | 'done'> = {
  pending: 'open',
  applied: 'done',
  dismissed: 'resolved',
  snoozed: 'ack',
  expired: 'resolved',
};

const PRIORITY_BY_SEVERITY: Record<'info' | 'warn' | 'critical', 'low' | 'medium' | 'high' | 'urgent'> = {
  info: 'medium',
  warn: 'high',
  critical: 'urgent',
};

function bridgeFingerprint(agentEventId: number): string {
  return `bridge:agent:${agentEventId}`;
}

function ymdUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function hhmmUtc(d: Date): string {
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}

type AgentEventRow = typeof agentEvents.$inferSelect;

interface BridgeResult {
  scanned: number;
  inserted: number;
  skippedExisting: number;
  errors: number;
}

/**
 * Map a single agent_events row to wb_events insert payload.
 * Returns null if event_type is unknown (defensive — log and skip).
 */
function mapAgentEventToWb(row: AgentEventRow): typeof wbEvents.$inferInsert | null {
  const category = CATEGORY_BY_EVENT_TYPE[row.eventType];
  if (!category) {
    logger.warn({ agentEventId: row.eventId, eventType: row.eventType }, 'unknown agent event type, skipping');
    return null;
  }

  // AUDIT-05 fix: row.createdAt should always be set per schema (defaultNow),
  // but if it's somehow NULL we'd misattribute the event date to "now".
  // Skip such rows rather than falsifying their timestamps.
  if (!row.createdAt) {
    logger.warn({ agentEventId: row.eventId }, 'agent_event has NULL created_at, skipping');
    return null;
  }
  const createdAt = row.createdAt;

  const severity = SEVERITY_BY_AGENT[row.severity] ?? 'info';
  const status = STATUS_BY_AGENT[row.status] ?? 'open';
  const priority = PRIORITY_BY_SEVERITY[severity];

  return {
    workspaceId: row.workspaceId,
    shopId: row.shopId ?? null,
    nmId: row.nmId ?? null,
    date: ymdUtc(createdAt),
    time: hhmmUtc(createdAt),
    type: 'alert',
    category,
    severity,
    status,
    priority,
    title: row.title,
    description: row.description ?? null,
    evidence: {
      bridgedFrom: 'agent_events',
      agentEventId: row.eventId,
      agentEventType: row.eventType,
      agentSource: row.agentSource ?? null,
      suggestedAction: row.suggestedAction ?? null,
      actionArgs: row.actionArgs ?? null,
      productTitle: row.productTitle ?? null,
      meta: row.meta ?? {},
    },
    tags: [],
    fingerprint: bridgeFingerprint(row.eventId),
    source: 'agent',
    sourceId: String(row.eventId),
    completedAt: row.appliedAt ?? null,
  };
}

/**
 * Copy agent_events rows newer than `sinceCreatedAt` into wb_events.
 * Idempotent via wb_events_fingerprint_uniq (workspace_id + fingerprint).
 *
 * @param sinceCreatedAt — only consider agent_events.created_at > this. Pass `null` to scan all.
 */
export async function bridgeAgentEvents(sinceCreatedAt: Date | null = null): Promise<BridgeResult> {
  const result: BridgeResult = { scanned: 0, inserted: 0, skippedExisting: 0, errors: 0 };

  const where = sinceCreatedAt
    ? gt(agentEvents.createdAt, sinceCreatedAt)
    : sql`true`;

  const rows = await db
    .select()
    .from(agentEvents)
    .where(where)
    .orderBy(agentEvents.createdAt);

  result.scanned = rows.length;
  if (rows.length === 0) {
    return result;
  }

  // Build candidate payloads, grouping by workspace_id so we can do one
  // pre-check SELECT per workspace (rather than 1 SELECT per row).
  type CandidateRow = { agentEventId: number; payload: typeof wbEvents.$inferInsert; fingerprint: string };
  const byWorkspace = new Map<number, CandidateRow[]>();
  for (const row of rows) {
    const payload = mapAgentEventToWb(row);
    if (!payload) continue;
    const list = byWorkspace.get(row.workspaceId) ?? [];
    list.push({ agentEventId: row.eventId, payload, fingerprint: payload.fingerprint! });
    byWorkspace.set(row.workspaceId, list);
  }

  for (const [workspaceId, candidates] of byWorkspace.entries()) {
    const fingerprints = candidates.map((c) => c.fingerprint);

    // Find which fingerprints already exist for this workspace
    let existing = new Set<string>();
    try {
      const rows = await db
        .select({ fingerprint: wbEvents.fingerprint })
        .from(wbEvents)
        .where(and(eq(wbEvents.workspaceId, workspaceId), inArray(wbEvents.fingerprint, fingerprints)));
      existing = new Set(rows.map((r) => r.fingerprint).filter((f): f is string => !!f));
    } catch (err) {
      result.errors += candidates.length;
      logger.error({ err, workspaceId }, 'failed to pre-check existing fingerprints');
      continue;
    }

    const toInsert = candidates.filter((c) => !existing.has(c.fingerprint));
    result.skippedExisting += candidates.length - toInsert.length;

    if (toInsert.length === 0) continue;

    // Bulk insert. If even one row conflicts (race with another tick), the
    // whole batch fails — fall back to per-row insert in that case.
    try {
      await db.insert(wbEvents).values(toInsert.map((c) => c.payload));
      result.inserted += toInsert.length;
    } catch (err) {
      logger.warn({ err, workspaceId, batchSize: toInsert.length }, 'bulk insert failed, falling back to per-row');
      for (const c of toInsert) {
        try {
          await db.insert(wbEvents).values(c.payload);
          result.inserted += 1;
        } catch (rowErr) {
          // Unique violation (race condition) is expected; everything else is an error
          const msg = String((rowErr as any)?.message ?? '');
          if (msg.includes('wb_events_fingerprint_uniq') || msg.includes('duplicate key')) {
            result.skippedExisting += 1;
          } else {
            result.errors += 1;
            logger.error(
              { err: rowErr, agentEventId: c.agentEventId, workspaceId, fingerprint: c.fingerprint },
              'failed to bridge agent_event row',
            );
          }
        }
      }
    }
  }

  return result;
}

/**
 * Convenience: backfill — copies ALL existing agent_events. Run once manually
 * (or from a one-shot script) right after deploy. Subsequent ticks should
 * call `bridgeAgentEvents(sinceCreatedAt)`.
 */
export async function backfillAllAgentEvents(): Promise<BridgeResult> {
  logger.info('starting full backfill of agent_events → wb_events');
  const result = await bridgeAgentEvents(null);
  logger.info({ result }, 'backfill done');
  return result;
}
