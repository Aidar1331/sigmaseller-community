/**
 * Detects data gaps by finding the last date with ACTUAL (non-zero) data
 * in each data table for a workspace.
 * Used by smart refresh to sync exactly the missing days.
 *
 * Important: the orders/sales sync script writes zero-value rows for dates
 * where the WB API hasn't returned data yet (API has 1-2 day lag).
 * We must look for MAX(date) WHERE data > 0 to find the real data boundary.
 *
 * NOTE on campaigns and supplies — they are NOT time-series streams and
 * therefore are intentionally absent from the UNION below:
 *   - syncCampaigns refreshes metadata (id/name/status) for all active
 *     adverts in one snapshot; no concept of "missed days".
 *   - runSuppliesSyncForWorkspace pulls all in-flight supplies (status
 *     IN 1..6) regardless of date.
 * For freshness of those streams use `wb_sync_runs.last_success_at` via
 * the marketplace_shops_sync_status VIEW (migration 0111).
 */

import { db } from '../db/client.js';
import { sql } from 'drizzle-orm';

export interface DataGap {
  dataType: string;
  firstDataDate: string | null;
  lastDataDate: string | null;
  totalDays: number;
  gapDays: number;
  recommendedDaysBack: number;
}

export interface DataGapsResult {
  gaps: DataGap[];
}

const MIN_DAYS_BACK = 3;
// Sigma Seller продаёт аналитику с глубиной 90 дней — это фиксированный сервисный SLA, не настройка экономии.
// Поэтому detector гарантирует двунаправленный gap-fill: вперёд до today И назад до today-90.
const MAX_DAYS_BACK = 90;
const REQUIRED_HISTORY_DAYS = 90;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export async function detectDataGaps(workspaceId: number, shopId?: number): Promise<DataGapsResult> {
  // shop_id filter: when shopId provided, filter per-shop; otherwise aggregate workspace
  const shopFilter = shopId ? sql`AND shop_id = ${shopId}` : sql``;
  const rows = await db.execute<{ data_type: string; first_date: string | null; last_date: string | null; total_days: number }>(sql`
    SELECT 'orders-sales' AS data_type, MIN(date) AS first_date, MAX(date) AS last_date,
           COUNT(DISTINCT date)::int AS total_days
      FROM wb_orders_sales_daily
      WHERE workspace_id = ${workspaceId} ${shopFilter}
        AND (orders_count > 0 OR sales_count > 0)
    UNION ALL
    SELECT 'adv' AS data_type, MIN(date) AS first_date, MAX(date) AS last_date,
           COUNT(DISTINCT date)::int AS total_days
      FROM wb_adv_daily
      WHERE workspace_id = ${workspaceId} ${shopFilter}
        AND (spend_kopecks > 0 OR views_count > 0 OR clicks_count > 0)
    UNION ALL
    SELECT 'funnel' AS data_type, MIN(date) AS first_date, MAX(date) AS last_date,
           COUNT(DISTINCT date)::int AS total_days
      FROM wb_funnel_daily
      WHERE workspace_id = ${workspaceId} ${shopFilter} AND source = 'products'
    UNION ALL
    SELECT 'finance' AS data_type,
      COALESCE(
        (SELECT MIN(date) FROM wb_finance_daily WHERE workspace_id = ${workspaceId} ${shopFilter} AND lines > 0),
        (SELECT MIN(date_from) FROM wb_finance_weekly_products WHERE workspace_id = ${workspaceId} ${shopFilter})
      ) AS first_date,
      COALESCE(
        (SELECT MAX(date) FROM wb_finance_daily WHERE workspace_id = ${workspaceId} ${shopFilter} AND lines > 0),
        (SELECT MAX(date_to) FROM wb_finance_weekly_products WHERE workspace_id = ${workspaceId} ${shopFilter})
      ) AS last_date,
      COALESCE(
        (SELECT COUNT(DISTINCT date)::int FROM wb_finance_daily WHERE workspace_id = ${workspaceId} ${shopFilter} AND lines > 0),
        0
      ) AS total_days
    UNION ALL
    SELECT 'stocks' AS data_type,
      LEAST(
        COALESCE((SELECT MIN(date)::text FROM wb_stocks_daily_products WHERE workspace_id = ${workspaceId} ${shopFilter}), '9999-12-31'),
        COALESCE((SELECT TO_CHAR(MIN(date), 'YYYY-MM-DD') FROM wb_stocks_daily WHERE workspace_id = ${workspaceId} ${shopFilter}), '9999-12-31'),
        COALESCE(TO_CHAR(MIN(updated_at), 'YYYY-MM-DD'), '9999-12-31')
      ) AS first_date,
      GREATEST(
        COALESCE((SELECT MAX(date)::text FROM wb_stocks_daily_products WHERE workspace_id = ${workspaceId} ${shopFilter}), '2000-01-01'),
        COALESCE((SELECT TO_CHAR(MAX(date), 'YYYY-MM-DD') FROM wb_stocks_daily WHERE workspace_id = ${workspaceId} ${shopFilter}), '2000-01-01'),
        COALESCE(TO_CHAR(MAX(updated_at), 'YYYY-MM-DD'), '2000-01-01')
      ) AS last_date,
      GREATEST(1,
        COALESCE((SELECT COUNT(DISTINCT date)::int FROM wb_stocks_daily_products WHERE workspace_id = ${workspaceId} ${shopFilter}), 0)
        + COALESCE((SELECT COUNT(DISTINCT date::text)::int FROM wb_stocks_daily WHERE workspace_id = ${workspaceId} ${shopFilter}), 0)
      ) AS total_days
      FROM wb_stocks_current WHERE workspace_id = ${workspaceId} ${shopFilter}
    UNION ALL
    SELECT 'paid-storage' AS data_type, TO_CHAR(MIN(date), 'YYYY-MM-DD') AS first_date,
           TO_CHAR(MAX(date), 'YYYY-MM-DD') AS last_date,
           COUNT(DISTINCT date::date)::int AS total_days
      FROM wb_storage_daily
      WHERE workspace_id = ${workspaceId} ${shopFilter} AND cost > 0
    UNION ALL
    SELECT 'stocks-history' AS data_type, TO_CHAR(MIN(date), 'YYYY-MM-DD') AS first_date,
           TO_CHAR(MAX(date), 'YYYY-MM-DD') AS last_date,
           COUNT(DISTINCT date::date)::int AS total_days
      FROM wb_stocks_daily
      WHERE workspace_id = ${workspaceId} ${shopFilter} AND qty > 0
    UNION ALL
    SELECT 'spp' AS data_type, MIN(date_from) AS first_date,
           MAX(date_to) AS last_date,
           COUNT(DISTINCT date_from)::int AS total_days
      FROM wb_spp_weekly
      WHERE workspace_id = ${workspaceId} AND spp_pct_bp > 0
  `);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const gaps: DataGap[] = (rows.rows ?? rows as any).map((row: any) => {
    const dataType = row.data_type as string;
    const firstDataDate = row.first_date as string | null;
    const lastDataDate = row.last_date as string | null;
    const totalDays = Number(row.total_days) || 0;

    if (!lastDataDate) {
      // No data ever — initial backfill полный 90-дневный горизонт.
      return {
        dataType,
        firstDataDate: null,
        lastDataDate: null,
        totalDays: 0,
        gapDays: REQUIRED_HISTORY_DAYS,
        recommendedDaysBack: REQUIRED_HISTORY_DAYS,
      };
    }

    const lastDate = new Date(lastDataDate + 'T00:00:00');
    const diffMs = today.getTime() - lastDate.getTime();
    const gapForward = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));

    // Если первая дата в БД ближе чем 90д назад от today — есть «дырка» сзади. Догружаем чтобы покрыть полный 90-дневный горизонт.
    const firstDate = firstDataDate ? new Date(firstDataDate + 'T00:00:00') : lastDate;
    const firstDateAge = Math.max(0, Math.floor((today.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24)));
    const gapBackward = Math.max(0, REQUIRED_HISTORY_DAYS - firstDateAge);

    // Берём бóльший из двух: вперёд (catch-up) или назад (history-fill). +1 — safety.
    const recommendedDaysBack = clamp(
      Math.max(gapForward + 1, gapBackward),
      MIN_DAYS_BACK,
      MAX_DAYS_BACK,
    );

    return {
      dataType,
      firstDataDate: firstDataDate ?? lastDataDate,
      lastDataDate,
      totalDays,
      gapDays: gapForward, // for API back-compat — represents catch-up gap forward to today; backward gap absorbed into recommendedDaysBack
      recommendedDaysBack,
    };
  });

  return { gaps };
}
