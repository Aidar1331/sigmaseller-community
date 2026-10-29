import { db } from '../../db/client.js';
import { wbCards } from '../../db/schema.js';
import { eq, and, ilike, sql } from 'drizzle-orm';

interface QueryCompetitorsArgs {
  keywords: string[];
  nmIds?: number[];
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function queryCompetitors(args: QueryCompetitorsArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    // Get own products from DB for comparison
    const ownCards = await db.select({
      nmId: wbCards.nmId,
      title: wbCards.title,
      brand: wbCards.brandName,
    }).from(wbCards).where(and(eq(wbCards.workspaceId, wsId), ...(shopId ? [eq(wbCards.shopId, shopId)] : []))).limit(100);

    return JSON.stringify({
      note: 'Конкурентный анализ через поиск WB. Для полного анализа используйте конкурентные инструменты Pulse.',
      keywords: args.keywords,
      ownProductsCount: ownCards.length,
      ownProducts: ownCards.slice(0, 20).map(c => ({
        nmId: c.nmId,
        title: c.title?.toString().slice(0, 60),
        brand: c.brand,
      })),
      recommendation: 'Для детального конкурентного анализа проверьте позиции через query_seo и сравните цены через query_finance.',
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка конкурентного анализа' });
  }
}
