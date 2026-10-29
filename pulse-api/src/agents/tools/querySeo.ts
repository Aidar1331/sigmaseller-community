/**
 * Tool: query_seo — SEO-аналитика: позиции, ключевые слова, тренды.
 * Inspired by JVO's SEO PRO module with keyword tracking and position monitoring.
 */

import { db } from '../../db/client.js';
import { seoKeywords, seoKeywordProducts, seoPositionSnapshots, seoAlerts } from '../../db/schema.js';
import { eq, and, gte, inArray, sql, desc } from 'drizzle-orm';
import { resolveProductIds } from './_resolveProductIds.js';

interface QuerySeoArgs {
  /** nmId или vendorCode (артикул продавца). Принимается любой. */
  nmIds?: Array<number | string>;
  daysBack?: number;
  _workspaceId?: number;
  _shopId?: number;
}

export async function querySeoOverview(args: QuerySeoArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const daysBack = args.daysBack ?? 14;
  const since = new Date(Date.now() - daysBack * 86400000);

  // Resolve nmId или vendorCode → массив nmId (если фильтр передан)
  const resolvedNmIds = args.nmIds?.length ? await resolveProductIds(wsId, args.nmIds) : [];
  if (args.nmIds?.length && !resolvedNmIds.length) {
    return JSON.stringify({ error: 'no_products_found', hint: `артикулы не найдены: ${args.nmIds.join(', ')}` });
  }

  // Active keywords for this workspace
  const keywords = await db
    .select({
      keywordId: seoKeywords.keywordId,
      keyword: seoKeywords.keyword,
      alertThreshold: seoKeywords.alertThreshold,
      lastCheckedAt: seoKeywords.lastCheckedAt,
    })
    .from(seoKeywords)
    .where(and(eq(seoKeywords.workspaceId, wsId), ...(shopId ? [eq(seoKeywords.shopId, shopId)] : []), eq(seoKeywords.isActive, true)))
    .limit(100);

  if (keywords.length === 0) {
    return JSON.stringify({
      message: 'SEO-мониторинг не настроен. Добавьте ключевые слова для отслеживания.',
      keywords: [],
      positions: [],
      alerts: [],
    });
  }

  const keywordIds = keywords.map((k) => k.keywordId);

  // Latest positions for each keyword+nmId pair
  const positions = await db
    .select({
      keywordId: seoPositionSnapshots.keywordId,
      nmId: seoPositionSnapshots.nmId,
      position: seoPositionSnapshots.position,
      page: seoPositionSnapshots.page,
      isPromo: seoPositionSnapshots.isPromo,
      cpm: seoPositionSnapshots.cpm,
      checkedAt: seoPositionSnapshots.checkedAt,
    })
    .from(seoPositionSnapshots)
    .where(and(
      inArray(seoPositionSnapshots.keywordId, keywordIds),
      gte(seoPositionSnapshots.checkedAt, since),
    ))
    .orderBy(desc(seoPositionSnapshots.checkedAt))
    .limit(500);

  // Recent SEO alerts (unread first)
  const alerts = await db
    .select({
      keywordId: seoAlerts.keywordId,
      nmId: seoAlerts.nmId,
      alertType: seoAlerts.alertType,
      previousPosition: seoAlerts.previousPosition,
      currentPosition: seoAlerts.currentPosition,
      createdAt: seoAlerts.createdAt,
    })
    .from(seoAlerts)
    .where(and(
      inArray(seoAlerts.keywordId, keywordIds),
      gte(seoAlerts.createdAt, since),
    ))
    .orderBy(desc(seoAlerts.createdAt))
    .limit(50);

  // Build keyword position map for latest snapshot
  const keywordMap = new Map(keywords.map((k) => [k.keywordId, k.keyword]));

  // Group positions by keyword for summary
  const positionsByKeyword = new Map<number, Array<{ nmId: number; position: number | null; isPromo: boolean }>>();
  for (const p of positions) {
    if (!positionsByKeyword.has(p.keywordId)) {
      positionsByKeyword.set(p.keywordId, []);
    }
    const arr = positionsByKeyword.get(p.keywordId)!;
    // Only keep latest per nmId
    if (!arr.find((x) => x.nmId === p.nmId)) {
      arr.push({ nmId: p.nmId!, position: p.position, isPromo: p.isPromo });
    }
  }

  const keywordSummaries = keywords.map((k) => {
    const pos = positionsByKeyword.get(k.keywordId) ?? [];
    const organic = pos.filter((p) => !p.isPromo && p.position != null);
    const avgPosition = organic.length > 0
      ? Math.round(organic.reduce((s, p) => s + (p.position ?? 0), 0) / organic.length)
      : null;

    return {
      keyword: k.keyword,
      trackedProducts: pos.length,
      avgPosition,
      bestPosition: organic.length > 0 ? Math.min(...organic.map((p) => p.position!)) : null,
      promotedCount: pos.filter((p) => p.isPromo).length,
    };
  });

  return JSON.stringify({
    period: { daysBack },
    totalKeywords: keywords.length,
    keywords: keywordSummaries,
    recentAlerts: alerts.map((a) => ({
      keyword: keywordMap.get(a.keywordId) ?? 'unknown',
      nmId: a.nmId,
      type: a.alertType,
      from: a.previousPosition,
      to: a.currentPosition,
      date: a.createdAt,
    })),
    droppedCount: alerts.filter((a) => a.alertType === 'dropped').length,
    recoveredCount: alerts.filter((a) => a.alertType === 'recovered').length,
    lostCount: alerts.filter((a) => a.alertType === 'lost').length,
  });
}
