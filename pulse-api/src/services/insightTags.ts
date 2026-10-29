import { db } from '../db/client.js';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt } from 'drizzle-orm';
import { wbTagProducts } from '../db/schema.js';

export async function getExcludedNmIds(workspaceId: number, excludedTagIds: number[]): Promise<Set<number>> {
  const set = new Set<number>();
  if (!excludedTagIds?.length) return set;

  const rows = await db
    .select({ nmId: wbTagProducts.nmId })
    .from(wbTagProducts)
    .where(and(eq(wbTagProducts.workspaceId, workspaceId), inArray(wbTagProducts.tagId, excludedTagIds as any)));

  for (const r of rows) set.add(Number(r.nmId));
  return set;
}
