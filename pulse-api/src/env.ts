import dotenv from 'dotenv';
dotenv.config({ override: true });
import { z } from 'zod';

const envSchema = z.object({
  // postgres://... isn't a WHATWG URL, so don't use z.string().url()
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  API_KEY: z.string().min(1),
  
  // Encryption secret for API keys (required for encryption operations)
  // Must be separate from API_KEY for security
  API_KEY_ENCRYPTION_SECRET: z.string().min(32).optional(),
  
  // JWT auth (required in production)
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'), // legacy fallback — use JWT_ACCESS_EXPIRES_IN instead
  JWT_ACCESS_EXPIRES_IN: z.string().optional(), // e.g. "15m"
  JWT_REFRESH_EXPIRES_IN: z.string().optional(), // e.g. "30d"
  NODE_ENV: z.string().default('development'),
  
  // Admin user IDs (comma-separated) - these users can access /admin/* routes
  ADMIN_USER_IDS: z.string().optional(),
  
  // Subscription enforcement (set to '0' ONLY for local dev to bypass paywall)
  SUBSCRIPTION_ENFORCE: z.enum(['0', '1']).default('1'),

  // WB Partner API: сервисный секрет для подписания всех запросов к WB.
  // Получен при регистрации сервиса на business-solutions@rwb.ru. Подмешивается
  // в каждый запрос как `X-Client-Secret: <secret>` рядом с Bearer-токеном
  // продавца. Срок жизни 180 дней, WB генерит overlap-секрет за 30 дней
  // до истечения. Без секрета WB понижает лимиты до базовых.
  WB_PARTNER_SERVICE_SECRET: z.string().optional(),

  // Wildberries feedbacks/questions
  WB_FEEDBACKS_API_KEY: z.string().optional(),
  WB_FEEDBACKS_API_BASE: z.string().optional(),
  WB_QUESTIONS_API_BASE: z.string().optional(),

  // LLM settings (OpenAI-compatible)
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_PROMPT_PRICE_PER_1M_USD: z.coerce.number().optional(),
  LLM_COMPLETION_PRICE_PER_1M_USD: z.coerce.number().optional(),

  // Web search (optional)
  WEB_SEARCH_API_KEY: z.string().optional(),
  WEB_SEARCH_BASE_URL: z.string().optional(),

  // Telegram moderation (optional)
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(), // without @, used to build t.me/<username>?start=<code>

  // FBS assembly-slip sidecar (Docker)
  FBS_SIDECAR_URL: z.string().optional(),   // e.g. http://fbs-sidecar:7001
  FBS_SIDECAR_TOKEN: z.string().optional(), // shared secret, same value on the sidecar side
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_MODERATION_CHAT_ID: z.string().optional(),
  // Separate bot token for admin/operator notifications (cron failures,
  // deploy issues, infrastructure). Falls back to TELEGRAM_BOT_TOKEN if
  // unset — keeps backwards compatibility for single-bot deploys.
  TELEGRAM_ADMIN_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_PAYMENT_PROVIDER_TOKEN: z.string().optional(),

  // OpenAI (optional)
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_TEXT_MODEL: z.string().optional(),
  OPENAI_VISION_MODEL: z.string().optional(),
  OPENAI_IMAGE_MODEL: z.string().optional(),

  // Other AI providers (optional)
  GEMINI_API_KEY: z.string().optional(),
  IDEOGRAM_API_KEY: z.string().optional(),
  FIREFLY_API_KEY: z.string().optional(),
  VOYAGE_API_KEY: z.string().optional(),
  JINA_API_KEY: z.string().optional(),
  RUNWAY_API_KEY: z.string().optional(),
  RUNWAY_API_BASE: z.string().optional(),
  RUNWAY_API_VERSION: z.string().optional(),

  // FBS scheduler (optional)
  FBS_RUNNER_CMD: z.string().optional(),
  FBS_RUNNER_ARGS: z.string().optional(),
  ENABLE_FBS_SCHEDULER: z.string().optional(),
  ENABLE_FBS_STOCKS_SYNC: z.string().optional(),
  ENABLE_TASK_MONITOR_SCAN: z.string().optional(),

  // Multi-Agent v2 foundation (Phase 0). When '0' (default), all new supervisor/
  // verification/runner logic stays dormant — /ai/chat behaves exactly as before.
  ENABLE_MULTI_AGENT: z.enum(['0', '1']).default('0'),

  // When '1', the API process skips pg-boss + Studio BullMQ worker startup.
  // Used in production where a separate pulse-workers service owns those.
  // Default '0' keeps single-process layouts (local dev, simple deploys) working.
  DISABLE_INTERNAL_JOBS: z.enum(['0', '1']).default('0'),

  // When '1', dangerous AI agent actions (action_set_price, action_reply_feedback, ...)
  // route through the durable Action Queue (migration 0117 + agentActionRunner).
  // Default '0' keeps the legacy inline path (immediate WB call inside the tool)
  // so we can flip rollout per-tool and per-env.
  // See: src/agents/tools/actionQueue.ts + src/jobs/agentActionRunner.ts.
  ENABLE_ACTION_QUEUE: z.enum(['0', '1']).default('0'),

  // Subscriptions (optional)
  SUBSCRIPTION_MONTHLY_PRICE: z.coerce.number().optional(),
  SUBSCRIPTION_YEARLY_PRICE: z.coerce.number().optional(),
  SUBSCRIPTION_MONTHLY_DAYS: z.coerce.number().optional(),
  SUBSCRIPTION_YEARLY_DAYS: z.coerce.number().optional(),
  SUBSCRIPTION_CURRENCY: z.string().optional(),

  // Frontend URL (for password reset links etc.)
  FRONTEND_URL: z.string().optional(),

  // Sentry error monitoring
  SENTRY_DSN: z.string().optional(),

  // Email (Resend)
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  // Anthropic (Claude AI)
  ANTHROPIC_API_KEY: z.string().optional(),

  // YooKassa (ЮКасса) payment integration
  YOOKASSA_SHOP_ID: z.string().optional(),
  YOOKASSA_SECRET_KEY: z.string().optional(),
  YOOKASSA_RETURN_URL: z.string().optional(),
  YOOKASSA_WEBHOOK_SECRET: z.string().optional(),

  // optional scheduled jobs
  ENABLE_FINANCE_DAILY_SYNC: z.string().optional(),
  FINANCE_SYNC_WORKSPACE_ID: z.string().optional(),
  FINANCE_SYNC_DAYS_BACK: z.string().optional(),
  FINANCE_SYNC_WINDOW_DAYS: z.string().optional(),
  FINANCE_SYNC_MIN_INTERVAL_HOURS: z.string().optional(),

  ENABLE_WB_CARDS_EMBED_SYNC: z.string().optional(),

  ENABLE_SPP_DAILY_SYNC: z.string().optional(),
  SPP_SYNC_WORKSPACE_ID: z.string().optional(),
  SPP_SYNC_DAYS_BACK: z.string().optional(),
  SPP_SYNC_MIN_INTERVAL_HOURS: z.string().optional(),

  // S3 Storage (Visual Studio)
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  // Dev fallback — base URL для локального хранилища `pulse-api/storage/`
  // обслуживается через `GET /storage/*`. Нужно если API и Web на разных портах.
  LOCAL_STORAGE_URL: z.string().optional(),

  // Redis (BullMQ for AI jobs)
  REDIS_URL: z.string().optional(),

  // Google AI (Gemini for image generation)
  GOOGLE_AI_API_KEY: z.string().optional(),

  // rembg (background removal service)
  REMBG_URL: z.string().optional(),

  // CORS origins (comma-separated, e.g. "https://app.example.com,https://api.example.com")
  CORS_ORIGIN: z.string().optional(),

  YANDEX_DIRECT_CLIENT_ID: z.string().optional(),
  YANDEX_DIRECT_OAUTH_TOKEN: z.string().optional(),
  YANDEX_DIRECT_CLIENT_LOGIN: z.string().optional(),

  // Закрыть регистрацию новых пользователей. /auth/register отдаст 403,
  // фронт покажет waitlist-форму вместо обычной. Включается без релиза.
  REGISTRATION_DISABLED: z.enum(['0', '1']).default('0'),
});

export const env = envSchema.parse(process.env);

// Production hardening — fail-fast on placeholder/default secrets.
// These strings ship in `.env.example` and various Fastify boilerplates;
// running them in prod means anyone can forge tokens or call protected endpoints.
if (env.NODE_ENV === 'production') {
  const placeholders = ['change-me', 'changeme', 'dev-secret', 'dev-jwt-secret', 'replace-me', 'todo'];
  const checkPlaceholder = (name: string, value: string) => {
    const lower = value.toLowerCase();
    if (placeholders.some((p) => lower.includes(p))) {
      throw new Error(`[env] ${name} contains a placeholder value (${value.slice(0, 20)}...). Generate a secure value before running in production.`);
    }
  };
  checkPlaceholder('JWT_SECRET', env.JWT_SECRET);
  checkPlaceholder('API_KEY', env.API_KEY);
  if (env.API_KEY_ENCRYPTION_SECRET) {
    checkPlaceholder('API_KEY_ENCRYPTION_SECRET', env.API_KEY_ENCRYPTION_SECRET);
  }

  // CORS_ORIGIN must be explicit in prod — the hardcoded fallback in server.ts
  // points at legacy domains and lets the API accept requests from anywhere
  // they happen to match. Force the operator to make this decision.
  if (!env.CORS_ORIGIN || env.CORS_ORIGIN.trim() === '') {
    throw new Error('[env] CORS_ORIGIN must be set explicitly in production (comma-separated list of allowed origins).');
  }
}
