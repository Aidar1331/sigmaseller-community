import { db } from '../db/client.js';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt } from 'drizzle-orm';
import { insights } from '../db/schema.js';
import log from '../lib/logger.js';

export type InsightInsert = {
  workspaceId: number;
  nmId?: number | null;
  date: string; // YYYY-MM-DD
  insightType: string;
  category: string;
  severity?: 'info' | 'warn' | 'critical' | string | null;
  score?: number | null;
  title: string;
  description?: string | null;
  evidence?: any;
  fingerprint?: string | null;
  cooldownDays?: number;
};

export function sensitivityMultiplier(level: string | null | undefined): number {
  if (level === 'sensitive') return 0.5;
  if (level === 'critical') return 2;
  return 1;
}

export function baseThresholdPct(level: string | null | undefined): number {
  const base = 0.2; // 20%
  return base * sensitivityMultiplier(level);
}

export function severityByDelta(deltaPct: number, thresholdPct: number): 'info' | 'warn' | 'critical' {
  const ad = Math.abs(deltaPct);
  if (ad >= thresholdPct * 2) return 'critical';
  if (ad >= thresholdPct) return 'warn';
  return 'info';
}

export function scoreByDelta(deltaPct: number, volume: number): number {
  const magnitude = Math.abs(deltaPct) * 100;
  const v = Math.log10(1 + Math.max(0, volume));
  return Math.max(1, Math.round(magnitude * v));
}

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function dateSub(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return ymd(d);
}

export async function insertInsight(row: InsightInsert): Promise<{ inserted: boolean; trend?: 'strengthening' | null }> {
  const cooldown = row.cooldownDays ?? 3;

  if (cooldown > 0) {
    const from = dateSub(row.date, cooldown);
    const prev = await db
      .select({ insightId: insights.insightId, score: insights.score })
      .from(insights)
      .where(
        and(
          eq(insights.workspaceId, row.workspaceId),
          eq(insights.insightType, row.insightType),
          row.nmId ? eq(insights.nmId, row.nmId as any) : sql`true`,
          gte(insights.date, from)
        )
      )
      .orderBy(desc(insights.createdAt))
      .limit(1);

    const last = prev[0];
    if (last && row.score != null) {
      const lastScore = Number(last.score ?? 0);
      if (lastScore > 0 && row.score <= Math.round(lastScore * 1.1)) {
        return { inserted: false };
      }
      row.evidence = { ...(row.evidence ?? {}), trend: 'strengthening' };
    }
  }

  try {
    await db.insert(insights).values({
      workspaceId: row.workspaceId,
      nmId: row.nmId ?? null,
      date: row.date,
      insightType: row.insightType,
      category: row.category,
      severity: row.severity ?? null,
      score: row.score ?? null,
      title: row.title,
      description: row.description ?? null,
      evidence: row.evidence ?? {},
      fingerprint: row.fingerprint ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (e: any) {
    log.warn({ workspaceId: row.workspaceId, category: row.category, error: e?.message }, 'insights: upsert failed');
    return { inserted: false };
  }

  return { inserted: true, trend: (row.evidence as any)?.trend ?? null };
}
