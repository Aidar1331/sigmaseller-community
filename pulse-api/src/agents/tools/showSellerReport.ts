import { db } from '../../db/client.js';
import { sql } from 'drizzle-orm';

interface ShowSellerReportArgs {
  period: 'daily' | 'weekly' | 'monthly';
  from?: string;
  to?: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function showSellerReport(args: ShowSellerReportArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const days = args.period === 'daily' ? 1 : args.period === 'weekly' ? 7 : 30;
  const dateTo = args.to ?? new Date().toISOString().slice(0, 10);

  try {
    // DB columns are snake_case (Drizzle pgTable mapping) — the old camelCase
    // quoted identifiers silently errored out so the tool never worked.
    // Also add shop_id scope.
    const shopClause = shopId != null ? sql`AND shop_id = ${shopId}` : sql``;
    // date column is TEXT (YYYY-MM-DD) — compare as string after casting.
    const dateFromStr = sql`(${dateTo}::date - ${days}::int)::text`;
    const dateToStr = sql`${dateTo}::date::text`;

    const salesRows = await db.execute(sql`
      SELECT
        COALESCE(SUM(orders_count), 0) AS orders,
        COALESCE(SUM(sales_count), 0) AS sales,
        COALESCE(SUM(sales_rub), 0) AS revenue,
        COALESCE(SUM(orders_rub), 0) AS "ordersRevenue"
      FROM wb_orders_sales_daily_products
      WHERE workspace_id = ${wsId}
        ${shopClause}
        AND date >= ${dateFromStr}
        AND date <= ${dateToStr}
    `);

    const financeRows = await db.execute(sql`
      SELECT
        COALESCE(SUM(income_from_sales_kopecks - commission_kopecks - logistics_kopecks), 0) AS payout,
        COALESCE(SUM(commission_kopecks), 0) AS commission,
        COALESCE(SUM(logistics_kopecks), 0) AS logistics,
        COALESCE(SUM(storage_kopecks), 0) AS storage,
        COALESCE(SUM(penalties_kopecks), 0) AS penalty
      FROM wb_finance_daily_products
      WHERE workspace_id = ${wsId}
        ${shopClause}
        AND date >= ${dateFromStr}
        AND date <= ${dateToStr}
    `);

    const s = ((salesRows as any).rows ?? salesRows ?? [{}])[0];
    const f = ((financeRows as any).rows ?? financeRows ?? [{}])[0];

    return JSON.stringify({
      __widget: 'seller_report',
      props: {
        period: args.period,
        dateTo,
        days,
        sales: {
          orders: Number(s.orders || 0),
          sales: Number(s.sales || 0),
          revenue: Number(s.revenue || 0),
          ordersRevenue: Number(s.ordersRevenue || 0),
        },
        finance: {
          payoutRub: Math.round(Number(f.payout || 0) / 100),
          commissionRub: Math.round(Number(f.commission || 0) / 100),
          logisticsRub: Math.round(Number(f.logistics || 0) / 100),
          storageRub: Math.round(Number(f.storage || 0) / 100),
          penaltyRub: Math.round(Number(f.penalty || 0) / 100),
        },
      },
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка генерации отчёта' });
  }
}
