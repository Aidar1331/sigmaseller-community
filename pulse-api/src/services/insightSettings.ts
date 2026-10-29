import { db } from '../db/client.js';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt } from 'drizzle-orm';
import { insightSettings } from '../db/schema.js';

export type InsightSettingsRow = {
  workspaceId: number;
  sensitivity: string;
  minStockDays: number;
  targetDrrPct: number;
  excludedTagIds: number[];
  notifyChannels: any;
  notifyTime: string;
  timezone: string;
  lastRunAt: Date | null;
};

export function defaultInsightSettings(workspaceId: number): InsightSettingsRow {
  return {
    workspaceId,
    sensitivity: 'standard',
    minStockDays: 5,
    targetDrrPct: 20,
    excludedTagIds: [],
    notifyChannels: { ui: true, telegram: false, categories: {} },
    notifyTime: '08:00',
    timezone: 'Europe/Moscow',
    lastRunAt: null,
  };
}

export async function getInsightSettings(workspaceId: number): Promise<InsightSettingsRow> {
  const rows = await db.select().from(insightSettings).where(eq(insightSettings.workspaceId, workspaceId)).limit(1);
  if (rows.length) {
    const r = rows[0] as any;
    return {
      workspaceId,
      sensitivity: String(r.sensitivity ?? 'standard'),
      minStockDays: Number(r.minStockDays ?? 5),
      targetDrrPct: Number(r.targetDrrPct ?? 20),
      excludedTagIds: Array.isArray(r.excludedTagIds) ? r.excludedTagIds.map(Number) : [],
      notifyChannels: r.notifyChannels ?? { ui: true, telegram: false, categories: {} },
      notifyTime: String(r.notifyTime ?? '08:00'),
      timezone: String(r.timezone ?? 'Europe/Moscow'),
      lastRunAt: r.lastRunAt ?? null,
    };
  }

  const defaults = defaultInsightSettings(workspaceId);
  const [row] = await db
    .insert(insightSettings)
    .values({
      workspaceId: defaults.workspaceId,
      sensitivity: defaults.sensitivity,
      minStockDays: defaults.minStockDays,
      targetDrrPct: defaults.targetDrrPct,
      excludedTagIds: defaults.excludedTagIds,
      notifyChannels: defaults.notifyChannels,
      notifyTime: defaults.notifyTime,
      timezone: defaults.timezone,
      updatedAt: new Date(),
    })
    .returning();

  return {
    workspaceId,
    sensitivity: String(row.sensitivity ?? 'standard'),
    minStockDays: Number(row.minStockDays ?? 5),
    targetDrrPct: Number(row.targetDrrPct ?? 20),
    excludedTagIds: Array.isArray(row.excludedTagIds) ? row.excludedTagIds.map(Number) : [],
    notifyChannels: row.notifyChannels ?? { ui: true, telegram: false, categories: {} },
    notifyTime: String(row.notifyTime ?? '08:00'),
    timezone: String(row.timezone ?? 'Europe/Moscow'),
    lastRunAt: row.lastRunAt ?? null,
  };
}

export async function updateInsightLastRun(workspaceId: number, at: Date) {
  await db
    .update(insightSettings)
    .set({ lastRunAt: at, updatedAt: new Date() })
    .where(eq(insightSettings.workspaceId, workspaceId));
}
