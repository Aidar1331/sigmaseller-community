/**
 * Creative Audit Auto-Apply Service
 *
 * Applies audit recommendations to WB cards and tracks impact.
 */

import { db } from '../db/client.js';
import { eq, and, desc, sql, gte, lte } from 'drizzle-orm';
import {
  creativeAuditRunsFinal,
  creativeAuditExperiments,
  wbCards,
  wbEvents,
  wbFunnelDailyProducts,
  wbOrdersSalesDailyProducts,
} from '../db/schema.js';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { safeUpdateCard, getCardsList } from '../integrations/wb/content.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'creative-audit-apply' });

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface ApplyRequest {
  workspaceId: number;
  auditId: number;
  applyTitle: boolean;
  applyDescription: boolean;
  applyCharacteristics: Array<{ id: number; name: string; value: string | string[] }>;
  // Optional per-shop scope — prevents pulling the same nmId from a different
  // shop in the workspace. Falls back to workspace-wide lookup if omitted.
  shopId?: number;
  // Optional text overrides. When provided, sent to WB instead of the
  // audit-suggested values. Used by the UI to let the operator tweak
  // title/description before pushing to the marketplace.
  overrideTitle?: string;
  overrideDescription?: string;
}

export interface ApplyResult {
  experimentId: number;
  appliedFields: string[];
  wbApiResult: { error: boolean; errorText?: string };
}

export interface CardSnapshot {
  title: string | null;
  description: string | null;
  characteristics: Array<{ id: number; name: string; value: string | string[] }>;
}

export interface BaselineMetrics {
  ctr: number;
  conversion: number;
  orders: number;
  revenue: number;
  views: number;
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return isoDate(d);
}

/**
 * Get baseline metrics for a product (last 7 days average)
 */
async function getBaselineMetrics(
  workspaceId: number,
  nmId: number
): Promise<BaselineMetrics> {
  const dateFrom = daysAgo(7);
  const dateTo = daysAgo(1);

  // Get funnel data (views, ctr)
  const [funnelRow] = await db
    .select({
      views: sql<number>`COALESCE(SUM(${wbFunnelDailyProducts.viewCount}), 0)`,
      opens: sql<number>`COALESCE(SUM(${wbFunnelDailyProducts.openCardCount}), 0)`,
      carts: sql<number>`COALESCE(SUM(${wbFunnelDailyProducts.addToCartCount}), 0)`,
      orders: sql<number>`COALESCE(SUM(${wbFunnelDailyProducts.orderCount}), 0)`,
    })
    .from(wbFunnelDailyProducts)
    .where(
      and(
        eq(wbFunnelDailyProducts.workspaceId, workspaceId),
        eq(wbFunnelDailyProducts.nmId, nmId),
        gte(wbFunnelDailyProducts.date, dateFrom),
        lte(wbFunnelDailyProducts.date, dateTo)
      )
    );

  // Get orders/revenue
  const [ordersRow] = await db
    .select({
      orders: sql<number>`COALESCE(SUM(${wbOrdersSalesDailyProducts.ordersCount}), 0)`,
      revenue: sql<number>`COALESCE(SUM(${wbOrdersSalesDailyProducts.ordersRub}), 0)`,
    })
    .from(wbOrdersSalesDailyProducts)
    .where(
      and(
        eq(wbOrdersSalesDailyProducts.workspaceId, workspaceId),
        eq(wbOrdersSalesDailyProducts.nmId, nmId),
        gte(wbOrdersSalesDailyProducts.date, dateFrom),
        lte(wbOrdersSalesDailyProducts.date, dateTo)
      )
    );

  const views = Number(funnelRow?.views ?? 0);
  const opens = Number(funnelRow?.opens ?? 0);
  const orders = Number(ordersRow?.orders ?? funnelRow?.orders ?? 0);
  const revenue = Number(ordersRow?.revenue ?? 0) / 100; // kopecks to rubles

  const ctr = views > 0 ? (opens / views) * 100 : 0;
  const conversion = views > 0 ? (orders / views) * 100 : 0;

  return {
    ctr: Math.round(ctr * 100) / 100,
    conversion: Math.round(conversion * 100) / 100,
    orders,
    revenue: Math.round(revenue),
    views,
  };
}

/**
 * Get current card data.
 *
 * Раньше использовали WB content `getCard(nmId)` → WB API игнорирует
 * фильтр `nmID` (это задокументировано прямо в `content.ts`), возвращает
 * «первую попавшуюся» карточку, проверка по nmID отсекает её → null →
 * «Card not found». Из-за этого Apply на любой аудит падал.
 *
 * Новая логика:
 *   1. Локальный `wb_cards.raw` уже содержит свежий snapshot карточки
 *      (туда же кладёт сборщик каталога). Он — основной источник.
 *   2. Если raw пустой/без полей — пытаемся достать с WB через
 *      `getCardsList({ textSearch: vendorCode })` и ищем точный nmID.
 *   3. Возвращаем null только если оба источника пусты.
 */
async function getCurrentCardData(
  workspaceId: number,
  nmId: number,
  shopId?: number,
  vendorCode?: string,
): Promise<CardSnapshot | null> {
  // 1. Из локальной БД
  const [localCard] = await db
    .select({ raw: wbCards.raw, vendorCode: wbCards.vendorCode, title: wbCards.title })
    .from(wbCards)
    .where(and(
      eq(wbCards.workspaceId, workspaceId),
      eq(wbCards.nmId, nmId),
      ...(shopId != null ? [eq(wbCards.shopId, shopId)] : []),
    ))
    .limit(1);

  const raw = (localCard?.raw ?? null) as any;
  if (raw && (raw.title || raw.description || raw.characteristics)) {
    return {
      title: raw.title ?? localCard?.title ?? null,
      description: raw.description ?? null,
      characteristics: (raw.characteristics ?? []).map((c: any) => ({
        id: c.id,
        name: c.name ?? '',
        value: c.value,
      })),
    };
  }

  // 2. Fallback: WB content API через textSearch по vendorCode.
  //    Фильтр nmID в /content/v2/get/cards/list ненадёжен — текстовый поиск стабильнее.
  const vc = vendorCode || localCard?.vendorCode;
  if (!vc) return null;

  try {
    const apiKey = await getWbApiKey(workspaceId, shopId);
    const list = await getCardsList(apiKey, { cursor: { limit: 100 }, filter: { textSearch: vc } as any });
    const found = (list.cards ?? []).find((c: any) => Number(c.nmID) === nmId);
    if (!found) {
      logger.warn({ nmId, vendorCode: vc, returned: list.cards?.length ?? 0 }, 'WB content: no exact match by textSearch');
      // 3. Самый крайний случай: вернём из локальной БД хотя бы title (без description/chars).
      if (localCard?.title) {
        return { title: localCard.title, description: null, characteristics: [] };
      }
      return null;
    }
    return {
      title: found.title ?? null,
      description: found.description ?? null,
      characteristics: (found.characteristics ?? []).map((c: any) => ({
        id: c.id,
        name: c.name ?? '',
        value: c.value,
      })),
    };
  } catch (err: any) {
    logger.warn({ err: err?.message, nmId }, 'WB content fetch failed, falling back to local title only');
    if (localCard?.title) {
      return { title: localCard.title, description: null, characteristics: [] };
    }
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Apply Audit Recommendations
// ─────────────────────────────────────────────────────────────────

export async function applyAuditRecommendations(
  req: ApplyRequest
): Promise<ApplyResult> {
  const { workspaceId, auditId, applyTitle, applyDescription, applyCharacteristics } = req;

  logger.info({ workspaceId, auditId, applyTitle, applyDescription }, 'Applying audit recommendations');

  // 1. Load audit
  const [audit] = await db
    .select()
    .from(creativeAuditRunsFinal)
    .where(
      and(
        eq(creativeAuditRunsFinal.id, auditId),
        eq(creativeAuditRunsFinal.workspaceId, workspaceId)
      )
    )
    .limit(1);

  if (!audit) {
    throw new Error(`Audit not found: ${auditId}`);
  }

  const nmId = Number(audit.nmId);
  const finalJson = audit.finalJson as any;

  // shopId всегда берём из самого аудита, если caller его не прислал.
  // Без этого в multi-shop workspace getWbApiKey() возьмёт ключ «не того»
  // магазина и WB вернёт null → «Card not found».
  const shopId = req.shopId ?? (audit.shopId != null ? Number(audit.shopId) : undefined);

  // 2. Load local card first — нужен vendorCode для textSearch + он же
  //    источник snapshot'а если WB content API дурит.
  const [localCard] = await db
    .select({ vendorCode: wbCards.vendorCode })
    .from(wbCards)
    .where(and(
      eq(wbCards.workspaceId, workspaceId),
      eq(wbCards.nmId, nmId),
      ...(shopId != null ? [eq(wbCards.shopId, shopId)] : []),
    ))
    .limit(1);

  if (!localCard?.vendorCode) {
    throw new Error(`Local card not found: nmId=${nmId}`);
  }

  // 3. Get current card data (for snapshot)
  const currentCard = await getCurrentCardData(workspaceId, nmId, shopId, localCard.vendorCode);
  if (!currentCard) {
    throw new Error(`Card not found: nmId=${nmId}`);
  }

  // 4. Build update patch (только меняемые поля — остальное берётся из текущей
  // карточки через safeUpdateCard, чтобы не затереть характеристики/title/desc).
  const updatePayload: any = {};

  const appliedFields: string[] = [];

  if (applyTitle) {
    // Override побеждает suggested — оператор мог отредактировать в диалоге.
    const rawTitle = req.overrideTitle != null && req.overrideTitle !== ''
      ? req.overrideTitle
      : finalJson?.contentRewrites?.suggestedTitle;
    if (rawTitle == null) throw new Error('Нет текста заголовка для применения');
    const t = String(rawTitle).trim();
    if (t.length === 0) throw new Error('Заголовок пустой');
    if (t.length > 100) throw new Error(`Заголовок превышает лимит WB: ${t.length} > 100 символов.`);
    updatePayload.title = t;
    appliedFields.push('title');
  }

  if (applyDescription) {
    const rawDesc = req.overrideDescription != null && req.overrideDescription !== ''
      ? req.overrideDescription
      : finalJson?.contentRewrites?.suggestedDescription;
    if (rawDesc == null) throw new Error('Нет текста описания для применения');
    const d = String(rawDesc).trim();
    if (d.length === 0) throw new Error('Описание пустое');
    if (d.length > 5000) throw new Error(`Описание превышает лимит WB: ${d.length} > 5000 символов.`);
    updatePayload.description = d;
    appliedFields.push('description');
  }

  if (applyCharacteristics?.length > 0) {
    updatePayload.characteristics = applyCharacteristics.map((c) => ({
      id: c.id,
      value: c.value,
    }));
    appliedFields.push('characteristics');
  }

  if (appliedFields.length === 0) {
    throw new Error('Nothing to apply');
  }

  // 5. Get baseline metrics
  const baselineMetrics = await getBaselineMetrics(workspaceId, nmId);

  // 6. Call WB API — обязательно с shopId, иначе получим API-ключ «другого» магазина в multi-shop workspace
  const apiKey = await getWbApiKey(workspaceId, shopId);
  const wbResult = await safeUpdateCard(apiKey, nmId, updatePayload);

  if (wbResult.error) {
    logger.error({ wbResult, nmId }, 'WB API error during apply');
    throw new Error(`WB API error: ${wbResult.errorText ?? 'Unknown error'}`);
  }

  // 7. Create experiment record
  const [experiment] = await db
    .insert(creativeAuditExperiments)
    .values({
      workspaceId,
      auditId,
      nmId,
      appliedTitle: applyTitle,
      appliedDescription: applyDescription,
      appliedCharacteristics: applyCharacteristics,
      beforeSnapshot: currentCard,
      baselineMetrics,
      baselineDate: daysAgo(0),
      status: 'running',
    })
    .returning({ experimentId: creativeAuditExperiments.experimentId });

  // 8. Create event log
  await db.insert(wbEvents).values({
    workspaceId,
    nmId,
    date: isoDate(new Date()),
    type: 'log',
    category: 'creative_audit',
    title: `🧪 ${nmId}: A/B-тест #${experiment.experimentId} запущен (${appliedFields.join(', ')})`,
    description: `Применены изменения: ${appliedFields.join(', ')}. `
      + `Базовая конверсия (что было): ${baselineMetrics.conversion.toFixed(2)}% при ${baselineMetrics.views} показах. `
      + `Заказов до изменений: ${baselineMetrics.orders}, выручка: ${(baselineMetrics.revenue / 100).toLocaleString('ru-RU')} ₽. `
      + `Следи за конверсией: если вырастет — оставляем, если упадёт — откатываем через 7 дней.`,
    source: 'agent',
    sourceId: String(auditId),
    status: 'resolved',
    evidence: {
      auditId,
      experimentId: experiment.experimentId,
      appliedFields,
      baselineMetrics,
    },
  });

  logger.info(
    { experimentId: experiment.experimentId, appliedFields, nmId },
    'Audit recommendations applied successfully'
  );

  return {
    experimentId: experiment.experimentId,
    appliedFields,
    wbApiResult: wbResult,
  };
}

// ─────────────────────────────────────────────────────────────────
// Revert Changes
// ─────────────────────────────────────────────────────────────────

export async function revertExperiment(
  workspaceId: number,
  experimentId: number
): Promise<{ reverted: boolean }> {
  logger.info({ workspaceId, experimentId }, 'Reverting experiment');

  // 1. Load experiment
  const [experiment] = await db
    .select()
    .from(creativeAuditExperiments)
    .where(
      and(
        eq(creativeAuditExperiments.experimentId, experimentId),
        eq(creativeAuditExperiments.workspaceId, workspaceId)
      )
    )
    .limit(1);

  if (!experiment) {
    throw new Error(`Experiment not found: ${experimentId}`);
  }

  if (experiment.status === 'reverted') {
    throw new Error('Experiment already reverted');
  }

  const nmId = Number(experiment.nmId);
  const snapshot = experiment.beforeSnapshot as CardSnapshot;

  // 2. Get vendorCode и shopId — shopId нужен чтобы взять «свой» API-ключ магазина в multi-shop workspace
  const [localCard] = await db
    .select({ vendorCode: wbCards.vendorCode, shopId: wbCards.shopId })
    .from(wbCards)
    .where(and(eq(wbCards.workspaceId, workspaceId), eq(wbCards.nmId, nmId)))
    .limit(1);

  if (!localCard?.vendorCode) {
    throw new Error(`Card not found: nmId=${nmId}`);
  }

  // 3. Build revert patch (только меняемые поля; остальное возьмётся из current
  // через safeUpdateCard и не будет затёрто).
  const revertPayload: any = {};

  if (experiment.appliedTitle && snapshot.title) {
    revertPayload.title = snapshot.title;
  }

  if (experiment.appliedDescription && snapshot.description) {
    revertPayload.description = snapshot.description;
  }

  if ((experiment.appliedCharacteristics as any[])?.length > 0 && snapshot.characteristics?.length > 0) {
    revertPayload.characteristics = snapshot.characteristics.map((c) => ({
      id: c.id,
      value: c.value,
    }));
  }

  // 4. Call WB API — обязательно с shopId
  const apiKey = await getWbApiKey(workspaceId, localCard.shopId ?? undefined);
  const wbResult = await safeUpdateCard(apiKey, nmId, revertPayload);

  if (wbResult.error) {
    logger.error({ wbResult, nmId }, 'WB API error during revert');
    throw new Error(`WB API error: ${wbResult.errorText ?? 'Unknown error'}`);
  }

  // 5. Update experiment status
  await db
    .update(creativeAuditExperiments)
    .set({
      status: 'reverted',
      revertedAt: new Date(),
    })
    .where(eq(creativeAuditExperiments.experimentId, experimentId));

  // 6. Create event log
  await db.insert(wbEvents).values({
    workspaceId,
    nmId,
    date: isoDate(new Date()),
    type: 'log',
    category: 'creative_audit',
    title: `↩ ${nmId}: A/B-тест #${experimentId} откатили (вернули прежнюю версию карточки)`,
    source: 'agent',
    status: 'resolved',
  });

  logger.info({ experimentId, nmId }, 'Experiment reverted successfully');

  return { reverted: true };
}

// ─────────────────────────────────────────────────────────────────
// Create Tasks from Audit
// ─────────────────────────────────────────────────────────────────

export interface CreateTaskRequest {
  role: string;
  taskIndex: number;
  assigneeId?: number;
  dueInDays?: number;
}

export async function createTasksFromAudit(
  workspaceId: number,
  auditId: number,
  tasks: CreateTaskRequest[]
): Promise<Array<{ eventId: number; title: string }>> {
  logger.info({ workspaceId, auditId, tasksCount: tasks.length }, 'Creating tasks from audit');

  // 1. Load audit
  const [audit] = await db
    .select()
    .from(creativeAuditRunsFinal)
    .where(
      and(
        eq(creativeAuditRunsFinal.id, auditId),
        eq(creativeAuditRunsFinal.workspaceId, workspaceId)
      )
    )
    .limit(1);

  if (!audit) {
    throw new Error(`Audit not found: ${auditId}`);
  }

  const nmId = Number(audit.nmId);
  const finalJson = audit.finalJson as any;
  const roleTasks = finalJson?.roleTasks ?? {};

  const createdTasks: Array<{ eventId: number; title: string }> = [];
  const today = isoDate(new Date());

  for (const taskReq of tasks) {
    const roleTaskList = roleTasks[taskReq.role] as Array<{ task: string; priority?: string; brief?: string }> | undefined;

    if (!roleTaskList || !roleTaskList[taskReq.taskIndex]) {
      logger.warn({ role: taskReq.role, taskIndex: taskReq.taskIndex }, 'Task not found in audit');
      continue;
    }

    const taskData = roleTaskList[taskReq.taskIndex];
    const priority = taskData.priority ?? 'medium';
    const dueDate = taskReq.dueInDays
      ? new Date(Date.now() + taskReq.dueInDays * 24 * 60 * 60 * 1000)
      : null;

    const roleLabels: Record<string, string> = {
      designer: 'Дизайнер',
      contentManager: 'Контент',
      seoSpecialist: 'SEO',
      photographer: 'Фотограф',
      marketer: 'Маркетолог',
    };

    const title = `[${roleLabels[taskReq.role] ?? taskReq.role}] ${taskData.task}`.slice(0, 140);

    const [event] = await db
      .insert(wbEvents)
      .values({
        workspaceId,
        nmId,
        date: today,
        type: 'task',
        category: 'creative_audit',
        priority: ['critical', 'high', 'medium', 'low'].includes(priority) ? priority : 'medium',
        status: 'open',
        title,
        description: taskData.brief ?? null,
        source: 'creative_audit',
        sourceId: String(auditId),
        assigneeId: taskReq.assigneeId ?? null,
        dueAt: dueDate,
        tags: [taskReq.role],
      })
      .returning({ eventId: wbEvents.eventId });

    createdTasks.push({ eventId: event.eventId, title });
  }

  logger.info({ auditId, createdCount: createdTasks.length }, 'Tasks created from audit');

  return createdTasks;
}

// ─────────────────────────────────────────────────────────────────
// List Experiments
// ─────────────────────────────────────────────────────────────────

export async function listExperiments(
  workspaceId: number,
  status?: string,
  limit: number = 50
) {
  const conditions = [eq(creativeAuditExperiments.workspaceId, workspaceId)];

  if (status) {
    conditions.push(eq(creativeAuditExperiments.status, status));
  }

  const rows = await db
    .select()
    .from(creativeAuditExperiments)
    .where(and(...conditions))
    .orderBy(desc(creativeAuditExperiments.createdAt))
    .limit(limit);

  return rows;
}
