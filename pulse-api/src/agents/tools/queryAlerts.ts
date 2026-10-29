/**
 * Tool: query_alerts — Recent alerts and events.
 * Reuses patterns from routes/events.ts
 */

import { db } from '../../db/client.js';
import { wbEvents } from '../../db/schema.js';
import { eq, and, inArray, desc, sql } from 'drizzle-orm';

interface QueryAlertsArgs {
  status?: 'active' | 'resolved' | 'all';
  severity?: 'warn' | 'critical' | 'all';
  limit?: number;
  _workspaceId?: number;
  _shopId?: number;
}

export async function queryAlerts(args: QueryAlertsArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const conds: any[] = [
    eq(wbEvents.workspaceId, wsId),
    ...(shopId ? [eq(wbEvents.shopId, shopId)] : []),
  ];

  if (args.status && args.status !== 'all') {
    conds.push(eq(wbEvents.status, args.status));
  }
  if (args.severity && args.severity !== 'all') {
    conds.push(eq(wbEvents.severity, args.severity));
  }

  const events = await db
    .select({
      eventId: wbEvents.eventId,
      nmId: wbEvents.nmId,
      type: wbEvents.type,
      category: wbEvents.category,
      severity: wbEvents.severity,
      status: wbEvents.status,
      title: wbEvents.title,
      description: wbEvents.description,
      evidence: wbEvents.evidence,
      triggerRule: wbEvents.triggerRule,
      suggestedAction: wbEvents.suggestedAction,
      date: wbEvents.date,
      createdAt: wbEvents.createdAt,
    })
    .from(wbEvents)
    .where(and(...conds))
    .orderBy(desc(wbEvents.createdAt))
    .limit(args.limit ?? 20);

  // Summary counts
  const counts = await db
    .select({
      severity: wbEvents.severity,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(wbEvents)
    .where(and(eq(wbEvents.workspaceId, wsId), ...(shopId ? [eq(wbEvents.shopId, shopId)] : []), eq(wbEvents.status, 'active')))
    .groupBy(wbEvents.severity);

  const criticalCount = counts.find((c) => c.severity === 'critical')?.count ?? 0;
  const warnCount = counts.find((c) => c.severity === 'warn')?.count ?? 0;

  return JSON.stringify({
    summary: { critical: criticalCount, warn: warnCount, total: criticalCount + warnCount },
    events: events.map((e) => ({
      id: e.eventId,
      nmId: e.nmId,
      type: e.type,
      severity: e.severity,
      status: e.status,
      title: e.title,
      description: e.description,
      triggerRule: e.triggerRule,
      suggestedAction: e.suggestedAction,
      date: e.date,
    })),
  });
}
