import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { wbEvents } from '../db/schema.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { requireRole } from '../plugins/roleCheck.js';
import { buildShopFilter } from './pulse/helpers.js';

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

async function buildMorningReport(workspaceId: number, date: string, shopId?: number) {
  const start = ymd(new Date(new Date(date + 'T00:00:00Z').getTime() - 14 * 24 * 3600 * 1000));

  const counts = await db
    .select({
      date: wbEvents.date,
      type: wbEvents.type,
      status: wbEvents.status,
      cnt: sql<number>`count(*)`.mapWith(Number),
    })
    .from(wbEvents)
    .where(and(eq(wbEvents.workspaceId, workspaceId), gte(wbEvents.date, start), lt(wbEvents.date, date), buildShopFilter(wbEvents.shopId, shopId)))
    .groupBy(wbEvents.date, wbEvents.type, wbEvents.status);

  const openItems = await db
    .select({
      eventId: wbEvents.eventId,
      nmId: wbEvents.nmId,
      date: wbEvents.date,
      time: wbEvents.time,
      type: wbEvents.type,
      category: wbEvents.category,
      severity: wbEvents.severity,
      status: wbEvents.status,
      title: wbEvents.title,
      description: wbEvents.description,
      dueAt: wbEvents.dueAt,
      createdAt: wbEvents.createdAt,
    })
    .from(wbEvents)
    .where(
      and(
        eq(wbEvents.workspaceId, workspaceId),
        inArray(wbEvents.type, ['alert', 'task'] as any),
        inArray(wbEvents.status, ['open', 'ack'] as any),
        buildShopFilter(wbEvents.shopId, shopId),
      )
    )
    .orderBy(desc(wbEvents.date), desc(wbEvents.createdAt))
    .limit(300);

  const now = Date.now();
  const overdueTasks = openItems.filter((x: any) => x.type === 'task' && x.dueAt && new Date(x.dueAt).getTime() < now);

  return {
    ok: true,
    workspaceId,
    date,
    windowStart: start,
    counts,
    openItems,
    overdueTasksCount: overdueTasks.length,
  };
}

export const reportsRoutes: FastifyPluginAsync = async (app) => {
  // Morning report: counts window + open alerts/tasks
  app.get('/reports/:workspaceId/morning', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({ date: z.string().optional(), shopId: z.coerce.number().int().positive().optional() }).parse(req.query);
    const date = query.date ?? ymd(new Date());
    return buildMorningReport(params.workspaceId, date, query.shopId);
  });

  // Send report to Telegram
  app.post('/reports/:workspaceId/morning/send', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        date: z.string().optional(),
        chatId: z.string().optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse((req as any).body ?? {});

    const date = body.date ?? ymd(new Date());
    const payload = await buildMorningReport(params.workspaceId, date, body.shopId);

    const counts = payload.counts || [];
    const openItems = payload.openItems || [];

    const alerts = counts.filter((c: any) => c.type === 'alert').reduce((a: number, c: any) => a + (c.cnt || 0), 0);
    const tasks = counts.filter((c: any) => c.type === 'task').reduce((a: number, c: any) => a + (c.cnt || 0), 0);

    const header = `📊 <b>Отчёт сейчас</b> — ${date}`;
    const summary = `• Уведомления: <b>${alerts}</b>\n• Задачи: <b>${tasks}</b>\n• Просрочено: <b>${payload.overdueTasksCount || 0}</b>`;

    const topItems = (openItems as any[]).slice(0, 8).map((x) => {
      const tag = x.type === 'task' ? '📝' : x.type === 'alert' ? '⚠️' : 'ℹ️';
      return `${tag} ${x.title}`;
    }).join('\n');

    const text = [header, summary, topItems ? `\n${topItems}` : ''].join('\n');

    await sendTelegramMessage(text, body.chatId);
    return { ok: true, sent: true };
  });
};
