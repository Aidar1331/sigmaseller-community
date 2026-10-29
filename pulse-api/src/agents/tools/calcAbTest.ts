import { db } from '../../db/client.js';
import { sql } from 'drizzle-orm';

interface CalcAbTestArgs {
  nmId: number;
  changeDate: string;
  periodDaysBefore?: number;
  periodDaysAfter?: number;
  changeDescription: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function calcAbTest(args: CalcAbTestArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const daysBefore = args.periodDaysBefore ?? 7;
  const daysAfter = args.periodDaysAfter ?? 7;

  try {
    // DB columns are snake_case; the previous quoted camelCase query silently
    // returned empty rows. Also scope to shop when provided so the same nmId
    // in different shops doesn't mix.
    // `date` column is TEXT (YYYY-MM-DD) — cast comparison value to text.
    const shopClause = shopId != null ? sql`AND shop_id = ${shopId}` : sql``;
    const [beforeRows, afterRows] = await Promise.all([
      db.execute(sql`
        SELECT
          COALESCE(SUM(orders_count), 0) AS orders,
          COALESCE(SUM(sales_count), 0) AS sales,
          COALESCE(SUM(sales_rub), 0) AS revenue
        FROM wb_orders_sales_daily_products
        WHERE workspace_id = ${wsId} AND nm_id = ${args.nmId}
          ${shopClause}
          AND date >= (${args.changeDate}::date - ${daysBefore}::int)::text
          AND date < ${args.changeDate}::date::text
      `),
      db.execute(sql`
        SELECT
          COALESCE(SUM(orders_count), 0) AS orders,
          COALESCE(SUM(sales_count), 0) AS sales,
          COALESCE(SUM(sales_rub), 0) AS revenue
        FROM wb_orders_sales_daily_products
        WHERE workspace_id = ${wsId} AND nm_id = ${args.nmId}
          ${shopClause}
          AND date >= ${args.changeDate}::date::text
          AND date < (${args.changeDate}::date + ${daysAfter}::int)::text
      `),
    ]);

    const before = ((beforeRows as any).rows ?? beforeRows ?? [{}])[0];
    const after = ((afterRows as any).rows ?? afterRows ?? [{}])[0];

    const bOrders = Number(before.orders || 0);
    const aOrders = Number(after.orders || 0);
    const bRevenue = Number(before.revenue || 0);
    const aRevenue = Number(after.revenue || 0);

    const ordersDelta = bOrders > 0 ? ((aOrders - bOrders) / bOrders) * 100 : 0;
    const revenueDelta = bRevenue > 0 ? ((aRevenue - bRevenue) / bRevenue) * 100 : 0;

    const isSignificant = Math.abs(ordersDelta) > 10 || Math.abs(revenueDelta) > 10;
    const verdict = revenueDelta > 10 ? 'ПОЛОЖИТЕЛЬНО' : revenueDelta < -10 ? 'ОТРИЦАТЕЛЬНО' : 'НЕЙТРАЛЬНО';

    return JSON.stringify({
      nmId: args.nmId,
      changeDate: args.changeDate,
      changeDescription: args.changeDescription,
      before: { period: `${daysBefore} дней до`, orders: bOrders, revenue: bRevenue },
      after: { period: `${daysAfter} дней после`, orders: aOrders, revenue: aRevenue },
      delta: { ordersPct: Math.round(ordersDelta * 10) / 10, revenuePct: Math.round(revenueDelta * 10) / 10 },
      isSignificant,
      verdict,
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Ошибка A/B анализа' });
  }
}
