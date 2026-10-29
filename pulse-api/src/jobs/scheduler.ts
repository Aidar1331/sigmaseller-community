/**
 * Unified job scheduler using pg-boss
 * 
 * Replaces setInterval-based loops with proper cron scheduling
 */

import { getQueue, stopQueue } from './queue.js';
import { allowScheduledJob } from './communityPolicy.js';
import type { PgBoss } from 'pg-boss';
import { logJobs as logger } from '../lib/logger.js';
import { sendTelegramModeration } from '../integrations/telegram.js';
import { getRedis } from '../lib/redis.js';

// Per-job failure-alert cooldown (rev 25z.1). pg-boss retries failed jobs
// 3 times by default and our cron cadence is 1 min on the noisy ones —
// so a single bad deploy generates 6+ identical Telegram alerts. Gate
// each job to ONE alert per FAILURE_COOLDOWN_S, count suppressed ones.
const FAILURE_COOLDOWN_S = 30 * 60;

interface AlertDecision { alert: boolean; suppressedCount: number; }

async function shouldAlertJobFailure(jobName: string): Promise<AlertDecision> {
  const key = `mod:job_fail:${jobName}`;
  const countKey = `mod:job_fail_count:${jobName}`;
  try {
    const redis = getRedis();
    // NX + EX = atomically "set if absent, with TTL". Returns 'OK' on
    // first failure in the window, null when the cooldown is still hot.
    const set = await redis.set(key, '1', 'EX', FAILURE_COOLDOWN_S, 'NX');
    if (set === 'OK') {
      await redis.del(countKey);
      return { alert: true, suppressedCount: 0 };
    }
    const count = await redis.incr(countKey);
    await redis.expire(countKey, FAILURE_COOLDOWN_S);
    return { alert: false, suppressedCount: count };
  } catch {
    // Redis unavailable → fail open (still alert), better noisy than silent.
    return { alert: true, suppressedCount: 0 };
  }
}

// Job names
export const JOBS = {
  FINANCE_WEEKLY_PRODUCTS: 'finance-weekly-products-sync',
  FINANCE_DAILY: 'finance-daily-sync',
  STOCKS_SNAPSHOT: 'stocks-daily-snapshot',
  SPP_WEEKLY: 'spp-weekly-sync',
  ORDERS_SALES_SYNC: 'orders-sales-sync',
  ADV_DAILY_SYNC: 'adv-daily-sync',
  FUNNEL_DAILY_SYNC: 'funnel-daily-sync',
  AUTO_ALERTS: 'auto-alerts-daily',
  INITIAL_SYNC: 'initial-full-sync',
  AB_PHOTO_ROTATE: 'ab-photo-auto-rotate',
  AB_PHOTO_METRICS: 'ab-photo-metrics-collect',
  PRICE_AB_ROTATE: 'price-ab-auto-rotate',
  WB_CARDS_EMBED_SYNC: 'wb-cards-embed-sync',
  INSIGHTS_DAILY: 'insights-daily',
  FBS_RUN: 'fbs-run',
  FBS_SCHEDULE_TICK: 'fbs-schedule-tick',
  SEO_POSITIONS_DAILY: 'seo-positions-daily',
  BIDDER_HOURLY: 'bidder-hourly',
  FEEDBACK_AUTO_REPLY: 'feedback-auto-reply',
  FEEDBACK_SYNC: 'feedback-sync',
  REMINDER_SENDER: 'reminder-sender',
  KNOWLEDGE_IMPORT: 'knowledge-import-from-history',
  SUPPLIES_SYNC: 'supplies-sync',
  ACCEPTANCE_COEFF_MONITOR: 'acceptance-coeff-monitor',
  FBS_STOCKS_SYNC: 'fbs-stocks-sync',
  TASK_MONITOR_SCAN: 'task-monitor-scan',
  // WB API 2.0 jobs (Phase 0)
  REPORTS_DAILY_SYNC: 'reports-daily-sync',
  SEARCH_QUERIES_SYNC: 'search-queries-sync',
  PRICES_HISTORY_SYNC: 'prices-history-sync',
  STOCKS_HISTORY_SYNC: 'stocks-history-sync',
  PAID_STORAGE_SYNC: 'paid-storage-sync',
  PROMOTIONS_SYNC: 'promotions-sync',
  // Campaigns sync
  CAMPAIGNS_SYNC: 'campaigns-sync',
  // AI Agent jobs
  TASK_MONITOR_DAILY: 'task-monitor-daily',
  PRICING_ENGINE_DAILY: 'pricing-engine-daily',
  SUPPLY_AGENT_DAILY: 'supply-agent-daily',
  SEO_AGENT_DAILY: 'seo-agent-daily',
  // Multi-Agent v2 (Phase 0)
  VERIFICATION_RUNNER: 'agent-verification-runner',
  // Multi-Agent v2 (Phase 4)
  AGENT_MONITOR_SCAN: 'agent-monitor-scan',
  // Billing
  SUBSCRIPTION_RENEWAL_DAILY: 'subscription-renewal-daily',
  // Action Queue sweeper (migration 0117) — reclaims actions stuck in 'running'
  // after a worker death; runs every minute.
  AGENT_ACTION_SWEEPER: 'agent-action-sweeper',
  // wb_sync_runs orphan sweeper — without this, child processes killed
  // mid-sync leave rows stuck in 'running'. The startup-time cleanup in
  // initializeJobs() only fires once per pulse-workers boot, so a long
  // uptime accumulates orphans (observed: 9 over one night).
  WB_SYNC_RUNS_SWEEPER: 'wb-sync-runs-sweeper',
  // Overnight backfill walker — advances per-(shop, sync_type) cursors in
  // wb_backfill_progress backward at a pace that never overruns WB's
  // per-endpoint quotas. Replaces the rev-13/14 "gulp 90 days at connect"
  // anti-pattern. See backfillWalker.ts header.
  BACKFILL_WALKER: 'backfill-walker',
  // Daily Telegram digests (rev 25c) — admin (sync/walker/coverage) at
  // 06:30 MSK; user (per-shop business summary) at 09:00 MSK. See dailyDigests.ts.
  ADMIN_DAILY_DIGEST: 'admin-daily-digest',
  USER_DAILY_DIGEST:  'user-daily-digest',
  // Real-time critical events pusher (rev 25f, v2.0-α) — every minute,
  // polls agent_events for new critical rows and pushes to linked users
  // with per-user throttle (max 1 push / 10 min). See
  // criticalEventsPusher.ts header.
  CRITICAL_EVENTS_PUSHER: 'critical-events-pusher',
  // Bridge agent_events → wb_events (calendar of events UI). Copies new
  // agent_events rows with category mapping (oos→stock, margin_drop→sales,
  // feedback_alert→review, etc.) every 5 minutes. Idempotent via
  // wb_events_fingerprint_uniq. See services/eventBridge/agentEventsToWb.ts.
  AGENT_EVENTS_BRIDGE: 'agent-events-bridge',
  // Price-change detector — emits wb_events.category='price' when
  // finished_price_rub changes ≥5% AND ≥50 ₽ day-over-day. Daily at 08:00 MSK.
  PRICE_CHANGE_DETECTOR: 'price-change-detector',
  // Rating-drop detector — compares 30d avg vs 31-90d baseline per nmId,
  // emits wb_events.category='review' (severity warn|critical). 10:00 MSK daily.
  RATING_DROP_DETECTOR: 'rating-drop-detector',
  // Supply booking queue processor — tries to book FBO preorder slots
  // automatically when WB acceptance coefficient drops ≤ user-set threshold.
  // Runs every 10 minutes. See workspace/PLAN-SUPPLIES-E2E-AGENT-2026-05-23.md.
  BOOKING_QUEUE_PROCESSOR: 'supply-booking-queue-processor',
} as const;

// Default timezone for all schedules
const DEFAULT_TZ = 'Europe/Moscow';

interface JobConfig {
  name: string;
  cron: string;
  handler: () => Promise<void>;
  enabled: boolean;
}

const jobs: JobConfig[] = [];

/**
 * Register a job with the scheduler
 */
export function registerJob(config: JobConfig): void {
  jobs.push({ ...config, enabled: config.enabled && allowScheduledJob(config.name) });
}

/**
 * Start all registered jobs
 */
export async function startScheduler(): Promise<void> {
  const boss = await getQueue();
  
  for (const job of jobs) {
    if (!job.enabled) {
      await boss.unschedule(job.name).catch(() => {});
      logger.info({ job: job.name }, 'job disabled, skipping');
      continue;
    }

    try {
      // Create queue if not exists
      await boss.createQueue(job.name);

      // Schedule the job
      await boss.schedule(job.name, job.cron, {}, {
        tz: DEFAULT_TZ,
      });

      // Register worker
      await boss.work(job.name, {}, async () => {
        logger.info({ job: job.name }, 'job running');
        const start = Date.now();
        try {
          await job.handler();
          logger.info({ job: job.name, durationMs: Date.now() - start }, 'job completed');
        } catch (err) {
          logger.error({ err, job: job.name }, 'job error');
          // Per-job cooldown: send at most 1 Telegram alert per
          // FAILURE_COOLDOWN_S window. Subsequent failures in the same
          // window are counted, not paged.
          const decision = await shouldAlertJobFailure(job.name);
          if (decision.alert) {
            sendTelegramModeration({
              text: `🔴 <b>Sync job failed</b>\n\nJob: <code>${job.name}</code>\nError: <code>${String((err as any)?.message ?? err).slice(0, 300)}</code>\nDuration: ${Date.now() - start}ms`,
            }).catch(() => {});
          } else {
            logger.warn({ job: job.name, suppressed: decision.suppressedCount }, 'job-failure alert suppressed (cooldown)');
          }
          throw err; // Let pg-boss handle retry
        }
      });

      logger.info({ job: job.name, cron: job.cron, tz: DEFAULT_TZ }, 'job registered');
    } catch (err) {
      logger.error({ err, job: job.name }, 'failed to register job');
    }
  }

  logger.info({ activeJobs: jobs.filter(j => j.enabled).length }, 'scheduler started');
}

/**
 * Stop the scheduler gracefully
 */
export async function stopScheduler(): Promise<void> {
  await stopQueue();
  logger.info('scheduler stopped');
}

/**
 * Trigger a job immediately (for manual runs)
 */
export async function triggerJob(jobName: string, data: Record<string, unknown> = {}): Promise<string | null> {
  const boss = await getQueue();
  return boss.send(jobName, data, {
    retryLimit: 1,
    expireInSeconds: 3600,
  });
}

// ─── Job Implementations ───

/**
 * Initialize all jobs based on environment config
 */
export async function initializeJobs(): Promise<void> {
  const env = process.env;

  // Cleanup orphan sync locks from previous API runs. tsx watch rebuilds
  // the process on HMR and production pods restart; any in-flight IIFE
  // is killed mid-run with its `wb_sync_runs` row stuck in
  // status='running'. The dedup guard in maybeStart* helpers then sees
  // that row and skips the cron — so stale locks silently halt daily
  // syncs until they're cleared.
  //
  // We apply per-stage staleness thresholds: stocks snapshot is fast
  // (≤15 min healthy runs), finance/funnel can legitimately take 30+
  // min, so anything >2h is definitively orphan.
  try {
    const { db: dbClient } = await import('../db/client.js');
    const { wbSyncRuns } = await import('../db/schema.js');
    const { and, eq, sql } = await import('drizzle-orm');

    // First pass: the fast seo-refresh stages — 15 min threshold.
    const clearedSeo = await dbClient
      .update(wbSyncRuns)
      .set({
        status: 'failed',
        error: 'orphan: api restart (seo-refresh, >15m stale)',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(wbSyncRuns.status, 'running'),
        sql`${wbSyncRuns.stage} LIKE 'seo-refresh:%'`,
        sql`${wbSyncRuns.startedAt} < NOW() - INTERVAL '15 minutes'`,
      ))
      .returning({ runId: wbSyncRuns.runId });

    // Second pass: everything else — 5 min threshold. A spawned child
    // process cannot survive its parent on this single-instance prod, so
    // any 'running' row we see at startup is by definition orphaned. The
    // 5-min grace is to avoid racing a still-spawning child during the
    // very first seconds of a fresh boot. Used to be 2h; tightened
    // 2026-05-06 after a manual restart left 5 rows stuck mid-refresh.
    const clearedOther = await dbClient
      .update(wbSyncRuns)
      .set({
        status: 'failed',
        error: 'orphan: api restart (>5min stale)',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(wbSyncRuns.status, 'running'),
        sql`${wbSyncRuns.stage} NOT LIKE 'seo-refresh:%'`,
        sql`${wbSyncRuns.startedAt} < NOW() - INTERVAL '5 minutes'`,
      ))
      .returning({ runId: wbSyncRuns.runId });

    const total = clearedSeo.length + clearedOther.length;
    if (total > 0) {
      logger.info(
        { seo: clearedSeo.length, other: clearedOther.length, total },
        'cleared orphan sync locks on startup',
      );
    }
  } catch (err) {
    logger.error({ err }, 'failed to clear orphan sync locks');
  }

  // Register initial-sync worker (triggered on shop creation, not cron-based)
  const { registerInitialSyncWorker } = await import('./initialSync.js');
  await registerInitialSyncWorker();

  // WB Partner API: monitor expiry of WB_PARTNER_SERVICE_SECRET — алёрт
  // админам за 14 дней до истечения (по доке WB новый секрет выпускается
  // за 30 дн до конца срока, бесшовная миграция).
  const { registerWbPartnerSecretMonitor } = await import('./wbPartnerSecretMonitor.js');
  await registerWbPartnerSecretMonitor();

  // WB buyer chats — синк раз в 10 мин (см. wbChatsSync.ts). Заполняет
  // wb_chats.reply_sign чтобы send_chat_message executor не делал лишний
  // network-роундтрип при каждой отправке.
  const { registerWbChatsSync } = await import('./wbChatsSync.js');
  await registerWbChatsSync();

  // WB returns — синк заявок покупателей на возврат каждые 15 мин.
  // Эндпоинт /api/v1/claims отдаёт за 14 дней; держим оба cluster'а
  // (активные + архив) в БД для UI и для AI-инсайтов.
  const { registerWbReturnsSync } = await import('./wbReturnsSync.js');
  await registerWbReturnsSync();

  // WB prices daily snapshot — один срез в сутки в wb_prices_history.
  // Нужно для price-change detector и для taskMonitor (LOCF).
  const { registerWbPricesDailySnapshot } = await import('./wbPricesDailySnapshot.js');
  await registerWbPricesDailySnapshot();

  // WB adv finance — фактические списания на рекламу (УПД) с разбивкой
  // по источнику оплаты. Нужно для корректной маржи: «Прочие удержания»
  // в еженедельном отчёте включает списания с Баланса, но не со Счёта.
  const { registerWbAdvFinanceSync } = await import('./wbAdvFinanceSync.js');
  await registerWbAdvFinanceSync();

  // WB deductions daily — отчёт об удержаниях за подмены/неверные вложения.
  // 1 rpm на endpoint, потому раз в сутки.
  const { registerWbDeductionsDailySync } = await import('./wbDeductionsDailySync.js');
  await registerWbDeductionsDailySync();

  // Лаборатория: ночной снапшот карточек + публикация в Канбан
  const { registerWbCardSnapshotDaily } = await import('./wbCardSnapshotDaily.js');
  registerWbCardSnapshotDaily();

  // Finance weekly products sync - 03:00 MSK daily
  if (env.ENABLE_FINANCE_DAILY_SYNC === '1') {
    const { maybeStartFinanceWeeklyProductsSync, maybeStartFinanceDailySync } = await import('./financeDailySync.js');

    // Weekly products aggregation (for per-nm margin dashboards). Daily.
    registerJob({
      name: JOBS.FINANCE_WEEKLY_PRODUCTS,
      cron: '0 3 * * *',
      enabled: true,
      handler: async () => {
        await maybeStartFinanceWeeklyProductsSync('pg-boss');
      },
    });

    // Daily aggregation into wb_finance_daily.
    // F-11 stagger: разнесён в свой 6-часовой слот (минута :30, час 3/9/15/21)
    // чтобы не пересекаться с orders-sales/adv/funnel/spp на statistics-api
    // (общий 1 rpm bucket). Раньше «5 1,5,9,13,17,21» дёргал WB одновременно
    // с adv-daily (минута :15) и orders-sales (:05) → 429 storm.
    registerJob({
      name: JOBS.FINANCE_DAILY,
      cron: '30 3,9,15,21 * * *',
      enabled: true,
      handler: async () => {
        await maybeStartFinanceDailySync('pg-boss');
      },
    });
  }

  // Stocks snapshot - 04:00 MSK daily
  if (env.ENABLE_STOCKS_SNAPSHOT !== '0') {
    const { runStocksDailySnapshot } = await import('./stocksDailySnapshot.js');
    registerJob({
      name: JOBS.STOCKS_SNAPSHOT,
      // Cost-cap 2026-06-18: every 6h instead of ~hourly.
      cron: '25 */6 * * *',
      enabled: true,
      handler: async () => {
        await runStocksDailySnapshot();
      },
    });
  }

  // ADV daily sync — c сервисными лимитами hourly @:15. Bidder и так дёргает
  // ставки каждый час, а до этого статистика расхода обновлялась раз в 6ч
  // и оператор жаловался «реклама сжирает бюджет за ночь».
  if (env.ENABLE_ADV_DAILY_SYNC === '1') {
    const { maybeStartAdvDailySync } = await import('./advDailySync.js');
    registerJob({
      name: JOBS.ADV_DAILY_SYNC,
      // Cost-cap 2026-06-18: every 6h instead of hourly.
      cron: '15 */6 * * *',
      enabled: true,
      handler: async () => {
        await maybeStartAdvDailySync('pg-boss');
      },
    });
  }

  // Orders/Sales sync — c WB Partner secret лимиты сервисные, F-11 stagger
  // больше не нужен. Hourly @:05 — продавец видит свежие заказы в дашборде
  // почти в real-time. До этого было 6h, упирались в 1/3h Basic-лимит.
  if (env.ENABLE_ORDERS_SALES_SYNC === '1') {
    const { maybeStartOrdersSalesSync } = await import('./ordersSalesDailySync.js');
    registerJob({
      name: JOBS.ORDERS_SALES_SYNC,
      // Cost-cap 2026-06-18: WB bills per entity, so re-pulling overlapping
      // windows hourly was the top spend driver. Capped to every 6h.
      cron: '5 */6 * * *',
      enabled: true,
      handler: async () => {
        await maybeStartOrdersSalesSync('pg-boss');
      },
    });
  }

  // SPP weekly sync — F-11 stagger: 2 раза в сутки (4:20 и 16:20),
  // не каждые 2ч. SPP по дизайну еженедельный, чаще не нужен.
  if (env.ENABLE_SPP_DAILY_SYNC === '1') {
    const { maybeStartSppWeeklySync } = await import('./sppDailySync.js');
    registerJob({
      name: JOBS.SPP_WEEKLY,
      cron: '20 4,16 * * *',
      enabled: true,
      handler: async () => {
        await maybeStartSppWeeklySync('pg-boss');
      },
    });
  }

  // Funnel daily sync — c сервисными лимитами every 2h @:35. Падение
  // CTR/CR теперь ловится в течение пары часов, а не на следующее утро.
  // Чаще, чем 2ч, не имеет смысла: WB обновляет funnel-данные сам не
  // каждый час.
  if (env.ENABLE_FUNNEL_DAILY_SYNC === '1') {
    const { maybeStartFunnelDailySync } = await import('./funnelDailySync.js');
    registerJob({
      name: JOBS.FUNNEL_DAILY_SYNC,
      // Cost-cap 2026-06-18: every 6h instead of every 2h.
      cron: '35 */6 * * *',
      enabled: true,
      handler: async () => {
        await maybeStartFunnelDailySync('pg-boss');
      },
    });
  }

  // AB Photo auto-rotate - каждые 5 минут. UI разрешает rotationMinutes >= 20,
  // поэтому тестировщик с настройкой «20 мин» получает фактическую первую
  // ротацию максимум через 25 мин после старта — близко к ожиданию. Раньше
  // cron был часовой/6-часовой, и расхождение с UI «20 мин» приводило к тому,
  // что фото не менялось в обещанный срок.
  if (env.ENABLE_AB_PHOTO_ROTATE !== '0') {
    const { runAbPhotoAutoRotate } = await import('./abPhotoAutoRotate.js');
    registerJob({
      name: JOBS.AB_PHOTO_ROTATE,
      // Каждую минуту: при rotation_minutes=20 это даёт фактическую длину фазы
      // 20–21 мин (±1 мин). 5-мин cron давал «качели» 20 → 25 → 20 (пропуск
      // тика когда целевое время 20:00 а cron в 19:00/24:00).
      cron: '* * * * *',
      enabled: true,
      handler: async () => {
        await runAbPhotoAutoRotate();
      },
    });
  }

  // Price A/B ротация — каждые 5 минут проверяет тесты, чьи rotation_minutes
  // прошли. Меняет цену через POST /api/v2/upload/task. Дефолт интервала
  // в тестах = 20 мин, минимум жёстко 20 (zod validation).
  if (env.ENABLE_PRICE_AB_ROTATE !== '0') {
    const { runPriceAbAutoRotate } = await import('./priceAbAutoRotate.js');
    registerJob({
      name: JOBS.PRICE_AB_ROTATE,
      cron: '* * * * *',
      enabled: true,
      handler: async () => {
        await runPriceAbAutoRotate();
      },
    });
  }

  // WB Cards embed sync — каждые 15 минут. Эмбедит свежие/изменённые
  // карточки товаров через Jina (1024-dim cosine vectors). Идемпотентен:
  // партиал-индекс wb_cards_needs_embed_idx делает SELECT кандидатов O(touched),
  // shouldSkipReembed() пропускает API-вызов если embedding_text не изменился.
  // Без JINA_API_KEY job просто пишет warning и возвращается.
  // Cron-флаг: ENABLE_WB_CARDS_EMBED_SYNC (default ON).
  if (env.ENABLE_WB_CARDS_EMBED_SYNC !== '0') {
    const { runWbCardsEmbedSync } = await import('./wbCardsEmbedSync.js');
    registerJob({
      name: JOBS.WB_CARDS_EMBED_SYNC,
      cron: '*/15 * * * *',
      enabled: true,
      handler: async () => {
        await runWbCardsEmbedSync();
      },
    });
  }

  // Insights daily - 08:00 MSK daily
  if (env.ENABLE_INSIGHTS_DAILY !== '0') {
    const { runInsightsDaily } = await import('./insightsDaily.js');
    registerJob({
      name: JOBS.INSIGHTS_DAILY,
      cron: '0 8 * * *',
      enabled: true,
      handler: async () => {
        await runInsightsDaily();
      },
    });
  }

  // SEO positions daily - 03:00 MSK daily
  if (env.ENABLE_SEO_POSITIONS_DAILY !== '0') {
    const { runSeoPositionsDaily } = await import('./seoPositionsDaily.js');
    registerJob({
      name: JOBS.SEO_POSITIONS_DAILY,
      cron: '0 3 * * *',
      enabled: true,
      handler: async () => {
        await runSeoPositionsDaily();
      },
    });
  }

  // Bidder hourly - every hour at :00
  if (env.ENABLE_BIDDER_HOURLY !== '0') {
    const { runBidderHourly } = await import('./bidderHourly.js');
    registerJob({
      name: JOBS.BIDDER_HOURLY,
      cron: '30 0,2,4,6,8-23 * * *',
      enabled: true,
      handler: async () => {
        await runBidderHourly();
      },
    });
  }

  // Feedback / questions sync — каждые 15 минут. Auto-reply теперь отвечает
  // в день обращения. До этого был hourly из-за Basic-лимита 5/час
  // (4 вызова не оставляли запас). С X-Client-Secret хватает.
  if (env.ENABLE_FEEDBACK_SYNC !== '0') {
    const { runFeedbackSync } = await import('./feedbackSync.js');
    registerJob({
      name: JOBS.FEEDBACK_SYNC,
      // Cost-cap 2026-06-18: every 6h instead of every 15 min.
      cron: '45 */6 * * *',
      enabled: true,
      handler: async () => {
        await runFeedbackSync();
      },
    });
  }

  // Feedback auto-reply — каждый час в :25 (через 10 мин после sync на :15,
  // чтобы свежие отзывы успели появиться в БД). Учащён с 2ч до 1ч 2026-06-10:
  // продавец ждёт AI-ответ максимум ~1:15 от появления отзыва в WB
  // (15 мин до sync + до 60 мин до auto-reply).
  if (env.ENABLE_FEEDBACK_AUTO_REPLY !== '0') {
    const { runFeedbackAutoReply } = await import('./feedbackAutoReply.js');
    registerJob({
      name: JOBS.FEEDBACK_AUTO_REPLY,
      cron: '25 * * * *',
      enabled: true,
      handler: async () => {
        await runFeedbackAutoReply();
      },
    });
  }

  // Reminder sender - every 5 minutes
  if (env.ENABLE_REMINDER_SENDER !== '0') {
    const { runReminderSender } = await import('./reminderSender.js');
    registerJob({
      name: JOBS.REMINDER_SENDER,
      cron: '*/5 * * * *',
      enabled: true,
      handler: async () => {
        await runReminderSender();
      },
    });
  }

  // NOTE: AB Photo rotate duplicate removed (was also registered above with 6h cron)
  // Use ENABLE_AB_PHOTO_ROTATE to enable the 6-hour rotation schedule

  // AB Photo metrics collection - hourly
  if (env.ENABLE_AB_PHOTO_METRICS !== '0') {
    const { collectAbPhotoMetrics } = await import('./abPhotoAutoRotate.js');
    registerJob({
      name: JOBS.AB_PHOTO_METRICS,
      // Cost-cap 2026-06-18: every 6h instead of hourly.
      cron: '50 */6 * * *',
      enabled: true,
      handler: async () => {
        await collectAbPhotoMetrics();
      },
    });
  }

  // Knowledge import from feedback history - once daily at 04:00
  if (env.ENABLE_KNOWLEDGE_IMPORT !== '0') {
    const { runKnowledgeImport } = await import('./knowledgeImport.js');
    registerJob({
      name: JOBS.KNOWLEDGE_IMPORT,
      cron: '0 4 * * *',
      enabled: true,
      handler: async () => {
        await runKnowledgeImport();
      },
    });
  }

  // Session cleanup - daily at 03:00 (clean up expired sessions)
  {
    const { runSessionCleanup } = await import('./sessionCleanup.js');
    registerJob({
      name: 'SESSION_CLEANUP',
      cron: '0 3 * * *',
      enabled: true,
      handler: async () => {
        await runSessionCleanup();
      },
    });
  }

  // Supplies sync - every 4 hours
  if (env.ENABLE_SUPPLIES_SYNC !== '0') {
    const { runSuppliesSync } = await import('./suppliesSync.js');
    registerJob({
      name: JOBS.SUPPLIES_SYNC,
      // Cost-cap 2026-06-18: every 6h instead of every 4h.
      cron: '0 */6 * * *',
      enabled: true,
      handler: async () => {
        await runSuppliesSync();
      },
    });
  }

  // F-13: Acceptance Coefficient Monitor («Ловец приёмки» MVP).
  // Каждые 15 минут (минуты 5/20/35/50). С сервисными лимитами окна
  // приёмки ловим почти в реал-тайме — раньше час часто = опоздали.
  if (env.ENABLE_ACCEPTANCE_COEFF_MONITOR !== '0') {
    const { runAcceptanceCoeffMonitor } = await import('./acceptanceCoeffMonitor.js');
    registerJob({
      name: JOBS.ACCEPTANCE_COEFF_MONITOR,
      cron: '5,20,35,50 * * * *',
      enabled: true,
      handler: async () => {
        await runAcceptanceCoeffMonitor();
      },
    });
  }

  // FBS stocks sync — раз в час, отдельно от FBO. Источник:
  // Marketplace API /api/v3/stocks/{warehouseId}. Пишем в wb_stocks_fbs_current.
  if (env.ENABLE_FBS_STOCKS_SYNC !== '0') {
    const { runFbsStocksSync } = await import('./fbsStocksSync.js');
    registerJob({
      name: JOBS.FBS_STOCKS_SYNC,
      // Cost-cap 2026-06-18: every 6h instead of hourly.
      cron: '55 */6 * * *',
      enabled: true,
      handler: async () => {
        await runFbsStocksSync();
      },
    });
  }

  // Task Monitor scan — каждые 2 часа сканирует workspace, генерирует
  // свежие agent_events (избытки FBO, OOS, падения CTR/CR и т.д.).
  // Опирается на свежие данные FBS/FBO/funnel — синхи выше отрабатывают
  // раньше по своему расписанию.
  if (env.ENABLE_TASK_MONITOR_SCAN !== '0') {
    const { runTaskMonitorForAll } = await import('../services/taskMonitor/index.js');
    registerJob({
      name: JOBS.TASK_MONITOR_SCAN,
      cron: '23 */2 * * *',
      enabled: true,
      handler: async () => {
        await runTaskMonitorForAll();
      },
    });
  }

  // Campaigns sync - every 6 hours (multi-shop)
  if (env.ENABLE_CAMPAIGNS_SYNC !== '0') {
    registerJob({
      name: JOBS.CAMPAIGNS_SYNC,
      cron: '45 */6 * * *',
      enabled: true,
      handler: async () => {
        const { syncCampaigns } = await import('../integrations/wb/campaigns.js');
        const { db: dbClient } = await import('../db/client.js');
        const { marketplaceShops: shopsTable } = await import('../db/schema.js');
        const { eq: eqOp, and: andOp } = await import('drizzle-orm');
        const { getActiveWorkspaceIds } = await import('../lib/guardedSpawn.js');
        const wsIds = await getActiveWorkspaceIds();
        for (const wsId of wsIds) {
          const shops = await dbClient
            .select({ shopId: shopsTable.shopId })
            .from(shopsTable)
            .where(andOp(eqOp(shopsTable.workspaceId, wsId), eqOp(shopsTable.isActive, true)));
          for (const shop of shops) {
            try {
              const r = await syncCampaigns(wsId, shop.shopId);
              logger.info({ workspaceId: wsId, shopId: shop.shopId, synced: r.synced, errors: r.errors.length }, 'campaigns sync done');
            } catch (err) {
              logger.error({ err, workspaceId: wsId, shopId: shop.shopId }, 'campaigns sync error');
            }
          }
        }
      },
    });
  }

  // Search queries sync - daily at 04:00
  if (env.ENABLE_SEARCH_QUERIES_SYNC !== '0') {
    const { runSearchQueriesSync } = await import('./searchQueriesSync.js');
    registerJob({
      name: JOBS.SEARCH_QUERIES_SYNC,
      cron: '0 4 * * *',
      enabled: true,
      handler: async () => {
        await runSearchQueriesSync();
      },
    });
  }

  // Stocks history sync - daily at 06:30
  if (env.ENABLE_STOCKS_HISTORY_SYNC !== '0') {
    const { runStocksHistorySync } = await import('./stocksHistorySync.js');
    registerJob({
      name: JOBS.STOCKS_HISTORY_SYNC,
      cron: '30 6 * * *',
      enabled: true,
      handler: async () => {
        await runStocksHistorySync();
      },
    });
  }

  // Paid-storage sync (фактическая стоимость хранения per-nmId) — 07:00 MSK.
  // Replaces legacy statistics-api /reports/storage (disabled 2026-03).
  if (env.ENABLE_PAID_STORAGE_SYNC !== '0') {
    const { runPaidStorageSync } = await import('./paidStorageSync.js');
    registerJob({
      name: JOBS.PAID_STORAGE_SYNC,
      cron: '0 7 * * *',
      enabled: true,
      handler: async () => {
        await runPaidStorageSync();
      },
    });
  }

  // Reports daily sync (region-sales, deductions, storage, hidden-products, warehouse-remains) - 06:00 daily
  if (env.ENABLE_REPORTS_DAILY_SYNC !== '0') {
    const { runReportsDailySync } = await import('./reportsDailySync.js');
    registerJob({
      name: JOBS.REPORTS_DAILY_SYNC,
      cron: '0 6 * * *',
      enabled: true,
      handler: async () => {
        await runReportsDailySync();
      },
    });
  }

  // Task Monitor — daily at 07:00 MSK
  if (env.ENABLE_TASK_MONITOR !== '0') {
    registerJob({
      name: JOBS.TASK_MONITOR_DAILY,
      cron: '0 7 * * *',
      enabled: true,
      handler: async () => {
        const { runTaskMonitorForAll } = await import('../services/taskMonitor/index.js');
        await runTaskMonitorForAll();
      },
    });
  }

  // Pricing Engine daily evaluation — 09:00 MSK. Iterates per-shop so analysis
  // is never mixed across shops of the same workspace.
  if (env.ENABLE_PRICING_ENGINE !== '0') {
    registerJob({
      name: JOBS.PRICING_ENGINE_DAILY,
      cron: '0 9 * * *',
      enabled: true,
      handler: async () => {
        const { runPricingAgent } = await import('../agents/specialized/pricingAgent.js');
        const { workspaces, marketplaceShops } = await import('../db/schema.js');
        const { db: dbClient } = await import('../db/client.js');
        const { eq } = await import('drizzle-orm');
        const wsList = await dbClient.select({ wsId: workspaces.workspaceId }).from(workspaces);
        for (const ws of wsList) {
          try {
            const shops = await dbClient
              .select({ shopId: marketplaceShops.shopId })
              .from(marketplaceShops)
              .where(eq(marketplaceShops.workspaceId, ws.wsId));
            // Fallback for workspaces без активных shops — запускаем раз без scope.
            if (shops.length === 0) {
              await runPricingAgent(ws.wsId);
              continue;
            }
            for (const shop of shops) {
              try {
                await runPricingAgent(ws.wsId, shop.shopId);
              } catch (err) {
                logger.error({ err, workspaceId: ws.wsId, shopId: shop.shopId }, 'pricingEngine per-shop error');
              }
            }
          } catch (err) {
            logger.error({ err, workspaceId: ws.wsId }, 'pricingEngine workspace error');
          }
        }
      },
    });
  }

  // Supply Agent daily — 06:30 MSK (после stocks sync).
  // Анализирует остатки + скорость продаж → рекомендации поставок
  // (agent_supply_recommendations). Итерирует по всем активным WB-shops.
  if (env.ENABLE_SUPPLY_AGENT_DAILY !== '0') {
    registerJob({
      name: JOBS.SUPPLY_AGENT_DAILY,
      cron: '30 6 * * *',
      enabled: true,
      handler: async () => {
        const { runSupplyAgentPersisted } = await import('../agents/specialized/runners/supplyRunner.js');
        const { marketplaceShops } = await import('../db/schema.js');
        const { db: dbClient } = await import('../db/client.js');
        const { and: andOp, eq: eqOp } = await import('drizzle-orm');
        const shops = await dbClient
          .select({ workspaceId: marketplaceShops.workspaceId, shopId: marketplaceShops.shopId })
          .from(marketplaceShops)
          .where(andOp(eqOp(marketplaceShops.platform, 'wb'), eqOp(marketplaceShops.isActive, true)));
        for (const shop of shops) {
          try {
            await runSupplyAgentPersisted({
              workspaceId: shop.workspaceId,
              shopId: shop.shopId,
              trigger: 'cron',
            });
          } catch (err) {
            logger.error({ err, workspaceId: shop.workspaceId, shopId: shop.shopId }, 'supply agent cron error');
          }
        }
      },
    });
  }

  // SEO Agent daily — 07:30 MSK (после seo-positions-daily в 03:00).
  // Анализирует свежие снимки → генерирует seo_alerts с 48h-дедупом.
  if (env.ENABLE_SEO_AGENT_DAILY !== '0') {
    registerJob({
      name: JOBS.SEO_AGENT_DAILY,
      cron: '30 7 * * *',
      enabled: true,
      handler: async () => {
        const { runSeoAgentPersisted } = await import('../agents/specialized/runners/seoRunner.js');
        const { marketplaceShops } = await import('../db/schema.js');
        const { db: dbClient } = await import('../db/client.js');
        const { and: andOp, eq: eqOp } = await import('drizzle-orm');
        const shops = await dbClient
          .select({ workspaceId: marketplaceShops.workspaceId, shopId: marketplaceShops.shopId })
          .from(marketplaceShops)
          .where(andOp(eqOp(marketplaceShops.platform, 'wb'), eqOp(marketplaceShops.isActive, true)));
        for (const shop of shops) {
          try {
            await runSeoAgentPersisted({
              workspaceId: shop.workspaceId,
              shopId: shop.shopId,
              trigger: 'cron',
            });
          } catch (err) {
            logger.error({ err, workspaceId: shop.workspaceId, shopId: shop.shopId }, 'seo agent cron error');
          }
        }
      },
    });
  }

  // Multi-Agent v2 Phase 0 — V&V runner. Drains pending agent_verification_checks
  // rows every minute. Registered only when multi-agent is explicitly enabled,
  // so the default build adds zero load.
  if (env.ENABLE_MULTI_AGENT === '1') {
    registerJob({
      name: JOBS.VERIFICATION_RUNNER,
      // M1: every-minute was draining ~1500 empty job-runs/day against the
      // verification queue. Drop to every 5 min — V&V doesn't need
      // sub-minute reaction; it audits past actions post-hoc. If a faster
      // SLA becomes important, switch to on-demand triggers via pg-boss
      // send() from the executeNode hook.
      cron: '*/5 * * * *',
      enabled: true,
      handler: async () => {
        const { runVerificationRunner } = await import('../services/agentVerification/verificationRunner.js');
        await runVerificationRunner();
      },
    });

    // Multi-Agent v2 Phase 4 — Monitor scan. Proactively generates insights
    // from system_events + agent_actions. Every 4 hours.
    registerJob({
      name: JOBS.AGENT_MONITOR_SCAN,
      cron: '0 */4 * * *',
      enabled: true,
      handler: async () => {
        const { runAgentMonitorScan } = await import('../services/agentMonitor/index.js');
        const summary = await runAgentMonitorScan();
        logger.info({ ...summary }, 'agent-monitor-scan completed');
      },
    });
  }

  // Billing — daily subscription renewal + pre-notify.
  // Runs at 09:00 MSK so failures reach users during business hours.
  // Can be disabled via ENABLE_SUBSCRIPTION_RENEWAL=0 if YooKassa creds
  // aren't configured in a given environment (dev/staging).
  if (env.ENABLE_SUBSCRIPTION_RENEWAL !== '0') {
    registerJob({
      name: JOBS.SUBSCRIPTION_RENEWAL_DAILY,
      cron: '0 9 * * *',
      enabled: true,
      handler: async () => {
        const { runSubscriptionRenewal } = await import('./subscriptionRenewal.js');
        const summary = await runSubscriptionRenewal();
        logger.info(summary, 'subscription-renewal-daily summary');
      },
    });
  }

  // Action Queue sweeper — reclaims agent_actions rows stuck in 'running' for
  // > 5 minutes (worker process died with action in flight). Re-enqueues
  // retryable ones; marks others as failed:permanent. Always on; cheap (one
  // UPDATE … RETURNING per tick, plus a few pg-boss send() calls if rows hit).
  registerJob({
    name: JOBS.AGENT_ACTION_SWEEPER,
    cron: '* * * * *',
    enabled: true,
    handler: async () => {
      const { sweepStuckActions } = await import('./agentActionRunner.js');
      const summary = await sweepStuckActions(5);
      if (summary.rescued > 0 || summary.permanent > 0) {
        logger.info(summary, 'agent-action-sweeper: cleaned up');
      }
    },
  });

  // Overnight backfill walker — every 30 min in the 23:00-03:30 MSK window,
  // advances one (shop, sync_type) cursor backward by CHUNK_DAYS (=7). Times
  // chosen so daily syncs (which run 06:00-21:00 MSK) don't compete with
  // walker for WB per-endpoint quotas. See backfillWalker.ts.
  if (env.ENABLE_BACKFILL_WALKER !== '0') {
    const { runBackfillWalker } = await import('./backfillWalker.js');
    registerJob({
      name: JOBS.BACKFILL_WALKER,
      // Cost-cap 2026-06-18: once nightly instead of every 30 min. Historical
      // backfill is finite and non-urgent; slower walk, far fewer WB entities.
      cron: '0 1 * * *',
      enabled: true,
      handler: async () => {
        await runBackfillWalker();
      },
    });
  }

  // Admin daily digest (Telegram) — fires after the walker has finished and
  // after the morning crons (reports-daily at 06:00, paid-storage at 07:00).
  // 06:30 catches today's reports-daily but predates 07:00 paid-storage; that
  // ordering is intentional — operator wants the data while drinking coffee,
  // not at 08:00 when they're already in meetings.
  if (env.ENABLE_ADMIN_DAILY_DIGEST !== '0') {
    const { runAdminDailyDigest } = await import('./dailyDigests.js');
    registerJob({
      name: JOBS.ADMIN_DAILY_DIGEST,
      cron: '30 6 * * *',
      enabled: true,
      handler: async () => {
        await runAdminDailyDigest();
      },
    });
  }

  // User daily digest (Telegram) — 09:00 MSK so sellers get it when they're
  // at their morning workflow, not when most are still asleep. Sends a
  // business-flavoured per-shop summary (orders, sales, anomaly flags) to
  // each user that has linked their Telegram via /telegram/link-code.
  if (env.ENABLE_USER_DAILY_DIGEST !== '0') {
    const { runUserDailyDigest } = await import('./dailyDigests.js');
    registerJob({
      name: JOBS.USER_DAILY_DIGEST,
      cron: '0 9 * * *',
      enabled: true,
      handler: async () => {
        await runUserDailyDigest();
      },
    });
  }

  // Real-time critical events push (rev 25f, v2.0-α) — polls agent_events
  // for new critical rows every minute and pushes to each linked user
  // via Telegram with action buttons. Per-user throttle: max 1 push / 10
  // minutes (rolled-up "you have 3 new criticals" messages are a rev 25g
  // followup). See criticalEventsPusher.ts.
  if (env.ENABLE_CRITICAL_EVENTS_PUSHER !== '0') {
    const { runCriticalEventsPusher } = await import('./criticalEventsPusher.js');
    registerJob({
      name: JOBS.CRITICAL_EVENTS_PUSHER,
      cron: '* * * * *',
      enabled: true,
      handler: async () => {
        await runCriticalEventsPusher();
      },
    });
  }

  // Bridge agent_events → wb_events for Calendar-of-Events UI. Copies new
  // agent_events rows (oos_warning, stock_forecast, order_drop, margin_drop,
  // feedback_alert) into wb_events with category mapping so the calendar in
  // /events shows them. Idempotent via wb_events_fingerprint_uniq.
  if (env.ENABLE_AGENT_EVENTS_BRIDGE !== '0') {
    const { runAgentEventsBridge } = await import('./agentEventsBridge.js');
    registerJob({
      name: JOBS.AGENT_EVENTS_BRIDGE,
      cron: '*/5 * * * *',
      enabled: true,
      handler: async () => {
        await runAgentEventsBridge();
      },
    });
  }

  // Price events detector — runs hourly (at :07 to dodge collisions with
  // other on-the-hour jobs). Запускает 3 детектора подряд: sales-based,
  // seller-cabinet (price/discount) и СПП. Каждый сравнивает свежие данные
  // с предыдущим срезом и emit'ит события категории 'price'. Fingerprint-
  // дедуп защищает от повторов в один и тот же день — за час пустых тиков
  // не плодим дубликатов. Disabled by ENABLE_PRICE_CHANGE_DETECTOR=0.
  if (env.ENABLE_PRICE_CHANGE_DETECTOR !== '0') {
    const { runPriceChangeDetector } = await import('./priceChangeDetector.js');
    registerJob({
      name: JOBS.PRICE_CHANGE_DETECTOR,
      cron: '7 * * * *',
      enabled: true,
      handler: async () => {
        await runPriceChangeDetector();
      },
    });
  }

  // Rating-drop detector — daily at 10:00 MSK (after feedbackSync run at :15).
  // Compares 30-day avg rating vs 31-90 day baseline per product; emits
  // wb_events.category='review' (warn|critical) when rating drops below 4.0
  // or 0.5+ point drop vs baseline. Disabled via ENABLE_RATING_DROP_DETECTOR=0.
  if (env.ENABLE_RATING_DROP_DETECTOR !== '0') {
    const { runRatingDropDetector } = await import('./ratingDropDetector.js');
    registerJob({
      name: JOBS.RATING_DROP_DETECTOR,
      cron: '0 10 * * *',
      enabled: true,
      handler: async () => {
        await runRatingDropDetector();
      },
    });
  }

  // Supply booking queue processor — every 10 min, tries to confirm FBO
  // preorder slots in `supply_booking_queue` when actual coefficient ≤ threshold.
  // Disabled via ENABLE_BOOKING_QUEUE_PROCESSOR=0.
  if (env.ENABLE_BOOKING_QUEUE_PROCESSOR !== '0') {
    const { runBookingQueueProcessor } = await import('./supplyBookingQueueProcessor.js');
    registerJob({
      name: JOBS.BOOKING_QUEUE_PROCESSOR,
      cron: '5,15,25,35,45,55 * * * *',
      enabled: true,
      handler: async () => {
        await runBookingQueueProcessor();
      },
    });
  }

  // wb_sync_runs sweeper — periodically cleans rows stuck in 'running' for
  // > 10 minutes. Mirrors the startup-time cleanup in initializeJobs() but
  // continuous, not boot-only. Without it, child processes killed mid-sync
  // accumulate orphan 'running' rows forever (observed: 9 over one night).
  registerJob({
    name: JOBS.WB_SYNC_RUNS_SWEEPER,
    cron: '*/5 * * * *',
    enabled: true,
    handler: async () => {
      const { db: dbClient } = await import('../db/client.js');
      const { wbSyncRuns } = await import('../db/schema.js');
      const { and, eq, sql } = await import('drizzle-orm');
      const cleared = await dbClient
        .update(wbSyncRuns)
        .set({
          status: 'failed',
          error: 'orphan: cleaned by periodic sweeper (>10 min running)',
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(wbSyncRuns.status, 'running'),
          // F-017: was '10 minutes'. spawnAndWait timeout is 45 min, finance/orders
          // child can run 15-20 min for first-time backfill (lots of pages). Setting
          // sweeper above 45-min child cap + buffer for cleanup ensures we never
          // mark a still-progressing run as orphan. Genuinely dead runs (parent
          // SIGTERM, OOM, container restart) are still cleaned within 6h; boot-time
          // cleanup also covers the restart case.
          sql`${wbSyncRuns.startedAt} < NOW() - INTERVAL '360 minutes'`,
        ))
        .returning({ runId: wbSyncRuns.runId, stage: wbSyncRuns.stage });
      if (cleared.length > 0) {
        logger.warn({ count: cleared.length, stages: cleared.map((r) => r.stage) }, 'wb-sync-runs-sweeper: cleaned orphans');
      }
    },
  });

  await startScheduler();

  // Missed-cron catchup. pg-boss does NOT replay missed crons by default — if
  // workers were down at the scheduled slot (DB pool exhaustion, deploy, crash)
  // the day's run is silently lost until next slot. We check for each critical
  // daily sync whether ANY wb_sync_runs row exists since its most-recent passed
  // slot today (MSK); if not, the cron never fired → enqueue once.
  //
  // Detection rule is "any row" (not "status=done") because even a failed/
  // retrying row proves pg-boss DID fire the worker — pg-boss retry handles
  // that case on its own. We only enqueue when no row at all exists, which
  // means the worker was simply down for the slot.
  try {
    const { db: dbClient } = await import('../db/client.js');
    const { wbSyncRuns } = await import('../db/schema.js');
    const { and, sql } = await import('drizzle-orm');
    const { getQueue } = await import('./queue.js');

    interface CatchupCfg {
      job: string;
      stagePrefix: string;       // wb_sync_runs.stage LIKE `${stagePrefix}%`
      slotsMskHour: number[];    // ascending; each is the start-of-hour MSK
    }
    const DAILY_CATCHUP: CatchupCfg[] = [
      { job: JOBS.REPORTS_DAILY_SYNC,   stagePrefix: 'reports-daily', slotsMskHour: [6] },
      { job: JOBS.FINANCE_DAILY,        stagePrefix: 'finance-daily', slotsMskHour: [3, 9, 15, 21] },
      { job: JOBS.ORDERS_SALES_SYNC,    stagePrefix: 'orders-sales',  slotsMskHour: [0, 6, 12, 18] },
      { job: JOBS.ADV_DAILY_SYNC,       stagePrefix: 'adv-daily',     slotsMskHour: [1, 7, 13, 19] },
      { job: JOBS.FUNNEL_DAILY_SYNC,    stagePrefix: 'funnel-daily',  slotsMskHour: [2, 8, 14, 20] },
      { job: JOBS.SPP_WEEKLY,           stagePrefix: 'spp-weekly',    slotsMskHour: [4, 16] },
    ];

    const nowMs = Date.now();
    // Build today's 00:00 MSK in UTC milliseconds. Walks current MSK calendar
    // date (UTC + 3h) and re-shifts back. Avoids brittle locale fiddling.
    const mskNow = new Date(nowMs + 3 * 3600 * 1000);
    const slotBaseUtcMs = Date.UTC(
      mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate(),
      0, 0, 0,
    ) - 3 * 3600 * 1000;

    for (const cfg of DAILY_CATCHUP) {
      // A disabled or unregistered job has no consumer on a fresh database.
      if (!jobs.some(job => job.name === cfg.job && job.enabled)) continue;
      const passedSlotsMs = cfg.slotsMskHour
        .map((h) => slotBaseUtcMs + h * 3600 * 1000)
        .filter((ms) => ms <= nowMs);
      if (passedSlotsMs.length === 0) continue; // no slot passed yet today
      const lastSlotMs = Math.max(...passedSlotsMs);
      const slotIso = new Date(lastSlotMs).toISOString();
      const recent = await dbClient
        .select({ runId: wbSyncRuns.runId })
        .from(wbSyncRuns)
        .where(and(
          sql`${wbSyncRuns.stage} LIKE ${cfg.stagePrefix + '%'}`,
          sql`${wbSyncRuns.startedAt} >= ${slotIso}::timestamptz`,
        ))
        .limit(1);
      if (recent.length > 0) continue;
      const boss = await getQueue();
      await boss.send(cfg.job, {}, { retryLimit: 1, expireInSeconds: 3600 });
      logger.warn(
        { job: cfg.job, lastSlotUtc: slotIso },
        'missed-cron catchup: enqueued',
      );
    }
  } catch (err) {
    logger.error({ err }, 'missed-cron catchup failed');
  }
}
