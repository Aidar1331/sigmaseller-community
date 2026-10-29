/**
 * Real-time critical events pusher (rev 25f, digest in 25v.1).
 *
 * Polls `agent_events` every minute for new rows with `severity = 'critical'`
 * and pushes them to all linked Telegram users in the event's workspace.
 *
 * Rollup (25v.1): each cron tick collects ALL new events (post-watermark)
 * and emits ONE digest message per linked user — not one message per
 * event. With 14 new criticals per tick we now send 1 grouped message,
 * not 1-and-throttle-13. Singletons keep the rich event card with action
 * buttons; multi-event digests use a compact list and link to /alerts
 * for actions.
 *
 * Throttling: still 1 push per user per `PUSH_THROTTLE_MIN` minutes,
 * but now applied at the digest level — so even if events keep streaming
 * the user gets at most 1 notification per window.
 *
 * Watermark: stored in Redis as ISO timestamp. On first run, defaults to
 * NOW − 5 min (to avoid replaying old criticals when the job is first
 * deployed). Cleared by hand only if you need a back-fill push.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { getRedis } from '../lib/redis.js';
import { sendTelegramMessage } from '../integrations/telegram.js';
import { fetchPublicCard } from '../integrations/wb/publicCard.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'criticalEventsPusher' });

// Per-env watermark so prod/staging don't trample each other's cursor when
// they share Redis. NODE_ENV in production is 'production'; everything else
// (test/dev) gets its own namespace.
const WATERMARK_KEY = `tg:critical_pusher:watermark:${process.env.NODE_ENV ?? 'prod'}`;
const THROTTLE_PREFIX = 'tg:push_throttle';
const PUSH_THROTTLE_MIN = 10;
const USER_FANOUT_CONCURRENCY = 8; // parallel sends per workspace
const TRIGGER_LABEL: Record<string, string> = {
  stock_zero: 'Нулевой остаток',
  stock_critical: 'Критически мало',
  returns_spike: 'Всплеск возвратов',
  price_margin_negative: 'Отрицательная маржа',
  adv_zero_orders: 'Реклама без заказов',
  content_negative_review: 'Негативный отзыв',
};

interface PendingCriticalEvent {
  event_id: number;
  workspace_id: number;
  nm_id: number | null;
  title: string;
  description: string | null;
  suggested_action: string | null;
  trigger: string | null;
  qty: number | null;
  avg_daily: number | null;
  shop_name: string | null;
  created_at: string;
}

async function getWatermark(): Promise<string> {
  try {
    const v = await getRedis().get(WATERMARK_KEY);
    if (v) return v;
  } catch {/* ok */}
  // First run: 5 min ago — short enough to avoid spamming on first deploy
  return new Date(Date.now() - 5 * 60_000).toISOString();
}

async function setWatermark(iso: string): Promise<void> {
  try { await getRedis().set(WATERMARK_KEY, iso); } catch {/* ok */}
}

function fmtRub(rub: number): string {
  if (Math.abs(rub) >= 1_000_000) return `${(rub / 1_000_000).toFixed(1)} млн ₽`;
  if (Math.abs(rub) >= 1_000) return `${Math.round(rub / 1000)}k ₽`;
  return `${Math.round(rub)} ₽`;
}

/**
 * Multi-event digest. Mirrors the in-app Monitoring page (`/task-monitor`):
 * groups by trigger, shows severity icon + count per group, and lists each
 * event with its real `description` line (numbers from the detector — qty,
 * losses, %) rather than just the trigger label. Keeps the per-group list
 * capped so the message stays scannable on mobile.
 */
const SEVERITY_ICON: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🔵',
  info: '⚪',
};
const TRIGGER_ICON: Record<string, string> = {
  stock_zero: '📦', stock_critical: '📦', stock_low: '📦',
  stock_excess: '📦', stock_forecast_oos: '📦',
  returns_spike: '🔄', buyout_drop: '🔄',
  sales_drop_daily: '📉', sales_drop_weekly: '📉',
  adv_zero_orders: '⚡', adv_drr_high: '⚡', adv_budget_exhausted: '⚡',
  price_margin_negative: '💰', price_competitor_lower: '💰',
  content_negative_review: '💬', content_rating_drop: '💬',
};

function buildDigestHtml(events: PendingCriticalEvent[], lossByEvent: Map<number, number | null>): string {
  const byTrigger = new Map<string, PendingCriticalEvent[]>();
  for (const e of events) {
    const key = e.trigger ?? 'other';
    if (!byTrigger.has(key)) byTrigger.set(key, []);
    byTrigger.get(key)!.push(e);
  }
  const totalLoss = Array.from(lossByEvent.values()).reduce((s: number, v) => s + (v ?? 0), 0);
  const shopName = events.find((e) => e.shop_name)?.shop_name;
  const uniqueNm = new Set(events.map((e) => e.nm_id).filter((v): v is number => v != null)).size;
  const lines: string[] = [];
  lines.push(`<b>Мониторинг — ${events.length} ${plural(events.length, 'событие', 'события', 'событий')}</b>`);
  const sub: string[] = [];
  if (shopName) sub.push(shopName);
  if (uniqueNm > 0) sub.push(`${uniqueNm} ${plural(uniqueNm, 'товар', 'товара', 'товаров')}`);
  if (sub.length) lines.push(`<i>${sub.join(' · ')}</i>`);
  if (totalLoss > 0) lines.push(`Оценка потерь: <b>~${fmtRub(totalLoss)}/мес</b>`);
  lines.push('');
  // Summary only: one line per trigger with count. Per-product details
  // live in `/task-monitor` — opening it is the explicit user request to
  // see the breakdown.
  const groups = Array.from(byTrigger.entries()).sort((a, b) => b[1].length - a[1].length);
  for (const [trigger, group] of groups) {
    const label = TRIGGER_LABEL[trigger] ?? trigger;
    const icon = TRIGGER_ICON[trigger] ?? '•';
    lines.push(`${icon} <b>${label}</b> · ${group.length} ${plural(group.length, 'товар', 'товара', 'товаров')}`);
  }
  lines.push('');
  lines.push('<i>Кнопка ниже откроет детализацию.</i>');
  return lines.join('\n');
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function digestButtons() {
  const base = (process.env.FRONTEND_URL && process.env.FRONTEND_URL.startsWith('https://'))
    ? process.env.FRONTEND_URL.replace(/\/$/, '')
    : 'https://sigmaseller.ru';
  return [[{ text: '🔔 Открыть мониторинг', url: `${base}/task-monitor` }]];
}

function buildPushHtml(e: PendingCriticalEvent, lossRub: number | null): string {
  const groupLabel = e.trigger ? (TRIGGER_LABEL[e.trigger] ?? e.trigger) : 'Критично';
  // numeric pg fields come back as strings — coerce to Number before
  // formatting (toFixed only exists on Number).
  const qty = e.qty != null ? Number(e.qty) : null;
  const avgDaily = e.avg_daily != null ? Number(e.avg_daily) : null;
  // Strip the redundant "OOS:" / "Критически мало:" prefix — the header above
  // already names the trigger, so the title only needs the product name.
  const cleanTitle = e.title.replace(/^(OOS|Критически мало|Всплеск возвратов|Реклама без заказов|Отрицательная маржа|Негативный отзыв):\s*/i, '');
  const lines: string[] = [];
  lines.push(`<b>${groupLabel}${e.shop_name ? ` · ${e.shop_name}` : ''}</b>`);
  lines.push('');
  if (e.nm_id) {
    lines.push(`<a href="https://www.wildberries.ru/catalog/${e.nm_id}/detail.aspx">${e.nm_id}</a> — ${cleanTitle}`);
  } else {
    lines.push(cleanTitle);
  }
  const facts: string[] = [];
  if (qty != null) facts.push(`остаток <b>${qty} шт</b>`);
  if (avgDaily != null && avgDaily > 0) facts.push(`темп <b>${avgDaily.toFixed(1)} шт/день</b>`);
  if (lossRub != null && lossRub > 0) facts.push(`потери <b>~${fmtRub(lossRub)}/мес</b>`);
  if (facts.length) lines.push(facts.join(' · '));
  if (e.description) {
    lines.push('');
    lines.push(`<i>${e.description}</i>`);
  }
  const action = suggestedActionHint(e.suggested_action, e.trigger);
  if (action) {
    lines.push('');
    lines.push(`<b>Что делать:</b> ${action}`);
  }
  return lines.join('\n');
}

function suggestedActionHint(suggestedAction: string | null, trigger: string | null): string | null {
  if (suggestedAction === 'restock') return 'оформить поставку (кнопка ниже).';
  if (suggestedAction === 'reprice') return 'изменить цену (кнопка ниже).';
  if (suggestedAction === 'pause_ads') return 'приостановить рекламу (кнопка ниже).';
  if (suggestedAction === 'reply_review') return 'ответить на отзыв (AI-черновик по кнопке ниже).';
  if (trigger === 'stock_zero' || trigger === 'stock_critical') return 'сформировать поставку.';
  if (trigger === 'buyout_drop') return 'проверить карточку и отзывы (искажение ожиданий).';
  if (trigger === 'returns_spike') return 'разобрать причины возвратов в отзывах.';
  if (trigger === 'price_margin_negative') return 'поднять цену или снизить себестоимость/логистику.';
  if (trigger === 'content_negative_review') return 'ответить на отзыв (AI-черновик по кнопке).';
  return null;
}

function actionButtons(eventId: number, suggestedAction: string | null, nmId: number | null) {
  // Telegram callback_data limit is 64 bytes — short keys.
  const buttons: any[][] = [];
  // rev 27i: primary action gets its own full-width row (visually bigger).
  if (suggestedAction) {
    const label =
      suggestedAction === 'restock' ? '📦 Заказать поставку' :
      suggestedAction === 'reprice' ? '💰 Изменить цену' :
      suggestedAction === 'pause_ads' ? '⏸️ Приостановить рекламу' :
      suggestedAction === 'reply_review' ? '💬 Ответить на отзыв' :
      '✅ Применить';
    buttons.push([{ text: label, callback_data: `apply:${eventId}` }]);
  }
  // Ask-AI is always useful, especially for events without a concrete action.
  if (nmId) {
    buttons.push([{ text: '🤖 Спросить ИИ — почему?', callback_data: `ask:${eventId}` }]);
  }
  buttons.push([
    { text: '🔕 Напомнить 24ч', callback_data: `snooze:${eventId}:24` },
    { text: '🗑 Закрыть', callback_data: `dismiss:${eventId}` },
  ]);
  return buttons;
}

interface LinkedUserRow {
  user_id: number;
  tg_chat_id: string;
}

async function getLinkedUsersForWorkspace(workspaceId: number): Promise<LinkedUserRow[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT l.user_id, l.tg_chat_id
      FROM user_telegram_links l
      JOIN workspace_members m ON m.user_id = l.user_id
     WHERE m.workspace_id = ${workspaceId};
  `);
  return rows.rows as unknown as LinkedUserRow[];
}

async function isThrottled(userId: number): Promise<boolean> {
  try {
    const v = await getRedis().get(`${THROTTLE_PREFIX}:${userId}`);
    return v != null;
  } catch { return false; }
}

async function markPushed(userId: number): Promise<void> {
  try {
    await getRedis().set(
      `${THROTTLE_PREFIX}:${userId}`, '1', 'EX', PUSH_THROTTLE_MIN * 60,
    );
  } catch {/* ok */}
}

/**
 * Pull events created after the last watermark, classify each as critical
 * stock event (for the loss-estimate query) or other, then push to each
 * linked user. Watermark advances to the latest seen event's timestamp.
 */
export async function runCriticalEventsPusher(): Promise<void> {
  const watermark = await getWatermark();
  // Fetch new criticals + enrich with shop name and loss estimate where
  // computable. LEFT JOIN against marketplace_shops via meta.shopId is
  // heuristic (the event doesn't always carry shopId) — fall back to
  // first shop in workspace when missing.
  const rows = await db.execute(sql<PendingCriticalEvent>`
    SELECT ev.event_id, ev.workspace_id, ev.nm_id, ev.title, ev.description,
           ev.suggested_action, ev.meta->>'triggerId' AS trigger,
           (ev.meta->>'qty')::numeric AS qty,
           (ev.meta->>'avgDaily')::numeric AS avg_daily,
           ms.name AS shop_name,
           ev.created_at::text AS created_at
      FROM agent_events ev
      LEFT JOIN marketplace_shops ms
        ON ms.workspace_id = ev.workspace_id
       AND ms.shop_id = (ev.meta->>'shopId')::int
     WHERE ev.severity = 'critical'
       AND ev.status = 'pending'
       AND ev.created_at > ${watermark}::timestamptz
     ORDER BY ev.created_at ASC
     LIMIT 100;
  `);
  const events = rows.rows as unknown as PendingCriticalEvent[];
  if (events.length === 0) return;

  logger.info({ count: events.length, watermark }, 'critical events to push');

  // Pre-compute loss estimates. Primary source: WB CDN buyer-facing price
  // (`fetchPublicCard().showcasePriceKop` = `price.product` after СПП — the
  // number the customer sees in the catalog). Fallback: 30-day historical
  // average from `wb_orders_sales_daily_products` when CDN returns nothing.
  // Buyer prices cached in Redis (30 min) and fetched with concurrency cap
  // so a busy tick doesn't hammer card.wb.ru.
  const lossByEvent = new Map<number, number | null>();
  const nmIdsForPrice = Array.from(new Set(
    events
      .filter((e) => e.nm_id != null && e.avg_daily != null && Number(e.avg_daily) > 0)
      .map((e) => e.nm_id as number),
  ));
  const priceByNm = new Map<number, number>(); // nm_id → unit price in kopecks
  if (nmIdsForPrice.length > 0) {
    const CDN_CACHE_TTL = 30 * 60;
    const CDN_CONCURRENCY = 5;
    const r = getRedis();
    for (let i = 0; i < nmIdsForPrice.length; i += CDN_CONCURRENCY) {
      const slice = nmIdsForPrice.slice(i, i + CDN_CONCURRENCY);
      await Promise.all(slice.map(async (nmId) => {
        const cacheKey = `wb:buyer_price:${nmId}`;
        try {
          const cached = await r.get(cacheKey);
          if (cached) { priceByNm.set(nmId, Number(cached)); return; }
        } catch {/* redis miss is fine */}
        try {
          const card = await fetchPublicCard(nmId);
          if (card?.showcasePriceKop && card.showcasePriceKop > 0) {
            priceByNm.set(nmId, card.showcasePriceKop);
            try { await r.set(cacheKey, String(card.showcasePriceKop), 'EX', CDN_CACHE_TTL); } catch {/* ok */}
          }
        } catch (err) {
          logger.warn({ nmId, err: (err as Error).message }, 'public card fetch failed; will fall back to historical avg');
        }
      }));
    }
    // Fallback for nm_ids the CDN didn't answer for: historical avg.
    const missing = nmIdsForPrice.filter((n) => !priceByNm.has(n));
    if (missing.length > 0) {
      const wsIds = Array.from(new Set(events.map((e) => e.workspace_id)));
      // Drizzle's `${arr}` expands to a row literal `($1,$2,...)` which Postgres rejects on `::bigint[]` cast. Use sql.join + IN.
      const priceRows = await db.execute(sql`
        SELECT nm_id,
               CASE WHEN SUM(sales_count) > 0
                    THEN SUM(sales_rub::numeric) / SUM(sales_count)
                    ELSE NULL END AS unit_price_kop
          FROM wb_orders_sales_daily_products
         WHERE workspace_id IN (${sql.join(wsIds.map((n) => sql`${n}`), sql`, `)})
           AND nm_id        IN (${sql.join(missing.map((n) => sql`${n}`), sql`, `)})
           AND date::date  >= CURRENT_DATE - 30
         GROUP BY nm_id;
      `);
      for (const row of priceRows.rows as any[]) {
        if (row.unit_price_kop != null) priceByNm.set(Number(row.nm_id), Number(row.unit_price_kop));
      }
    }
  }
  for (const e of events) {
    let lossRub: number | null = null;
    if (e.nm_id != null && e.avg_daily != null && Number(e.avg_daily) > 0) {
      const priceKop = priceByNm.get(e.nm_id);
      if (priceKop != null) lossRub = (Number(e.avg_daily) * 30 * priceKop) / 100;
    }
    lossByEvent.set(e.event_id, lossRub);
  }

  // Group events by workspace, then resolve user lists once per workspace.
  const eventsByWorkspace = new Map<number, PendingCriticalEvent[]>();
  for (const e of events) {
    if (!eventsByWorkspace.has(e.workspace_id)) eventsByWorkspace.set(e.workspace_id, []);
    eventsByWorkspace.get(e.workspace_id)!.push(e);
  }

  let sent = 0, throttled = 0, digests = 0, singles = 0;
  for (const [workspaceId, wsEvents] of eventsByWorkspace) {
    const users = await getLinkedUsersForWorkspace(workspaceId);
    // Bounded parallel fan-out: USER_FANOUT_CONCURRENCY sends in flight
    // at a time. Keeps total job runtime low for big workspaces without
    // crossing Telegram's global 30 msg/sec ceiling.
    for (let i = 0; i < users.length; i += USER_FANOUT_CONCURRENCY) {
      const chunk = users.slice(i, i + USER_FANOUT_CONCURRENCY);
      await Promise.all(chunk.map(async (u) => {
        if (await isThrottled(u.user_id)) { throttled++; return; }
        try {
          if (wsEvents.length === 1) {
            const e = wsEvents[0];
            await sendTelegramMessage(u.tg_chat_id, buildPushHtml(e, lossByEvent.get(e.event_id) ?? null), {
              parseMode: 'HTML',
              buttons: actionButtons(e.event_id, e.suggested_action, e.nm_id),
            });
            singles++;
          } else {
            await sendTelegramMessage(u.tg_chat_id, buildDigestHtml(wsEvents, lossByEvent), {
              parseMode: 'HTML',
              buttons: digestButtons(),
            });
            digests++;
          }
          await markPushed(u.user_id);
          sent++;
        } catch (err) {
          logger.warn({ err: (err as Error).message, userId: u.user_id }, 'push failed');
        }
      }));
    }
  }

  // Advance watermark to the latest event we processed. We use exact
  // timestamp (not now()) so a slow handler doesn't skip new arrivals.
  const lastCreatedAt = events[events.length - 1].created_at;
  await setWatermark(lastCreatedAt);

  logger.info({ events: events.length, sent, singles, digests, throttled }, 'critical push cycle complete');
}
