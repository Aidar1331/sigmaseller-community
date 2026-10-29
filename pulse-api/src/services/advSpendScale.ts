import { db } from '../db/client.js';
import { sql } from 'drizzle-orm';

/**
 * Возвращает коэффициент для приведения per-nm spend из wb_adv_daily_products
 * (=`/v3/fullstats`) к фактическим списаниям из wb_adv_finance (=`/adv/v1/upd`,
 * что = xlsx «История затрат» в ЛК ВБ).
 *
 * Зачем: fullstats per-nm системно занижает spend — кампании без target_nm,
 * пересчёт WB, и пр. РНП и A/B-метрики основаны на fullstats → ДРР занижен,
 * маржа завышена. Этот scale-фактор устраняет расхождение по итогу: per-nm
 * доли остаются как в fullstats, а сумма по магазину = xlsx ЛК ВБ.
 *
 * Использование:
 *   const scale = await getAdvSpendScale(wsId, shopId, '2026-05-01', '2026-05-31');
 *   const trueSpendKop = rawSpendKop * scale;
 *
 * Если scale = 1 (нет расхождения или нет данных) — это nooop. Если scale > 1
 * (fullstats занижен) — компенсация. Если scale < 1 (fullstats завысил, редко) —
 * корректируем вниз.
 *
 * @returns коэффициент (1 если данных недостаточно — defensive default).
 */
export async function getAdvSpendScale(
  workspaceId: number,
  shopId: number | null | undefined,
  start: string,
  end: string,
): Promise<number> {
  const shopFilter = shopId ? sql`AND shop_id = ${shopId}` : sql``;

  const finRes: any = await db.execute(sql`
    SELECT COALESCE(SUM(upd_sum_kopecks), 0)::bigint AS spend_kop
      FROM wb_adv_finance
     WHERE workspace_id = ${workspaceId}
       ${shopFilter}
       AND upd_date BETWEEN ${start} AND ${end}
  `);
  const finKop = Number(((finRes.rows ?? finRes) as any[])[0]?.spend_kop ?? 0);

  const fsRes: any = await db.execute(sql`
    SELECT COALESCE(SUM(spend_kopecks), 0)::bigint AS spend_kop
      FROM wb_adv_daily_products
     WHERE workspace_id = ${workspaceId}
       ${shopFilter}
       AND date BETWEEN ${start} AND ${end}
  `);
  const fsKop = Number(((fsRes.rows ?? fsRes) as any[])[0]?.spend_kop ?? 0);

  if (fsKop <= 0 || finKop <= 0) return 1;
  return finKop / fsKop;
}
