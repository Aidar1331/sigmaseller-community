// Multi-Agent v2 — event sourcing helper (Phase 0 skeleton).
//
// Phase 4 Monitor Agent will consume from system_events. In Phase 0 nothing
// writes here yet — this is pure infrastructure so Phase 1+ callers can start
// emitting events incrementally.

import { db } from '../db/client.js';
import { systemEvents } from '../db/schema.js';

export interface LogSystemEventParams {
  agentName?: string;
  eventType: string; // 'price_changed' | 'campaign_paused' | 'feedback_replied' | ...
  workspaceId?: number;
  shopId?: number | null;
  entityType?: string; // 'card' | 'campaign' | 'supply' | 'feedback' | 'chat' | 'price'
  entityId?: string;
  payload?: unknown;
  correlationId?: string;
}

export async function logSystemEvent(params: LogSystemEventParams): Promise<void> {
  await db.insert(systemEvents).values({
    agentName: params.agentName ?? null,
    eventType: params.eventType,
    workspaceId: params.workspaceId ?? null,
    shopId: params.shopId ?? null,
    entityType: params.entityType ?? null,
    entityId: params.entityId ?? null,
    payload: params.payload === undefined ? null : (params.payload as Record<string, unknown>),
    correlationId: params.correlationId ?? null,
  });
}
