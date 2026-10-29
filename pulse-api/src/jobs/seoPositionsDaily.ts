/**
 * SEO Positions Daily Job
 * 
 * Checks keyword positions for all active keywords in all workspaces.
 * Runs at 03:00 MSK to get fresh daily positions.
 */

import { eq, and, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logJobs as logger } from '../lib/logger.js';
import {
  seoKeywords,
  seoKeywordProducts,
  seoPositionSnapshots,
  seoAlerts,
} from '../db/schema.js';
import { findProductPositions } from '../integrations/wb/search.js';

const BATCH_SIZE = 10; // Keywords per batch
const BATCH_DELAY_MS = 5000; // 5 seconds between batches

export async function runSeoPositionsDaily(): Promise<void> {
  logger.info('starting daily position check');

  // Get all active keywords with their products
  const keywords = await db
    .select({
      keywordId: seoKeywords.keywordId,
      workspaceId: seoKeywords.workspaceId,
      keyword: seoKeywords.keyword,
      alertThreshold: seoKeywords.alertThreshold,
    })
    .from(seoKeywords)
    .where(eq(seoKeywords.isActive, true));

  if (keywords.length === 0) {
    logger.info('no active keywords to check');
    return;
  }

  logger.info({ count: keywords.length }, 'found active keywords');

  // Get products for each keyword
  const keywordIds = keywords.map((k: { keywordId: number }) => k.keywordId);
  const products = await db
    .select()
    .from(seoKeywordProducts)
    .where(inArray(seoKeywordProducts.keywordId, keywordIds));

  const productsByKeyword = new Map<number, number[]>();
  for (const p of products) {
    const list = productsByKeyword.get(p.keywordId) || [];
    list.push(p.nmId);
    productsByKeyword.set(p.keywordId, list);
  }

  // Get previous positions for alerting (only for relevant keywords, last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  // FIX: Use sql.join for proper PostgreSQL array handling
  const keywordIdsList = keywordIds.map(id => sql`${id}`);
  const previousSnapshots = keywordIds.length > 0 
    ? await db.execute(sql`
        SELECT DISTINCT ON (keyword_id, nm_id) keyword_id, nm_id, position
        FROM seo_position_snapshots
        WHERE keyword_id IN (${sql.join(keywordIdsList, sql`, `)})
          AND checked_at > ${sevenDaysAgo}::timestamptz
        ORDER BY keyword_id, nm_id, checked_at DESC
      `)
    : { rows: [] };
  const previousByKey = new Map<string, number | null>();
  for (const row of previousSnapshots.rows as any[]) {
    previousByKey.set(`${row.keyword_id}-${row.nm_id}`, row.position);
  }

  let processed = 0;
  let errors = 0;
  const allAlerts: any[] = [];

  // Process keywords in batches
  for (let i = 0; i < keywords.length; i += BATCH_SIZE) {
    const batch = keywords.slice(i, i + BATCH_SIZE);

    for (const kw of batch) {
      const nmIds = productsByKeyword.get(kw.keywordId) || [];
      if (nmIds.length === 0) {
        continue;
      }

      try {
        const { positions, totalProducts } = await findProductPositions(kw.keyword, nmIds);

        const now = new Date();

        // Save snapshots
        const snapshotValues = positions.map(p => ({
          keywordId: kw.keywordId,
          nmId: p.nmId,
          position: p.position,
          page: p.page,
          totalProducts,
          cpm: p.cpm,
          isPromo: p.isPromo,
          checkedAt: now,
        }));

        await db.insert(seoPositionSnapshots).values(snapshotValues);

        // Update lastCheckedAt
        await db
          .update(seoKeywords)
          .set({ lastCheckedAt: now, updatedAt: now })
          .where(eq(seoKeywords.keywordId, kw.keywordId));

        // Check for alerts using user settings
        const positionThreshold = kw.alertThreshold || 100; // Position threshold
        const dropThreshold = 10; // TODO: Make this configurable per keyword (alertDropThreshold)
        const recoveryThreshold = 10; // TODO: Make this configurable per keyword
        
        for (const p of positions) {
          const prevKey = `${kw.keywordId}-${p.nmId}`;
          const prev = previousByKey.get(prevKey);

          if (prev !== undefined && prev !== null && p.position !== null) {
            // Position dropped significantly
            if (p.position > prev && p.position - prev >= dropThreshold) {
              allAlerts.push({
                keywordId: kw.keywordId,
                nmId: p.nmId,
                previousPosition: prev,
                currentPosition: p.position,
                alertType: 'dropped',
              });
            }
            // Position dropped below threshold
            else if (prev <= positionThreshold && p.position > positionThreshold) {
              allAlerts.push({
                keywordId: kw.keywordId,
                nmId: p.nmId,
                previousPosition: prev,
                currentPosition: p.position,
                alertType: 'dropped',
              });
            }
            // Position recovered significantly
            else if (p.position < prev && prev - p.position >= recoveryThreshold) {
              allAlerts.push({
                keywordId: kw.keywordId,
                nmId: p.nmId,
                previousPosition: prev,
                currentPosition: p.position,
                alertType: 'recovered',
              });
            }
          } else if (prev !== undefined && prev !== null && p.position === null) {
            // Lost from search
            allAlerts.push({
              keywordId: kw.keywordId,
              nmId: p.nmId,
              previousPosition: prev,
              currentPosition: null,
              alertType: 'lost',
            });
          }
        }

        processed++;
        logger.info({ keyword: kw.keyword, processed, total: keywords.length }, 'checked keyword');
      } catch (err) {
        errors++;
        logger.error({ err, keyword: kw.keyword }, 'error checking keyword');
      }
    }

    // Delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < keywords.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  // Save all alerts
  if (allAlerts.length > 0) {
    await db.insert(seoAlerts).values(allAlerts);
    logger.info({ alertCount: allAlerts.length }, 'created alerts');
  }

  logger.info({ processed, errors, alertCount: allAlerts.length }, 'seo positions daily completed');
}
