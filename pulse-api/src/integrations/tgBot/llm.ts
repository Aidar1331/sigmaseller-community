import { runWithAiWorkspace } from '../../lib/sellerAiContext.js';
import { requireSellerAiKey } from '../../services/sellerAiCredentials.js';
/**
 * Conversational AI for the SigmaSeller bot.
 *
 * When the user types free text (not a /command, not a callback button)
 * the bot routes the message here. Claude gets:
 *
 *   1. A system prompt describing its role + workspace context (shop names,
 *      total alerts, last-day revenue snapshot) pre-loaded so the model
 *      can answer common questions ("какие у меня магазины?", "что сейчас
 *      горит?") without any tool round-trip.
 *
 *   2. Four read-only tools for specifics:
 *        - find_product(query)
 *        - get_stock(nm_id)
 *        - get_shop_summary(shop_id, period)
 *        - get_alerts(trigger_id)
 *
 * Write actions (apply/reprice/pause-ads) are deliberately NOT exposed
 * here — those must stay behind the explicit inline-button confirmation
 * flow (event card). The bot says "хочешь сейчас сделать N? тогда открой
 * этот алёрт через /alerts" rather than auto-acting.
 *
 * Token / cost discipline: model = sonnet-4-6 (snappy + cheap), max
 * tokens 1024 for replies. Conversation history is NOT preserved across
 * messages in v0 — each user message is a fresh context. v0.5 adds a
 * small per-user message buffer.
 */

import Anthropic from '@anthropic-ai/sdk';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { env } from '../../env.js';
import log from '../../lib/logger.js';
import { getRedis } from '../../lib/redis.js';
import {
  listShopsForUser, listAlertGroups, shopRangeAggregate, shopDailySnapshot,
  topKeywordMovers, listPendingNegativeReviews,
} from './data.js';
import { TRIGGER_LABEL_RU } from './menus.js';
import {
  loadHistory, appendUser, appendAssistant, slimForLLM,
} from './chatMemory.js';
import { appendMessage as persistMessage, maybeSetAutoTitle } from './chatSessions.js';
import { calcUnitEconomics } from '../../agents/tools/calcUnitEconomics.js';

// Per-user LLM rate limit (rev 25f): max 15 requests / day. Approved by
// operator with $50/mo budget cap. On limit hit we return a polite menu-
// fallback message instead of calling Anthropic.
const LLM_DAILY_LIMIT = 15;
async function checkAndBumpRateLimit(userId: number): Promise<{ ok: boolean; remaining: number }> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const key = `tg:llm_daily:${userId}:${today}`;
    const redis = getRedis();
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 86400 + 600); // 24h + 10min buffer
    const remaining = LLM_DAILY_LIMIT - count;
    return { ok: count <= LLM_DAILY_LIMIT, remaining };
  } catch {
    // Redis down → fail open. Better degraded chat than blocked chat.
    return { ok: true, remaining: -1 };
  }
}

const logger = log.child({ module: 'tgBotLlm' });

// Dynamic model routing (rev 25k). Sonnet-4.6 is overkill — and expensive —
// for routine tool-call orchestration. Haiku-4.5 handles "find this product,
// show stock, list alerts" tasks just as well at a fraction of the cost
// (Reddit r/Anthropic + r/ClaudeAI benchmarks: 3-5× cheaper, near-parity on
// structured tool use). We keep Sonnet on the bench for `copywriting` tasks
// where the model genuinely needs higher creative quality — generating
// review responses, marketing copy, etc. Until /feedback ships in v2.0-β,
// nothing in the bot triggers the copywriting path, so every chat goes
// through Haiku.
const MODEL_TOOL_CALLING = 'claude-haiku-4-5';
const MODEL_COPYWRITING = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;
const TOOL_LOOP_LIMIT = 8; // rev 27e: bumped from 4 to give the model headroom on complex multi-hop questions

export type LlmTaskType = 'tool_calling' | 'copywriting';

function pickModel(taskType: LlmTaskType): string {
  return taskType === 'copywriting' ? MODEL_COPYWRITING : MODEL_TOOL_CALLING;
}

type ToolInput = Record<string, unknown>;

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'find_product',
    description:
      'Найти товар(ы) пользователя по части названия или артикулу WB (nm_id). ' +
      'Возвращает до 10 совпадений с их nm_id, названием и магазином.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Часть названия, или конкретный nm_id' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_stock',
    description:
      'Текущий складской остаток одного товара и среднедневные продажи за последние 7 дней.',
    input_schema: {
      type: 'object',
      properties: {
        nm_id: { type: 'integer', description: 'WB nomenclature id товара' },
      },
      required: ['nm_id'],
    },
  },
  {
    name: 'get_shop_summary',
    description:
      'Дневная сводка одного магазина: заказы, выкупы, выручка. ' +
      'period: today | yesterday | 7d | 30d.',
    input_schema: {
      type: 'object',
      properties: {
        shop_id: { type: 'integer' },
        period: { type: 'string', enum: ['today', 'yesterday', '7d', '30d'] },
      },
      required: ['shop_id', 'period'],
    },
  },
  {
    name: 'get_alerts',
    description:
      'Список активных алёртов мониторинга по типу. ' +
      'Если trigger_id не указан — все группы с количествами. ' +
      'Допустимые trigger_id: stock_zero, stock_critical, stock_low, ' +
      'sales_drop_daily, buyout_drop, returns_spike, и т.д.',
    input_schema: {
      type: 'object',
      properties: { trigger_id: { type: 'string' } },
    },
  },
  {
    name: 'get_seo_positions',
    description:
      'Топ ключевых слов по движению позиций за последние сутки. ' +
      'Возвращает ключ, nm_id, текущую позицию, предыдущую позицию и дельту. ' +
      'Отрицательная дельта — позиция улучшилась (товар поднялся в выдаче).',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Сколько ключей вернуть (по умолчанию 20)' },
      },
    },
  },
  {
    name: 'get_orders',
    description:
      'Топ-N товаров по количеству заказов за период. ' +
      'period: today | yesterday | 7d | 30d. ' +
      'Возвращает nm_id, название, кол-во заказов, выручку, среднюю цену.',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['today', 'yesterday', '7d', '30d'] },
        limit: { type: 'integer', description: 'По умолчанию 10' },
      },
      required: ['period'],
    },
  },
  {
    name: 'get_reviews',
    description:
      'Список неотвеченных негативных отзывов (рейтинг ≤ 3). ' +
      'Возвращает item_id, nm_id, рейтинг, имя, текст, дату.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'По умолчанию 10, максимум 20' },
      },
    },
  },
  {
    name: 'get_ab_test_status',
    description:
      'Активные A/B-тесты фотографий в кабинете. ' +
      'Возвращает test_id, nm_id, status (running/paused/completed), goal, ' +
      'winner_variant (если уже определён), started_at, period_days.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['running', 'paused', 'completed'],
          description: 'Фильтр по статусу (опционально)',
        },
      },
    },
  },
  {
    name: 'get_unit_economics',
    description:
      'Юнит-экономика одного товара за последние 30 дней. ' +
      'Возвращает выручку, себестоимость, логистику, комиссию, прибыль с единицы, ' +
      'маржу %, ROI %. Полезно для вопросов "сколько я зарабатываю с этого товара".',
    input_schema: {
      type: 'object',
      properties: {
        nm_id: { type: 'integer' },
      },
      required: ['nm_id'],
    },
  },
  {
    name: 'get_competitor_price',
    description:
      'Текущая цена и недавняя динамика у отслеживаемых конкурентов (за последние 7 дней). ' +
      'Без параметров — топ-10 конкурентов по разнице с моей ценой. ' +
      'С competitor_nm_id — данные по конкретному конкуренту.',
    input_schema: {
      type: 'object',
      properties: {
        competitor_nm_id: { type: 'integer', description: 'WB nm_id конкурента' },
        limit: { type: 'integer', description: 'По умолчанию 10' },
      },
    },
  },
  {
    name: 'get_supplies_status',
    description:
      'Текущий статус активных поставок на склады WB. ' +
      'Возвращает supply_id, preorder_id, статус (черновик / запланировано / приёмка / принято), ' +
      'склад, дата поставки, заявленное и принятое количество.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'По умолчанию 10' },
      },
    },
  },
  {
    name: 'get_timeseries',
    description:
      'Дневной timeseries метрики по товару за период (rev 27e). ' +
      'Метрики: orders | revenue | stock | buyout_pct. ' +
      'Возвращает массив {date, value}. Используй когда нужно понять тренд: ' +
      '«падает ли заказ постепенно или резко», «когда упал выкуп».',
    input_schema: {
      type: 'object',
      properties: {
        nm_id: { type: 'integer' },
        metric: { type: 'string', enum: ['orders', 'revenue', 'stock', 'buyout_pct'] },
        days: { type: 'integer', description: 'Сколько дней назад (по умолчанию 30, максимум 90)' },
      },
      required: ['nm_id', 'metric'],
    },
  },
  {
    name: 'get_anomaly_summary',
    description:
      'Агрегат всех активных аномалий по кабинету (rev 27e). ' +
      'Возвращает: число товаров по каждому типу проблемы (stock_zero, buyout_drop, и т.д.), ' +
      'топ-5 «лидеров потерь» с потенциальной выручкой за месяц. ' +
      'Используй вместо нескольких find_product+get_alerts когда юзер спрашивает «что у меня плохо в целом».',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_balance_summary',
    description:
      'Финансовый баланс продавца (rev 27c). Возвращает: WB-баланс на счёте + к выводу (по каждому магазину), ' +
      'остаток AI-токенов SigmaSeller. Используй когда юзер спрашивает про «баланс», «деньги», «выплаты», «к выводу», ' +
      '«сколько мне должны», «сколько на AI».',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'propose_set_price',
    description:
      'Предложить изменение цены на товар (рев 26d). Это write-действие — ' +
      'НЕ выполняется автоматически. Бот покажет пользователю карточку с ' +
      'кнопками «Применить / Отменить». Используй когда пользователь явно ' +
      'просит изменить цену или ты считаешь это лучшей рекомендацией.',
    input_schema: {
      type: 'object',
      properties: {
        nm_id: { type: 'integer', description: 'WB nm_id товара' },
        new_price_rub: { type: 'integer', description: 'Новая цена в рублях (целое число)' },
        reason: { type: 'string', description: 'Краткая причина (1 предложение)' },
      },
      required: ['nm_id', 'new_price_rub'],
    },
  },
];

async function runTool(name: string, input: ToolInput, workspaceId: number, userId: number): Promise<unknown> {
  try {
    switch (name) {
      case 'find_product': {
        const q = String(input.query ?? '').trim();
        if (!q) return { error: 'query is empty' };
        // Numeric → exact nm_id; else FTS on title.
        const isNum = /^\d+$/.test(q);
        const rows = await db.execute(sql`
          SELECT c.nm_id, COALESCE(c.title, c.subject_name, '#'||c.nm_id::text) AS title,
                 ms.shop_id, ms.name AS shop_name
            FROM wb_cards c
            LEFT JOIN marketplace_shops ms
              ON ms.workspace_id = c.workspace_id AND ms.shop_id = c.shop_id
           WHERE c.workspace_id = ${workspaceId}
             AND ${isNum ? sql`c.nm_id = ${Number(q)}` : sql`c.title ILIKE ${'%' + q + '%'}`}
           LIMIT 10;
        `);
        return rows.rows;
      }
      case 'get_stock': {
        const nmId = Number(input.nm_id);
        if (!Number.isInteger(nmId)) return { error: 'invalid nm_id' };
        const rows = await db.execute(sql`
          WITH cur AS (
            SELECT shop_id, quantity FROM wb_stocks_daily_products
             WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
               AND date::date = (
                 SELECT MAX(date::date) FROM wb_stocks_daily_products
                  WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
               )
          ),
          sales AS (
            SELECT shop_id, AVG(sales_count) AS avg_daily
              FROM wb_orders_sales_daily_products
             WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
               AND date::date BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE - 1
             GROUP BY shop_id
          )
          SELECT cur.shop_id, cur.quantity,
                 COALESCE(s.avg_daily, 0)::numeric AS avg_daily_sales,
                 ms.name AS shop_name
            FROM cur
            LEFT JOIN sales s USING (shop_id)
            LEFT JOIN marketplace_shops ms
              ON ms.workspace_id = ${workspaceId} AND ms.shop_id = cur.shop_id;
        `);
        return rows.rows;
      }
      case 'get_shop_summary': {
        const shopId = Number(input.shop_id);
        const period = String(input.period ?? 'today');
        const today = new Date();
        const isoToday = today.toISOString().slice(0, 10);
        const isoYesterday = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
        let summary;
        if (period === 'today') summary = await shopDailySnapshot(workspaceId, shopId, isoToday);
        else if (period === 'yesterday') summary = await shopDailySnapshot(workspaceId, shopId, isoYesterday);
        else {
          const days = period === '30d' ? 30 : 7;
          const from = new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);
          summary = await shopRangeAggregate(workspaceId, shopId, from, isoYesterday);
        }
        return summary ?? { error: 'no data' };
      }
      case 'get_alerts': {
        const trigger = input.trigger_id ? String(input.trigger_id) : null;
        if (trigger) {
          const rows = await db.execute(sql`
            SELECT event_id, title, nm_id, severity
              FROM agent_events
             WHERE workspace_id = ${workspaceId}
               AND status = 'pending'
               AND meta->>'triggerId' = ${trigger}
             ORDER BY created_at DESC LIMIT 10;
          `);
          return rows.rows;
        }
        return await listAlertGroups(workspaceId);
      }
      case 'get_seo_positions': {
        const limit = Number.isInteger(input.limit) ? Number(input.limit) : 20;
        const rows = await topKeywordMovers(workspaceId, Math.min(Math.max(limit, 1), 50));
        return rows.map((r) => ({
          keyword: r.keyword,
          nm_id: r.nmId,
          position: r.latestPosition,
          prev_position: r.prevPosition,
          delta: r.delta,
        }));
      }
      case 'get_orders': {
        const period = String(input.period ?? 'today');
        const limit = Math.min(Math.max(Number(input.limit ?? 10), 1), 20);
        const today = new Date();
        const isoToday = today.toISOString().slice(0, 10);
        const isoYesterday = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
        let dateFrom = isoToday;
        let dateTo = isoToday;
        if (period === 'yesterday') { dateFrom = isoYesterday; dateTo = isoYesterday; }
        else if (period === '7d') {
          dateFrom = new Date(today.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
          dateTo = isoYesterday;
        } else if (period === '30d') {
          dateFrom = new Date(today.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
          dateTo = isoYesterday;
        }
        const rows = await db.execute(sql`
          SELECT op.nm_id,
                 COALESCE(c.title, c.subject_name, '#'||op.nm_id::text) AS title,
                 SUM(op.orders_count)::int AS orders_count,
                 SUM(op.orders_rub::numeric)::numeric AS orders_rub,
                 SUM(op.sales_count)::int AS sales_count
            FROM wb_orders_sales_daily_products op
            LEFT JOIN wb_cards c
              ON c.workspace_id = op.workspace_id AND c.nm_id = op.nm_id
           WHERE op.workspace_id = ${workspaceId}
             AND op.date::date BETWEEN ${dateFrom}::date AND ${dateTo}::date
           GROUP BY op.nm_id, c.title, c.subject_name
           ORDER BY orders_count DESC
           LIMIT ${limit};
        `);
        return (rows.rows as any[]).map((r) => ({
          nm_id: Number(r.nm_id),
          title: String(r.title),
          orders_count: Number(r.orders_count),
          orders_rub: Number(r.orders_rub ?? 0),
          sales_count: Number(r.sales_count ?? 0),
          avg_price_rub: Number(r.orders_count) > 0
            ? Math.round(Number(r.orders_rub ?? 0) / Number(r.orders_count))
            : null,
        }));
      }
      case 'get_reviews': {
        const limit = Math.min(Math.max(Number(input.limit ?? 10), 1), 20);
        const reviews = await listPendingNegativeReviews(workspaceId, limit);
        return reviews.map((r) => ({
          item_id: r.itemId,
          nm_id: r.nmId,
          rating: r.rating,
          user_name: r.userName,
          product_title: r.productTitle,
          text: r.text.length > 300 ? r.text.slice(0, 300) + '…' : r.text,
          created_at: r.createdAt,
        }));
      }
      case 'get_ab_test_status': {
        const status = input.status ? String(input.status) : null;
        const rows = await db.execute(sql`
          SELECT test_id, nm_id, status, goal, winner_variant,
                 started_at, completed_at, period_days,
                 (variant_a->>'label') AS variant_a_label,
                 (variant_b->>'label') AS variant_b_label
            FROM ab_photo_tests
           WHERE workspace_id = ${workspaceId}
             ${status ? sql`AND status = ${status}` : sql``}
           ORDER BY started_at DESC
           LIMIT 20;
        `);
        return (rows.rows as any[]).map((r) => ({
          test_id: Number(r.test_id),
          nm_id: Number(r.nm_id),
          status: String(r.status),
          goal: String(r.goal),
          winner: r.winner_variant ? String(r.winner_variant) : null,
          started_at: r.started_at,
          completed_at: r.completed_at,
          period_days: Number(r.period_days),
          variant_a: r.variant_a_label,
          variant_b: r.variant_b_label,
        }));
      }
      case 'get_unit_economics': {
        const nmId = Number(input.nm_id);
        if (!Number.isInteger(nmId)) return { error: 'invalid nm_id' };
        const json = await calcUnitEconomics({ nmId, _workspaceId: workspaceId });
        try { return JSON.parse(json); } catch { return { raw: json }; }
      }
      case 'get_competitor_price': {
        const competitorNmId = input.competitor_nm_id ? Number(input.competitor_nm_id) : null;
        const limit = Math.min(Math.max(Number(input.limit ?? 10), 1), 30);
        const rows = await db.execute(sql`
          WITH latest AS (
            SELECT DISTINCT ON (sc.competitor_id)
                   sc.competitor_id, sc.nm_id, sc.name,
                   scp.price, scp.original_price, scp.discount,
                   scp.checked_at, scp.rating, scp.feedbacks
              FROM seo_competitors sc
              JOIN seo_competitor_positions scp ON scp.competitor_id = sc.competitor_id
             WHERE sc.workspace_id = ${workspaceId}
               AND sc.is_active = true
               ${competitorNmId ? sql`AND sc.nm_id = ${competitorNmId}` : sql``}
             ORDER BY sc.competitor_id, scp.checked_at DESC
          )
          SELECT * FROM latest
           ORDER BY checked_at DESC
           LIMIT ${limit};
        `);
        return (rows.rows as any[]).map((r) => ({
          competitor_nm_id: Number(r.nm_id),
          name: String(r.name),
          price_rub: r.price != null ? Math.round(Number(r.price) / 100) : null,
          original_price_rub: r.original_price != null ? Math.round(Number(r.original_price) / 100) : null,
          discount_pct: r.discount != null ? Number(r.discount) : null,
          rating: r.rating != null ? Number(r.rating) : null,
          reviews: r.feedbacks != null ? Number(r.feedbacks) : null,
          checked_at: r.checked_at,
        }));
      }
      case 'get_supplies_status': {
        const limit = Math.min(Math.max(Number(input.limit ?? 10), 1), 30);
        const rows = await db.execute(sql`
          SELECT wb_supply_id, wb_preorder_id, status_id,
                 warehouse_name, supply_date,
                 quantity, accepted_quantity
            FROM wb_supplies
           WHERE workspace_id = ${workspaceId}
             AND status_id < 5
           ORDER BY supply_date NULLS LAST, created_at DESC
           LIMIT ${limit};
        `);
        const STATUS_RU: Record<number, string> = {
          1: 'черновик',
          2: 'запланировано',
          3: 'отгрузка разрешена',
          4: 'идёт приёмка',
          5: 'принято',
          6: 'отгружено на воротах',
        };
        return (rows.rows as any[]).map((r) => ({
          supply_id: r.wb_supply_id != null ? Number(r.wb_supply_id) : null,
          preorder_id: Number(r.wb_preorder_id),
          status: STATUS_RU[Number(r.status_id)] ?? `status=${r.status_id}`,
          warehouse: r.warehouse_name,
          supply_date: r.supply_date,
          quantity: Number(r.quantity ?? 0),
          accepted_quantity: Number(r.accepted_quantity ?? 0),
        }));
      }
      case 'get_timeseries': {
        const nmId = Number(input.nm_id);
        const metric = String(input.metric ?? '');
        const days = Math.min(Math.max(Number(input.days ?? 30), 1), 90);
        if (!Number.isInteger(nmId) || !['orders', 'revenue', 'stock', 'buyout_pct'].includes(metric)) {
          return { error: 'invalid nm_id or metric' };
        }
        if (metric === 'stock') {
          const rows = await db.execute(sql`
            SELECT date::date AS date, SUM(quantity)::int AS value
              FROM wb_stocks_daily_products
             WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
               AND date::date >= CURRENT_DATE - ${days}
             GROUP BY date::date ORDER BY date::date;
          `);
          return (rows.rows as any[]).map((r) => ({ date: String(r.date).slice(0, 10), value: Number(r.value) }));
        }
        const valueExpr = metric === 'orders'
          ? sql`SUM(orders_count)::int`
          : metric === 'revenue'
          ? sql`SUM(orders_rub::numeric)::numeric`
          : sql`CASE WHEN SUM(orders_count) > 0
                       THEN (SUM(sales_count)::numeric / SUM(orders_count)::numeric) * 100
                       ELSE NULL END`;
        const rows = await db.execute(sql`
          SELECT date::date AS date, ${valueExpr} AS value
            FROM wb_orders_sales_daily_products
           WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
             AND date::date >= CURRENT_DATE - ${days}
           GROUP BY date::date ORDER BY date::date;
        `);
        return (rows.rows as any[])
          .filter((r) => r.value != null)
          .map((r) => ({ date: String(r.date).slice(0, 10), value: Number(r.value) }));
      }
      case 'get_anomaly_summary': {
        // Group counts
        const groupRows = await db.execute(sql`
          SELECT meta->>'triggerId' AS trigger,
                 COUNT(*)::int AS count
            FROM agent_events
           WHERE workspace_id = ${workspaceId}
             AND status = 'pending'
             AND meta->>'triggerId' IS NOT NULL
           GROUP BY meta->>'triggerId'
           ORDER BY count DESC;
        `);
        // Top losers by potential loss across all critical events
        const lossRows = await db.execute(sql`
          WITH ev AS (
            SELECT event_id, nm_id, title,
                   meta->>'triggerId' AS trigger,
                   (meta->>'avgDaily')::numeric AS avg_daily
              FROM agent_events
             WHERE workspace_id = ${workspaceId}
               AND status = 'pending'
               AND severity = 'critical'
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
          SELECT ev.nm_id, ev.title, ev.trigger,
                 CASE WHEN ev.avg_daily IS NOT NULL AND px.unit_price_rub IS NOT NULL
                      THEN ev.avg_daily * 30 * px.unit_price_rub ELSE NULL END AS monthly_loss_rub
            FROM ev LEFT JOIN px USING (nm_id)
           ORDER BY monthly_loss_rub DESC NULLS LAST
           LIMIT 5;
        `);
        return {
          groups: (groupRows.rows as any[]).map((r) => ({ trigger: r.trigger, count: Number(r.count) })),
          top_losers: (lossRows.rows as any[]).map((r) => ({
            nm_id: r.nm_id != null ? Number(r.nm_id) : null,
            title: r.title,
            trigger: r.trigger,
            monthly_loss_rub: r.monthly_loss_rub != null ? Number(r.monthly_loss_rub) : null,
          })),
        };
      }
      case 'get_balance_summary': {
        const { getBalance: getWbBalance } = await import('../wb/balance.js');
        const { getBalance: getAiBalance } = await import('../../services/aiTokens.js');
        // List active WB shops with API keys, fetch balance for each (rate
        // limited per shop — 1 req/min — but for a handful of shops in one
        // user turn this is fine).
        const shopRows = await db.execute(sql<{ shop_id: number; name: string; api_key: string | null }>`
          SELECT shop_id::int AS shop_id, name, api_key
            FROM marketplace_shops
           WHERE workspace_id = ${workspaceId}
             AND platform = 'wb'
             AND is_active = true
           ORDER BY shop_id;
        `);
        const wbBalances = await Promise.all((shopRows.rows as any[]).map(async (s) => {
          if (!s.api_key) return { shop: s.name, error: 'no API key' };
          try {
            const b = await getWbBalance(s.api_key);
            return { shop: s.name, current_rub: b.current, withdrawable_rub: b.forWithdraw, currency: b.currency };
          } catch (err) {
            return { shop: s.name, error: (err as Error).message.slice(0, 80) };
          }
        }));
        const ai = await getAiBalance(workspaceId).catch(() => null);
        return {
          wb_per_shop: wbBalances,
          ai_tokens_rub: ai ? Math.floor(ai.balanceKopecks / 100) : null,
          ai_total_spent_rub: ai ? Math.ceil(ai.totalSpentKopecks / 100) : null,
        };
      }
      case 'propose_set_price': {
        const nmId = Number(input.nm_id);
        const newPriceRub = Number(input.new_price_rub);
        const reason = String(input.reason ?? '').trim() || undefined;
        if (!Number.isInteger(nmId) || nmId <= 0) return { error: 'invalid nm_id' };
        if (!Number.isInteger(newPriceRub) || newPriceRub < 1 || newPriceRub > 10_000_000) {
          return { error: 'new_price_rub must be a positive integer ≤ 10_000_000' };
        }
        // Resolve shop_id + current price + title — proposal must be specific.
        const meta = await db.execute(sql`
          SELECT c.shop_id, COALESCE(c.title, '#'||c.nm_id::text) AS title,
                 (SELECT price_rub FROM wb_orders_sales_daily_products p
                   WHERE p.workspace_id = c.workspace_id AND p.nm_id = c.nm_id
                   ORDER BY date DESC LIMIT 1) AS current_price_rub
            FROM wb_cards c
           WHERE c.workspace_id = ${workspaceId} AND c.nm_id = ${nmId}
           LIMIT 1;
        `);
        const m = meta.rows[0] as any;
        if (!m) return { error: 'product not found in workspace' };
        const { savePending, newNonce } = await import('./pendingActions.js');
        const nonce = newNonce();
        await savePending(nonce, {
          type: 'set_price',
          userId,
          workspaceId,
          shopId: Number(m.shop_id),
          nmId,
          newPriceRub,
          oldPriceRub: m.current_price_rub != null ? Number(m.current_price_rub) : null,
          productTitle: String(m.title),
          reason,
        });
        return {
          pending_confirmation: true,
          nonce,
          summary: `Цена ${newPriceRub} ₽ на «${m.title}»`,
          note: 'Пользователь должен подтвердить через карточку. Не вызывай этот tool повторно.',
        };
      }
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (err) {
    logger.warn({ tool: name, err: (err as Error).message }, 'tool error');
    return { error: (err as Error).message };
  }
}

import { SIGMA_SELLER_SYSTEM_PROMPT } from './systemPrompt.js';

/**
 * Build the per-request system prompt: canonical SIGMA_SELLER_SYSTEM_PROMPT
 * + workspace-specific context (shop names, current alert group counts)
 * appended so the model can answer trivial questions without a tool call.
 */
function systemPrompt(workspaceId: number, shopNames: string[], alertGroups: Array<{ trigger: string; count: number }>): string {
  const shopsLine = shopNames.length > 0 ? shopNames.map((n) => `«${n}»`).join(', ') : '(нет подключённых магазинов)';
  const alertsLine = alertGroups.length > 0
    ? alertGroups.map((g) => `${TRIGGER_LABEL_RU[g.trigger] ?? g.trigger} × ${g.count}`).join(', ')
    : 'нет активных алёртов';
  return SIGMA_SELLER_SYSTEM_PROMPT + '\n\n' + [
    '### CURRENT USER CONTEXT',
    `workspace_id=${workspaceId}`,
    `Магазины пользователя: ${shopsLine}`,
    `Активные алёрты по группам: ${alertsLine}`,
  ].join('\n');
}

export interface ChatResult {
  text: string;
  toolCalls: number;
}

/**
 * Pseudo-streaming callback (rev 25w). Fires as text accumulates during the
 * final-turn streaming. Callers debounce edits — we call this on every
 * delta so the caller has flexibility on cadence.
 *
 * Empty string means "we're between turns" (a tool round-trip just
 * happened); callers can use that to render a "Думаю…" interstitial.
 */
export type ProgressCallback = (textSoFar: string) => void | Promise<void>;

/**
 * Structured progress events (rev 26c). Emit alongside `onProgress(text)` so
 * the UI can render visible reasoning stages — tool invocations, results,
 * loop turns — without each caller having to redo the tap-into-stream
 * pattern.
 */
export type LlmEvent =
  | { type: 'tool_start'; name: string; input: any }
  | { type: 'tool_end'; name: string; ok: boolean; summary?: string; pendingNonce?: string }
  | { type: 'turn_start'; turnIndex: number }
  | { type: 'done' };

export type LlmEventCallback = (e: LlmEvent) => void | Promise<void>;

async function chatWithLLMImpl(
  userId: number,
  userMessage: string,
  opts?: {
    taskType?: LlmTaskType;
    onProgress?: ProgressCallback;
    onEvent?: LlmEventCallback;
    sessionId?: number;
  },
): Promise<ChatResult> {
  const taskType: LlmTaskType = opts?.taskType ?? 'tool_calling';
  const model = pickModel(taskType);
  const apiKey = (await requireSellerAiKey('anthropic'));
  if (!apiKey) {
    return { text: '⚠️ AI-чат пока не настроен (нет ключа ANTHROPIC_API_KEY). Скажи оператору.', toolCalls: 0 };
  }
  // Per-user rate limit before doing any data fetches or LLM call.
  const limit = await checkAndBumpRateLimit(userId);
  if (!limit.ok) {
    return {
      text: '⏱ Ты исчерпал дневной лимит AI-чата (15 запросов). Лимит сбросится завтра в 00:00 МСК.\n\nДля повседневных задач используй меню — /alerts, /shops, /today — там без лимитов.',
      toolCalls: 0,
    };
  }
  const shops = await listShopsForUser(userId);
  if (shops.length === 0) {
    return { text: '🔒 Не вижу подключённых магазинов в твоём аккаунте. Сначала подключи в кабинете.', toolCalls: 0 };
  }
  const workspaceId = shops[0].workspaceId;
  const groups = await listAlertGroups(workspaceId);
  const system = systemPrompt(workspaceId, shops.map((s) => s.name), groups);

  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 0 });

  // Load + slim conversation memory so the model has context across
  // turns ("про какую подушку ты говорил?" needs the prior turn). We
  // append the current user-message to memory first, then build the
  // request from the slimmed history.
  await appendUser(userId, userMessage);
  if (opts?.sessionId) {
    await persistMessage(opts.sessionId, 'user', userMessage);
    await maybeSetAutoTitle(opts.sessionId, userMessage);
  }
  const history = await loadHistory(userId);
  const messages: Anthropic.Messages.MessageParam[] = slimForLLM(history)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const onProgress = opts?.onProgress;
  const onEvent = opts?.onEvent;
  const emit = async (e: LlmEvent): Promise<void> => {
    if (!onEvent) return;
    try { await onEvent(e); } catch { /* swallow */ }
  };
  let toolCalls = 0;
  let finalText = '';
  for (let i = 0; i < TOOL_LOOP_LIMIT; i++) {
    await emit({ type: 'turn_start', turnIndex: i });
    // Use streaming so callers can update the Telegram message as text
    // arrives. Anthropic's MessageStream emits per-delta events and
    // resolves to a final Message object at the end — same shape we'd
    // get from .create(), so the tool-loop logic below is unchanged.
    const stream = client.messages.stream({
      model,
      max_tokens: MAX_TOKENS,
      system,
      tools: TOOLS,
      messages,
    });

    if (onProgress) {
      // Signal "starting a new turn" — caller can keep a typing indicator
      // fresh between tool round-trips.
      try { await onProgress(finalText); } catch { /* never let UI break the LLM */ }
      let buffer = '';
      stream.on('text', (delta: string) => {
        buffer += delta;
        // Fire-and-forget; the caller debounces.
        Promise.resolve(onProgress(buffer)).catch(() => {/* swallow */});
      });
    }

    const resp = await stream.finalMessage();

    // Collect any text the model produced this turn.
    const turnText = resp.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
      .trim();
    if (turnText) finalText = turnText;

    // If no tool_use blocks, we're done.
    const toolUses = resp.content.filter((b: any) => b.type === 'tool_use') as any[];
    if (toolUses.length === 0) break;

    // Echo assistant turn back into messages, then run tools and append
    // results as a user-role message — required by Anthropic's tool-loop
    // protocol.
    messages.push({ role: 'assistant', content: resp.content as any });
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      toolCalls++;
      await emit({ type: 'tool_start', name: tu.name, input: tu.input ?? {} });
      const result = await runTool(tu.name, tu.input ?? {}, workspaceId, userId);
      const ok = !(result && typeof result === 'object' && 'error' in (result as any));
      const pendingNonce =
        result && typeof result === 'object' && (result as any).pending_confirmation
          ? String((result as any).nonce)
          : undefined;
      await emit({
        type: 'tool_end',
        name: tu.name,
        ok,
        summary: summarizeToolResult(tu.name, result),
        pendingNonce,
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result).slice(0, 4000),
      });
    }
    messages.push({ role: 'user', content: toolResults });

    if (resp.stop_reason !== 'tool_use') break;
  }

  if (!finalText) finalText = '🤔 Не получилось сформулировать ответ. Попробуй переформулировать или открой /alerts вручную.';
  // Persist the assistant's response into memory for the next turn.
  await appendAssistant(userId, finalText);
  if (opts?.sessionId) {
    await persistMessage(opts.sessionId, 'assistant', finalText);
  }
  await emit({ type: 'done' });
  return { text: finalText, toolCalls };
}

/**
 * Friendly short summary of a tool result, used for the inline status line
 * shown to the user when a tool finishes (rev 26c). Keep it under ~30 chars.
 */
function summarizeToolResult(name: string, result: unknown): string | undefined {
  if (!result) return undefined;
  if (typeof result !== 'object') return undefined;
  if ('error' in (result as any)) return String((result as any).error).slice(0, 40);
  if (Array.isArray(result)) {
    return `${result.length} результ.`;
  }
  const r = result as any;
  if (name === 'find_product' && r.rows) return `найдено ${r.rows.length}`;
  if (name === 'get_stock' && typeof r.quantity === 'number') return `остаток ${r.quantity}`;
  if (name === 'get_shop_summary' && r.ordersCount != null) return `заказов ${r.ordersCount}`;
  if (name === 'get_unit_economics' && r.perUnit?.marginPct != null) return `маржа ${r.perUnit.marginPct}%`;
  return undefined;
}

/**
 * Human-readable labels for tool names, used as the prefix in the in-flight
 * status block (rev 26c). Defaults to the raw name if not mapped.
 */
export const TOOL_LABEL_RU: Record<string, string> = {
  find_product: '🔍 Ищу товар',
  get_stock: '📦 Смотрю остаток',
  get_shop_summary: '🏪 Достаю сводку магазина',
  get_alerts: '🔔 Собираю алёрты',
  get_seo_positions: '📈 Смотрю SEO позиции',
  get_orders: '🛒 Смотрю заказы',
  get_reviews: '💬 Подтягиваю отзывы',
  get_ab_test_status: '🧪 Проверяю A/B-тесты',
  get_unit_economics: '📊 Считаю юнит-экономику',
  get_competitor_price: '🎯 Сравниваю с конкурентами',
  get_supplies_status: '🚚 Смотрю поставки',
  get_timeseries: '📈 Подтягиваю динамику',
  get_anomaly_summary: '🧭 Сканирую кабинет',
  get_balance_summary: '💳 Смотрю балансы',
  propose_set_price: '💰 Готовлю предложение цены',
};

export async function chatWithLLM(...args: Parameters<typeof chatWithLLMImpl>): Promise<ChatResult> {
  const shops = await listShopsForUser(args[0]);
  if (!shops.length) return { text: 'Подключите магазин в личном кабинете.', toolCalls: 0 };
  return runWithAiWorkspace(shops[0].workspaceId, () => chatWithLLMImpl(...args));
}
