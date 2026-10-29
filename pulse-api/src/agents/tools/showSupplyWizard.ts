/**
 * Widget tool `show_supply_wizard` — 3-шаговый виджет в чате для создания
 * FBO-поставки «пара кликов».
 *
 * Шаг 1: top-10 рекомендаций (из последнего run supply-agent).
 * Шаг 2: выбор склада (из wb_warehouses).
 * Шаг 3: deliveryType + кнопка [Создать поставку] → dispatch синтетического
 *   user-сообщения, которое main assistant обработает через action_create_supply.
 *
 * Это ЧИСТО widget-tool: сам ничего не создаёт, только рендерит UI.
 * Реальное создание идёт через action_create_supply с confirmation.
 */

import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  agentRunResults,
  agentSupplyRecommendations,
  wbSupplyItems,
  wbCards,
  wbWarehouses,
} from '../../db/schema.js';

export interface ShowSupplyWizardInput {
  /** Ограничить рекомендациями с этой urgency и выше (default — все). */
  minUrgency?: 'critical' | 'high' | 'medium' | 'low';
  _workspaceId?: number;
  _shopId?: number | null;
}

export async function showSupplyWizard(input: ShowSupplyWizardInput): Promise<string> {
  const wsId = input._workspaceId;
  if (!wsId) return JSON.stringify({ status: 'error', error: 'workspace_id missing' });

  // 1. Последний done run supply-агента
  const [lastRun] = await db
    .select({ runId: agentRunResults.runId, finishedAt: agentRunResults.finishedAt })
    .from(agentRunResults)
    .where(and(
      eq(agentRunResults.workspaceId, wsId),
      eq(agentRunResults.agentName, 'supply'),
      eq(agentRunResults.status, 'done'),
      ...(input._shopId != null ? [eq(agentRunResults.shopId, input._shopId)] : []),
    ))
    .orderBy(desc(agentRunResults.startedAt))
    .limit(1);

  if (!lastRun) {
    return JSON.stringify({
      status: 'ok',
      content:
        'Нет ни одного завершённого анализа Supply-агента. Сначала запустите анализ: в чате напишите «что мне поставить?» либо откройте страницу `/plan` и нажмите «Запустить анализ».',
    });
  }

  // 2. Рекомендации
  const recs = await db
    .select()
    .from(agentSupplyRecommendations)
    .where(eq(agentSupplyRecommendations.runId, lastRun.runId))
    .limit(30);

  // Сортировка: critical → high → medium → low, внутри — по recommendedQty desc
  const urgencyRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = recs
    .slice()
    .sort((a, b) => {
      const ua = urgencyRank[a.urgency] ?? 9;
      const ub = urgencyRank[b.urgency] ?? 9;
      if (ua !== ub) return ua - ub;
      return b.recommendedQty - a.recommendedQty;
    })
    .slice(0, 10);

  // 3. Склады (активные + сортировка)
  const warehouses = await db
    .select({ id: wbWarehouses.id, name: wbWarehouses.name, region: wbWarehouses.region })
    .from(wbWarehouses)
    .where(eq(wbWarehouses.isActive, true));
  warehouses.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));

  // 4. Подтянем barcode для товаров — это нужно для action_create_supply
  const nmIds = sorted.map((r) => r.nmId);
  const barcodesMap = new Map<number, string | null>();
  if (nmIds.length > 0) {
    const itemRows = await db
      .select({ nmId: wbSupplyItems.nmId, barcode: wbSupplyItems.barcode })
      .from(wbSupplyItems)
      .where(isNotNull(wbSupplyItems.nmId));
    for (const r of itemRows) if (r.nmId) barcodesMap.set(r.nmId, r.barcode);
  }

  const wizardItems = sorted.map((r) => ({
    nmId: r.nmId,
    productTitle: r.productTitle,
    currentStock: r.currentStock,
    recommendedQty: r.recommendedQty,
    urgency: r.urgency,
    reason: r.reason,
    barcode: barcodesMap.get(r.nmId) ?? null,
  }));

  return JSON.stringify({
    status: 'ok',
    summary: `Мастер поставки: топ-${wizardItems.length} товаров к пополнению. Выбери склад и тип доставки.`,
    __widget: 'supply_wizard',
    props: {
      workspaceId: wsId,
      shopId: input._shopId ?? null,
      runId: lastRun.runId,
      finishedAt: lastRun.finishedAt,
      items: wizardItems,
      warehouses: warehouses.map((w) => ({ id: w.id, name: w.name, region: w.region })),
    },
  });
}
