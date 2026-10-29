/**
 * SEO Agent -- monitors keyword positions and suggests optimizations.
 */

import { db } from '../../db/client.js';
import { seoKeywords, seoKeywordProducts, seoPositionSnapshots, wbCards } from '../../db/schema.js';
import { eq, and, desc, sql, gte, inArray } from 'drizzle-orm';
import { logSeo as logger } from '../../lib/logger.js';

interface SeoAlert {
  nmId: number;
  productTitle: string;
  keyword: string;
  currentPosition: number;
  previousPosition: number;
  change: number;
  severity: 'critical' | 'warning' | 'info';
  recommendation: string;
}

export async function runSeoAgent(wsId: number, shopId?: number): Promise<{
  summary: string;
  alerts: SeoAlert[];
}> {
  // Load active keywords for workspace (scoped to shop when provided)
  let activeKeywords: Array<{ keywordId: number; keyword: string }> = [];
  try {
    activeKeywords = await db.select({ keywordId: seoKeywords.keywordId, keyword: seoKeywords.keyword })
      .from(seoKeywords)
      .where(and(
        eq(seoKeywords.workspaceId, wsId),
        eq(seoKeywords.isActive, true),
        ...(shopId != null ? [eq(seoKeywords.shopId, shopId)] : []),
      ))
      .limit(500);
  } catch (err) {
    logger.warn({ err }, 'Non-critical error in SEO agent');
    return { summary: 'SEO мониторинг: данных по ключевым словам пока нет.', alerts: [] };
  }

  if (activeKeywords.length === 0) {
    return { summary: 'SEO мониторинг: нет отслеживаемых ключевых слов.', alerts: [] };
  }

  // Get card names (scoped to shop when provided)
  const cards = await db.select({ nmId: wbCards.nmId, title: wbCards.title })
    .from(wbCards).where(and(
      eq(wbCards.workspaceId, wsId),
      ...(shopId != null ? [eq(wbCards.shopId, shopId)] : []),
    ));
  const cardMap = new Map(cards.map(c => [c.nmId, c.title ?? `${c.nmId}`]));

  const keywordIds = activeKeywords.map(k => k.keywordId);
  const keywordMap = new Map(activeKeywords.map(k => [k.keywordId, k.keyword]));

  // For each keyword, get the two most recent position snapshots to detect changes
  const alerts: SeoAlert[] = [];

  const MIN_SNAPSHOT_GAP_MS = 20 * 3600 * 1000; // at least 20h between compared snapshots

  for (const kwId of keywordIds) {
    const snapshots = await db.select({
      nmId: seoPositionSnapshots.nmId,
      position: seoPositionSnapshots.position,
      checkedAt: seoPositionSnapshots.checkedAt,
    })
    .from(seoPositionSnapshots)
    .where(eq(seoPositionSnapshots.keywordId, kwId))
    .orderBy(desc(seoPositionSnapshots.checkedAt))
    .limit(30); // get recent snapshots per keyword

    // Group by nmId, collect up to 3 latest snapshots per product for stabilization
    const byNm = new Map<number, Array<{ position: number | null; checkedAt: Date | null }>>();
    for (const snap of snapshots) {
      const arr = byNm.get(snap.nmId) ?? [];
      if (arr.length < 3) arr.push({ position: snap.position, checkedAt: snap.checkedAt });
      byNm.set(snap.nmId, arr);
    }

    for (const [nmId, snaps] of byNm) {
      if (snaps.length < 2) continue;
      const currentPos = snaps[0].position ?? 0;
      const prevPos = snaps[1].position ?? currentPos;
      if (currentPos === 0 || prevPos === 0) continue;

      // Require minimum time gap to avoid intra-day fluctuations
      const currentTime = snaps[0].checkedAt ? new Date(snaps[0].checkedAt).getTime() : 0;
      const prevTime = snaps[1].checkedAt ? new Date(snaps[1].checkedAt).getTime() : 0;
      if (currentTime - prevTime < MIN_SNAPSHOT_GAP_MS) continue;

      const change = currentPos - prevPos; // positive = position dropped (worse)

      // Stabilization: if we have 3 snapshots, check the trend is consistent
      // (avoids alerting on single-day spike that reverted)
      if (snaps.length >= 3) {
        const olderPos = snaps[2].position ?? 0;
        if (olderPos > 0) {
          const prevChange = prevPos - olderPos;
          // If previous change was opposite direction and similar magnitude, skip (likely fluctuation)
          if (Math.sign(prevChange) !== Math.sign(change) && Math.abs(prevChange) > Math.abs(change) * 0.5) {
            continue;
          }
        }
      }

      if (change > 10) {
        alerts.push({
          nmId,
          productTitle: cardMap.get(nmId) ?? `${nmId}`,
          keyword: keywordMap.get(kwId) ?? '',
          currentPosition: currentPos,
          previousPosition: prevPos,
          change,
          severity: change > 30 ? 'critical' : 'warning',
          recommendation: `Позиция упала на ${change} мест. Проверьте контент карточки и конкурентов.`,
        });
      } else if (change < -10) {
        alerts.push({
          nmId,
          productTitle: cardMap.get(nmId) ?? `${nmId}`,
          keyword: keywordMap.get(kwId) ?? '',
          currentPosition: currentPos,
          previousPosition: prevPos,
          change,
          severity: 'info',
          recommendation: `Позиция выросла на ${Math.abs(change)} мест. Продолжайте текущую стратегию.`,
        });
      }
    }
  }

  const critCount = alerts.filter(a => a.severity === 'critical').length;
  const summary = alerts.length > 0
    ? `SEO мониторинг: ${alerts.length} алертов (${critCount} критичных)`
    : 'SEO мониторинг: все позиции стабильны';

  return { summary, alerts };
}
