/**
 * Tool `action_prepare_fbw_supply` — готовит FBW-поставку:
 *
 *   1. Через `POST /api/v1/acceptance/options` находит склады, которые
 *      физически могут принять указанные товары.
 *   2. Для топ-кандидатов смотрит коэф приёмки из `supply_slots_cache`
 *      (наполняется acceptanceCoeffMonitor) на горизонте 14 дней.
 *   3. Применяет per-ws/SKU порог `supply_box_settings.alert_coeff_threshold`
 *      чтобы выбрать «комфортный» слот.
 *   4. Считает примерную стоимость приёмки (`acceptanceCost`) и пишет
 *      рекомендацию в `agent_supply_recommendations`.
 *   5. Возвращает 1-3 кандидата + deep-link на ЛК WB
 *      (https://seller.wildberries.ru/supplies-management/new-order) —
 *      по нему пользователь создаёт preorder вручную, **потому что WB
 *      убрал API создания FBW-поставок** (см. live-probe 2026-05-27).
 *
 * После того как preorder появится в WB, `suppliesSync` подхватит его
 * автоматически — и `actionBookSupplySlot` / `actionQueueAutoBook` уже
 * умеют работать с existing preorderID.
 *
 * Безопасно: read-only, не требует подтверждения.
 */

import { eq, and, gte, lte, sql, inArray, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  wbCards,
  wbWarehouses,
  supplySlotsCache,
  supplyBoxSettings,
  supplyPriorityWarehouses,
  agentSupplyRecommendations,
  agentRunResults,
} from '../../db/schema.js';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { getAcceptanceOptions } from '../../integrations/wb/supplies/client.js';
import { computeSupplyRoi, formatSupplyRoiForChat, type SupplyRoiResult } from '../../services/supplyRoi.js';
import { log } from '../../lib/logger.js';
import { randomUUID } from 'node:crypto';

const logger = log.child({ module: 'actionPrepareFbwSupply' });

const FBW_DEEP_LINK_BASE = 'https://seller.wildberries.ru/supplies-management/new-order';

export interface ActionPrepareFbwSupplyArgs {
  /** Артикулы WB для отгрузки. */
  nmIds: number[];
  /** Запланированные количества по nmId. Если не задано — берём avg за 14 дней × 30. */
  quantities?: Record<string, number>;
  /** Если пользователь указал предпочитаемый склад. */
  preferredWarehouseId?: number;
  /** Тип упаковки. */
  packageType?: 'box' | 'mono_pallet' | 'super_safe';
  /** Дополнительные дни запаса (default 30). */
  targetDays?: number;
  _workspaceId?: number;
  _shopId?: number;
}

interface WarehouseCandidate {
  warehouseId: number;
  warehouseName: string;
  acceptedItems: number; // сколько SKU реально может принять (из request)
  totalItems: number;
  bestCoefficient: number | null; // минимальный из supply_slots_cache на 14д
  bestDate: string | null;
  isPriority: boolean;
}

export async function actionPrepareFbwSupply(
  args: ActionPrepareFbwSupplyArgs,
): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  if (!args.nmIds || args.nmIds.length === 0) {
    return JSON.stringify({ error: 'nmIds is required (>= 1)' });
  }

  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    // 1) Pull barcodes for the given nmIds from wb_cards
    const cards = await db
      .select({
        nmId: wbCards.nmId,
        title: wbCards.title,
        raw: wbCards.raw,
      })
      .from(wbCards)
      .where(and(eq(wbCards.workspaceId, wsId), inArray(wbCards.nmId, args.nmIds.map(BigInt) as any)));

    const nmToBarcode = new Map<number, { barcode: string; title: string }>();
    for (const c of cards) {
      const sizes = (c.raw as any)?.sizes ?? [];
      for (const size of sizes) {
        const skus = size?.skus ?? [];
        if (skus.length > 0) {
          nmToBarcode.set(Number(c.nmId), { barcode: String(skus[0]), title: c.title ?? '' });
          break;
        }
      }
    }

    const missing = args.nmIds.filter((nm) => !nmToBarcode.has(nm));
    if (missing.length > 0) {
      logger.warn({ wsId, missing }, 'some nmIds have no barcode in wb_cards');
    }

    // 2) Compose acceptance/options request
    const reqItems = args.nmIds
      .filter((nm) => nmToBarcode.has(nm))
      .map((nm) => {
        const fromArgs = args.quantities?.[String(nm)];
        return {
          barcode: nmToBarcode.get(nm)!.barcode,
          quantity: fromArgs ?? 10, // дефолт пока без forecast
        };
      });
    if (reqItems.length === 0) {
      return JSON.stringify({
        error: 'Ни у одного nmId не нашлось баркода в wb_cards. Возможно нужен ресинк карточек.',
      });
    }

    const opts = await getAcceptanceOptions(apiKey, reqItems, args.preferredWarehouseId);

    // 3) Aggregate warehouses
    const whStats = new Map<number, { accepted: number; total: number }>();
    for (const r of opts.result) {
      if (r.isError || !r.warehouses) continue;
      for (const wh of r.warehouses) {
        const stat = whStats.get(wh.warehouseID) ?? { accepted: 0, total: 0 };
        stat.total += 1;
        const can =
          (args.packageType ?? 'box') === 'box' ? wh.canBox :
          args.packageType === 'mono_pallet' ? wh.canMonopallet :
          wh.canSupersafe;
        if (can) stat.accepted += 1;
        whStats.set(wh.warehouseID, stat);
      }
    }

    if (whStats.size === 0) {
      return JSON.stringify({
        status: 'no_warehouses',
        message: 'WB не вернул ни одного склада с возможностью приёмки. Проверь баркоды в карточках или увеличь quantity.',
      });
    }

    // 4) Pull warehouse names + priority + cached coefficients
    const whIds = Array.from(whStats.keys());
    const whNames = await db
      .select({ id: wbWarehouses.id, name: wbWarehouses.name })
      .from(wbWarehouses)
      .where(inArray(wbWarehouses.id, whIds));
    const nameMap = new Map(whNames.map((w) => [w.id, w.name]));

    const priorities = await db
      .select({ warehouseId: supplyPriorityWarehouses.warehouseId, priority: supplyPriorityWarehouses.priority })
      .from(supplyPriorityWarehouses)
      .where(eq(supplyPriorityWarehouses.workspaceId, wsId));
    const prioritySet = new Set(priorities.map((p) => p.warehouseId));

    const today = new Date();
    const horizon14d = new Date(today.getTime() + 14 * 86400_000);
    const horizonStr = horizon14d.toISOString().slice(0, 10);
    const slotRows = await db
      .select({
        warehouseId: supplySlotsCache.warehouseId,
        date: supplySlotsCache.date,
        coefficient: supplySlotsCache.coefficient,
        available: supplySlotsCache.available,
      })
      .from(supplySlotsCache)
      .where(
        and(
          eq(supplySlotsCache.workspaceId, wsId),
          inArray(supplySlotsCache.warehouseId, whIds),
          gte(supplySlotsCache.date, today.toISOString().slice(0, 10)),
          lte(supplySlotsCache.date, horizonStr),
        ),
      );

    const bestSlot = new Map<number, { coefficient: number; date: string }>();
    for (const row of slotRows) {
      const coef = row.coefficient != null ? Number(row.coefficient) : null;
      if (coef == null || coef < 0 || row.available === false) continue;
      const cur = bestSlot.get(row.warehouseId);
      if (!cur || coef < cur.coefficient || (coef === cur.coefficient && row.date < cur.date)) {
        bestSlot.set(row.warehouseId, { coefficient: coef, date: row.date });
      }
    }

    // 5) Apply threshold from supply_box_settings (workspace default; per-nm если bulk не подходит)
    const [wsDefault] = await db
      .select({ threshold: supplyBoxSettings.alertCoeffThreshold })
      .from(supplyBoxSettings)
      .where(and(eq(supplyBoxSettings.workspaceId, wsId), sql`nm_id IS NULL`))
      .limit(1);
    const threshold = wsDefault?.threshold != null ? Number(wsDefault.threshold) : 1.0;

    // 6) Score & rank candidates
    const candidates: WarehouseCandidate[] = whIds.map((id) => {
      const stat = whStats.get(id)!;
      const slot = bestSlot.get(id) ?? null;
      return {
        warehouseId: id,
        warehouseName: nameMap.get(id) ?? `wh-${id}`,
        acceptedItems: stat.accepted,
        totalItems: stat.total,
        bestCoefficient: slot?.coefficient ?? null,
        bestDate: slot?.date ?? null,
        isPriority: prioritySet.has(id),
      };
    });

    const ranked = candidates
      .filter((c) => c.acceptedItems > 0)
      .sort((a, b) => {
        // Priority warehouses first
        if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1;
        // Then by accept count (more is better)
        if (b.acceptedItems !== a.acceptedItems) return b.acceptedItems - a.acceptedItems;
        // Then by best coefficient (lower is better, null = unknown = worst)
        const ca = a.bestCoefficient ?? 99;
        const cb = b.bestCoefficient ?? 99;
        return ca - cb;
      })
      .slice(0, 3);

    if (ranked.length === 0) {
      return JSON.stringify({
        status: 'no_acceptable',
        message: 'Ни один склад не может принять этот ассортимент. Попробуй уменьшить количество или сменить тип упаковки.',
      });
    }

    // 7) Save recommendation to agent_supply_recommendations
    const runId = randomUUID();
    await db.insert(agentRunResults).values({
      runId,
      workspaceId: wsId,
      shopId: shopId ?? null,
      agentName: 'supply',
      trigger: 'subagent',
      status: 'done',
      summary: 'FBW warehouse recommendation',
      finishedAt: new Date(),
    });

    const totalQty = reqItems.reduce((s, i) => s + i.quantity, 0);
    const best = ranked[0];
    const exceedsThreshold = best.bestCoefficient != null && best.bestCoefficient > threshold;

    // Записываем рекомендацию по топ-1 (можно и по всем 3 при желании)
    for (const nm of args.nmIds.filter((n) => nmToBarcode.has(n))) {
      const qty = args.quantities?.[String(nm)] ?? 10;
      await db.insert(agentSupplyRecommendations).values({
        runId,
        workspaceId: wsId,
        shopId: shopId ?? null,
        nmId: BigInt(nm) as any,
        productTitle: nmToBarcode.get(nm)!.title,
        currentStock: 0,
        avgDailySales: 0,
        daysOfStock: null,
        recommendedQty: qty,
        urgency: 'medium',
        reason: `FBW prep: ${best.warehouseName} (${best.warehouseId}), coef ${best.bestCoefficient ?? '?'}×`,
        warehouseId: best.warehouseId,
        warehouseName: best.warehouseName,
        expectedCoefficient: best.bestCoefficient != null ? String(best.bestCoefficient) : null,
        recommendedAtForDate: best.bestDate,
      });
    }

    // 8) Build deep-link
    const params = new URLSearchParams({
      warehouseId: String(best.warehouseId),
      preorderType: args.packageType ?? 'box',
    });
    const deepLink = `${FBW_DEEP_LINK_BASE}?${params.toString()}`;

    const advice =
      exceedsThreshold
        ? `⚠️ Лучший коэф ${best.bestCoefficient}× выше порога ${threshold}×. Можно либо подождать (поставлю в очередь автоброни через action_queue_auto_book), либо создать всё равно.`
        : best.bestCoefficient === 0
        ? `✅ Бесплатная приёмка на ${best.bestDate}.`
        : best.bestCoefficient === 1
        ? `✅ Стандартная приёмка (×1) на ${best.bestDate}.`
        : `ℹ️ Коэф ${best.bestCoefficient}× на ${best.bestDate}.`;

    // 9) ROI по каждому nmId + агрегированный итог.
    // Acceptance per unit: bestCoefficient × базовая ставка приёмки.
    // Приближённо берём 50 ₽ × coef за единицу (WB-стандарт; точное значение —
    // в supplies/client.ts, но для recommend достаточно оценки).
    const acceptanceCostPerUnitKop = (best.bestCoefficient ?? 0) > 0
      ? Math.round((best.bestCoefficient ?? 0) * 50 * 100)
      : 0;

    const roiPerNm: Array<{ nmId: number; qty: number; roi: SupplyRoiResult }> = [];
    const aggregatedWarnings = new Set<string>();
    let aggCost = 0;
    let aggRevenue = 0;
    let aggTurnoverDaysMax = 0;
    let aggConfidence: 'high' | 'medium' | 'low' = 'high';

    for (const nm of args.nmIds.filter((n) => nmToBarcode.has(n))) {
      const qty = args.quantities?.[String(nm)] ?? 10;
      try {
        const r = await computeSupplyRoi(wsId, nm, qty, best.warehouseId, {
          shopId: shopId,
          acceptanceCostPerUnitKop,
        });
        roiPerNm.push({ nmId: nm, qty, roi: r });
        aggRevenue += r.revenueKopForecast;
        aggCost += r.costsKop.total;
        aggTurnoverDaysMax = Math.max(aggTurnoverDaysMax, r.turnoverDays);
        for (const w of r.warnings) aggregatedWarnings.add(`nm=${nm}: ${w}`);
        if (r.confidence === 'low') aggConfidence = 'low';
        else if (r.confidence === 'medium' && aggConfidence === 'high') aggConfidence = 'medium';
      } catch (e: any) {
        logger.warn({ err: e?.message, nm }, 'supplyRoi failed for nmId');
      }
    }

    const aggMarginPct = aggRevenue > 0 ? Math.round(((aggRevenue - aggCost) / aggRevenue) * 100) : 0;
    const aggRoiPct = aggCost > 0 ? Math.round(((aggRevenue - aggCost) / aggCost) * 100) : 0;
    const aggPaybackDays = aggRevenue > 0 && aggTurnoverDaysMax > 0
      ? Math.round(aggCost / (aggRevenue / aggTurnoverDaysMax))
      : 999;

    // ROI-блок для message
    const roiSummary =
      roiPerNm.length > 0
        ? `\n\n📊 ROI прогноз партии (${roiPerNm.length} SKU):\n` +
          `Выручка: ${Math.round(aggRevenue / 100)} ₽ · Затраты: ${Math.round(aggCost / 100)} ₽\n` +
          `Маржа: ${aggMarginPct}% · ROI: ${aggRoiPct}% · Окупаемость: ${aggPaybackDays} д\n` +
          `Уверенность: ${aggConfidence}` +
          (aggregatedWarnings.size > 0
            ? '\n' + Array.from(aggregatedWarnings).slice(0, 4).map((w) => `⚠️ ${w}`).join('\n')
            : '')
        : '';

    const roiVerdict =
      aggCost === 0
        ? null
        : aggRoiPct < 0
        ? `🔴 ROI отрицательный: партия по прогнозу не окупается. Лучше распродать остатки или пересмотреть цену.`
        : aggRoiPct < 10
        ? `🟡 ROI ${aggRoiPct}% — на грани. Подумай дважды или подкорректируй цену.`
        : `🟢 ROI ${aggRoiPct}% — поставка имеет смысл.`;

    return JSON.stringify({
      status: 'recommendation',
      best: {
        warehouseId: best.warehouseId,
        warehouseName: best.warehouseName,
        bestCoefficient: best.bestCoefficient,
        bestDate: best.bestDate,
        acceptedItems: best.acceptedItems,
        totalItems: best.totalItems,
      },
      alternatives: ranked.slice(1).map((c) => ({
        warehouseId: c.warehouseId,
        warehouseName: c.warehouseName,
        bestCoefficient: c.bestCoefficient,
        bestDate: c.bestDate,
      })),
      totalItemsRequested: totalQty,
      deepLink,
      threshold,
      exceedsThreshold,
      runId,
      roi: {
        revenueRub: Math.round(aggRevenue / 100),
        costsRub: Math.round(aggCost / 100),
        marginPct: aggMarginPct,
        roiPct: aggRoiPct,
        paybackDays: aggPaybackDays,
        turnoverDays: aggTurnoverDaysMax,
        confidence: aggConfidence,
        warnings: Array.from(aggregatedWarnings),
        perNm: roiPerNm.map((r) => ({
          nmId: r.nmId,
          qty: r.qty,
          marginPct: r.roi.marginPct,
          roiPct: r.roi.roiPct,
          paybackDays: r.roi.paybackDays,
          confidence: r.roi.confidence,
        })),
      },
      message:
        `📦 Рекомендация по складу: **${best.warehouseName}** (${best.warehouseId}).\n` +
        `${advice}` +
        roiSummary +
        (roiVerdict ? `\n${roiVerdict}` : '') +
        `\n\nWB убрал API создания FBW-поставок → создай preorder в ЛК WB по ссылке: ${deepLink}\n\n` +
        `После того как preorder появится в твоём списке, я автоматически подхвачу его через suppliesSync, и ты сможешь забронировать слот через action_book_supply_slot или поставить в очередь автоброни через action_queue_auto_book.`,
    });
  } catch (err: any) {
    logger.error({ err: err.message, wsId, shopId }, 'actionPrepareFbwSupply failed');
    return JSON.stringify({
      status: 'failed',
      error: err.message || 'Ошибка подготовки FBW-поставки',
    });
  }
}
