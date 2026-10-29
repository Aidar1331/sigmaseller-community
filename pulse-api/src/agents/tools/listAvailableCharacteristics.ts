/**
 * AI-tool: список характеристик которые встречаются у товаров магазина.
 *
 * Зачем:
 *   - AI не знает заранее какие именно характеристики использует магазин
 *     (Цвет? Размер? Состав? Аромат? Сезон?). Они зависят от категорий.
 *   - До того как звать query_products_by_characteristics с конкретным
 *     фильтром, AI вызывает этот tool и узнаёт что есть в магазине и
 *     какие значения встречаются.
 *
 * Возвращает: top-N характеристик с самыми частыми значениями. Не каждый
 * value, чтобы не сжечь токены — обрезаем до 10 на ключ.
 *
 * SQL: распаковываем raw->'characteristics' через jsonb_array_elements,
 *   группируем по name. Это медленно без индекса, но при <100k карточек
 *   нормально (запрос будет за секунды).
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';

interface Args {
  /** Опц. — посмотреть характеристики только конкретной категории */
  category?: string;
  /** Сколько самых частых ключей отдать. По умолчанию все. */
  limit?: number;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

interface CharSummary {
  name: string;
  productCount: number;
  topValues: Array<{ value: string; count: number }>;
}

export async function listAvailableCharacteristics(args: Args): Promise<string> {
  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  const shopId = args._shopId;
  const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);

  const categoryFilter = args.category
    ? sql`AND subject_name ILIKE ${`%${args.category}%`}`
    : sql``;
  // shopId фильтр — в multi-shop workspace без него выдаст характеристики
  // всех 3 магазинов смешанно.
  const shopFilter = shopId ? sql`AND shop_id = ${shopId}` : sql``;

  // Распаковываем characteristics в плоский (name, value_text) и считаем
  // вхождения. value может быть string или ['string'], нормализуем через
  // CASE WHEN jsonb_typeof = 'array' THEN array_to_string ELSE текст.
  const rows = await db.execute(sql`
    WITH chars AS (
      SELECT
        c->>'name' AS name,
        CASE jsonb_typeof(c->'value')
          WHEN 'array' THEN array_to_string(ARRAY(SELECT jsonb_array_elements_text(c->'value')), ', ')
          ELSE c->>'value'
        END AS value
      FROM wb_cards,
           LATERAL jsonb_array_elements(COALESCE(raw->'characteristics','[]'::jsonb)) AS c
      WHERE workspace_id = ${wsId} ${shopFilter} ${categoryFilter}
        AND c->>'name' IS NOT NULL
        AND c->>'name' NOT IN ('Ставка НДС','ОКПД2','ТНВЭД','ТН ВЭД','Код ТН ВЭД','НДС')
    ),
    by_name AS (
      SELECT name, COUNT(DISTINCT value) AS distinct_values,
             COUNT(*) AS product_count
      FROM chars
      GROUP BY name
    ),
    top_values AS (
      SELECT name, value, COUNT(*) AS cnt,
             ROW_NUMBER() OVER (PARTITION BY name ORDER BY COUNT(*) DESC) AS rn
      FROM chars
      WHERE value IS NOT NULL AND value <> ''
      GROUP BY name, value
    )
    SELECT bn.name, bn.product_count,
           json_agg(
             json_build_object('value', tv.value, 'count', tv.cnt)
             ORDER BY tv.cnt DESC
           ) FILTER (WHERE tv.rn <= 10) AS top_values
    FROM by_name bn
    LEFT JOIN top_values tv ON tv.name = bn.name AND tv.rn <= 10
    GROUP BY bn.name, bn.product_count
    ORDER BY bn.product_count DESC
    LIMIT ${limit}
  `);

  const list = ((rows as any).rows ?? []).map((r: any): CharSummary => ({
    name: r.name,
    productCount: Number(r.product_count),
    topValues: r.top_values ?? [],
  }));

  return JSON.stringify({
    workspaceId: wsId,
    category: args.category,
    totalCharacteristics: list.length,
    characteristics: list,
    note: list.length === 0
      ? 'В этом магазине характеристики не заполнены или категория не найдена.'
      : 'productCount = сколько товаров имеют эту характеристику. topValues — топ-10 значений.',
  }, null, 2);
}
