import { db } from '../../db/client.js';
import { sql } from 'drizzle-orm';

interface QueryAssortmentHealthArgs {
  daysBack?: number;
  /** Сколько товаров вернуть в topProducts/deadStock. Раньше было захардкожено
   * 10 — AI не мог показать пользователю полную ABC-разбивку, если в магазине
   * больше 10 товаров. Дефолт 100, потолок 500 (~30KB JSON, безопасно для LLM). */
  limit?: number;
  /** Включить колонку «выкупы» (sales). По умолчанию выключено — пара
   * orders/sales за одну неделю путает пользователя (разные товары/даты).
   * Когда нужен drill-down — поставь true. */
  showSales?: boolean;
  /** Включить когортный % выкупа из wb_funnel_daily_products (WB сам считает
   * с правильной cohort-логикой: «из заказов недели N сколько % выкуплено»). */
  showBuyoutPct?: boolean;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function queryAssortmentHealth(args: QueryAssortmentHealthArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const days = args.daysBack ?? 30;
  const limit = Math.max(1, Math.min(500, args.limit ?? 100));
  const showSales = args.showSales === true;
  const showBuyoutPct = args.showBuyoutPct === true;

  try {
    // ABC analysis: главная метрика — orders_rub (сумма заказов за период).
    // Раньше использовали sales_rub (выкупы) → расходилось с финотчётом
    // (где revenue включает корректировки). Сейчас orders_rub для ABC более
    // показателен — это «спрос недели», а выкупы могут быть от старых заказов.
    const rows = await db.execute(sql`
      SELECT
        nm_id AS "nmId",
        COALESCE(SUM(orders_rub), 0) AS "totalRevenue",
        COALESCE(SUM(orders_count), 0) AS "totalOrders",
        COALESCE(SUM(sales_count), 0) AS "totalSales",
        COALESCE(SUM(sales_rub), 0) AS "totalSalesRub"
      FROM wb_orders_sales_daily_products
      WHERE workspace_id = ${wsId}
        ${shopId ? sql`AND shop_id = ${shopId}` : sql``}
        AND date >= (CURRENT_DATE - ${days}::int)::text
      GROUP BY nm_id
      ORDER BY "totalRevenue" DESC
    `);

    const products = (rows as any).rows ?? rows ?? [];
    const totalRevenue = products.reduce((s: number, r: any) => s + Number(r.totalRevenue || 0), 0);

    // Когортный % выкупа из funnel-таблицы (WB считает по своей внутренней
    // cohort-логике: «из заказов в день N сколько % выкуплено в течение
    // нормального лага 7-21 дн»). Подтягиваем только если попросили.
    let buyoutMap = new Map<string, number>();
    if (showBuyoutPct) {
      const fRows = await db.execute(sql`
        SELECT
          nm_id AS "nmId",
          COALESCE(SUM(order_count), 0) AS "orderCount",
          COALESCE(SUM(buyout_count), 0) AS "buyoutCount"
        FROM wb_funnel_daily_products
        WHERE workspace_id = ${wsId}
          ${shopId ? sql`AND shop_id = ${shopId}` : sql``}
          AND date >= (CURRENT_DATE - ${days}::int)::text
        GROUP BY nm_id
      `);
      // Минимальное окно для надёжного когортного % выкупа — 21 день
      // (стандартный лаг WB ПВЗ-доставки). На более коротком периоде
      // buyouts=0 при orders>0 означает «ещё в пути», не «не выкупают».
      // Чтобы не вводить пользователя в заблуждение нулями, помечаем такие
      // случаи как `null` (UI/AI должны показать «в пути» / «—»).
      const cohortReliable = days >= 21;
      for (const f of ((fRows as any).rows ?? fRows ?? [])) {
        const orders = Number(f.orderCount || 0);
        const buyouts = Number(f.buyoutCount || 0);
        if (orders > 0) {
          if (buyouts === 0 && !cohortReliable) {
            buyoutMap.set(String(f.nmId), null as any); // ещё в пути
          } else {
            buyoutMap.set(String(f.nmId), Math.round((buyouts / orders) * 1000) / 10);
          }
        }
      }
    }

    let cumulative = 0;
    const classified = products.map((r: any) => {
      cumulative += Number(r.totalRevenue || 0);
      const pct = totalRevenue > 0 ? (cumulative / totalRevenue) * 100 : 0;
      const abc = pct <= 80 ? 'A' : pct <= 95 ? 'B' : 'C';
      // Главные поля — orders и orderRevenue. Выкупы — опционально через showSales.
      const out: any = {
        nmId: r.nmId,
        orderRevenue: Number(r.totalRevenue || 0), // сумма заказов в копейках
        orders: Number(r.totalOrders || 0),
        abc,
      };
      if (showSales) {
        out.sales = Number(r.totalSales || 0);
        out.salesRevenue = Number(r.totalSalesRub || 0);
      }
      if (showBuyoutPct) {
        out.buyoutPctCohort = buyoutMap.get(String(r.nmId)) ?? null;
      }
      return out;
    });

    // Мёртвый сток — товары без заказов за период (выкупы не смотрим:
    // могли быть лагом по старым заказам, а deadStock — про спрос).
    const deadStock = classified.filter((c: any) => c.orders === 0);

    return JSON.stringify({
      period: `${days} дней`,
      totalProducts: classified.length,
      totalRevenue,
      abcSummary: {
        A: classified.filter((c: any) => c.abc === 'A').length,
        B: classified.filter((c: any) => c.abc === 'B').length,
        C: classified.filter((c: any) => c.abc === 'C').length,
      },
      deadStockCount: deadStock.length,
      topProducts: classified.slice(0, limit),
      deadStock: deadStock.slice(0, limit),
      recommendations: [
        deadStock.length > 0 ? `${deadStock.length} товаров без продаж за ${days} дней — кандидаты на распродажу или вывод.` : null,
        classified.filter((c: any) => c.abc === 'C').length > classified.length * 0.5 ? 'Более 50% товаров в категории C — ассортимент требует оптимизации.' : null,
      ].filter(Boolean),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка анализа ассортимента' });
  }
}
