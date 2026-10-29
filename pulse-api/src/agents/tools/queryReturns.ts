/**
 * Tool: query_returns — Анализ возвратов.
 * Выявляет паттерны возвратов, проблемные товары, причины.
 * Inspired by JVO's return analysis patterns.
 */

import { db } from '../../db/client.js';
import { wbReturns, wbCards } from '../../db/schema.js';
import { eq, and, gte, inArray, sql, desc } from 'drizzle-orm';

interface QueryReturnsArgs {
  nmIds?: number[];
  daysBack?: number;
  _workspaceId?: number;
  _shopId?: number;
}

export async function queryReturnsOverview(args: QueryReturnsArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const daysBack = args.daysBack ?? 30;
  const since = new Date(Date.now() - daysBack * 86400000).toISOString();

  const conds: any[] = [
    eq(wbReturns.workspaceId, wsId),
    gte(wbReturns.createdAt, new Date(since)),
  ];
  // CRITICAL: scope to a single shop when caller provided one. Without this
  // filter the tool returned returns across all shops of the workspace.
  if (shopId != null) conds.push(eq(wbReturns.shopId, shopId));
  if (args.nmIds?.length) conds.push(inArray(wbReturns.nmId, args.nmIds));

  // Aggregate returns by product
  const byProduct = await db
    .select({
      nmId: wbReturns.nmId,
      totalReturns: sql<number>`count(*)`.mapWith(Number),
      pending: sql<number>`count(*) filter (where ${wbReturns.status} = 'pending')`.mapWith(Number),
      approved: sql<number>`count(*) filter (where ${wbReturns.status} = 'approved')`.mapWith(Number),
      rejected: sql<number>`count(*) filter (where ${wbReturns.status} = 'rejected')`.mapWith(Number),
    })
    .from(wbReturns)
    .where(and(...conds))
    .groupBy(wbReturns.nmId)
    .orderBy(desc(sql`count(*)`))
    .limit(30);

  // Top reasons
  const byReason = await db
    .select({
      reason: wbReturns.reason,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(wbReturns)
    .where(and(...conds))
    .groupBy(wbReturns.reason)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  // Total stats
  const [totals] = await db
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      withPhotos: sql<number>`count(*) filter (where ${wbReturns.photos} is not null and jsonb_array_length(${wbReturns.photos}) > 0)`.mapWith(Number),
    })
    .from(wbReturns)
    .where(and(...conds));

  return JSON.stringify({
    period: { daysBack, since: since.slice(0, 10) },
    totalReturns: totals?.total ?? 0,
    returnsWithPhotos: totals?.withPhotos ?? 0,
    byProduct: byProduct.map((r) => ({
      nmId: r.nmId,
      total: r.totalReturns,
      pending: r.pending,
      approved: r.approved,
      rejected: r.rejected,
    })),
    topReasons: byReason.map((r) => ({
      reason: r.reason || 'Не указана',
      count: r.count,
    })),
  });
}
