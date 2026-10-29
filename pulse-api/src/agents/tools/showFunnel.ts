/**
 * Tool: show_funnel — Generate funnel diagram widget data.
 * Returns a widget payload that will be rendered as an interactive
 * FunnelDiagram component on the frontend.
 */

import { db } from '../../db/client.js';
import { wbFunnelDailyProducts } from '../../db/schema.js';
import { eq, and, gte, lte, sql } from 'drizzle-orm';

interface ShowFunnelArgs {
  nmId?: number;
  from: string;
  to: string;
  _workspaceId?: number;
  _shopId?: number;
}

export async function showFunnelDiagram(args: ShowFunnelArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  const conds: any[] = [
    eq(wbFunnelDailyProducts.workspaceId, wsId),
    gte(wbFunnelDailyProducts.date, args.from),
    lte(wbFunnelDailyProducts.date, args.to),
  ];
  if (shopId != null) conds.push(eq(wbFunnelDailyProducts.shopId, shopId));
  if (args.nmId) conds.push(eq(wbFunnelDailyProducts.nmId, args.nmId));

  const rows = await db
    .select({
      cardOpens: sql<number>`coalesce(sum(${wbFunnelDailyProducts.openCardCount}), 0)`.mapWith(Number),
      addToCart: sql<number>`coalesce(sum(${wbFunnelDailyProducts.addToCartCount}), 0)`.mapWith(Number),
      orders: sql<number>`coalesce(sum(${wbFunnelDailyProducts.orderCount}), 0)`.mapWith(Number),
      buyouts: sql<number>`coalesce(sum(${wbFunnelDailyProducts.buyoutCount}), 0)`.mapWith(Number),
      cancels: sql<number>`coalesce(sum(${wbFunnelDailyProducts.cancelCount}), 0)`.mapWith(Number),
    })
    .from(wbFunnelDailyProducts)
    .where(and(...conds));

  const f = rows[0] ?? { cardOpens: 0, addToCart: 0, orders: 0, buyouts: 0, cancels: 0 };

  // Build widget payload. First stage is "Перешли в карточку" (openCardCount) — NOT search impressions. WB sales-funnel/products не отдаёт impressions отдельной метрикой.
  const widget = {
    __widget: 'funnel_diagram',
    props: {
      title: args.nmId ? `Воронка артикула ${args.nmId}` : 'Воронка конверсии',
      period: { from: args.from, to: args.to },
      stages: [
        { name: 'Перешли в карточку', value: f.cardOpens, color: '#6366f1' },
        { name: 'В корзину', value: f.addToCart, pct: f.cardOpens > 0 ? +((f.addToCart / f.cardOpens) * 100).toFixed(1) : 0, color: '#8b5cf6' },
        { name: 'Заказы', value: f.orders, pct: f.addToCart > 0 ? +((f.orders / f.addToCart) * 100).toFixed(1) : 0, color: '#a78bfa' },
        { name: 'Выкупы', value: f.buyouts, pct: f.orders > 0 ? +((f.buyouts / f.orders) * 100).toFixed(1) : 0, color: '#c4b5fd' },
      ],
      cancels: f.cancels,
      overallConversion: f.cardOpens > 0 ? +((f.buyouts / f.cardOpens) * 100).toFixed(2) : 0,
    },
  };

  return JSON.stringify(widget);
}
