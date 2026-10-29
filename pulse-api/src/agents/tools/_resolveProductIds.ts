/**
 * Resolver артикулов для AI-tools.
 *
 * Принимает массив строк или чисел (артикул WB = nmId, артикул продавца = vendorCode)
 * и возвращает массив nmId. Если ни один не найден — возвращает пустой массив.
 *
 * Поведение:
 *  - числовые значения длиной 7-12 цифр считаются nmId, идут как есть
 *  - всё остальное ищется в wb_cards.vendor_code по точному совпадению (case-insensitive)
 *
 * Зачем: Кеворк (29.05.2026) пытался спросить «конверсии артикула 7700S»,
 * AI потребовал nmId и тем самым поломал UX. Tools должны принимать любой формат.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';

export async function resolveProductIds(
  workspaceId: number,
  identifiers: Array<string | number>,
): Promise<number[]> {
  if (!identifiers?.length) return [];

  const nmIds: number[] = [];
  const vendorCodes: string[] = [];

  for (const raw of identifiers) {
    const str = String(raw ?? '').trim();
    if (!str) continue;

    // 7-12 цифр → nmId
    if (/^\d{7,12}$/.test(str)) {
      nmIds.push(Number(str));
    } else {
      vendorCodes.push(str);
    }
  }

  if (vendorCodes.length > 0) {
    const rows = ((await db.execute(sql`
      SELECT nm_id, vendor_code FROM wb_cards
      WHERE workspace_id = ${workspaceId}
        AND lower(vendor_code) = ANY(${vendorCodes.map((v) => v.toLowerCase())})
    `)) as any).rows ?? [];
    for (const r of rows) nmIds.push(Number(r.nm_id));
  }

  return Array.from(new Set(nmIds));
}
