/**
 * AI-tool: точный фильтр по характеристикам товара (структурный поиск).
 *
 * Когда использовать (для системного промпта):
 *   - Юзер ясно указывает свойства: «синий 38 размер», «лоферы из эко-замши
 *     демисезонные», «бренд VENT-DESIGN».
 *   - Для свободных запросов («подарок маме») — query_products_by_semantics.
 *
 * Как работает:
 *   - Использует raw->'characteristics' jsonb с GIN-индексом
 *     (jsonb_path_ops) — wb_cards_chars_gin_idx.
 *   - Оператор `@>` для AND: каждый фильтр должен присутствовать в массиве.
 *   - Можно передать несколько значений на ключ (OR внутри ключа): применяем
 *     UNION через OR-комбинированные @> предикаты.
 *
 * Если юзер не знает доступные характеристики — пусть сначала вызовет
 * list_available_characteristics для конкретного магазина.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';

interface Args {
  /** map характеристика → значение(я). Пример: {"Цвет": ["Чёрный","Серый"], "Сезон": "Демисезон"} */
  filters: Record<string, string | string[]>;
  /** Дополнительно — фильтр по бренду (на верхнем уровне wb_cards, не в characteristics) */
  brand?: string;
  /** Категория (subject_name) */
  category?: string;
  limit?: number;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

interface Match {
  nmId: number;
  title: string | null;
  brandName: string | null;
  subjectName: string | null;
  vendorCode: string | null;
  matchedChars: Array<{ name: string; value: string }>;
}

export async function queryProductsByCharacteristics(args: Args): Promise<string> {
  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  const shopId = args._shopId;
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);

  const filters = args.filters ?? {};
  const filterKeys = Object.keys(filters);
  if (filterKeys.length === 0 && !args.brand && !args.category) {
    return JSON.stringify({ error: 'Нужен хотя бы один фильтр: filters, brand или category.' });
  }

  // Строим WHERE: workspace_id + (опц. brand + category) + AND по каждой
  // характеристике. Для OR-значений строим вложенный массив @> вариантов.
  const charPredicates: string[] = [];
  for (const [name, raw] of Object.entries(filters)) {
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length === 0) continue;
    // OR внутри одного ключа: (chars @> [{name,value:v1}] OR chars @> [{name,value:v2}])
    // value в WB может быть string или array — пробуем оба варианта чтобы
    // покрыть оба формата (мы не знаем заранее как WB сохранил конкретно эту
    // характеристику).
    const variants = values.flatMap((v) => [
      `raw->'characteristics' @> '[${JSON.stringify({ name, value: v })}]'::jsonb`,
      `raw->'characteristics' @> '[${JSON.stringify({ name, value: [v] })}]'::jsonb`,
    ]);
    charPredicates.push(`(${variants.join(' OR ')})`);
  }
  const whereCharBlock = charPredicates.length ? ` AND ${charPredicates.join(' AND ')}` : '';
  const brandBlock = args.brand ? ` AND brand_name ILIKE '%${args.brand.replace(/'/g, "''")}%'` : '';
  const categoryBlock = args.category ? ` AND subject_name ILIKE '%${args.category.replace(/'/g, "''")}%'` : '';
  // shopId: критично в multi-shop workspace — без фильтра товары разных
  // магазинов перемешиваются в выдаче.
  const shopBlock = shopId ? ` AND shop_id = ${shopId}` : '';

  // Безопасность: workspaceId/shopId параметризованы как числа, остальные
  // через ILIKE c escape одинарных кавычек. characteristics-фильтр строится
  // через JSON.stringify — безопасно.
  const result = await db.execute(sql.raw(`
    SELECT nm_id, title, brand_name, subject_name, vendor_code, raw->'characteristics' AS chars
    FROM wb_cards
    WHERE workspace_id = ${wsId}${shopBlock}${brandBlock}${categoryBlock}${whereCharBlock}
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `));
  const rows = (result as any).rows ?? [];

  const matches: Match[] = rows.map((r: any) => {
    const chars: any[] = Array.isArray(r.chars) ? r.chars : [];
    // Извлекаем именно те characteristics что прошли фильтр (для прозрачности)
    const matchedChars = filterKeys.flatMap((name) => {
      const found = chars.find((c) => c?.name === name);
      if (!found) return [];
      const v = found.value;
      return [{ name, value: Array.isArray(v) ? v.join(', ') : String(v ?? '') }];
    });
    return {
      nmId: Number(r.nm_id),
      title: r.title,
      brandName: r.brand_name,
      subjectName: r.subject_name,
      vendorCode: r.vendor_code,
      matchedChars,
    };
  });

  return JSON.stringify({
    filters,
    brand: args.brand,
    category: args.category,
    totalFound: matches.length,
    matches,
    note: matches.length === 0
      ? 'По заданным характеристикам ничего не нашлось. Возможно WB сохранил характеристику в другом формате. Попробуй list_available_characteristics для проверки.'
      : undefined,
  }, null, 2);
}
