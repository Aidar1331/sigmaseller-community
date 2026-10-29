import { getQueue, JOB_FBS_SCHEDULE_TICK } from './queue.js';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { fbsSchedules, fbsRuns } from '../db/schema.js';
import { env } from '../env.js';
import { logJobs as logger } from '../lib/logger.js';

function toParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return {
    weekday: get('weekday') || 'Mon',
    year: get('year') || '1970',
    month: get('month') || '01',
    day: get('day') || '01',
    hour: get('hour') || '00',
    minute: get('minute') || '00',
  };
}

const WEEKDAY_MAP: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function dateKey(parts: { year: string; month: string; day: string }): string {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function timeKey(parts: { hour: string; minute: string }): string {
  return `${parts.hour}:${parts.minute}`;
}

function normalizeDays(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((d) => Number(d))
    .filter((d) => Number.isFinite(d) && d >= 1 && d <= 7);
}

export async function registerFbsScheduleWorker(): Promise<void> {
  if (env.ENABLE_FBS_SCHEDULER === '0') {
    logger.info('FBS schedule disabled, skipping registration');
    return;
  }

  const boss = await getQueue();
  await boss.createQueue(JOB_FBS_SCHEDULE_TICK);

  // Every minute
  await boss.schedule(JOB_FBS_SCHEDULE_TICK, '* * * * *');

  await boss.work(JOB_FBS_SCHEDULE_TICK, { localConcurrency: 1 }, async () => {
    const now = new Date();

    const schedules = await db
      .select({
        scheduleId: fbsSchedules.scheduleId,
        workspaceId: fbsSchedules.workspaceId,
        shopId: fbsSchedules.shopId,
        daysOfWeek: fbsSchedules.daysOfWeek,
        sendTime: fbsSchedules.sendTime,
        timezone: fbsSchedules.timezone,
        telegramChatId: fbsSchedules.telegramChatId,
        telegramEnabled: fbsSchedules.telegramEnabled,
        isActive: fbsSchedules.isActive,
        lastRunAt: fbsSchedules.lastRunAt,
      })
      .from(fbsSchedules)
      .where(eq(fbsSchedules.isActive, true));

    for (const s of schedules) {
      const tz = s.timezone || 'Europe/Moscow';
      let parts;
      try {
        parts = toParts(now, tz);
      } catch {
        parts = toParts(now, 'Europe/Moscow');
      }

      const dayNum = WEEKDAY_MAP[parts.weekday] || 1;
      const days = normalizeDays(s.daysOfWeek);
      if (!days.includes(dayNum)) continue;

      if (timeKey(parts) !== s.sendTime) continue;

      // Avoid duplicates within same local date
      if (s.lastRunAt) {
        const lastParts = toParts(new Date(s.lastRunAt), tz);
        if (dateKey(lastParts) === dateKey(parts)) {
          continue;
        }
      }

      // Enqueue run
      const { randomUUID } = await import('node:crypto');
      const runId = randomUUID();

      await db.insert(fbsRuns).values({
        runId,
        workspaceId: s.workspaceId,
        scheduleId: s.scheduleId,
        shopId: s.shopId ?? null,
        status: 'queued',
        telegramChatId: s.telegramEnabled ? s.telegramChatId ?? null : null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      try {
        const { JOB_FBS_RUN } = await import('./queue.js');
        await boss.send(JOB_FBS_RUN, { runId, workspaceId: s.workspaceId, shopId: s.shopId ?? null }, {
          retryLimit: 1,
          expireInSeconds: 3600,
        });
      } catch (e) {
        await db
          .update(fbsRuns)
          .set({ status: 'failed', errorText: 'enqueue_failed', updatedAt: new Date(), finishedAt: new Date() })
          .where(eq(fbsRuns.runId, runId));
        continue;
      }

      await db
        .update(fbsSchedules)
        .set({ lastRunAt: new Date(), updatedAt: new Date() })
        .where(and(eq(fbsSchedules.scheduleId, s.scheduleId), eq(fbsSchedules.workspaceId, s.workspaceId)));
    }
  });

  logger.info('FBS schedule registered (tick every minute)');
}
