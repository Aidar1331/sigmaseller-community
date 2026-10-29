/**
 * Daily Telegram digests (rev 25c)
 *
 * Two separate digests with two separate audiences:
 *
 *   runAdminDailyDigest()  — 06:30 MSK, to TELEGRAM_MODERATION_CHAT_ID
 *     Technical: sync_runs by family (24h), walker progress,
 *     per-shop coverage matrix (120 days). For the operator who needs
 *     to see "is the sync healthy?" at a glance.
 *
 *   runUserDailyDigest()   — 09:00 MSK, to each user.user_telegram_links.tg_chat_id
 *     Business: per-workspace per-shop orders+sales for the latest fully
 *     synced day, week-comparison, anomaly flags. For the seller who
 *     opens Telegram with their tea, not the operator.
 *
 * No technical jargon (sync, cron, walker, WB 429, pg-boss) leaks into
 * the user digest — operator specifically called this out 2026-05-16.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sendTelegramModeration, sendTelegramMessage } from '../integrations/telegram.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'dailyDigests' });

// ============================================================================
// Admin daily digest (technical)
// ============================================================================

interface SyncFamilyRow {
  family: string;
  done: number;
  fails: number;
  rows: number;
}
interface WalkerRow {
  shop_id: number;
  name: string;
  sync_type: string;
  oldest_covered: Date | null;
  target_oldest: Date;
  remaining: number;
  last_advanced_at: Date | null;
  last_error: string | null;
}
interface CoverageRow {
  shop_id: number;
  name: string;
  fin_days: number;
  ord_days: number;
  fun_days: number;
  adv_days: number;
}

const SYNC_FAMILY_RU: Record<string, string> = {
  'reports-daily':            'Отчёты WB',
  'finance-daily':            'Финансы (день)',
  'finance-weekly-products':  'Финансы / товары',
  'funnel-daily':             'Воронка',
  'adv-daily':                'Реклама',
  'orders-sales':             'Заказы и продажи',
  'spp-weekly':               'СПП (неделя)',
  'stocks-snapshot':          'Остатки на складе',
  'stocks-history':           'История остатков',
  'search-queries':           'Поисковые запросы',
};

const SYNC_TYPE_RU: Record<string, string> = {
  orders_sales: 'Заказы и продажи',
  funnel:       'Воронка',
  adv:          'Реклама',
  finance:      'Финансы',
};

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}
function lpad(s: string | number, n: number): string {
  const t = String(s);
  return t.length >= n ? t : ' '.repeat(n - t.length) + t;
}
function ruDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}
function fmtRub(rub: number): string {
  return Math.round(rub).toLocaleString('ru-RU') + ' ₽';
}

// Columns wb_orders_sales_daily.{orders_rub, sales_rub, finished_price_rub}
// are named *_rub but actually store kopecks (see schema.ts). Use this
// helper to avoid silent ×100 inflation in user-facing output.
function fmtRubFromKop(kop: number): string {
  return fmtRub(kop / 100);
}

export async function runAdminDailyDigest(): Promise<void> {
  const t0 = Date.now();
  const today = new Date();
  logger.info('starting admin daily digest');

  // 1) Sync runs by family over the last 24h.
  const syncFamilies = await db.execute(sql<SyncFamilyRow>`
    WITH sr AS (
      SELECT substring(stage from '^([a-z][a-z0-9-]+?)(:|$)') AS family,
             status, rows_written
        FROM wb_sync_runs
       WHERE created_at > now() - interval '24 hours'
    )
    SELECT family,
           COUNT(*) FILTER (WHERE status='done')::int AS done,
           COUNT(*) FILTER (WHERE status IN ('failed','error') OR status LIKE 'failed:%')::int AS fails,
           COALESCE(SUM(rows_written) FILTER (WHERE status='done'), 0)::int AS rows
      FROM sr
     WHERE family IS NOT NULL
     GROUP BY family
     ORDER BY family;
  `);

  // 2) Walker progress per (shop, sync_type).
  const walker = await db.execute(sql<WalkerRow>`
    SELECT s.shop_id, s.name, p.sync_type,
           p.oldest_covered, p.target_oldest,
           (p.oldest_covered - p.target_oldest)::int AS remaining,
           p.last_advanced_at, p.last_error
      FROM wb_backfill_progress p
      JOIN marketplace_shops s USING (workspace_id, shop_id)
     WHERE s.platform = 'wb'
     ORDER BY s.shop_id, p.sync_type;
  `);

  // 3) Per-shop 120-day coverage matrix.
  const coverage = await db.execute(sql<CoverageRow>`
    WITH shop AS (SELECT shop_id, name FROM marketplace_shops WHERE platform='wb' AND is_active),
    fd AS (SELECT shop_id, COUNT(DISTINCT date::date) AS d FROM wb_finance_daily      WHERE date::date >= current_date - 120 GROUP BY shop_id),
    os AS (SELECT shop_id, COUNT(DISTINCT date::date) AS d FROM wb_orders_sales_daily WHERE date::date >= current_date - 120 GROUP BY shop_id),
    fl AS (SELECT shop_id, COUNT(DISTINCT date::date) AS d FROM wb_funnel_daily       WHERE date::date >= current_date - 120 GROUP BY shop_id),
    ad AS (SELECT shop_id, COUNT(DISTINCT date::date) AS d FROM wb_adv_daily          WHERE date::date >= current_date - 120 GROUP BY shop_id)
    SELECT s.shop_id, s.name,
           COALESCE(fd.d, 0)::int AS fin_days,
           COALESCE(os.d, 0)::int AS ord_days,
           COALESCE(fl.d, 0)::int AS fun_days,
           COALESCE(ad.d, 0)::int AS adv_days
      FROM shop s
      LEFT JOIN fd USING (shop_id)
      LEFT JOIN os USING (shop_id)
      LEFT JOIN fl USING (shop_id)
      LEFT JOIN ad USING (shop_id)
     ORDER BY s.shop_id;
  `);

  // Build the message.
  const lines: string[] = [];
  lines.push(`☀️ <b>SigmaSeller · ежедневная сводка</b> · ${ruDate(today)}`);
  lines.push('');
  lines.push('📊 <b>Синхронизации за сутки</b>');
  lines.push('<pre>Раздел              Усп  Сбой  Записей');
  lines.push('───────────────────────────────────────');
  for (const r of syncFamilies.rows as unknown as SyncFamilyRow[]) {
    const name = SYNC_FAMILY_RU[r.family] ?? r.family;
    const rowsStr = r.rows > 0 ? lpad(r.rows.toLocaleString('ru-RU'), 8) : lpad('—', 8);
    lines.push(
      `${pad(name, 19)} ${lpad(r.done, 3)}  ${lpad(r.fails || '—', 4)} ${rowsStr}`,
    );
  }
  lines.push('</pre>');

  // Attention block — anything with fails > done
  const issues = (syncFamilies.rows as unknown as SyncFamilyRow[]).filter(r => r.fails > r.done);
  if (issues.length > 0) {
    lines.push('');
    lines.push('⚠️ <b>Что требует внимания</b>');
    for (const r of issues) {
      const name = SYNC_FAMILY_RU[r.family] ?? r.family;
      lines.push(`• <b>${name}</b> · ${r.fails} сбоев из ${r.fails + r.done}`);
    }
  }

  // Walker
  lines.push('');
  lines.push('🌙 <b>Догрузчик истории · ночью</b>');
  lines.push('Цикл стартует в 23:00 MSK и работает до 03:30. Каждые 30 минут берёт один магазин + один тип данных и догоняет историю на 7 дней назад.');
  lines.push('');
  lines.push('<pre>Магазин   Метрика           Осталось');
  lines.push('──────────────────────────────────────');
  for (const r of walker.rows as unknown as WalkerRow[]) {
    const sync = SYNC_TYPE_RU[r.sync_type] ?? r.sync_type;
    const mark = r.last_error ? ' ⚠' : '';
    lines.push(`${pad(r.name, 9)} ${pad(sync, 17)} ${lpad(r.remaining + ' дн', 7)}${mark}`);
  }
  lines.push('</pre>');
  const stuck = (walker.rows as unknown as WalkerRow[]).filter(r => r.last_error);
  for (const r of stuck) {
    const sync = SYNC_TYPE_RU[r.sync_type] ?? r.sync_type;
    const errSnippet = (r.last_error ?? '').slice(0, 60);
    lines.push(`⚠ ${r.name} · ${sync} — ${errSnippet}`);
  }

  // Coverage
  lines.push('');
  lines.push('📈 <b>Покрытие данных за 120 дней</b>');
  lines.push('<pre>Магазин   Финансы Заказы Воронка Реклама');
  lines.push('────────────────────────────────────────');
  for (const r of coverage.rows as unknown as CoverageRow[]) {
    lines.push(
      `${pad(r.name, 9)} ${lpad(r.fin_days, 7)} ${lpad(r.ord_days, 6)} ${lpad(r.fun_days, 7)} ${lpad(r.adv_days, 7)}`,
    );
  }
  lines.push('</pre>');
  lines.push('<i>Цифры — количество дней с данными за последние 120. Цель: 90 у всех.</i>');

  const text = lines.join('\n');
  await sendTelegramModeration({ text });

  const elapsed = Date.now() - t0;
  logger.info({ elapsedMs: elapsed, families: syncFamilies.rows.length }, 'admin digest sent');
}

// ============================================================================
// User daily digest (business)
// ============================================================================

interface ShopDayRow {
  shop_id: number;
  shop_name: string;
  date: string;
  orders_count: number;
  sales_count: number;
  orders_rub: number;
  sales_rub: number;
}

// ---------------------------------------------------------------------------
// Verdict & status helpers (Digest V2 — Слой 2)
// ---------------------------------------------------------------------------

type StatusEmoji = '🟢' | '🟡' | '🔴';

interface ShopStatus {
  emoji: StatusEmoji;
  verdict: string;
  hint: string | null;       // actionable suggestion (rendered as "↳ ...")
}

/**
 * Decides 🟢/🟡/🔴 status + verbal verdict + actionable hint per shop.
 * Rules (per SPEC-DIGEST-V2-2026-05-23.md):
 *   🔴 — выкуп 0% при заказах > 0  OR  падение продаж > 50% к недельному ср.
 *   🟡 — выкуп ниже 85% от baseline (если есть ≥3 дня истории) OR падение 20-50%
 *   🟢 — всё нормально/выше нормы
 */
function detectShopStatus(args: {
  ordersCount: number;
  salesCount: number;
  daySalesKop: number;             // sales_rub for yesterday (in kopecks)
  weekAvgSalesKop: number;         // average daily sales over last 7 days (kopecks)
  baselineBuyoutRatio: number | null;  // 0..1, null if insufficient history
  baselineDays: number;            // number of historical days with orders for baseline
}): ShopStatus {
  const { ordersCount, salesCount, daySalesKop, weekAvgSalesKop, baselineBuyoutRatio, baselineDays } = args;

  // 🔴 zero buyout with actual orders
  if (ordersCount > 0 && salesCount === 0) {
    return {
      emoji: '🔴',
      verdict: 'выкуп 0%',
      hint: ordersCount < 5
        ? '↳ заказы свежие — выкуп обычно через 1-3 дня'
        : '↳ возможен сбой логистики или массовая отмена — проверь',
    };
  }

  // Δ to weekly sales average — main "sharp drop" signal
  let salesDeltaPct: number | null = null;
  if (weekAvgSalesKop > 0 && daySalesKop > 0) {
    salesDeltaPct = ((daySalesKop - weekAvgSalesKop) / weekAvgSalesKop) * 100;
  }

  // 🔴 sharp drop > 50%
  if (salesDeltaPct != null && salesDeltaPct < -50) {
    return {
      emoji: '🔴',
      verdict: 'резкое падение продаж',
      hint: '↳ проверь остатки, цены, рекламу',
    };
  }

  const todayBuyoutRatio = ordersCount > 0 ? salesCount / ordersCount : null;
  const hasBaseline = baselineBuyoutRatio != null && baselineDays >= 3;

  // 🟡 buyout below baseline by >15%
  if (
    hasBaseline &&
    todayBuyoutRatio != null &&
    todayBuyoutRatio < (baselineBuyoutRatio as number) * 0.85
  ) {
    return {
      emoji: '🟡',
      verdict: 'выкуп ниже обычного',
      hint: '↳ проверь возвраты, медленную доставку, негативные отзывы',
    };
  }

  // 🟡 sales drop 20-50%
  if (salesDeltaPct != null && salesDeltaPct < -20) {
    return {
      emoji: '🟡',
      verdict: 'продажи проседают',
      hint: '↳ проверь конверсию, остатки, рекламу',
    };
  }

  // 🟢 — default. Verbal verdict reflects how strong.
  let verdict = 'стабильный день';
  if (todayBuyoutRatio != null && todayBuyoutRatio >= 0.9) verdict = 'отличный день';
  else if (salesDeltaPct != null && salesDeltaPct > 10) verdict = 'хороший день';
  return { emoji: '🟢', verdict, hint: null };
}

function isTestShopName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('test') || lower.includes('тест');
}
interface UserBindRow {
  user_id: number;
  tg_chat_id: string;
  workspace_id: number;
}

export async function runUserDailyDigest(): Promise<void> {
  const t0 = Date.now();
  logger.info('starting user daily digest');

  // 1) Find all (user, tg_chat_id, workspace) bindings.
  const bindings = await db.execute(sql<UserBindRow>`
    SELECT l.user_id, l.tg_chat_id, m.workspace_id
      FROM user_telegram_links l
      JOIN workspace_members m ON m.user_id = l.user_id
     ORDER BY l.user_id, m.workspace_id;
  `);
  const rows = bindings.rows as unknown as UserBindRow[];
  if (rows.length === 0) {
    logger.info('no bound users — skipping user digest');
    return;
  }

  // Group bindings by user (a user may have multiple workspaces).
  const byUser = new Map<number, { chatId: string; workspaceIds: number[] }>();
  for (const r of rows) {
    let entry = byUser.get(r.user_id);
    if (!entry) {
      entry = { chatId: r.tg_chat_id, workspaceIds: [] };
      byUser.set(r.user_id, entry);
    }
    entry.workspaceIds.push(r.workspace_id);
  }

  for (const [userId, entry] of byUser) {
    try {
      const text = await buildUserDigestText(entry.workspaceIds);
      if (text) {
        await sendTelegramMessage(entry.chatId, text);
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, userId }, 'user digest send failed');
    }
  }

  const elapsed = Date.now() - t0;
  logger.info({ elapsedMs: elapsed, users: byUser.size }, 'user digest cycle complete');
}

export async function buildUserDigestText(workspaceIds: number[]): Promise<string | null> {
  if (workspaceIds.length === 0) return null;

  // Find the latest fully-covered "yesterday" across the user's shops:
  // use the max(date) in orders_sales for these workspaces.
  const wsList = workspaceIds.map((x) => sql.raw(String(x)));
  const latestRows = await db.execute(sql<{ d: string }>`
    SELECT MAX(date::date)::text AS d
      FROM wb_orders_sales_daily
     WHERE workspace_id IN (${sql.join(wsList, sql`, `)});
  `);
  const latest = (latestRows.rows[0] as any)?.d as string | undefined;
  if (!latest) return null;

  const yesterday = latest;
  const weekFrom = (() => {
    const d = new Date(yesterday + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 6);
    return d.toISOString().slice(0, 10);
  })();

  // Per-shop yesterday + week aggregates.
  // baseline_buyout_ratio — buyout рассчитан ИСКЛЮЧАЯ yesterday, чтобы
  // baseline отражал «как было раньше», а не подмешивал сегодняшние данные.
  const perShop = await db.execute(sql<ShopDayRow & {
    week_orders: number;
    week_sales_rub: number;
    baseline_buyout_ratio: number | null;
    baseline_days: number;
  }>`
    WITH y AS (
      SELECT os.shop_id, ms.name AS shop_name,
             os.orders_count, os.sales_count,
             os.orders_rub::numeric AS orders_rub,
             os.sales_rub::numeric  AS sales_rub
        FROM wb_orders_sales_daily os
        JOIN marketplace_shops ms USING (workspace_id, shop_id)
       WHERE os.workspace_id IN (${sql.join(wsList, sql`, `)})
         AND os.date::date = ${yesterday}::date
    ),
    w AS (
      SELECT shop_id,
             SUM(orders_count)::int AS week_orders,
             SUM(sales_rub::numeric) AS week_sales_rub,
             CASE WHEN SUM(orders_count) FILTER (WHERE date::date < ${yesterday}::date) > 0
                  THEN SUM(sales_count) FILTER (WHERE date::date < ${yesterday}::date)::float
                     / SUM(orders_count) FILTER (WHERE date::date < ${yesterday}::date)::float
                  ELSE NULL END AS baseline_buyout_ratio,
             COUNT(*) FILTER (WHERE date::date < ${yesterday}::date AND orders_count > 0)::int AS baseline_days
        FROM wb_orders_sales_daily
       WHERE workspace_id IN (${sql.join(wsList, sql`, `)})
         AND date::date BETWEEN ${weekFrom}::date AND ${yesterday}::date
       GROUP BY shop_id
    )
    SELECT y.*,
           w.week_orders,
           w.week_sales_rub::numeric AS week_sales_rub,
           w.baseline_buyout_ratio,
           w.baseline_days
      FROM y LEFT JOIN w USING (shop_id)
     ORDER BY y.shop_id;
  `);
  const shopRows = perShop.rows as unknown as Array<ShopDayRow & {
    week_orders: number;
    week_sales_rub: string;
    baseline_buyout_ratio: number | null;
    baseline_days: number;
  }>;
  if (shopRows.length === 0) return null;

  const lines: string[] = [];
  const ymd = new Date(yesterday + 'T00:00:00Z');
  lines.push(`🌅 <b>Сводка за ${ruDate(ymd)}</b>`);
  lines.push(`<i>Данные на ${ruDate(ymd)}, 23:00 МСК</i>`);

  for (const r of shopRows) {
    const shopName = String(r.shop_name);
    const displayName = isTestShopName(shopName) ? `[TEST] ${shopName}` : shopName;

    const daySalesKop = Number(r.sales_rub);
    const weekSalesKop = Number(r.week_sales_rub) || 0;
    const weekAvgKop = weekSalesKop / 7;
    const baselineRatio = r.baseline_buyout_ratio != null ? Number(r.baseline_buyout_ratio) : null;
    const baselineDays = Number(r.baseline_days ?? 0);

    const status = detectShopStatus({
      ordersCount: r.orders_count,
      salesCount: r.sales_count,
      daySalesKop,
      weekAvgSalesKop: weekAvgKop,
      baselineBuyoutRatio: baselineRatio,
      baselineDays,
    });

    lines.push('');
    lines.push(`${status.emoji} <b>${displayName}</b> — ${status.verdict}`);
    lines.push(`Заказы: <b>${r.orders_count}</b> шт / <b>${fmtRubFromKop(Number(r.orders_rub))}</b>`);

    // Buyout line — обязательно показываем %
    let buyoutLine: string;
    if (r.orders_count > 0) {
      const todayPct = Math.round((r.sales_count / r.orders_count) * 100);
      buyoutLine = `Выкуп: <b>${todayPct}%</b> (${r.sales_count} шт / ${fmtRubFromKop(Number(r.sales_rub))})`;
      if (baselineRatio != null && baselineDays >= 3) {
        const baselinePct = Math.round(baselineRatio * 100);
        // Если сегодня заметно ниже baseline — намекаем «обычно X%»
        if (todayPct < Math.round(baselinePct * 0.85)) {
          buyoutLine += ` — обычно ~${baselinePct}%`;
        }
      }
    } else {
      buyoutLine = `Выкуп: <b>${r.sales_count}</b> шт / <b>${fmtRubFromKop(Number(r.sales_rub))}</b>`;
    }
    lines.push(buyoutLine);

    // Week delta — показываем только если ≥20% в любую сторону
    if (weekAvgKop > 0 && daySalesKop > 0) {
      const delta = Math.round(((daySalesKop - weekAvgKop) / weekAvgKop) * 100);
      if (delta <= -20) {
        lines.push(`📉 ${delta}% к среднему за неделю`);
      } else if (delta >= 20) {
        lines.push(`📈 +${delta}% к среднему за неделю`);
      }
    }

    if (status.hint) {
      lines.push(status.hint);
    }
  }
  return lines.join('\n');
}
