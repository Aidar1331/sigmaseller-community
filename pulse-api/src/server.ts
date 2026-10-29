import { assertNoPlatformAiKeys } from './services/sellerAiCredentials.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env } from './env.js';
import { importDefault } from './lib/importModule.js';
import { initSentry, captureError } from './lib/sentry.js';
import { log } from './lib/logger.js';

assertNoPlatformAiKeys();

// Initialize Sentry early
initSentry();

const app = Fastify({
  trustProxy: true,
  logger: {
    level: env.LOG_LEVEL,
    redact: ['password', 'recoveryCode', 'body.password', 'body.recoveryCode', 'req.body.password', 'req.body.recoveryCode', 'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]', 'req.body.apiKey', 'body.apiKey', 'apiKey', 'key', 'encrypted_key'],
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          },
  },
});

if (env.NODE_ENV !== 'production') {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'pulse-api',
        version: '0.0.1',
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });
}

// CORS configuration
const corsOrigins = env.CORS_ORIGIN
  ? env.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
  : ['https://app.example.com', 'https://api.example.com'];

await app.register(cors, {
  origin: env.NODE_ENV === 'production' ? corsOrigins : true,
  credentials: true, // Required for cookies
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-CSRF-Token', 'MCP-Protocol-Version', 'MCP-Session-Id', 'MCP-Method', 'MCP-Name'],
});

// Cookie support (required for JWT auth)
await app.register(cookie);

// Security headers (X-Frame-Options, X-Content-Type-Options, etc.)
//
// CSP for the API: pure JSON/SSE responses, no scripts/images/styles needed.
// `default-src 'none'` blocks anything from loading IF an attacker tricks the
// browser into rendering an API response as HTML (XSS on a JSON endpoint).
// `frame-ancestors 'none'` prevents the API host from being framed.
// The Next.js frontend runs on a separate origin and ships its own CSP.
await app.register(helmet, {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Breaks some API integrations
  // HSTS only meaningful behind TLS — nginx in front sets the canonical header.
  // Helmet's default of 180 days is fine; explicitly set so it's visible.
  strictTransportSecurity: {
    maxAge: 60 * 60 * 24 * 180,
    includeSubDomains: true,
  },
});

// WB Partner API: подмешиваем X-Client-Secret ко всем запросам *.wildberries.ru
// до того как любой код успеет дёрнуть WB. Делается через global fetch override,
// без правок в десятках call-site файлов под integrations/wb/.
{
  const { installWbPartnerSecretInterceptor } = await import('./integrations/wb/wbClient.js');
  installWbPartnerSecretInterceptor();
}

// Register plugins (using importDefault for tsx/compiled fallback with proper error logging)
await app.register(await importDefault('./plugins/errorHandler.js', import.meta.url));
await app.register(await importDefault('./plugins/auth.js', import.meta.url));
// CSRF runs after auth so it can inspect the session cookie, before routes.
await app.register(await importDefault('./plugins/csrf.js', import.meta.url));
await app.register(await importDefault('./plugins/workspace.js', import.meta.url));
await app.register(await importDefault('./plugins/requestContext.js', import.meta.url));
await app.register(await importDefault('./plugins/sellerAiContext.js', import.meta.url));
await app.register(await importDefault('./plugins/subscription.js', import.meta.url));

// Rate limiting — registered AFTER auth so req.user is available for per-user keys.
// trustProxy is set on the Fastify instance so req.ip is the real client IP, not 127.0.0.1.
await app.register(rateLimit, {
  max: (req) => {
    const userId = (req as any).user?.userId;
    return userId ? 1200 : 60;
  },
  timeWindow: '1 minute',
  keyGenerator: (req) => {
    const userId = (req as any).user?.userId;
    return userId ? `u:${userId}` : `ip:${req.ip}`;
  },
  allowList: (req) => {
    if (req.url === '/health') return true;
    if (env.NODE_ENV !== 'production' && (req.ip === '127.0.0.1' || req.ip === '::1')) return true;
    return false;
  },
});

// Health check with DB, AI, and job status
app.get('/health', async (req) => {
  const detailed = (req.query as Record<string, string>)?.detailed === 'true';

  // Basic health
  const health: Record<string, any> = {
    ok: true,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version ?? '0.0.1',
  };

  if (detailed) {
    // Check DB connection
    try {
      const { db } = await import('./db/client.js');
      const { sql } = await import('drizzle-orm');
      await db.execute(sql`SELECT 1`);
      health.db = 'ok';
    } catch (e) {
      health.db = 'error';
      health.ok = false;
    }

    // Memory usage
    const mem = process.memoryUsage();
    health.memory = {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    };

    // AI metrics (token usage today, last successful call)
    try {
      const { db } = await import('./db/client.js');
      const { sql } = await import('drizzle-orm');
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const aiRes = await db.execute(sql`
        SELECT
          COUNT(*) as call_count,
          COALESCE(SUM(prompt_tokens + completion_tokens), 0) as total_tokens,
          MAX(created_at) as last_call_at
        FROM ai_usage_events
        WHERE created_at >= ${todayStart.toISOString()}
      `);
      const aiRow = (aiRes as any).rows?.[0] ?? (aiRes as any)[0] ?? {};
      health.ai = {
        callsToday: Number(aiRow?.call_count ?? 0),
        tokensToday: Number(aiRow?.total_tokens ?? 0),
        lastCallAt: aiRow?.last_call_at ?? null,
      };
    } catch {
      health.ai = { callsToday: 0, tokensToday: 0, lastCallAt: null };
    }

    // pgvector availability
    try {
      const { db } = await import('./db/client.js');
      const { sql } = await import('drizzle-orm');
      const pgvRes = await db.execute(sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
      const rows = (pgvRes as any).rows ?? pgvRes;
      health.pgvector = (Array.isArray(rows) && rows.length > 0) ? 'available' : 'not_installed';
    } catch {
      health.pgvector = 'not_installed';
    }

    // Redis ping — workers (BullMQ + pg-boss) and subscription-cache depend on it.
    // A dead Redis still lets the API serve read traffic, but background work
    // queues silently. Surface it here so deploy/scripts/healthcheck.sh can
    // alert before users notice missed sync runs.
    try {
      const { getRedis } = await import('./lib/redis.js');
      const pong = await Promise.race([
        getRedis().ping(),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error('redis ping timeout')), 1000)),
      ]);
      health.redis = pong === 'PONG' ? 'ok' : 'error';
      if (health.redis !== 'ok') health.ok = false;
    } catch (e) {
      health.redis = 'error';
      health.ok = false;
    }

    // Data freshness — how many days behind are the core WB tables?
    //
    // Per-table SLA thresholds reflect real WB publish behaviour:
    //   - orders/funnel/adv daily aggregates are available same-day
    //     via the fast APIs (statistics, analytics, adv) → 2 day SLA.
    //   - finance *daily aggregate* (wb_finance_daily) lands next day.
    //   - finance *per-nm-id split* (wb_finance_daily_products) is
    //     backed by the weekly realization report, which WB publishes
    //     with a 3-7 day lag; fresher slices simply don't exist yet
    //     (see DECISIONS #25: queryFinance fallback). 7 day SLA.
    //
    // Anything beyond its SLA means a cron is broken or blocked by a
    // stuck wb_sync_runs row. Surfaces the "data syncing slowly"
    // problem as a first-class signal rather than waiting for a user
    // complaint. Also lists stuck `running` sync rows (>2h old) that
    // block dedup guards in maybeStart* helpers.
    const FRESHNESS_SLA_DAYS: Record<string, number> = {
      orders_sales:     2,
      finance_daily:    2,
      finance_products: 7,
      funnel_products:  2,
      adv_products:     2,
    };
    try {
      const { db } = await import('./db/client.js');
      const { sql } = await import('drizzle-orm');
      const freshRes = await db.execute(sql`
        SELECT 'orders_sales' AS src, MAX(date::date)::text AS max_date,
               (CURRENT_DATE - MAX(date::date))::int AS days_stale
        FROM wb_orders_sales_daily_products
        UNION ALL SELECT 'finance_daily', MAX(date::date)::text,
               (CURRENT_DATE - MAX(date::date))::int
        FROM wb_finance_daily
        UNION ALL SELECT 'finance_products', MAX(date::date)::text,
               (CURRENT_DATE - MAX(date::date))::int
        FROM wb_finance_daily_products
        UNION ALL SELECT 'funnel_products', MAX(date::date)::text,
               (CURRENT_DATE - MAX(date::date))::int
        FROM wb_funnel_daily_products
        UNION ALL SELECT 'adv_products', MAX(date::date)::text,
               (CURRENT_DATE - MAX(date::date))::int
        FROM wb_adv_daily_products
      `);
      const freshRows: Array<{ src: string; max_date: string | null; days_stale: number | null }> =
        ((freshRes as any).rows ?? freshRes) as any;
      const freshness: Record<string, {
        maxDate: string | null;
        daysStale: number | null;
        slaDays: number;
        withinSla: boolean;
      }> = {};
      const violations: string[] = [];
      for (const r of freshRows) {
        const days = r.days_stale == null ? null : Number(r.days_stale);
        const sla = FRESHNESS_SLA_DAYS[r.src] ?? 2;
        const withinSla = days == null ? true : days <= sla;
        freshness[r.src] = { maxDate: r.max_date ?? null, daysStale: days, slaDays: sla, withinSla };
        if (!withinSla) violations.push(`${r.src}:${days}d (sla ${sla})`);
      }

      const stuckRes = await db.execute(sql`
        SELECT stage, COUNT(*)::int AS count
        FROM wb_sync_runs
        WHERE status = 'running'
          AND started_at < NOW() - INTERVAL '2 hours'
        GROUP BY stage
        ORDER BY count DESC
      `);
      const stuckRows = ((stuckRes as any).rows ?? stuckRes) as Array<{ stage: string; count: number }>;
      const stuckTotal = stuckRows.reduce((a, r) => a + Number(r.count || 0), 0);

      const stale = violations.length > 0 || stuckTotal > 0;
      health.data = {
        freshness,
        slaViolations: violations,
        stuckSyncRuns: stuckTotal,
        stuckByStage: stuckRows,
        status: stale ? 'stale' : 'fresh',
      };
      if (stale) health.ok = false;
    } catch (err) {
      health.data = { status: 'unknown', error: String((err as Error)?.message ?? err).slice(0, 200) };
    }
  }

  return health;
});

// Register all routes from centralized config
// See routeConfig.ts for the list of routes
let registerAllRoutes: any;
try {
  ({ registerAllRoutes } = await import('./routeConfig.js'));
} catch {
  // @ts-ignore - tsx dev-only import
  ({ registerAllRoutes } = await import('./routeConfig.js'));
}
await registerAllRoutes(app);

// Local static storage — dev fallback для Studio, когда S3 не настроен.
// Serve files from `pulse-api/storage/*` через `GET /storage/*`.
// В prod (S3 настроен) этот маршрут всё равно живёт, но uploadFile() минует
// диск и пишет в S3, URL'ы указывают на S3-bucket.
app.get('/storage/*', async (req, reply) => {
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  const rel = (req.params as { '*': string })['*'];
  if (!rel || rel.includes('..')) return reply.code(400).send({ error: 'bad path' });
  const abs = path.resolve(process.cwd(), 'storage', rel);
  // Защита от path traversal
  if (!abs.startsWith(path.resolve(process.cwd(), 'storage'))) {
    return reply.code(400).send({ error: 'bad path' });
  }
  try {
    const data = await fs.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    const mime =
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.webp' ? 'image/webp' :
      ext === '.gif' ? 'image/gif' :
      ext === '.mp4' ? 'video/mp4' :
      'application/octet-stream';
    reply.header('Content-Type', mime);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(data);
  } catch {
    return reply.code(404).send({ error: 'not found' });
  }
});

// Run database migrations via our custom runner (applies each file in its own
// transaction, skips ignorable "already exists" errors per-file so newer
// migrations still run even if old ones were applied via drizzle-kit push).
try {
  const { runPendingMigrations } = await import('./db/runMigrations.js');
  const { pool } = await import('./db/client.js');
  const result = await runPendingMigrations(pool);
  log.info({ applied: result.applied.length, skipped: result.skipped.length }, 'Database migrations processed');

  // Guard against DECISIONS #89: the pg-boss / drizzle-kit push family
  // can mark a migration applied while some of its DDL silently failed.
  // verifyDbSchema asserts the columns/tables added by recent migrations
  // actually exist; throws in production on drift.
  const { verifyDbSchemaOrWarn } = await import('./lib/verifyDbSchema.js');
  await verifyDbSchemaOrWarn(pool);
} catch (err) {
  log.fatal({ err }, 'Failed to run database migrations — aborting startup');
  process.exit(1);
}

await app.listen({ port: env.PORT, host: env.HOST });

// Graceful shutdown
//
// Three concerns in order of urgency:
//   1. Stop the scheduler so no new jobs/spawns kick off mid-shutdown.
//   2. Terminate any in-flight child processes spawned via spawnAndWait
//      (SIGTERM with a 10s grace, then SIGKILL). Without this, a restart
//      during a manual refresh leaves the children orphaned (PPID=1) and
//      their `wb_sync_runs` rows stuck in 'running' forever — see
//      DECISIONS 2026-05-06.
//   3. Best-effort UPDATE all 'running' rows to 'failed:shutdown' so the UI
//      stops claiming work is in progress. Even rows from non-tracked
//      sources are flagged: at boot time the scheduler's startup-cleanup
//      will hit the same rows with a 5-min threshold, but flagging here
//      narrows the window where the UI can lie.
const shutdown = async (signal: string) => {
  log.info({ signal }, 'Shutting down gracefully');

  try {
    const { stopScheduler } = await import('./jobs/scheduler.js');
    await stopScheduler();
  } catch { /* scheduler may not be initialized */ }

  // Terminate tracked children with a 10s grace before SIGKILL.
  try {
    const { getActiveChildren } = await import('./lib/spawnWithTracking.js');
    const children = getActiveChildren();
    if (children.size > 0) {
      log.info({ count: children.size }, 'Sending SIGTERM to active sync children');
      for (const child of children.keys()) {
        try { child.kill('SIGTERM'); } catch { /* may already be dead */ }
      }
      // Wait up to 10s for graceful exit; cleanup() in spawnWithTracking
      // removes them from the map on exit.
      const deadline = Date.now() + 10_000;
      while (children.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (children.size > 0) {
        log.warn({ remaining: children.size }, 'Children did not exit on SIGTERM, sending SIGKILL');
        for (const child of children.keys()) {
          try { child.kill('SIGKILL'); } catch { /* swallow */ }
        }
      }
    }
  } catch (err) {
    log.error({ err }, 'Failed to terminate active children during shutdown');
  }

  // Flag any remaining 'running' rows. spawnWithTracking.cleanup already
  // wrote 'failed' rows for SIGTERM-ed children, so this UPDATE is mostly
  // a safety net for non-tracked spawn sources.
  try {
    const { db } = await import('./db/client.js');
    const { wbSyncRuns } = await import('./db/schema.js');
    const { eq } = await import('drizzle-orm');
    await db
      .update(wbSyncRuns)
      .set({
        status: 'failed',
        error: `api ${signal}: shutdown while running`,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(wbSyncRuns.status, 'running'));
  } catch (err) {
    log.error({ err }, 'Failed to flag running sync rows during shutdown');
  }

  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Catch unhandled promise rejections and uncaught exceptions
process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'Unhandled promise rejection');
  captureError(reason instanceof Error ? reason : new Error(String(reason)));
});
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception — shutting down');
  captureError(err);
  process.exit(1);
});

// Background jobs (pg-boss cron + Studio BullMQ).
//
// In a single-process deploy the API process owns these. In a split deploy
// (pulse-workers.service) the worker process owns them and the API sets
// DISABLE_INTERNAL_JOBS=1 to avoid double-scheduling. pg-boss does dedupe via
// Postgres advisory locks, but running the workers in API too still wastes
// memory, hammers Redis from two places, and confuses graceful-shutdown.
if (env.DISABLE_INTERNAL_JOBS === '1') {
  log.info('DISABLE_INTERNAL_JOBS=1 — pulse-api will NOT start scheduler/Studio worker; pulse-workers owns them');
} else {
  // Multi-Agent v2: register available domain agents (no-op when flag=0)
  const { registerAgentTaskWorker } = await import('./jobs/agentTaskWorker.js');
  const { registerAgentActionRunner } = await import('./jobs/agentActionRunner.js');
  const { registerAllActionExecutors } = await import('./agents/tools/executors/index.js');
  registerAllActionExecutors();
  await registerAgentTaskWorker();
  await registerAgentActionRunner();

  // Multi-Agent v2: register available domain agents (no-op when flag=0)
  try {
    const { bootstrapDomainAgents } = await import('./agents/supervisor/bootstrap.js');
    bootstrapDomainAgents();
  } catch (err) {
    log.error({ err }, 'Failed to bootstrap multi-agent registry');
  }

  // Initialize pg-boss based job scheduler
  try {
    const { initializeJobs } = await import('./jobs/scheduler.js');
    await initializeJobs();
  } catch (err) {
    // @ts-ignore - tsx dev runtime
    try {
      const { initializeJobs } = await import('./jobs/scheduler.js');
      await initializeJobs();
    } catch (innerErr) {
      log.error({ err: innerErr }, 'Failed to initialize job scheduler');
    }
  }

  // Studio AI worker (BullMQ) — processes image/video generation tasks.
  // Requires Redis (REDIS_URL env or default redis://localhost:6379).
  // Without Redis, studio_tasks rows stay 'pending' forever → generation UI
  // spins infinitely. The worker itself is resilient: if Redis is down, it
  // retries indefinitely; when Redis comes up, it starts consuming.
  try {
    const { startStudioWorker } = await import('./jobs/studioQueue.js');
    startStudioWorker();
    log.info('Studio AI worker started');
  } catch (err) {
    log.error({ err }, 'Failed to start Studio AI worker — generation will not process until fixed');
  }
}
