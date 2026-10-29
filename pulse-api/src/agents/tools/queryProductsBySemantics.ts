/**
 * AI-tool: семантический поиск товаров через RAG (pgvector + Jina embeddings).
 *
 * Когда использовать (для системного промпта AI):
 *   - Юзер описывает товар СВОБОДНОЙ речью без структурированных фильтров:
 *     «найди подарок маме», «что у меня летнее лёгкое», «товары как 731640698»
 *   - Юзер использует синонимы или категории не из exact-match (для exact
 *     фильтрации по характеристикам есть query_products_by_characteristics).
 *
 * Как работает: эмбедим запрос (Jina retrieval.query) → SQL ORDER BY
 *   embedding <=> $queryEmbed LIMIT N — это cosine distance с HNSW-индексом.
 *   Карточки без embedding (не успели проэмбедиться) автоматически отсеются.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { embedTexts, isVoyageEnabled } from '../../services/documentHub/voyage.js';

interface Args {
  query: string;
  limit?: number;
  /** Опц. — поиск похожих на конкретный артикул вместо текстового запроса */
  similarToNmId?: number;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

interface Match {
  nmId: number;
  title: string | null;
  brandName: string | null;
  subjectName: string | null;
  similarity: number; // 0..1, 1 = идентичный
}

export async function queryProductsBySemantics(args: Args): Promise<string> {
  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  const shopId = args._shopId;
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);

  if (!(await isVoyageEnabled())) {
    return JSON.stringify({
      error: 'Семантический поиск отключён — нет JINA_API_KEY/VOYAGE_API_KEY. Используй query_products_by_characteristics для точных фильтров.',
    });
  }

  try {
    // Источник вектора запроса: либо embedding другого артикула (similar-to),
    // либо embed свежего текста запроса.
    let queryVector: number[];
    if (args.similarToNmId) {
      const refShopFilter = shopId ? sql`AND shop_id = ${shopId}` : sql``;
      const [row] = await db.execute(sql`
        SELECT embedding::text AS emb FROM wb_cards
        WHERE workspace_id = ${wsId} AND nm_id = ${args.similarToNmId} AND embedding IS NOT NULL ${refShopFilter}
        LIMIT 1
      `).then((r: any) => r.rows ?? []);
      if (!row?.emb) {
        return JSON.stringify({ error: `Артикул ${args.similarToNmId} не проэмбедился — попробуй обычный текстовый запрос.` });
      }
      // pgvector в text-форме: '[v1,v2,...]'
      queryVector = JSON.parse(row.emb);
    } else if (args.query?.trim()) {
      const vectors = await embedTexts([args.query.trim()], 'query');
      queryVector = vectors[0];
    } else {
      return JSON.stringify({ error: 'Нужен query или similarToNmId' });
    }

    const vecStr = `[${queryVector.join(',')}]`;
    // Если задан shopId — фильтруем по нему. Это критично в multi-shop
    // workspace (у operator 3 магазина): без фильтра RAG смешивает товары
    // всех магазинов в выдаче.
    const shopFilter = shopId ? sql`AND shop_id = ${shopId}` : sql``;
    const result = await db.execute(sql`
      SELECT nm_id, title, brand_name, subject_name,
             1 - (embedding <=> ${vecStr}::vector) AS similarity
      FROM wb_cards
      WHERE workspace_id = ${wsId} AND embedding IS NOT NULL ${shopFilter}
      ORDER BY embedding <=> ${vecStr}::vector
      LIMIT ${limit}
    `);
    const rows = (result as any).rows ?? [];

    const matches: Match[] = rows.map((r: any) => ({
      nmId: Number(r.nm_id),
      title: r.title,
      brandName: r.brand_name,
      subjectName: r.subject_name,
      similarity: Math.round(Number(r.similarity) * 1000) / 1000,
    }));

    return JSON.stringify({
      query: args.similarToNmId ? `similar-to-${args.similarToNmId}` : args.query,
      totalFound: matches.length,
      matches,
      note: matches.length === 0
        ? 'Семантический поиск ничего не нашёл. Возможно карточки ещё не проэмбедились (см. cron wb_cards_embed_sync).'
        : 'similarity = 0..1, 1 = почти идентичный товар. Порог релевантности ~0.6.',
    }, null, 2);
  } catch (err: any) {
    return JSON.stringify({ error: `Семантический поиск упал: ${err?.message ?? String(err)}` });
  }
}
