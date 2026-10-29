/**
 * Data accessors for the Telegram bot UI.
 *
 * Mirrors the queries in jobs/dailyDigests.ts but parameterised by
 * arbitrary date ranges so the per-shop dashboard can switch between
 * today / yesterday / 7d / 30d windows on inline-button taps.
 *
 * Pure data layer: NO message-building here, NO Telegram send calls,
 * NO grammY Context — just SQL → typed result.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';

export interface ShopRow {
  workspaceId: number;
  shopId: number;
  name: string;
}

export async function listShopsForUser(userId: number): Promise<ShopRow[]> {
  const rows = await db.execute(sql<ShopRow>`
    SELECT ms.workspace_id::int AS "workspaceId",
           ms.shop_id::int      AS "shopId",
           ms.name              AS "name"
      FROM user_telegram_links l
      JOIN workspace_members m ON m.user_id = l.user_id
      JOIN marketplace_shops ms ON ms.workspace_id = m.workspace_id
     WHERE l.user_id = ${userId}
       AND ms.platform = 'wb'
       AND ms.is_active = true
     ORDER BY ms.shop_id;
  `);
  return rows.rows as unknown as ShopRow[];
}

export async function userIdByChatId(chatId: string): Promise<number | null> {
  const rows = await db.execute(sql<{ user_id: number }>`
    SELECT user_id FROM user_telegram_links WHERE tg_chat_id = ${chatId};
  `);
  const r = rows.rows[0] as any;
  return r ? Number(r.user_id) : null;
}

export interface ShopDaySummary {
  ordersCount: number;
  ordersRub: number;
  salesCount: number;
  salesRub: number;
  buyoutPct: number | null;
  date: string;
}

/**
 * Fetch a single date's snapshot for one shop. The `date` is a YYYY-MM-DD
 * string. Returns null if no data for that date.
 */
export async function shopDailySnapshot(
  workspaceId: number,
  shopId: number,
  date: string,
): Promise<ShopDaySummary | null> {
  const rows = await db.execute(sql`
    SELECT date,
           orders_count, orders_rub::numeric AS orders_rub,
           sales_count,  sales_rub::numeric  AS sales_rub
      FROM wb_orders_sales_daily
     WHERE workspace_id = ${workspaceId}
       AND shop_id = ${shopId}
       AND date::date = ${date}::date
     LIMIT 1;
  `);
  const r = rows.rows[0] as any;
  if (!r) return null;
  const ordersCount = Number(r.orders_count);
  const salesCount = Number(r.sales_count);
  const buyoutPct = ordersCount > 0 ? (salesCount / ordersCount) * 100 : null;
  return {
    date: r.date,
    ordersCount,
    ordersRub: Number(r.orders_rub),
    salesCount,
    salesRub: Number(r.sales_rub),
    buyoutPct,
  };
}

/**
 * Aggregate sales over a date range (inclusive on both ends).
 */
export async function shopRangeAggregate(
  workspaceId: number,
  shopId: number,
  dateFrom: string,
  dateTo: string,
): Promise<ShopDaySummary | null> {
  const rows = await db.execute(sql`
    SELECT
      SUM(orders_count)::int AS orders_count,
      SUM(sales_count)::int  AS sales_count,
      SUM(orders_rub::numeric) AS orders_rub,
      SUM(sales_rub::numeric)  AS sales_rub
      FROM wb_orders_sales_daily
     WHERE workspace_id = ${workspaceId}
       AND shop_id = ${shopId}
       AND date::date BETWEEN ${dateFrom}::date AND ${dateTo}::date;
  `);
  const r = rows.rows[0] as any;
  if (!r || r.orders_count === null) return null;
  const ordersCount = Number(r.orders_count ?? 0);
  const salesCount = Number(r.sales_count ?? 0);
  const buyoutPct = ordersCount > 0 ? (salesCount / ordersCount) * 100 : null;
  return {
    date: `${dateFrom}..${dateTo}`,
    ordersCount,
    ordersRub: Number(r.orders_rub ?? 0),
    salesCount,
    salesRub: Number(r.sales_rub ?? 0),
    buyoutPct,
  };
}

export interface TopProductRow {
  nmId: number;
  title: string;
  salesCount: number;
  salesRub: number;
}

export async function shopTopProducts(
  workspaceId: number,
  shopId: number,
  date: string,
  limit = 3,
): Promise<TopProductRow[]> {
  const rows = await db.execute(sql<TopProductRow>`
    SELECT op.nm_id AS "nmId",
           COALESCE(c.title, c.subject_name, '#'||op.nm_id::text) AS title,
           op.sales_count AS "salesCount",
           op.sales_rub::numeric AS "salesRub"
      FROM wb_orders_sales_daily_products op
      LEFT JOIN wb_cards c
        ON c.workspace_id = op.workspace_id AND c.nm_id = op.nm_id
     WHERE op.workspace_id = ${workspaceId}
       AND op.shop_id = ${shopId}
       AND op.date::date = ${date}::date
     ORDER BY op.sales_rub::numeric DESC NULLS LAST
     LIMIT ${limit};
  `);
  return (rows.rows as any[]).map((r) => ({
    nmId: Number(r.nmId),
    title: String(r.title),
    salesCount: Number(r.salesCount),
    salesRub: Number(r.salesRub),
  }));
}

export interface LowStockRow {
  nmId: number;
  title: string;
  quantity: number;
  avgDaily: number;
  daysLeft: number;
}

export async function shopLowStockProducts(
  workspaceId: number,
  shopId: number,
  thresholdDays = 5,
  limit = 5,
): Promise<LowStockRow[]> {
  const rows = await db.execute(sql`
    WITH cur AS (
      SELECT nm_id, quantity
        FROM wb_stocks_daily_products
       WHERE workspace_id = ${workspaceId}
         AND shop_id = ${shopId}
         AND date::date = (
           SELECT MAX(date::date) FROM wb_stocks_daily_products
            WHERE workspace_id = ${workspaceId} AND shop_id = ${shopId}
         )
    ),
    sales7d AS (
      SELECT nm_id, AVG(sales_count)::numeric AS avg_daily
        FROM wb_orders_sales_daily_products
       WHERE workspace_id = ${workspaceId} AND shop_id = ${shopId}
         AND date::date BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE - 1
       GROUP BY nm_id HAVING AVG(sales_count) > 0
    )
    SELECT cur.nm_id,
           COALESCE(c.title, c.subject_name, '#'||cur.nm_id::text) AS title,
           cur.quantity, s.avg_daily,
           (cur.quantity / s.avg_daily)::numeric AS days_left
      FROM cur
      JOIN sales7d s ON s.nm_id = cur.nm_id
      LEFT JOIN wb_cards c
        ON c.workspace_id = ${workspaceId} AND c.nm_id = cur.nm_id
     WHERE cur.quantity / s.avg_daily < ${thresholdDays}
     ORDER BY days_left ASC
     LIMIT ${limit};
  `);
  return (rows.rows as any[]).map((r) => ({
    nmId: Number(r.nm_id),
    title: String(r.title),
    quantity: Number(r.quantity),
    avgDaily: Number(r.avg_daily),
    daysLeft: Number(r.days_left),
  }));
}

export interface AlertGroupRow {
  trigger: string;
  count: number;
  severity: string;
}

export interface AlertItemRow {
  eventId: number;
  nmId: number | null;
  title: string;
  description: string | null;
  severity: string;
  suggestedAction: string | null;
  // Enriched metrics extracted from meta JSON when present
  qty: number | null;          // current stock for stock_* triggers
  avgDaily: number | null;     // avg sales/day for stock_* triggers
  // Heuristic monthly loss estimate (RUB). Null when not computable.
  potentialLossRub: number | null;
}

/**
 * List events for one trigger group, with enriched metrics for ranking
 * by impact (potential lost sales / month) where possible.
 *
 * For stock_zero / stock_low: potentialLossRub ≈ avg_daily_sales × 30 ×
 *   estimated_unit_price (sales_rub / sales_count averaged over last 30d).
 * For other triggers: potentialLossRub left null; the UI falls back to
 *   the creation timestamp / severity ordering.
 */
export async function alertGroupItems(
  workspaceId: number,
  trigger: string,
  limit = 20,
): Promise<AlertItemRow[]> {
  const rows = await db.execute(sql`
    WITH ev AS (
      SELECT event_id, nm_id, title, description, severity,
             suggested_action,
             (meta->>'qty')::numeric      AS qty,
             (meta->>'avgDaily')::numeric AS avg_daily
        FROM agent_events
       WHERE workspace_id = ${workspaceId}
         AND status = 'pending'
         AND meta->>'triggerId' = ${trigger}
       ORDER BY created_at DESC
       LIMIT ${limit}
    ),
    -- Average unit price per nmId over last 30 days, for impact estimation.
    px AS (
      SELECT nm_id,
             CASE WHEN SUM(sales_count) > 0
                  THEN SUM(sales_rub::numeric) / SUM(sales_count)
                  ELSE NULL END AS unit_price_rub
        FROM wb_orders_sales_daily_products
       WHERE workspace_id = ${workspaceId}
         AND date::date >= CURRENT_DATE - 30
       GROUP BY nm_id
    )
    SELECT ev.event_id, ev.nm_id, ev.title, ev.description, ev.severity,
           ev.suggested_action,
           ev.qty, ev.avg_daily,
           CASE
             WHEN ev.avg_daily IS NOT NULL AND px.unit_price_rub IS NOT NULL
             THEN (ev.avg_daily * 30 * px.unit_price_rub)
             ELSE NULL
           END AS potential_loss_rub
      FROM ev LEFT JOIN px USING (nm_id)
     ORDER BY potential_loss_rub DESC NULLS LAST, ev.event_id ASC;
  `);
  return (rows.rows as any[]).map((r) => ({
    eventId: Number(r.event_id),
    nmId: r.nm_id != null ? Number(r.nm_id) : null,
    title: String(r.title),
    description: r.description ? String(r.description) : null,
    severity: String(r.severity),
    suggestedAction: r.suggested_action ? String(r.suggested_action) : null,
    qty: r.qty != null ? Number(r.qty) : null,
    avgDaily: r.avg_daily != null ? Number(r.avg_daily) : null,
    potentialLossRub: r.potential_loss_rub != null ? Number(r.potential_loss_rub) : null,
  }));
}

export interface AlertItemDetail extends AlertItemRow {
  workspaceId: number;
  trigger: string;
  createdAt: string;
}

export async function alertItemById(
  workspaceId: number,
  eventId: number,
): Promise<AlertItemDetail | null> {
  const rows = await db.execute(sql`
    SELECT ev.event_id, ev.nm_id, ev.title, ev.description, ev.severity,
           ev.suggested_action, ev.created_at, ev.meta->>'triggerId' AS trigger,
           (ev.meta->>'qty')::numeric AS qty,
           (ev.meta->>'avgDaily')::numeric AS avg_daily,
           px.unit_price_rub
      FROM agent_events ev
      LEFT JOIN (
        SELECT nm_id,
               CASE WHEN SUM(sales_count) > 0
                    THEN SUM(sales_rub::numeric) / SUM(sales_count)
                    ELSE NULL END AS unit_price_rub
          FROM wb_orders_sales_daily_products
         WHERE workspace_id = ${workspaceId}
           AND date::date >= CURRENT_DATE - 30
         GROUP BY nm_id
      ) px ON px.nm_id = ev.nm_id
     WHERE ev.workspace_id = ${workspaceId}
       AND ev.event_id = ${eventId}
     LIMIT 1;
  `);
  const r = rows.rows[0] as any;
  if (!r) return null;
  const qty = r.qty != null ? Number(r.qty) : null;
  const avgDaily = r.avg_daily != null ? Number(r.avg_daily) : null;
  const price = r.unit_price_rub != null ? Number(r.unit_price_rub) : null;
  const potential = avgDaily != null && price != null ? avgDaily * 30 * price : null;
  return {
    workspaceId,
    eventId: Number(r.event_id),
    nmId: r.nm_id != null ? Number(r.nm_id) : null,
    title: String(r.title),
    description: r.description ? String(r.description) : null,
    severity: String(r.severity),
    suggestedAction: r.suggested_action ? String(r.suggested_action) : null,
    trigger: String(r.trigger ?? ''),
    qty,
    avgDaily,
    potentialLossRub: potential,
    createdAt: String(r.created_at),
  };
}

// ============================================================================
// SEO positions (rev 25m)
// ============================================================================

export interface KeywordPositionRow {
  keywordId: number;
  keyword: string;
  nmId: number;
  shopId: number | null;
  latestPosition: number | null;
  prevPosition: number | null;
  delta: number | null;       // negative = position improved (lower number = better in search)
  checkedAt: string;
}

/**
 * Top keywords by latest position. For each keyword × nm combo we pull
 * the LATEST snapshot (today's) and the PREVIOUS snapshot (yesterday's)
 * and compute the delta. Sorted by absolute delta DESC so biggest movers
 * land on top.
 */
export async function topKeywordMovers(
  workspaceId: number,
  limit = 20,
): Promise<KeywordPositionRow[]> {
  const rows = await db.execute(sql<KeywordPositionRow>`
    WITH latest AS (
      SELECT DISTINCT ON (keyword_id, nm_id)
             keyword_id, nm_id, position, checked_at
        FROM seo_position_snapshots
       ORDER BY keyword_id, nm_id, checked_at DESC
    ),
    prev AS (
      SELECT sps.keyword_id, sps.nm_id, sps.position, sps.checked_at
        FROM seo_position_snapshots sps
        JOIN latest l USING (keyword_id, nm_id)
       WHERE sps.checked_at < l.checked_at
       ORDER BY sps.checked_at DESC
    ),
    prev1 AS (
      SELECT DISTINCT ON (keyword_id, nm_id)
             keyword_id, nm_id, position AS prev_position
        FROM prev
       ORDER BY keyword_id, nm_id, checked_at DESC
    )
    SELECT k.keyword_id AS "keywordId",
           k.keyword,
           l.nm_id AS "nmId",
           k.shop_id AS "shopId",
           l.position AS "latestPosition",
           p.prev_position AS "prevPosition",
           (l.position - COALESCE(p.prev_position, l.position))::int AS "delta",
           l.checked_at::text AS "checkedAt"
      FROM latest l
      JOIN seo_keywords k ON k.keyword_id = l.keyword_id
      LEFT JOIN prev1 p ON p.keyword_id = l.keyword_id AND p.nm_id = l.nm_id
     WHERE k.workspace_id = ${workspaceId}
       AND k.is_active = true
     ORDER BY ABS(COALESCE(l.position - p.prev_position, 0)) DESC,
              l.position ASC NULLS LAST
     LIMIT ${limit};
  `);
  return (rows.rows as any[]).map((r) => ({
    keywordId: Number(r.keywordId),
    keyword: String(r.keyword),
    nmId: Number(r.nmId),
    shopId: r.shopId != null ? Number(r.shopId) : null,
    latestPosition: r.latestPosition != null ? Number(r.latestPosition) : null,
    prevPosition: r.prevPosition != null ? Number(r.prevPosition) : null,
    delta: r.delta != null ? Number(r.delta) : null,
    checkedAt: String(r.checkedAt),
  }));
}

// ============================================================================
// A/B photo tests (rev 25s)
// ============================================================================

export interface AbTestRow {
  testId: number;
  nmId: number;
  title: string;
  status: string;
  goal: string;
  winnerVariant: string | null;
  startedAt: string;
  periodDays: number;
}

export async function listAbTests(workspaceId: number, status?: 'running' | 'completed' | 'paused', limit = 10): Promise<AbTestRow[]> {
  const rows = await db.execute(sql`
    SELECT t.test_id, t.nm_id, t.status, t.goal, t.winner_variant,
           t.started_at, t.period_days,
           COALESCE(c.title, c.subject_name, '#'||t.nm_id::text) AS title
      FROM ab_photo_tests t
      LEFT JOIN wb_cards c
        ON c.workspace_id = t.workspace_id AND c.nm_id = t.nm_id
     WHERE t.workspace_id = ${workspaceId}
       ${status ? sql`AND t.status = ${status}` : sql``}
     ORDER BY t.started_at DESC
     LIMIT ${limit};
  `);
  return (rows.rows as any[]).map((r) => ({
    testId: Number(r.test_id),
    nmId: Number(r.nm_id),
    title: String(r.title),
    status: String(r.status),
    goal: String(r.goal),
    winnerVariant: r.winner_variant ? String(r.winner_variant) : null,
    startedAt: String(r.started_at),
    periodDays: Number(r.period_days),
  }));
}

export async function abTestById(workspaceId: number, testId: number): Promise<AbTestRow | null> {
  const rows = await db.execute(sql`
    SELECT t.test_id, t.nm_id, t.status, t.goal, t.winner_variant,
           t.started_at, t.period_days,
           COALESCE(c.title, c.subject_name, '#'||t.nm_id::text) AS title
      FROM ab_photo_tests t
      LEFT JOIN wb_cards c
        ON c.workspace_id = t.workspace_id AND c.nm_id = t.nm_id
     WHERE t.workspace_id = ${workspaceId} AND t.test_id = ${testId}
     LIMIT 1;
  `);
  const r = rows.rows[0] as any;
  if (!r) return null;
  return {
    testId: Number(r.test_id),
    nmId: Number(r.nm_id),
    title: String(r.title),
    status: String(r.status),
    goal: String(r.goal),
    winnerVariant: r.winner_variant ? String(r.winner_variant) : null,
    startedAt: String(r.started_at),
    periodDays: Number(r.period_days),
  };
}

export async function loadAbTestPhases(testId: number): Promise<Array<{ variant: string; startedAt: string; endedAt: string | null }>> {
  const rows = await db.execute(sql`
    SELECT variant, started_at, ended_at
      FROM ab_photo_phases
     WHERE test_id = ${testId}
     ORDER BY started_at ASC;
  `);
  return (rows.rows as any[]).map((r) => ({
    variant: String(r.variant),
    startedAt: String(r.started_at),
    endedAt: r.ended_at ? String(r.ended_at) : null,
  }));
}

export async function declareAbWinner(workspaceId: number, testId: number, variant: 'A' | 'B'): Promise<void> {
  await db.execute(sql`
    UPDATE ab_photo_tests
       SET winner_variant = ${variant},
           status = 'completed',
           completed_at = NOW(),
           updated_at = NOW()
     WHERE workspace_id = ${workspaceId}
       AND test_id = ${testId};
  `);
}

// ============================================================================
// Pricing decisions (rev 25q)
// ============================================================================

export interface PricingDecisionRow {
  decisionId: number;
  nmId: number;
  shopId: number | null;
  title: string;
  strategyType: string;
  oldPriceKop: number;
  newPriceKop: number;
  reason: string;
  status: string;
  createdAt: string;
}

/**
 * Pending (proposed) pricing decisions for the user's workspace,
 * joined to wb_cards for a readable title. Ordered by the largest
 * absolute price change first — biggest impact bubbles up.
 */
export async function listProposedPricingDecisions(
  workspaceId: number,
  limit = 10,
): Promise<PricingDecisionRow[]> {
  const rows = await db.execute(sql`
    SELECT pd.decision_id, pd.nm_id, pd.shop_id, pd.strategy_type,
           pd.old_price_kop, pd.new_price_kop, pd.reason, pd.status,
           pd.created_at,
           COALESCE(c.title, c.subject_name, '#'||pd.nm_id::text) AS title
      FROM pricing_decisions pd
      LEFT JOIN wb_cards c
        ON c.workspace_id = pd.workspace_id AND c.nm_id = pd.nm_id
     WHERE pd.workspace_id = ${workspaceId}
       AND pd.status = 'proposed'
     ORDER BY ABS(pd.new_price_kop - pd.old_price_kop) DESC, pd.created_at DESC
     LIMIT ${limit};
  `);
  return (rows.rows as any[]).map((r) => ({
    decisionId: Number(r.decision_id),
    nmId: Number(r.nm_id),
    shopId: r.shop_id != null ? Number(r.shop_id) : null,
    title: String(r.title),
    strategyType: String(r.strategy_type),
    oldPriceKop: Number(r.old_price_kop),
    newPriceKop: Number(r.new_price_kop),
    reason: String(r.reason),
    status: String(r.status),
    createdAt: String(r.created_at),
  }));
}

export async function pricingDecisionById(
  workspaceId: number,
  decisionId: number,
): Promise<PricingDecisionRow | null> {
  const rows = await db.execute(sql`
    SELECT pd.decision_id, pd.nm_id, pd.shop_id, pd.strategy_type,
           pd.old_price_kop, pd.new_price_kop, pd.reason, pd.status,
           pd.created_at,
           COALESCE(c.title, c.subject_name, '#'||pd.nm_id::text) AS title
      FROM pricing_decisions pd
      LEFT JOIN wb_cards c
        ON c.workspace_id = pd.workspace_id AND c.nm_id = pd.nm_id
     WHERE pd.workspace_id = ${workspaceId}
       AND pd.decision_id = ${decisionId}
     LIMIT 1;
  `);
  const r = rows.rows[0] as any;
  if (!r) return null;
  return {
    decisionId: Number(r.decision_id),
    nmId: Number(r.nm_id),
    shopId: r.shop_id != null ? Number(r.shop_id) : null,
    title: String(r.title),
    strategyType: String(r.strategy_type),
    oldPriceKop: Number(r.old_price_kop),
    newPriceKop: Number(r.new_price_kop),
    reason: String(r.reason),
    status: String(r.status),
    createdAt: String(r.created_at),
  };
}

export async function setDecisionStatus(
  workspaceId: number,
  decisionId: number,
  status: 'applied' | 'rejected',
): Promise<void> {
  await db.execute(sql`
    UPDATE pricing_decisions
       SET status = ${status}
     WHERE workspace_id = ${workspaceId}
       AND decision_id = ${decisionId};
  `);
}

// ============================================================================
// Supply drafts (rev 25p)
// ============================================================================

export interface SupplyDraftRow {
  draftId: number;
  name: string | null;
  status: string;
  totalItems: number;
  totalQty: number;
  createdAt: string;
}

export async function listOpenSupplyDrafts(workspaceId: number, limit = 5): Promise<SupplyDraftRow[]> {
  const rows = await db.execute(sql`
    SELECT draft_id, name, status, total_items, total_qty, created_at
      FROM supply_drafts
     WHERE workspace_id = ${workspaceId}
       AND status IN ('draft', 'pending', 'confirmed')
     ORDER BY created_at DESC
     LIMIT ${limit};
  `);
  return (rows.rows as any[]).map((r) => ({
    draftId: Number(r.draft_id),
    name: r.name ? String(r.name) : null,
    status: String(r.status),
    totalItems: Number(r.total_items ?? 0),
    totalQty: Number(r.total_qty ?? 0),
    createdAt: String(r.created_at),
  }));
}

/**
 * Single-item draft helper used by the bot's /supplies flow. Creates one
 * supply_drafts row + one supply_draft_items row in a transaction so
 * partial state can never leak into the cabinet's drafts list.
 */
export async function createBotSupplyDraft(args: {
  workspaceId: number;
  shopId: number | null;
  nmId: number;
  title: string;
  quantity: number;
  currentStock: number | null;
  avgDaily: number | null;
}): Promise<number> {
  return await db.transaction(async (tx) => {
    const draftRes = await tx.execute(sql`
      INSERT INTO supply_drafts
        (workspace_id, shop_id, name, status, total_items, total_qty)
      VALUES
        (${args.workspaceId}, ${args.shopId}, ${`Bot · ${args.title.slice(0, 60)}`},
         'draft', 1, ${args.quantity})
      RETURNING draft_id;
    `);
    const draftId = Number((draftRes.rows[0] as any).draft_id);
    await tx.execute(sql`
      INSERT INTO supply_draft_items
        (draft_id, nm_id, title, quantity, current_stock, avg_daily_sales)
      VALUES
        (${draftId}, ${args.nmId}, ${args.title}, ${args.quantity},
         ${args.currentStock}, ${args.avgDaily != null ? String(args.avgDaily) : null});
    `);
    return draftId;
  });
}

// ============================================================================
// Feedback / reviews (rev 25n)
// ============================================================================

export interface PendingReviewRow {
  itemId: string;
  shopId: number | null;
  nmId: number | null;
  rating: number | null;
  text: string;
  pros: string | null;
  cons: string | null;
  userName: string | null;
  productTitle: string | null;
  createdAt: string | null;
}

/**
 * Negative pending reviews — rating ≤ 3, not yet answered. Newest first
 * so the user sees the freshest pain points at the top.
 */
export async function listPendingNegativeReviews(
  workspaceId: number,
  limit = 10,
): Promise<PendingReviewRow[]> {
  const rows = await db.execute(sql`
    SELECT item_id, shop_id, nm_id, rating, text, pros, cons,
           user_name, product_title, created_at
      FROM marketplace_feedback_items
     WHERE workspace_id = ${workspaceId}
       AND item_type = 'review'
       AND is_answered = false
       AND (rating IS NULL OR rating <= 3)
     ORDER BY created_at DESC NULLS LAST
     LIMIT ${limit};
  `);
  return (rows.rows as any[]).map((r) => ({
    itemId: String(r.item_id),
    shopId: r.shop_id != null ? Number(r.shop_id) : null,
    nmId: r.nm_id != null ? Number(r.nm_id) : null,
    rating: r.rating != null ? Number(r.rating) : null,
    text: String(r.text ?? ''),
    pros: r.pros ? String(r.pros) : null,
    cons: r.cons ? String(r.cons) : null,
    userName: r.user_name ? String(r.user_name) : null,
    productTitle: r.product_title ? String(r.product_title) : null,
    createdAt: r.created_at ? String(r.created_at) : null,
  }));
}

export async function reviewById(workspaceId: number, itemId: string): Promise<PendingReviewRow | null> {
  const rows = await db.execute(sql`
    SELECT item_id, shop_id, nm_id, rating, text, pros, cons,
           user_name, product_title, created_at
      FROM marketplace_feedback_items
     WHERE workspace_id = ${workspaceId}
       AND item_type = 'review'
       AND item_id = ${itemId}
     LIMIT 1;
  `);
  const r = rows.rows[0] as any;
  if (!r) return null;
  return {
    itemId: String(r.item_id),
    shopId: r.shop_id != null ? Number(r.shop_id) : null,
    nmId: r.nm_id != null ? Number(r.nm_id) : null,
    rating: r.rating != null ? Number(r.rating) : null,
    text: String(r.text ?? ''),
    pros: r.pros ? String(r.pros) : null,
    cons: r.cons ? String(r.cons) : null,
    userName: r.user_name ? String(r.user_name) : null,
    productTitle: r.product_title ? String(r.product_title) : null,
    createdAt: r.created_at ? String(r.created_at) : null,
  };
}

/**
 * Marks the review as answered locally after we've successfully POSTed
 * the answer to WB. We update both `answer_text` and `is_answered/status`
 * so the next /feedback list doesn't show it again, even if WB's sync
 * hasn't caught up yet.
 */
export async function markReviewAnswered(
  workspaceId: number,
  itemId: string,
  answerText: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE marketplace_feedback_items
       SET answer_text = ${answerText},
           is_answered = true,
           answer_state = 'wbRu',
           status       = 'answered',
           answered_at  = NOW(),
           updated_at   = NOW()
     WHERE workspace_id = ${workspaceId}
       AND item_type = 'review'
       AND item_id = ${itemId};
  `);
}

/**
 * Top-N critical pending events across the workspace, ordered by potential
 * monthly loss (best estimate available). Used to build the `/today` triage
 * card (rev 27a).
 */
export interface TopCriticalRow {
  eventId: number;
  nmId: number | null;
  title: string;
  trigger: string;
  potentialLossRub: number | null;
  shopName: string | null;
}

export async function topCriticalEvents(
  workspaceId: number,
  limit = 3,
  shopId?: number,
): Promise<TopCriticalRow[]> {
  const shopFilter = shopId
    ? sql`AND (ev.meta->>'shopId')::int = ${shopId}`
    : sql``;
  const rows = await db.execute(sql`
    WITH ev AS (
      SELECT event_id, nm_id, title, meta,
             (meta->>'avgDaily')::numeric AS avg_daily,
             meta->>'triggerId' AS trigger,
             (meta->>'shopId')::int AS shop_id
        FROM agent_events ev
       WHERE workspace_id = ${workspaceId}
         AND status = 'pending'
         AND severity = 'critical'
         AND created_at > NOW() - INTERVAL '2 days'
         ${shopFilter}
    ),
    px AS (
      SELECT nm_id,
             CASE WHEN SUM(sales_count) > 0
                  THEN SUM(sales_rub::numeric) / SUM(sales_count)
                  ELSE NULL END AS unit_price_rub
        FROM wb_orders_sales_daily_products
       WHERE workspace_id = ${workspaceId}
         AND date::date >= CURRENT_DATE - 30
       GROUP BY nm_id
    )
    SELECT ev.event_id, ev.nm_id, ev.title, ev.trigger,
           CASE WHEN ev.avg_daily IS NOT NULL AND px.unit_price_rub IS NOT NULL
                THEN ev.avg_daily * 30 * px.unit_price_rub ELSE NULL END AS potential_loss_rub,
           ms.name AS shop_name
      FROM ev
      LEFT JOIN px USING (nm_id)
      LEFT JOIN marketplace_shops ms ON ms.workspace_id = ${workspaceId} AND ms.shop_id = ev.shop_id
     ORDER BY potential_loss_rub DESC NULLS LAST, ev.event_id ASC
     LIMIT ${limit};
  `);
  return (rows.rows as any[]).map((r) => ({
    eventId: Number(r.event_id),
    nmId: r.nm_id != null ? Number(r.nm_id) : null,
    title: String(r.title),
    trigger: String(r.trigger),
    potentialLossRub: r.potential_loss_rub != null ? Number(r.potential_loss_rub) : null,
    shopName: r.shop_name ?? null,
  }));
}

/**
 * Workspace-wide aggregate for "today" / "yesterday". Used as the bottom
 * mini-dashboard line on the /today screen (rev 27a). Optional shopId
 * narrows to one shop.
 */
export interface DayAggregateRow {
  ordersCount: number;
  ordersRub: number;
  salesCount: number;
  salesRub: number;
  buyoutPct: number | null;
  date: string;
}

export async function workspaceDayAggregate(
  workspaceId: number,
  date: string,
  shopId?: number,
): Promise<DayAggregateRow | null> {
  const shopFilter = shopId ? sql`AND shop_id = ${shopId}` : sql``;
  const rows = await db.execute(sql`
    SELECT COALESCE(SUM(orders_count), 0)::int AS orders_count,
           COALESCE(SUM(orders_rub::numeric), 0)::numeric AS orders_rub,
           COALESCE(SUM(sales_count), 0)::int AS sales_count,
           COALESCE(SUM(sales_rub::numeric), 0)::numeric AS sales_rub
      FROM wb_orders_sales_daily
     WHERE workspace_id = ${workspaceId}
       AND date::date = ${date}::date
       ${shopFilter};
  `);
  const r = rows.rows[0] as any;
  if (!r) return null;
  const ordersCount = Number(r.orders_count);
  const salesCount = Number(r.sales_count);
  return {
    ordersCount,
    ordersRub: Number(r.orders_rub),
    salesCount,
    salesRub: Number(r.sales_rub),
    buyoutPct: ordersCount > 0 ? (salesCount / ordersCount) * 100 : null,
    date,
  };
}

export async function listAlertGroups(workspaceId: number, shopId?: number): Promise<AlertGroupRow[]> {
  const shopFilter = shopId ? sql`AND (meta->>'shopId')::int = ${shopId}` : sql``;
  const rows = await db.execute(sql`
    SELECT meta->>'triggerId' AS trigger,
           COUNT(*)::int AS count,
           MIN(CASE severity
             WHEN 'critical' THEN 0
             WHEN 'high'     THEN 1
             WHEN 'medium'   THEN 2
             ELSE 3
           END) AS sev_rank
      FROM agent_events
     WHERE workspace_id = ${workspaceId}
       AND status = 'pending'
       AND meta->>'triggerId' IS NOT NULL
       ${shopFilter}
     GROUP BY meta->>'triggerId'
     ORDER BY sev_rank ASC, COUNT(*) DESC;
  `);
  return (rows.rows as any[]).map((r) => ({
    trigger: String(r.trigger),
    count: Number(r.count),
    severity: r.sev_rank === 0 ? 'critical' : r.sev_rank === 1 ? 'high' : r.sev_rank === 2 ? 'medium' : 'info',
  }));
}
