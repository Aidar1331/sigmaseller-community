import {
  pgTable,
  text,
  bigint,
  bigserial,
  boolean,
  integer,
  smallint,
  real,
  numeric,
  date,
  timestamp,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
  uuid,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// pgvector column type (requires CREATE EXTENSION vector)
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(1024)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    if (typeof value === 'string') {
      return value.replace(/[[\]]/g, '').split(',').map(Number);
    }
    return value as unknown as number[];
  },
});

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

// NOTE: workspaces/users are placeholders.
// If this service is truly standalone, we'll add full auth/tenant tables.
export const workspaces = pgTable('workspaces', {
  workspaceId: bigint('workspace_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  // Override for creative-audit pipeline. NULL = fall through to env
  // AUDIT_VERSION; one of 'v3' | 'v5_council'. See migration 0113.
  auditVersion: text('audit_version'),
});

export const users = pgTable('users', {
  userId: bigint('user_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  isAdmin: boolean('is_admin').notNull().default(false),
  // Email verification (see migration 0108).
  emailVerified: boolean('email_verified').notNull().default(false),
  emailVerifyToken: text('email_verify_token'),           // SHA-256 of the raw token
  emailVerifyExpiresAt: timestamptz('email_verify_expires_at'),
  // Password reset
  resetToken: text('reset_token'),
  resetExpiresAt: timestamptz('reset_expires_at'),
  // Brute-force lockout
  failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
  lockedUntil: timestamptz('locked_until'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const userSessions = pgTable(
  'user_sessions',
  {
    sessionId: text('session_id').primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.userId, { onDelete: 'cascade' }),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('user_sessions_user_idx').on(t.userId),
    expiresIdx: index('user_sessions_expires_idx').on(t.expiresAt),
  })
);

/**
 * Per-user Telegram bindings. Populated when a user sends /start <code>
 * to the bot; `sendTelegramPerUser(userId)` DMs them via `tg_chat_id`.
 */
export const userTelegramLinks = pgTable(
  'user_telegram_links',
  {
    userId: bigint('user_id', { mode: 'number' }).primaryKey().references(() => users.userId, { onDelete: 'cascade' }),
    tgChatId: text('tg_chat_id').notNull(),
    tgUsername: text('tg_username'),
    linkedAt: timestamptz('linked_at').notNull().defaultNow(),
  },
  (t) => ({
    chatIdx: uniqueIndex('user_telegram_links_chat_uniq').on(t.tgChatId),
  })
);

/**
 * Short-lived (10 min) one-time codes the user presents to the bot via
 * /start <code>. The row is consumed (used_at set) atomically when the
 * bot webhook links the chat.
 */
export const userTelegramLinkCodes = pgTable(
  'user_telegram_link_codes',
  {
    code: text('code').primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.userId, { onDelete: 'cascade' }),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('user_telegram_link_codes_user_idx').on(t.userId),
    expiresIdx: index('user_telegram_link_codes_expires_idx').on(t.expiresAt),
  })
);

/**
 * Long-lived refresh tokens (default 30d). The raw token is returned once
 * in the `refresh` httpOnly cookie; only a SHA-256 hash is kept in the DB,
 * so a leaked DB can't be replayed as tokens. One row per session pairs
 * 1:1 with `user_sessions.session_id` for rotation.
 */
export const userRefreshTokens = pgTable(
  'user_refresh_tokens',
  {
    sessionId: text('session_id').primaryKey().references(() => userSessions.sessionId, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.userId, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    // When a refresh is rotated we flip `revoked_at` instead of deleting so
    // an attacker replaying an old token triggers a detectable collision.
    revokedAt: timestamptz('revoked_at'),
    replacedBySessionId: text('replaced_by_session_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('user_refresh_tokens_user_idx').on(t.userId),
    expiresIdx: index('user_refresh_tokens_expires_idx').on(t.expiresAt),
  })
);

// ------------------------------
// Workspace members & invites
// ------------------------------

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.userId, { onDelete: 'cascade' }),
    role: text('role').notNull().default('viewer'), // owner | supervisor | manager | observer | viewer
    invitedBy: bigint('invited_by', { mode: 'number' }).references(() => users.userId),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.userId] }),
    userIdx: index('workspace_members_user_idx').on(t.userId),
    workspaceIdx: index('workspace_members_workspace_idx').on(t.workspaceId),
  })
);

export const workspaceInvites = pgTable(
  'workspace_invites',
  {
    inviteId: bigint('invite_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    role: text('role').notNull().default('viewer'), // owner | supervisor | manager | observer | viewer
    token: text('token').notNull().unique(),
    createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => users.userId),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    usedBy: bigint('used_by', { mode: 'number' }).references(() => users.userId),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    tokenIdx: index('workspace_invites_token_idx').on(t.token),
    workspaceIdx: index('workspace_invites_workspace_idx').on(t.workspaceId),
  })
);

// ------------------------------
// AI settings & usage
// ------------------------------

export const aiProviderSettings = pgTable('ai_provider_settings', {
  provider: text('provider').primaryKey(), // llm | web_search
  providerType: text('provider_type'), // openai | anthropic | google (for multi-provider routing)
  apiKey: text('api_key'),
  baseUrl: text('base_url'),
  model: text('model'),
  promptPricePer1mMicros: bigint('prompt_price_per1m_micros', { mode: 'number' }),
  completionPricePer1mMicros: bigint('completion_price_per1m_micros', { mode: 'number' }),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const aiUsageEvents = pgTable(
  'ai_usage_events',
  {
    usageId: bigint('usage_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    provider: text('provider').notNull(),
    model: text('model'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ai_usage_events_workspace_idx').on(t.workspaceId, t.createdAt),
    providerIdx: index('ai_usage_events_provider_idx').on(t.provider, t.createdAt),
  })
);

// ------------------------------
// AI Token Balance & Transactions
// ------------------------------

export const aiTokenBalance = pgTable(
  'ai_token_balance',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    balanceKopecks: bigint('balance_kopecks', { mode: 'number' }).notNull().default(0),
    maxBudgetKopecks: bigint('max_budget_kopecks', { mode: 'number' }),
    totalSpentKopecks: bigint('total_spent_kopecks', { mode: 'number' }).notNull().default(0),
    totalToppedUpKopecks: bigint('total_topped_up_kopecks', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceUniq: uniqueIndex('ai_token_balance_workspace_uniq').on(t.workspaceId),
  })
);

export const aiTokenTransactions = pgTable(
  'ai_token_transactions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.userId),
    chatMessageId: bigint('chat_message_id', { mode: 'number' }),
    type: text('type').notNull().default('usage'), // 'usage' | 'topup' | 'refund'
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    // bigint to avoid int32 overflow (~21M ₽) on active workspaces; see migration 0103
    costKopecks: bigint('cost_kopecks', { mode: 'number' }).notNull().default(0),
    rawCostKopecks: bigint('raw_cost_kopecks', { mode: 'number' }).notNull().default(0),
    model: text('model'),
    toolsUsed: text('tools_used').array(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('idx_ai_token_tx_workspace').on(t.workspaceId, t.createdAt),
    userIdx: index('idx_ai_token_tx_user').on(t.userId, t.createdAt),
  })
);

// ------------------------------
// Subscriptions / payments
// ------------------------------

export const workspaceSubscriptions = pgTable(
  'workspace_subscriptions',
  {
    subscriptionId: bigint('subscription_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),

    status: text('status').notNull().default('inactive'), // active | inactive | cancelled | past_due
    planCode: text('plan_code'), // monthly | yearly | custom
    provider: text('provider'),

    currentPeriodStart: timestamptz('current_period_start'),
    currentPeriodEnd: timestamptz('current_period_end'),

    autoRenew: boolean('auto_renew').notNull().default(true),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),

    meta: jsonb('meta').notNull().default({}),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceUniq: uniqueIndex('workspace_subscriptions_workspace_uniq').on(t.workspaceId),
    statusIdx: index('workspace_subscriptions_status_idx').on(t.status),
  })
);

export const workspacePayments = pgTable(
  'workspace_payments',
  {
    paymentId: bigint('payment_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),

    provider: text('provider').notNull().default('manual'), // manual | telegram | yookassa | cloudpayments
    providerPaymentId: text('provider_payment_id'),

    amountKopecks: bigint('amount_kopecks', { mode: 'number' }).notNull().default(0),
    currency: text('currency').notNull().default('RUB'),

    subscriptionType: text('subscription_type'), // monthly | yearly | custom
    daysAdded: integer('days_added'),

    status: text('status').notNull().default('completed'), // pending | completed | failed
    paidAt: timestamptz('paid_at'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('workspace_payments_workspace_idx').on(t.workspaceId, t.createdAt),
    providerPaymentUniq: uniqueIndex('workspace_payments_provider_payment_uniq')
      .on(t.provider, t.providerPaymentId)
      .where(sql`${t.providerPaymentId} IS NOT NULL`),
  })
);

export const marketplaceShops = pgTable(
  'marketplace_shops',
  {
    shopId: bigint('shop_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    platform: text('platform').notNull(),
    name: text('name').notNull(),
    apiKey: text('api_key').notNull(),
    // H16: sha256(plaintext apiKey). Populated by app code at INSERT/UPDATE
    // for dedup; migration 0123 backfills existing rows.
    apiKeyHash: text('api_key_hash'),
    /** WB Partner API per-shop token type — basic / test / personal / service /
     *  unknown / invalid. Заполняется через inspectWbToken() при INSERT/UPDATE
     *  api_key. Используется в buildWbHeaders для гейтинга X-Client-Secret:
     *  Personal-шопы запросы получают БЕЗ секрета (WB отказывает 403 иначе).
     *  Миграция 0130 добавила колонку и backfill через job. */
    tokenType: text('token_type').default('unknown'),
    clientId: text('client_id'),
    wbDeliveryType: text('wb_delivery_type').notNull().default('fbs'),
    
    // Налоговые настройки (по методологии Торгстат)
    // taxRegime: usn6 (УСН Доходы 6%), usn15 (УСН Д-Р 15%), osno (ОСНО), patent (Патент)
    taxRegime: text('tax_regime').notNull().default('usn15'),
    // taxRate: ставка налога в % (6, 15, 20 и т.д.) - переопределяет дефолт для режима
    taxRate: smallint('tax_rate'),
    // vatPct: НДС в % (0, 5, 10, 20). 0 = без НДС, >0 = плательщик НДС
    vatPct: smallint('vat_pct').notNull().default(0),
    // vatIncluded: true = входящий НДС учитывается (есть счета-фактуры от поставщиков)
    vatIncluded: boolean('vat_included').notNull().default(false),
    
    extra: jsonb('extra').notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('marketplace_shops_workspace_idx').on(t.workspaceId),
    platformIdx: index('marketplace_shops_platform_idx').on(t.platform),
    workspacePlatformIdx: index('marketplace_shops_workspace_platform_idx').on(t.workspaceId, t.platform),
  })
);

export const pulsePresets = pgTable(
  'pulse_presets',
  {
    presetId: bigint('preset_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),

    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }),
    createdByUserId: bigint('created_by_user_id', { mode: 'number' }).notNull().references(() => users.userId),

    name: text('name').notNull(),
    description: text('description'),

    config: jsonb('config').notNull().default({}),

    isPinned: boolean('is_pinned').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    deletedAt: timestamptz('deleted_at'),
  },
  (t) => ({
    workspaceSortIdx: index('pulse_presets_workspace_sort_idx').on(t.workspaceId, t.sortOrder),
    workspacePinnedIdx: index('pulse_presets_workspace_pinned_idx').on(t.workspaceId, t.isPinned, t.sortOrder),
    createdByIdx: index('pulse_presets_created_by_idx').on(t.createdByUserId),
    // Unique name per workspace for active presets
    workspaceNameUniq: uniqueIndex('pulse_presets_workspace_name_active_uniq')
      .on(t.workspaceId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
  })
);

export const pulseMetricGroups = pgTable('pulse_metric_groups', {
  groupId: text('group_id').primaryKey(),
  title: text('title').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const pulseMetricsCatalog = pgTable(
  'pulse_metrics_catalog',
  {
    metricId: text('metric_id').primaryKey(),
    groupId: text('group_id').notNull().references(() => pulseMetricGroups.groupId),
    title: text('title').notNull(),
    unit: text('unit'),
    sortOrder: integer('sort_order').notNull().default(0),
    isDefaultEnabled: boolean('is_default_enabled').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    groupIdx: index('pulse_metrics_catalog_group_idx').on(t.groupId, t.sortOrder),
  })
);

export const pulsePresetGroupSettings = pgTable(
  'pulse_preset_group_settings',
  {
    presetId: bigint('preset_id', { mode: 'number' })
      .notNull()
      .references(() => pulsePresets.presetId, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => pulseMetricGroups.groupId),
    isEnabled: boolean('is_enabled').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.presetId, t.groupId] }),
    groupIdx: index('pulse_preset_group_settings_group_idx').on(t.groupId),
  })
);

export const pulsePresetMetricSettings = pgTable(
  'pulse_preset_metric_settings',
  {
    presetId: bigint('preset_id', { mode: 'number' })
      .notNull()
      .references(() => pulsePresets.presetId, { onDelete: 'cascade' }),
    metricId: text('metric_id')
      .notNull()
      .references(() => pulseMetricsCatalog.metricId),
    isEnabled: boolean('is_enabled').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.presetId, t.metricId] }),
    metricIdx: index('pulse_preset_metric_settings_metric_idx').on(t.metricId),
  })
);

export const pulsePresetEvents = pgTable(
  'pulse_preset_events',
  {
    eventId: bigint('event_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),

    presetId: bigint('preset_id', { mode: 'number' }).notNull().references(() => pulsePresets.presetId),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    actorUserId: bigint('actor_user_id', { mode: 'number' }).notNull().references(() => users.userId),

    eventType: text('event_type').notNull(),

    before: jsonb('before'),
    after: jsonb('after'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    presetTimeIdx: index('pulse_preset_events_preset_id_idx').on(t.presetId, t.createdAt),
    workspaceTimeIdx: index('pulse_preset_events_workspace_id_idx').on(t.workspaceId, t.createdAt),
  })
);

// ------------------------------
// Plans (plan/fact)
// ------------------------------

export const pulsePlans = pgTable(
  'pulse_plans',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    date: text('date').notNull(), // YYYY-MM-DD
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    metric: text('metric').notNull(), // 'orders_qty' | 'orders_rub' | 'sales_qty' | 'sales_rub'

    // For *_rub metrics store kopecks. For *_qty metrics store units.
    value: bigint('value', { mode: 'number' }).notNull(),

    createdByUserId: bigint('created_by_user_id', { mode: 'number' }).notNull().references(() => users.userId),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.date, t.nmId, t.metric] }),
    workspaceDateIdx: index('pulse_plans_workspace_date_idx').on(t.workspaceId, t.date),
    workspaceNmIdx: index('pulse_plans_workspace_nm_idx').on(t.workspaceId, t.nmId),
  })
);

export const pulseAlertControls = pgTable(
  'pulse_alert_controls',
  {
    controlId: bigint('control_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    tagId: bigint('tag_id', { mode: 'number' }),
    nmId: bigint('nm_id', { mode: 'number' }),

    enableStocks: boolean('enable_stocks').notNull().default(true),
    enableAds: boolean('enable_ads').notNull().default(true),
    enableDrr: boolean('enable_drr').notNull().default(true),
    enableBuyout: boolean('enable_buyout').notNull().default(true),
    enableSalesDrop: boolean('enable_sales_drop').notNull().default(true),

    cooldownDays: integer('cooldown_days').notNull().default(1),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('pulse_alert_controls_workspace_idx').on(t.workspaceId),
  })
);

// ------------------------------
// Wildberries (WB) integration
// ------------------------------

export const wbCards = pgTable(
  'wb_cards',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),

    vendorCode: text('vendor_code'),
    title: text('title'),
    brandName: text('brand_name'),
    subjectId: integer('subject_id'),
    subjectName: text('subject_name'),

    mainPhotoUrl: text('main_photo_url'),
    photos: jsonb('photos').notNull().default([]),
    raw: jsonb('raw').notNull().default({}),

    // RAG-поля (migration 0135, 2026-05-31). embedding строится из title +
    // brand + subject + characteristics (см. services/wbCardsEmbed). HNSW
    // индекс по cosine; GIN по raw->'characteristics' для structured filter.
    embedding: vector('embedding'),
    embeddingText: text('embedding_text'),
    embeddedAt: timestamptz('embedded_at'),

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.nmId] }),
    workspaceIdx: index('wb_cards_workspace_idx').on(t.workspaceId),
  })
);

export const wbFunnelDailyProducts = pgTable(
  'wb_funnel_daily_products',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).notNull(),
    date: text('date').notNull(), // YYYY-MM-DD
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),

    viewCount: integer('view_count').notNull().default(0),
    openCardCount: integer('open_card_count').notNull().default(0),
    addToCartCount: integer('add_to_cart_count').notNull().default(0),
    addToWishlistCount: integer('add_to_wishlist_count').notNull().default(0),
    orderCount: integer('order_count').notNull().default(0),
    orderSum: bigint('order_sum', { mode: 'number' }).notNull().default(0),
    buyoutCount: integer('buyout_count').notNull().default(0),
    buyoutSum: bigint('buyout_sum', { mode: 'number' }).notNull().default(0),
    cancelCount: integer('cancel_count').notNull().default(0),
    cancelSum: bigint('cancel_sum', { mode: 'number' }).notNull().default(0),
    buyoutPercentBp: integer('buyout_percent_bp').notNull().default(0),

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.shopId, t.date, t.nmId] }),
    workspaceDateIdx: index('wb_funnel_daily_products_workspace_date_idx').on(t.workspaceId, t.date),
    workspaceNmIdx: index('wb_funnel_daily_products_workspace_nm_idx').on(t.workspaceId, t.nmId),
  })
);

export const wbFunnelDaily = pgTable(
  'wb_funnel_daily',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).notNull(),
    date: text('date').notNull(), // YYYY-MM-DD
    source: text('source').notNull(), // 'history' | 'products'

    viewCount: integer('view_count').notNull().default(0),
    openCardCount: integer('open_card_count').notNull().default(0),
    addToCartCount: integer('add_to_cart_count').notNull().default(0),
    addToWishlistCount: integer('add_to_wishlist_count').notNull().default(0),
    orderCount: integer('order_count').notNull().default(0),
    orderSum: bigint('order_sum', { mode: 'number' }).notNull().default(0),
    buyoutCount: integer('buyout_count').notNull().default(0),
    buyoutSum: bigint('buyout_sum', { mode: 'number' }).notNull().default(0),
    cancelCount: integer('cancel_count').notNull().default(0),
    cancelSum: bigint('cancel_sum', { mode: 'number' }).notNull().default(0),

    viewToOpenConversionBp: integer('view_to_open_conversion_bp').notNull().default(0), // basis points (x100)
    openToCartConversionBp: integer('open_to_cart_conversion_bp').notNull().default(0),
    cartToOrderConversionBp: integer('cart_to_order_conversion_bp').notNull().default(0),
    buyoutPercentBp: integer('buyout_percent_bp').notNull().default(0),

    productsCount: integer('products_count').notNull().default(0),

    raw: jsonb('raw').notNull().default({}),

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.shopId, t.date, t.source] }),
    workspaceDateIdx: index('wb_funnel_daily_workspace_date_idx').on(t.workspaceId, t.date),
  })
);

export const wbSyncRuns = pgTable(
  'wb_sync_runs',
  {
    runId: text('run_id').primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }),
    stage: text('stage').notNull(),
    status: text('status').notNull().default('running'), // running | done | error
    error: text('error'),
    /** Rows written to target table. NULL = legacy; 0 = "ran successfully
     * but no data" (often silent sub-failure — parent stage finished
     * `done` even when WB returned errors). Use to detect dead sync. */
    rowsWritten: integer('rows_written'),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    finishedAt: timestamptz('finished_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceTimeIdx: index('wb_sync_runs_workspace_time_idx').on(t.workspaceId, t.createdAt),
  })
);

export const wbOrdersSalesDailyProducts = pgTable(
  'wb_orders_sales_daily_products',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).notNull(),
    date: text('date').notNull(), // YYYY-MM-DD
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),

    ordersCount: integer('orders_count').notNull().default(0),
    salesCount: integer('sales_count').notNull().default(0),
    salesRub: bigint('sales_rub', { mode: 'number' }).notNull().default(0), // store as kopecks (RUB*100)
    forPayRub: bigint('for_pay_rub', { mode: 'number' }).notNull().default(0), // store as kopecks (RUB*100)
    ordersRub: bigint('orders_rub', { mode: 'number' }).notNull().default(0), // sum(priceWithDisc) in kopecks
    discountPercentSumBp: bigint('discount_percent_sum_bp', { mode: 'number' }).notNull().default(0), // sum of discountPercent in basis points
    finishedPriceRub: bigint('finished_price_rub', { mode: 'number' }).notNull().default(0), // sum(finishedPrice) in kopecks

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.shopId, t.date, t.nmId] }),
    workspaceDateIdx: index('wb_orders_sales_daily_products_workspace_date_idx').on(t.workspaceId, t.date),
    workspaceNmIdx: index('wb_orders_sales_daily_products_workspace_nm_idx').on(t.workspaceId, t.nmId),
  })
);

export const wbOrdersSalesDailyWarehouses = pgTable(
  'wb_orders_sales_daily_warehouses',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }),
    date: text('date').notNull(),
    warehouseName: text('warehouse_name').notNull(),

    ordersCount: integer('orders_count').notNull().default(0),
    salesCount: integer('sales_count').notNull().default(0),
    salesRub: bigint('sales_rub', { mode: 'number' }).notNull().default(0),
    forPayRub: bigint('for_pay_rub', { mode: 'number' }).notNull().default(0),
    ordersRub: bigint('orders_rub', { mode: 'number' }).notNull().default(0),

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.date, t.warehouseName] }),
    workspaceDateIdx: index('wb_orders_sales_daily_warehouses_workspace_date_idx').on(t.workspaceId, t.date),
  })
);

// Детализация по товарам и складам
export const wbOrdersSalesDailyProductWarehouses = pgTable(
  'wb_orders_sales_daily_product_warehouses',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }),
    date: text('date').notNull(),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    warehouseName: text('warehouse_name').notNull(),

    ordersCount: integer('orders_count').notNull().default(0),
    salesCount: integer('sales_count').notNull().default(0),
    salesRub: bigint('sales_rub', { mode: 'number' }).notNull().default(0),
    forPayRub: bigint('for_pay_rub', { mode: 'number' }).notNull().default(0),
    ordersRub: bigint('orders_rub', { mode: 'number' }).notNull().default(0),

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.date, t.nmId, t.warehouseName] }),
    workspaceDateIdx: index('wb_orders_sales_daily_product_warehouses_ws_date_idx').on(t.workspaceId, t.date),
    nmIdIdx: index('wb_orders_sales_daily_product_warehouses_nmid_idx').on(t.workspaceId, t.nmId),
  })
);

export const wbOrdersSalesDailyRegions = pgTable(
  'wb_orders_sales_daily_regions',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }),
    date: text('date').notNull(),
    regionName: text('region_name').notNull(),

    ordersCount: integer('orders_count').notNull().default(0),
    salesCount: integer('sales_count').notNull().default(0),
    salesRub: bigint('sales_rub', { mode: 'number' }).notNull().default(0),
    forPayRub: bigint('for_pay_rub', { mode: 'number' }).notNull().default(0),
    ordersRub: bigint('orders_rub', { mode: 'number' }).notNull().default(0),

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.date, t.regionName] }),
    workspaceDateIdx: index('wb_orders_sales_daily_regions_workspace_date_idx').on(t.workspaceId, t.date),
  })
);

// Детализация по товарам и регионам
export const wbOrdersSalesDailyProductRegions = pgTable(
  'wb_orders_sales_daily_product_regions',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }),
    date: text('date').notNull(),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    regionName: text('region_name').notNull(),

    ordersCount: integer('orders_count').notNull().default(0),
    salesCount: integer('sales_count').notNull().default(0),
    salesRub: bigint('sales_rub', { mode: 'number' }).notNull().default(0),
    forPayRub: bigint('for_pay_rub', { mode: 'number' }).notNull().default(0),
    ordersRub: bigint('orders_rub', { mode: 'number' }).notNull().default(0),

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.date, t.nmId, t.regionName] }),
    workspaceDateIdx: index('wb_orders_sales_daily_product_regions_ws_date_idx').on(t.workspaceId, t.date),
    nmIdIdx: index('wb_orders_sales_daily_product_regions_nmid_idx').on(t.workspaceId, t.nmId),
  })
);

export const wbOrdersSalesDaily = pgTable(
  'wb_orders_sales_daily',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).notNull(),
    date: text('date').notNull(), // YYYY-MM-DD
    ordersCount: integer('orders_count').notNull().default(0),
    salesCount: integer('sales_count').notNull().default(0),
    salesRub: bigint('sales_rub', { mode: 'number' }).notNull().default(0), // store as kopecks (RUB*100)
    ordersRub: bigint('orders_rub', { mode: 'number' }).notNull().default(0), // sum(priceWithDisc) in kopecks
    discountPercentSumBp: bigint('discount_percent_sum_bp', { mode: 'number' }).notNull().default(0), // sum of discountPercent in basis points
    finishedPriceRub: bigint('finished_price_rub', { mode: 'number' }).notNull().default(0), // sum(finishedPrice) in kopecks
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.shopId, t.date] }),
    workspaceDateIdx: index('wb_orders_sales_daily_workspace_date_idx').on(t.workspaceId, t.date),
  })
);

export const wbAdvDaily = pgTable(
  'wb_adv_daily',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).notNull(),
    date: text('date').notNull(), // YYYY-MM-DD
    spendKopecks: bigint('spend_kopecks', { mode: 'number' }).notNull().default(0),
    viewsCount: integer('views_count').notNull().default(0),
    clicksCount: integer('clicks_count').notNull().default(0),
    atbsCount: integer('atbs_count').notNull().default(0),
    ordersCount: integer('orders_count').notNull().default(0),
    sumPriceKopecks: bigint('sum_price_kopecks', { mode: 'number' }).notNull().default(0),
    spendManualKopecks: bigint('spend_manual_kopecks', { mode: 'number' }).notNull().default(0),
    viewsManualCount: integer('views_manual_count').notNull().default(0),
    clicksManualCount: integer('clicks_manual_count').notNull().default(0),
    atbsManualCount: integer('atbs_manual_count').notNull().default(0),
    ordersManualCount: integer('orders_manual_count').notNull().default(0),
    sumPriceManualKopecks: bigint('sum_price_manual_kopecks', { mode: 'number' }).notNull().default(0),
    spendUnifiedKopecks: bigint('spend_unified_kopecks', { mode: 'number' }).notNull().default(0),
    viewsUnifiedCount: integer('views_unified_count').notNull().default(0),
    clicksUnifiedCount: integer('clicks_unified_count').notNull().default(0),
    atbsUnifiedCount: integer('atbs_unified_count').notNull().default(0),
    ordersUnifiedCount: integer('orders_unified_count').notNull().default(0),
    sumPriceUnifiedKopecks: bigint('sum_price_unified_kopecks', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.shopId, t.date] }),
    workspaceDateIdx: index('wb_adv_daily_workspace_date_idx').on(t.workspaceId, t.date),
  })
);

export const wbAdvDailyProducts = pgTable(
  'wb_adv_daily_products',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).notNull(),
    date: text('date').notNull(), // YYYY-MM-DD
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),

    spendKopecks: bigint('spend_kopecks', { mode: 'number' }).notNull().default(0),
    viewsCount: integer('views_count').notNull().default(0),
    clicksCount: integer('clicks_count').notNull().default(0),
    atbsCount: integer('atbs_count').notNull().default(0),
    ordersCount: integer('orders_count').notNull().default(0),
    sumPriceKopecks: bigint('sum_price_kopecks', { mode: 'number' }).notNull().default(0),
    spendManualKopecks: bigint('spend_manual_kopecks', { mode: 'number' }).notNull().default(0),
    viewsManualCount: integer('views_manual_count').notNull().default(0),
    clicksManualCount: integer('clicks_manual_count').notNull().default(0),
    atbsManualCount: integer('atbs_manual_count').notNull().default(0),
    ordersManualCount: integer('orders_manual_count').notNull().default(0),
    sumPriceManualKopecks: bigint('sum_price_manual_kopecks', { mode: 'number' }).notNull().default(0),
    spendUnifiedKopecks: bigint('spend_unified_kopecks', { mode: 'number' }).notNull().default(0),
    viewsUnifiedCount: integer('views_unified_count').notNull().default(0),
    clicksUnifiedCount: integer('clicks_unified_count').notNull().default(0),
    atbsUnifiedCount: integer('atbs_unified_count').notNull().default(0),
    ordersUnifiedCount: integer('orders_unified_count').notNull().default(0),
    sumPriceUnifiedKopecks: bigint('sum_price_unified_kopecks', { mode: 'number' }).notNull().default(0),
    advertsCount: integer('adverts_count').notNull().default(0),

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.shopId, t.date, t.nmId] }),
    workspaceDateIdx: index('wb_adv_daily_products_workspace_date_idx').on(t.workspaceId, t.date),
    workspaceNmIdx: index('wb_adv_daily_products_workspace_nm_idx').on(t.workspaceId, t.nmId),
  })
);

// Финансы рекламы (фактические списания из /adv/v1/upd)
// Источник: Баланс (неттинг, в "Прочие удержания") / Счёт (ручное пополнение) / Бонусы / Кэшбэк
export const wbAdvFinance = pgTable(
  'wb_adv_finance',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }),
    
    // Данные из /adv/v1/upd
    updNum: integer('upd_num').notNull(), // Номер УПД
    updTime: timestamptz('upd_time'), // Время списания (может быть null)
    updDate: text('upd_date').notNull(), // YYYY-MM-DD (извлекаем из updTime для группировки)
    updSumKopecks: bigint('upd_sum_kopecks', { mode: 'number' }).notNull(), // Выставленная сумма в копейках
    
    advertId: integer('advert_id').notNull(), // ID кампании
    campName: text('camp_name'), // Название кампании
    advertType: smallint('advert_type').notNull(), // Тип кампании (8 = единая ставка)
    advertStatus: smallint('advert_status').notNull(), // Статус кампании
    
    // КЛЮЧЕВОЕ: источник списания
    paymentType: text('payment_type').notNull(), // Баланс | Бонусы | Счёт | Кэшбэк
    
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceAdvertDateIdx: index('wb_adv_finance_workspace_advert_date_idx').on(t.workspaceId, t.advertId, t.updDate),
    workspaceDateIdx: index('wb_adv_finance_workspace_date_idx').on(t.workspaceId, t.updDate),
    workspacePaymentTypeIdx: index('wb_adv_finance_workspace_payment_type_idx').on(t.workspaceId, t.paymentType),
    eventIdx: uniqueIndex('wb_adv_finance_event_idx').on(t.workspaceId, t.updNum, t.advertId, t.updTime, t.updSumKopecks),
  })
);

// Агрегированные финансы рекламы по дням (для быстрых запросов)
export const wbAdvFinanceDaily = pgTable(
  'wb_adv_finance_daily',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }),
    date: text('date').notNull(), // YYYY-MM-DD
    
    // Суммы по источникам (в копейках)
    balanceKopecks: bigint('balance_kopecks', { mode: 'number' }).notNull().default(0), // Баланс (неттинг)
    accountKopecks: bigint('account_kopecks', { mode: 'number' }).notNull().default(0), // Счёт (ручное пополнение)
    bonusKopecks: bigint('bonus_kopecks', { mode: 'number' }).notNull().default(0), // Бонусы
    cashbackKopecks: bigint('cashback_kopecks', { mode: 'number' }).notNull().default(0), // Кэшбэк
    totalKopecks: bigint('total_kopecks', { mode: 'number' }).notNull().default(0), // Всего
    
    // Количество списаний
    transactionsCount: integer('transactions_count').notNull().default(0),
    advertsCount: integer('adverts_count').notNull().default(0), // Уникальные кампании
    
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.date] }),
    workspaceDateIdx: index('wb_adv_finance_daily_workspace_date_idx').on(t.workspaceId, t.date),
  })
);

export const wbFinanceDaily = pgTable(
  'wb_finance_daily',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).notNull(),
    date: text('date').notNull(), // YYYY-MM-DD — sale_dt (дата продажи)
    rrDate: text('rr_date'), // Дата отчёта ВБ (rr_dt / date_from) — для переключателя "по дате отчёта"

    lines: integer('lines').notNull().default(0),

    retailKopecks: bigint('retail_kopecks', { mode: 'number' }).notNull().default(0),
    sppAmountKopecks: bigint('spp_amount_kopecks', { mode: 'number' }).notNull().default(0), // СПП (скидка постоянного покупателя) в рублях
    payoutKopecks: bigint('payout_kopecks', { mode: 'number' }).notNull().default(0),
    commissionKopecks: bigint('commission_kopecks', { mode: 'number' }).notNull().default(0),
    ppvzVwKopecks: bigint('ppvz_vw_kopecks', { mode: 'number' }).notNull().default(0), // Вознаграждение WB (часть комиссии)
    ppvzRewardKopecks: bigint('ppvz_reward_kopecks', { mode: 'number' }).notNull().default(0), // Вознаграждение (КРИТИЧНО для баланса!)

    logisticsKopecks: bigint('logistics_kopecks', { mode: 'number' }).notNull().default(0),
    returnLogisticsKopecks: bigint('return_logistics_kopecks', { mode: 'number' }).notNull().default(0),
    paidAcceptanceKopecks: bigint('paid_acceptance_kopecks', { mode: 'number' }).notNull().default(0),

    storageKopecks: bigint('storage_kopecks', { mode: 'number' }).notNull().default(0),
    penaltyKopecks: bigint('penalty_kopecks', { mode: 'number' }).notNull().default(0),
    otherHoldKopecks: bigint('other_hold_kopecks', { mode: 'number' }).notNull().default(0),
    promotionKopecks: bigint('promotion_kopecks', { mode: 'number' }).notNull().default(0), // Продвижение (из deduction)
    acquiringKopecks: bigint('acquiring_kopecks', { mode: 'number' }).notNull().default(0),
    additionalPaymentKopecks: bigint('additional_payment_kopecks', { mode: 'number' }).notNull().default(0),

    // New fields from WB API v5
    cashbackAmountKopecks: bigint('cashback_amount_kopecks', { mode: 'number' }).notNull().default(0),
    cashbackDiscountKopecks: bigint('cashback_discount_kopecks', { mode: 'number' }).notNull().default(0),
    cashbackCommissionChangeKopecks: bigint('cashback_commission_change_kopecks', { mode: 'number' }).notNull().default(0),
    sellerPromoDiscountKopecks: bigint('seller_promo_discount_kopecks', { mode: 'number' }).notNull().default(0),
    loyaltyDiscountKopecks: bigint('loyalty_discount_kopecks', { mode: 'number' }).notNull().default(0),
    wbDiscountPercent: integer('wb_discount_percent').notNull().default(0),
    installmentCofinancingKopecks: bigint('installment_cofinancing_kopecks', { mode: 'number' }).notNull().default(0),

    // Дополнительные поля (могут быть != 0 в других магазинах)
    supplierPromoKopecks: bigint('supplier_promo_kopecks', { mode: 'number' }).notNull().default(0),
    productDiscountKopecks: bigint('product_discount_kopecks', { mode: 'number' }).notNull().default(0),
    ppvzSppPrc: integer('ppvz_spp_prc').notNull().default(0), // Средний % СПП (0-100)

    returnsCount: integer('returns_count').notNull().default(0),
    returnsSumKopecks: bigint('returns_sum_kopecks', { mode: 'number' }).notNull().default(0), // Сумма возвратов (retail)

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.shopId, t.date] }),
    workspaceDateIdx: index('wb_finance_daily_workspace_date_idx').on(t.workspaceId, t.date),
    shopIdx: index('wb_finance_daily_shop_idx').on(t.shopId),
  })
);

export const wbFinanceDailyProducts = pgTable(
  'wb_finance_daily_products',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).notNull(),
    date: text('date').notNull(), // YYYY-MM-DD — sale_dt (дата продажи)
    rrDate: text('rr_date'),      // Дата отчёта ВБ (rr_dt / date_from) — для переключателя "по дате отчёта"
    reportId: bigint('report_id', { mode: 'number' }), // FK → wb_finance_reports.report_id (новый API 2026)
    saleQty: integer('sale_qty').notNull().default(0), // Количество проданных штук (Σ quantity по docTypeName='Продажа')
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),

    lines: integer('lines').notNull().default(0),

    revenueKopecks: bigint('revenue_kopecks', { mode: 'number' }).notNull().default(0),
    sppAmountKopecks: bigint('spp_amount_kopecks', { mode: 'number' }).notNull().default(0), // СПП (скидка постоянного покупателя)
    incomeFromSalesKopecks: bigint('income_from_sales_kopecks', { mode: 'number' }).notNull().default(0),
    commissionKopecks: bigint('commission_kopecks', { mode: 'number' }).notNull().default(0),
    ppvzVwKopecks: bigint('ppvz_vw_kopecks', { mode: 'number' }).notNull().default(0), // Вознаграждение WB (часть комиссии)
    ppvzRewardKopecks: bigint('ppvz_reward_kopecks', { mode: 'number' }).notNull().default(0), // Вознаграждение (КРИТИЧНО!)

    logisticsKopecks: bigint('logistics_kopecks', { mode: 'number' }).notNull().default(0),
    returnLogisticsKopecks: bigint('return_logistics_kopecks', { mode: 'number' }).notNull().default(0),
    paidAcceptanceKopecks: bigint('paid_acceptance_kopecks', { mode: 'number' }).notNull().default(0),
    storageKopecks: bigint('storage_kopecks', { mode: 'number' }).notNull().default(0),
    penaltiesKopecks: bigint('penalties_kopecks', { mode: 'number' }).notNull().default(0),
    otherHoldKopecks: bigint('other_hold_kopecks', { mode: 'number' }).notNull().default(0),
    promotionKopecks: bigint('promotion_kopecks', { mode: 'number' }).notNull().default(0), // Продвижение (из deduction)
    acquiringKopecks: bigint('acquiring_kopecks', { mode: 'number' }).notNull().default(0),
    additionalPaymentsKopecks: bigint('additional_payments_kopecks', { mode: 'number' }).notNull().default(0),

    // New fields from WB API v5
    cashbackAmountKopecks: bigint('cashback_amount_kopecks', { mode: 'number' }).notNull().default(0),
    cashbackDiscountKopecks: bigint('cashback_discount_kopecks', { mode: 'number' }).notNull().default(0),
    cashbackCommissionChangeKopecks: bigint('cashback_commission_change_kopecks', { mode: 'number' }).notNull().default(0),
    sellerPromoDiscountKopecks: bigint('seller_promo_discount_kopecks', { mode: 'number' }).notNull().default(0),
    loyaltyDiscountKopecks: bigint('loyalty_discount_kopecks', { mode: 'number' }).notNull().default(0),
    wbDiscountPercent: integer('wb_discount_percent').notNull().default(0),
    installmentCofinancingKopecks: bigint('installment_cofinancing_kopecks', { mode: 'number' }).notNull().default(0),

    // Дополнительные поля (могут быть != 0 в других магазинах)
    supplierPromoKopecks: bigint('supplier_promo_kopecks', { mode: 'number' }).notNull().default(0),
    productDiscountKopecks: bigint('product_discount_kopecks', { mode: 'number' }).notNull().default(0),
    ppvzSppPrc: integer('ppvz_spp_prc').notNull().default(0), // Средний % СПП

    returnsCount: integer('returns_count').notNull().default(0),
    returnsSumKopecks: bigint('returns_sum_kopecks', { mode: 'number' }).notNull().default(0), // Сумма возвратов (retail)

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.shopId, t.date, t.nmId] }),
    workspaceDateIdx: index('wb_finance_daily_products_workspace_date_idx').on(t.workspaceId, t.date),
    workspaceNmIdx: index('wb_finance_daily_products_workspace_nm_idx').on(t.workspaceId, t.nmId),
  })
);

export const wbFinanceWeeklyProducts = pgTable(
  'wb_finance_weekly_products',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }),
    dateFrom: text('date_from').notNull(), // report date_from (YYYY-MM-DD)
    dateTo: text('date_to').notNull(), // report date_to (YYYY-MM-DD)
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),

    lines: integer('lines').notNull().default(0),

    // amounts from reportDetailByPeriod
    revenueKopecks: bigint('revenue_kopecks', { mode: 'number' }).notNull().default(0), // retail_price_withdisc_rub
    incomeFromSalesKopecks: bigint('income_from_sales_kopecks', { mode: 'number' }).notNull().default(0), // ppvz_for_pay

    logisticsKopecks: bigint('logistics_kopecks', { mode: 'number' }).notNull().default(0), // delivery_rub
    paidAcceptanceKopecks: bigint('paid_acceptance_kopecks', { mode: 'number' }).notNull().default(0), // acceptance
    storageKopecks: bigint('storage_kopecks', { mode: 'number' }).notNull().default(0), // storage_fee
    penaltiesKopecks: bigint('penalties_kopecks', { mode: 'number' }).notNull().default(0), // penalty
    otherHoldKopecks: bigint('other_hold_kopecks', { mode: 'number' }).notNull().default(0), // deduction
    additionalPaymentsKopecks: bigint('additional_payments_kopecks', { mode: 'number' }).notNull().default(0), // additional_payment

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.dateFrom, t.dateTo, t.nmId] }),
    reportIdx: index('wb_finance_weekly_products_workspace_report_idx').on(t.workspaceId, t.dateFrom, t.dateTo),
    nmIdx: index('wb_finance_weekly_products_workspace_nm_idx').on(t.workspaceId, t.nmId),
  })
);

export const wbCogs = pgTable(
  'wb_cogs',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),

    // себестоимость 1 шт в копейках
    cogsKopecks: bigint('cogs_kopecks', { mode: 'number' }).notNull().default(0),
    // логистика селлера до склада WB на 1 шт. 0 = fallback 1.2% от revenue в supplyRoi.
    logisticsPerUnitKop: bigint('logistics_per_unit_kop', { mode: 'number' }).notNull().default(0),

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.nmId] }),
    workspaceIdx: index('wb_cogs_workspace_idx').on(t.workspaceId),
  })
);

export const wbFbsShipmentsDailyProducts = pgTable(
  'wb_fbs_shipments_daily_products',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    date: text('date').notNull(),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),

    suppliesCount: integer('supplies_count').notNull().default(0),
    ordersCount: integer('orders_count').notNull().default(0),
    itemsCount: integer('items_count').notNull().default(0),

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.date, t.nmId] }),
    workspaceDateIdx: index('wb_fbs_shipments_daily_products_workspace_date_idx').on(t.workspaceId, t.date),
    workspaceNmIdx: index('wb_fbs_shipments_daily_products_workspace_nm_idx').on(t.workspaceId, t.nmId),
  })
);

export const wbStocksCurrent = pgTable(
  'wb_stocks_current',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).notNull(),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),

    quantity: integer('quantity').notNull().default(0),
    inWayToClient: integer('in_way_to_client').notNull().default(0),
    inWayFromClient: integer('in_way_from_client').notNull().default(0),

    warehouseName: text('warehouse_name'),
    productTitle: text('product_title'), // Added for agent trigger scan
    daysOfStock: integer('days_of_stock'), // Calculated: quantity / avg daily sales

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.shopId, t.nmId] }),
    workspaceIdx: index('wb_stocks_current_workspace_idx').on(t.workspaceId),
  })
);

// WB Finance Reports — новый API finance-api.wildberries.ru.
// Один ряд = один отчёт реализации ВБ (как в xlsx-сводном).
export const wbFinanceReports = pgTable(
  'wb_finance_reports',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }).notNull(),
    reportId: bigint('report_id', { mode: 'number' }).notNull(),
    sellerFinanceName: text('seller_finance_name'),
    dateFrom: text('date_from').notNull(),
    dateTo: text('date_to').notNull(),
    createDate: text('create_date').notNull(),
    currency: text('currency').notNull().default('RUB'),
    reportType: integer('report_type').notNull().default(1),
    retailAmountKopecks: bigint('retail_amount_kopecks', { mode: 'number' }).notNull().default(0),
    forPayKopecks: bigint('for_pay_kopecks', { mode: 'number' }).notNull().default(0),
    deliveryServiceKopecks: bigint('delivery_service_kopecks', { mode: 'number' }).notNull().default(0),
    paidStorageKopecks: bigint('paid_storage_kopecks', { mode: 'number' }).notNull().default(0),
    paidAcceptanceKopecks: bigint('paid_acceptance_kopecks', { mode: 'number' }).notNull().default(0),
    deductionKopecks: bigint('deduction_kopecks', { mode: 'number' }).notNull().default(0),
    penaltyKopecks: bigint('penalty_kopecks', { mode: 'number' }).notNull().default(0),
    additionalPaymentKopecks: bigint('additional_payment_kopecks', { mode: 'number' }).notNull().default(0),
    cashbackAmountKopecks: bigint('cashback_amount_kopecks', { mode: 'number' }).notNull().default(0),
    cashbackDiscountKopecks: bigint('cashback_discount_kopecks', { mode: 'number' }).notNull().default(0),
    cashbackCommissionChangeKopecks: bigint('cashback_commission_change_kopecks', { mode: 'number' }).notNull().default(0),
    paymentScheduleKopecks: bigint('payment_schedule_kopecks', { mode: 'number' }).notNull().default(0),
    bankPaymentKopecks: bigint('bank_payment_kopecks', { mode: 'number' }).notNull().default(0),
    avgSalePercent: numeric('avg_sale_percent'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.shopId, t.reportId] }),
    wsDateIdx: index('wb_finance_reports_ws_date_idx').on(t.workspaceId, t.dateFrom),
    wsShopDateIdx: index('wb_finance_reports_ws_shop_date_idx').on(t.workspaceId, t.shopId, t.dateFrom),
  })
);

// Месячные целевые параметры плана продаж (страница /plan, "Факт / План").
// shop_id = 0 → план на весь workspace.
export const salesMonthlyTargets = pgTable(
  'sales_monthly_targets',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }).notNull().default(0),
    month: text('month').notNull(),
    marketRevenueRub: bigint('market_revenue_rub', { mode: 'number' }),
    targetSharePct: numeric('target_share_pct'),
    planRevenueRub: bigint('plan_revenue_rub', { mode: 'number' }).notNull().default(0),
    planAdSpendRub: bigint('plan_ad_spend_rub', { mode: 'number' }),
    planImpressions: bigint('plan_impressions', { mode: 'number' }),
    planOrdersQty: integer('plan_orders_qty'),
    comment: text('comment'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.shopId, t.month] }),
    workspaceMonthIdx: index('sales_monthly_targets_workspace_month_idx').on(t.workspaceId, t.month),
  })
);

// FBS-остатки (склад продавца) — отдельно от FBO в wb_stocks_current.
// WB Marketplace API: GET /api/v3/stocks/{warehouseId} возвращает остатки
// per SKU (баркод размера); один nm_id может иметь несколько SKU.
export const wbStocksFbsCurrent = pgTable(
  'wb_stocks_fbs_current',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }).notNull(),
    warehouseId: bigint('warehouse_id', { mode: 'number' }).notNull(),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    sku: text('sku').notNull(),
    quantity: integer('quantity').notNull().default(0),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.shopId, t.warehouseId, t.sku] }),
    workspaceNmIdx: index('wb_stocks_fbs_current_workspace_nm_idx').on(t.workspaceId, t.nmId),
    workspaceIdx: index('wb_stocks_fbs_current_workspace_idx').on(t.workspaceId),
  })
);

export const wbStocksDailyProducts = pgTable(
  'wb_stocks_daily_products',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).notNull(),
    date: text('date').notNull(),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),

    quantity: integer('quantity').notNull().default(0),
    inWayToClient: integer('in_way_to_client').notNull().default(0),
    inWayFromClient: integer('in_way_from_client').notNull().default(0),

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.shopId, t.date, t.nmId] }),
    workspaceDateIdx: index('wb_stocks_daily_products_workspace_date_idx').on(t.workspaceId, t.date),
    workspaceNmIdx: index('wb_stocks_daily_products_workspace_nm_idx').on(t.workspaceId, t.nmId),
  })
);


export const wbEvents = pgTable(
  'wb_events',
  {
    eventId: bigint('event_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }),
    nmId: bigint('nm_id', { mode: 'number' }),
    date: text('date').notNull(),
    time: text('time'),

    type: text('type').notNull(), // alert | log | task | reminder | note
    category: text('category'),
    severity: text('severity'),
    status: text('status').notNull().default('open'), // open | ack | resolved | done
    priority: text('priority').default('medium'), // low | medium | high | urgent

    title: text('title').notNull(),
    description: text('description'),
    evidence: jsonb('evidence').notNull().default({}),
    tags: text('tags').array().default([]),

    fingerprint: text('fingerprint'),

    // CRM/Planner fields
    assigneeId: bigint('assignee_id', { mode: 'number' }).references(() => users.userId, { onDelete: 'set null' }),
    parentEventId: bigint('parent_event_id', { mode: 'number' }),
    recurrence: jsonb('recurrence'), // { type: 'daily'|'weekly'|'monthly', interval: 1, endDate: '...' }

    // Reminders
    reminderAt: timestamptz('reminder_at'),
    reminderSent: boolean('reminder_sent').default(false),
    reminderMinutesBefore: integer('reminder_minutes_before'),

    // Source tracking
    source: text('source').default('manual'), // manual | system | bidder | seo | supplies | feedback | agent
    sourceId: text('source_id'),
    linkedCampaignId: bigint('linked_campaign_id', { mode: 'number' }),
    linkedSupplyId: text('linked_supply_id'),

    // AI Agent fields (nullable — backward-compatible with existing events)
    triggerRule: text('trigger_rule'), // e.g. 'stock_zero', 'drr_high', 'margin_negative'
    suggestedAction: text('suggested_action'), // AI recommendation text
    widgetType: text('widget_type'), // widget to render in AI chat
    widgetProps: jsonb('widget_props'), // widget configuration
    agentConversationId: bigint('agent_conversation_id', { mode: 'number' }), // link to AI conversation
    agentActionId: bigint('agent_action_id', { mode: 'number' }), // link to agent action
    dedupeKey: text('dedupe_key'), // alternative dedup key for agent events (separate from fingerprint)

    dueAt: timestamptz('due_at'),
    completedAt: timestamptz('completed_at'),
    resolvedAt: timestamptz('resolved_at'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceDateIdx: index('wb_events_workspace_date_idx').on(t.workspaceId, t.date),
    workspaceNmDateIdx: index('wb_events_workspace_nm_date_idx').on(t.workspaceId, t.nmId, t.date),
    fingerprintUniq: uniqueIndex('wb_events_fingerprint_uniq').on(t.workspaceId, t.fingerprint),
    assigneeIdx: index('wb_events_assignee_idx').on(t.assigneeId, t.status),
    parentIdx: index('wb_events_parent_idx').on(t.parentEventId),
    reminderIdx: index('wb_events_reminder_idx').on(t.reminderAt, t.reminderSent),
  })
);

export const wbEventComments = pgTable(
  'wb_event_comments',
  {
    commentId: bigint('comment_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    eventId: bigint('event_id', { mode: 'number' }).notNull().references(() => wbEvents.eventId, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    eventIdx: index('wb_event_comments_event_idx').on(t.eventId, t.createdAt),
  })
);

export const wbAlertSettings = pgTable(
  'wb_alert_settings',
  {
    settingId: bigint('setting_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    tagId: bigint('tag_id', { mode: 'number' }),
    nmId: bigint('nm_id', { mode: 'number' }),

    maxDrrFactPct: integer('max_drr_fact_pct'),
    maxDrrForecastPct: integer('max_drr_forecast_pct'),
    minDaysOfStock: integer('min_days_of_stock'),
    buyoutDropPpWarn: integer('buyout_drop_pp_warn'),
    buyoutDropPpCrit: integer('buyout_drop_pp_crit'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('wb_alert_settings_workspace_idx').on(t.workspaceId),
  })
);

export const creativeAuditRuns = pgTable(
  'creative_audit_runs',
  {
    auditId: bigint('audit_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('completed'),
    isFree: boolean('is_free').notNull().default(true),
    model: text('model'),
    score: integer('score'),
    summary: text('summary'),
    strengths: jsonb('strengths').notNull().default([]),
    issues: jsonb('issues').notNull().default([]),
    quickFixes: jsonb('quick_fixes').notNull().default([]),
    contentSuggestions: jsonb('content_suggestions').notNull().default([]),
    photoSuggestions: jsonb('photo_suggestions').notNull().default([]),
    seoSuggestions: jsonb('seo_suggestions').notNull().default([]),
    checklist: jsonb('checklist').notNull().default([]),
    inputSnapshot: jsonb('input_snapshot').notNull().default({}),
    raw: jsonb('raw').notNull().default({}),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('creative_audit_runs_workspace_idx').on(t.workspaceId, t.createdAt),
    workspaceNmIdx: index('creative_audit_runs_nm_idx').on(t.workspaceId, t.nmId, t.createdAt),
  })
);

// ── Creative Audit V3 (3-stage pipeline) ──────────────────────────

export const creativeCardSnapshots = pgTable(
  'creative_card_snapshots',
  {
    snapshotId: bigint('snapshot_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    snapshotData: jsonb('snapshot_data').notNull().default({}),
    photoUrls: jsonb('photo_urls').notNull().default([]),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsNmIdx: index('creative_snapshots_ws_nm_idx').on(t.workspaceId, t.nmId, t.createdAt),
  })
);

export const creativeCardAuditRuns = pgTable(
  'creative_card_audit_runs',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    snapshotId: bigint('snapshot_id', { mode: 'number' }).references(() => creativeCardSnapshots.snapshotId),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    modelName: text('model_name').notNull(),
    promptVersion: text('prompt_version').notNull().default('v3.0'),
    auditJson: jsonb('audit_json').notNull().default({}),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: text('cost_usd'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsIdx: index('creative_card_audit_ws_idx').on(t.workspaceId, t.createdAt),
  })
);

export const creativePhotoAuditRuns = pgTable(
  'creative_photo_audit_runs',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    snapshotId: bigint('snapshot_id', { mode: 'number' }).references(() => creativeCardSnapshots.snapshotId),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    modelName: text('model_name').notNull(),
    promptVersion: text('prompt_version').notNull().default('v3.0'),
    photosAnalyzed: integer('photos_analyzed').default(0),
    visionMode: boolean('vision_mode').default(true),
    auditJson: jsonb('audit_json').notNull().default({}),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: text('cost_usd'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsIdx: index('creative_photo_audit_ws_idx').on(t.workspaceId, t.createdAt),
  })
);

export const creativeAuditRunsFinal = pgTable(
  'creative_audit_runs_final',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    cardAuditId: bigint('card_audit_id', { mode: 'number' }).references(() => creativeCardAuditRuns.id),
    photoAuditId: bigint('photo_audit_id', { mode: 'number' }).references(() => creativePhotoAuditRuns.id),
    snapshotId: bigint('snapshot_id', { mode: 'number' }).references(() => creativeCardSnapshots.snapshotId),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    modelName: text('model_name').notNull(),
    promptVersion: text('prompt_version').notNull().default('v3.0'),
    isValidated: boolean('is_validated').default(false),
    finalJson: jsonb('final_json').notNull().default({}),
    overallScore: integer('overall_score'),
    cardScore: integer('card_score'),
    photoScore: integer('photo_score'),
    confidence: integer('confidence'),
    isFree: boolean('is_free').notNull().default(true),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    totalCostUsd: text('total_cost_usd'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsIdx: index('creative_final_ws_idx').on(t.workspaceId, t.createdAt),
    wsNmIdx: index('creative_final_ws_nm_idx').on(t.workspaceId, t.nmId, t.createdAt),
  })
);

/**
 * Async-job record for creative audit.
 *
 * Why this table exists (session 26):
 *   the audit runs 3 LLM stages (~2-5 min total) which does not fit inside
 *   a single synchronous HTTP round-trip — Next.js proxy, browser fetch,
 *   and intermediate CDNs all time out well before the work completes.
 *   The route now inserts a row here, returns the job_id in < 1 s, then
 *   runs the stages in the background, updating `status` / `stage` /
 *   `result_json` as it goes. The client polls `GET
 *   /creative-audit/:ws/jobs/:job_id` every ~3 s and renders progress.
 */
export const creativeAuditJobs = pgTable(
  'creative_audit_jobs',
  {
    jobId: bigint('job_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('running'),
    stage: text('stage'),
    errorMessage: text('error_message'),
    snapshotId: bigint('snapshot_id', { mode: 'number' }),
    finalAuditId: bigint('final_audit_id', { mode: 'number' }),
    resultJson: jsonb('result_json'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    wsCreated: index('creative_audit_jobs_ws_created').on(t.workspaceId, t.startedAt),
    wsNmStatus: index('creative_audit_jobs_nm_status').on(t.workspaceId, t.nmId, t.status),
  })
);

export const abPhotoTests = pgTable(
  'ab_photo_tests',
  {
    testId: bigint('test_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('running'), // running | paused | completed
    periodDays: integer('period_days').notNull().default(7),
    goal: text('goal').notNull().default('orders'), // orders | ctr | revenue
    variantA: jsonb('variant_a').notNull().default({}),
    variantB: jsonb('variant_b').notNull().default({}),
    // Multi-variant (up to 5) — extends A/B-only tests. Backwards compatible:
    // if empty, code falls back to {variantA, variantB}. See migration 0128.
    variants: jsonb('variants').notNull().default([]),
    winnerVariant: text('winner_variant'),

    // Fast rotation settings
    rotationMinutes: integer('rotation_minutes').default(10080), // default 7 days
    minPhotos: integer('min_photos').default(1),
    maxPhotos: integer('max_photos').default(4),
    currentVariant: text('current_variant').default('A'),
    lastRotatedAt: timestamptz('last_rotated_at'),
    autoRotate: boolean('auto_rotate').default(true),
    compareAdsSeparately: boolean('compare_ads_separately').default(true),

    // Человеко-читаемое имя теста (опционально). Дефолтно UI показывает
    // «Тест #<testId>», но пользователь может переименовать.
    name: text('name'),
    // Последняя ошибка sync фото в WB (например HTTP 403 при ротации).
    // Показывается в UI как warning, чтобы продавец знал что токену не хватает
    // scope «Контент-write» и фото реально на WB не подменяется.
    lastSyncError: text('last_sync_error'),
    lastSyncErrorAt: timestamptz('last_sync_error_at'),

    // Snapshot всех URL фото карточки на момент создания теста (migr. 0145).
    // При ротации тестируемый слот заменяется на тестовый URL, остальные слоты
    // сохраняются. Без этого WB media/save заменяет ВЕСЬ массив фото.
    originalPhotos: jsonb('original_photos').notNull().default([]),
    // Индекс слота, который тестируется (по умолчанию 0 = главное фото).
    testPhotoSlot: integer('test_photo_slot').notNull().default(0),

    // Snapshot title/description на момент создания (migr. 0146). Нужен чтобы
    // после теста title/description можно было откатить к оригиналу и UI мог
    // показать «было ↔ варианты ↔ результат» без догадок.
    originalTitle: text('original_title'),
    originalDescription: text('original_description'),

    // Архив (migr. 0147). Архивный тест не появляется в обычном списке UI,
    // но сохраняется со всеми фазами/метриками. Восстанавливается обнулением
    // этого поля.
    archivedAt: timestamptz('archived_at'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ab_photo_tests_workspace_idx').on(t.workspaceId, t.createdAt),
    workspaceNmIdx: index('ab_photo_tests_nm_idx').on(t.workspaceId, t.nmId, t.createdAt),
    rotationIdx: index('ab_photo_tests_rotation_idx').on(t.status, t.autoRotate, t.lastRotatedAt),
  })
);

export const abPhotoPhases = pgTable(
  'ab_photo_phases',
  {
    phaseId: bigint('phase_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    testId: bigint('test_id', { mode: 'number' }).notNull().references(() => abPhotoTests.testId, { onDelete: 'cascade' }),
    variant: text('variant').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    endedAt: timestamptz('ended_at'),
    metricsSummary: jsonb('metrics_summary').default({}),
    photosSynced: boolean('photos_synced').default(false),
  },
  (t) => ({
    testIdx: index('ab_photo_phases_test_idx').on(t.testId, t.startedAt),
  })
);

export const abPhotoMetrics = pgTable(
  'ab_photo_metrics',
  {
    metricId: bigint('metric_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    testId: bigint('test_id', { mode: 'number' }).notNull().references(() => abPhotoTests.testId, { onDelete: 'cascade' }),
    phaseId: bigint('phase_id', { mode: 'number' }).references(() => abPhotoPhases.phaseId, { onDelete: 'set null' }),
    variant: text('variant').notNull(),

    date: text('date').notNull(),
    hour: integer('hour'), // 0-23, null for daily

    // Organic metrics
    views: integer('views').default(0),
    opens: integer('opens').default(0),
    addToCart: integer('add_to_cart').default(0),
    orders: integer('orders').default(0),
    ordersRub: bigint('orders_rub', { mode: 'number' }).default(0),
    buyouts: integer('buyouts').default(0),
    buyoutsRub: bigint('buyouts_rub', { mode: 'number' }).default(0),

    // Ad metrics
    adViews: integer('ad_views').default(0),
    adClicks: integer('ad_clicks').default(0),
    adOrders: integer('ad_orders').default(0),
    adOrdersRub: bigint('ad_orders_rub', { mode: 'number' }).default(0),
    adSpend: integer('ad_spend').default(0),

    // Calculated
    ctrBp: integer('ctr_bp').default(0),
    conversionBp: integer('conversion_bp').default(0),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    testDateUniq: uniqueIndex('ab_photo_metrics_test_date_uniq').on(t.testId, t.variant, t.date, t.hour),
    testIdx: index('ab_photo_metrics_test_idx').on(t.testId, t.date),
    phaseIdx: index('ab_photo_metrics_phase_idx').on(t.phaseId),
  })
);

// ── A/B price tests (migration 0144) ──────────────────────────────────────
// Тот же паттерн что ab_photo: tests + phases, метрики собираются из
// funnel/orders_sales за интервал phase.started_at..ended_at.
export const priceAbTests = pgTable(
  'price_ab_tests',
  {
    testId: bigint('test_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    name: text('name'),
    status: text('status').notNull().default('running'),
    goal: text('goal').notNull().default('orders'), // orders | revenue | margin | ctr
    periodDays: integer('period_days').notNull().default(7),
    // [{ label: 'A', priceKop: 150000 }, { label: 'B', priceKop: 142500 }, ...]
    variants: jsonb('variants').notNull().default([]),
    currentVariant: text('current_variant').default('A'),
    winnerVariant: text('winner_variant'),
    rotationMinutes: integer('rotation_minutes').notNull().default(20),
    autoRotate: boolean('auto_rotate').notNull().default(true),
    originalPriceKop: bigint('original_price_kop', { mode: 'number' }),
    lastRotatedAt: timestamptz('last_rotated_at'),
    lastSyncError: text('last_sync_error'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    wsStatusIdx: index('price_ab_tests_ws_status_idx').on(t.workspaceId, t.status),
    nmIdx: index('price_ab_tests_nm_idx').on(t.nmId),
  })
);

export const priceAbPhases = pgTable(
  'price_ab_phases',
  {
    phaseId: bigint('phase_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    testId: bigint('test_id', { mode: 'number' }).notNull().references(() => priceAbTests.testId, { onDelete: 'cascade' }),
    variant: text('variant').notNull(),
    priceKop: bigint('price_kop', { mode: 'number' }).notNull(),
    startedAt: timestamptz('started_at').notNull(),
    endedAt: timestamptz('ended_at'),
    metricsSummary: jsonb('metrics_summary').notNull().default({}),
    priceSynced: boolean('price_synced').notNull().default(false),
    syncError: text('sync_error'),
  },
  (t) => ({
    testIdx: index('price_ab_phases_test_idx').on(t.testId, t.startedAt),
  })
);

export const abPhotoUploads = pgTable(
  'ab_photo_uploads',
  {
    uploadId: bigint('upload_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    testId: bigint('test_id', { mode: 'number' }).references(() => abPhotoTests.testId, { onDelete: 'cascade' }),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),

    variant: text('variant').notNull(),
    position: integer('position').notNull().default(0),

    originalFilename: text('original_filename'),
    storedPath: text('stored_path').notNull(),
    url: text('url'),

    width: integer('width'),
    height: integer('height'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    mimeType: text('mime_type'),

    isSyncedToWb: boolean('is_synced_to_wb').default(false),
    syncedAt: timestamptz('synced_at'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    testVariantIdx: index('ab_photo_uploads_test_idx').on(t.testId, t.variant, t.position),
    workspaceIdx: index('ab_photo_uploads_workspace_idx').on(t.workspaceId),
  })
);

export const insightSettings = pgTable(
  'insight_settings',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    sensitivity: text('sensitivity').notNull().default('standard'),
    minStockDays: integer('min_stock_days').notNull().default(5),
    targetDrrPct: integer('target_drr_pct').notNull().default(20),
    excludedTagIds: jsonb('excluded_tag_ids').notNull().default([]),
    notifyChannels: jsonb('notify_channels').notNull().default({ ui: true, telegram: false, categories: {} }),
    notifyTime: text('notify_time').notNull().default('08:00'),
    timezone: text('timezone').notNull().default('Europe/Moscow'),
    lastRunAt: timestamptz('last_run_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId] }),
  })
);

export const insights = pgTable(
  'insights',
  {
    insightId: bigint('insight_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }),
    date: text('date').notNull(),
    insightType: text('insight_type').notNull(),
    category: text('category').notNull(),
    severity: text('severity'),
    score: integer('score'),
    title: text('title').notNull(),
    description: text('description'),
    evidence: jsonb('evidence').notNull().default({}),
    fingerprint: text('fingerprint'),
    seenAt: timestamptz('seen_at'),
    dismissedAt: timestamptz('dismissed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceDateIdx: index('insights_workspace_date_idx').on(t.workspaceId, t.date, t.category),
    workspaceNmIdx: index('insights_workspace_nm_idx').on(t.workspaceId, t.nmId, t.date),
    fingerprintUniq: uniqueIndex('insights_fingerprint_uniq').on(t.workspaceId, t.fingerprint),
  })
);

export const wbTags = pgTable(
  'wb_tags',
  {
    tagId: bigint('tag_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }),
    name: text('name').notNull(),
    color: text('color'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('wb_tags_workspace_idx').on(t.workspaceId),
    workspaceNameUniq: uniqueIndex('wb_tags_workspace_name_uniq').on(t.workspaceId, t.name),
  })
);

export const wbTagProducts = pgTable(
  'wb_tag_products',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }),
    tagId: bigint('tag_id', { mode: 'number' }).notNull().references(() => wbTags.tagId, { onDelete: 'cascade' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.tagId, t.nmId] }),
    workspaceNmIdx: index('wb_tag_products_workspace_nm_idx').on(t.workspaceId, t.nmId),
    workspaceTagIdx: index('wb_tag_products_workspace_tag_idx').on(t.workspaceId, t.tagId),
  })
);

export const wbSppWeekly = pgTable(
  'wb_spp_weekly',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    dateFrom: text('date_from').notNull(),
    dateTo: text('date_to').notNull(),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),

    // spp percent in basis points (1% = 100)
    sppPctBp: integer('spp_pct_bp').notNull().default(0),

    // how many rows contributed
    lines: integer('lines').notNull().default(0),

    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.dateFrom, t.dateTo, t.nmId] }),
    reportIdx: index('wb_spp_weekly_workspace_report_idx').on(t.workspaceId, t.dateFrom, t.dateTo),
    nmIdx: index('wb_spp_weekly_workspace_nm_idx').on(t.workspaceId, t.nmId),
  })
);

// ------------------------------
// Feedbacks / Questions
// ------------------------------

export const marketplaceFeedbackItems = pgTable(
  'marketplace_feedback_items',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    marketplace: text('marketplace').notNull(),
    itemType: text('item_type').notNull(),
    itemId: text('item_id').notNull(),

    nmId: bigint('nm_id', { mode: 'number' }),
    vendorCode: text('vendor_code'),
    productTitle: text('product_title'),
    brandName: text('brand_name'),
    userName: text('user_name'),
    photosCount: integer('photos_count').default(0),
    hasVideo: boolean('has_video').default(false),

    rating: integer('rating'),
    text: text('text'),
    pros: text('pros'),
    cons: text('cons'),

    answerText: text('answer_text'),
    answerState: text('answer_state'),
    isAnswered: boolean('is_answered').notNull().default(false),
    status: text('status').notNull().default('new'),

    // AI-generated tags (migration 0114). Filled by feedbackAutoReply when
    // a draft is generated. Allows /feedback dashboard to group by theme.
    category: text('category'), // quality | delivery | packaging | mismatch | service | praise | other
    sentiment: text('sentiment'), // negative | neutral | positive

    createdAt: timestamptz('created_at'),
    updatedAt: timestamptz('updated_at'),
    answeredAt: timestamptz('answered_at'),
    syncedAt: timestamptz('synced_at').notNull().defaultNow(),

    raw: jsonb('raw').notNull().default({}),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.marketplace, t.itemType, t.itemId] }),
    workspaceIdx: index('marketplace_feedback_items_workspace_idx').on(t.workspaceId, t.marketplace, t.itemType),
    nmIdx: index('marketplace_feedback_items_nm_idx').on(t.workspaceId, t.nmId),
    statusIdx: index('marketplace_feedback_items_status_idx').on(t.workspaceId, t.status),
  })
);

export const marketplaceFeedbackAnalysis = pgTable(
  'marketplace_feedback_analysis',
  {
    analysisId: bigint('analysis_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    marketplace: text('marketplace').notNull(),
    itemType: text('item_type').notNull(),
    itemId: text('item_id').notNull(),

    sentiment: text('sentiment'),
    summary: text('summary'),
    keyPoints: jsonb('key_points').notNull().default([]),
    topics: jsonb('topics').notNull().default([]),
    issues: jsonb('issues').notNull().default([]),
    model: text('model'),
    confidence: integer('confidence'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceItemUniq: uniqueIndex('marketplace_feedback_analysis_item_uniq').on(t.workspaceId, t.marketplace, t.itemType, t.itemId),
    workspaceIdx: index('marketplace_feedback_analysis_workspace_idx').on(t.workspaceId, t.marketplace, t.itemType),
  })
);

export const marketplaceReplyDrafts = pgTable(
  'marketplace_reply_drafts',
  {
    draftId: bigint('draft_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    marketplace: text('marketplace').notNull(),
    itemType: text('item_type').notNull(),
    itemId: text('item_id').notNull(),

    source: text('source').notNull().default('ai'),
    content: text('content').notNull(),
    confidence: integer('confidence'),
    status: text('status').notNull().default('draft'),
    decisionReason: text('decision_reason'),
    webSources: jsonb('web_sources').notNull().default([]),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    approvedAt: timestamptz('approved_at'),
    sentAt: timestamptz('sent_at'),
    rejectedAt: timestamptz('rejected_at'),
  },
  (t) => ({
    itemIdx: index('marketplace_reply_drafts_item_idx').on(t.workspaceId, t.marketplace, t.itemType, t.itemId),
    statusIdx: index('marketplace_reply_drafts_status_idx').on(t.workspaceId, t.status, t.createdAt),
  })
);

export const marketplaceReplySettings = pgTable(
  'marketplace_reply_settings',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    marketplace: text('marketplace').notNull(),
    itemType: text('item_type').notNull(),

    autoSend: boolean('auto_send').notNull().default(false),
    minConfidence: integer('min_confidence').notNull().default(70),
    allowWebSearch: boolean('allow_web_search').notNull().default(true),
    requireApproval: boolean('require_approval').notNull().default(true),
    notifyTelegram: boolean('notify_telegram').notNull().default(false),
    tone: text('tone'),
    maxLength: integer('max_length'),

    // AI tuning options
    praiseLevel: text('praise_level').default('moderate'), // minimal | moderate | enthusiastic
    photoBonus: boolean('photo_bonus').default(true), // extra praise for photos
    star5Template: text('star_5_template'), // custom template for 5-star reviews
    complaintStyle: text('complaint_style').default('balanced'), // apologetic | solution_focused | balanced
    signature: text('signature'), // signature to append
    forbiddenWords: jsonb('forbidden_words').default([]), // words to avoid
    autoSendPositive: boolean('auto_send_positive').default(false), // auto-send 4-5 star
    autoSendMinRating: integer('auto_send_min_rating').default(4),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.marketplace, t.itemType] }),
  })
);

// ------------------------------
// Knowledge base
// ------------------------------

export const knowledgeEntries = pgTable(
  'knowledge_entries',
  {
    entryId: bigint('entry_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    scopeType: text('scope_type').notNull(),
    scopeKey: text('scope_key').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    tags: jsonb('tags').notNull().default([]),
    source: text('source').notNull().default('manual'),
    entryType: text('entry_type').default('general'), // faq | complaint_solution | product_feature | brand_voice | general
    category: text('category'), // sizing | care | materials | warranty | shipping | faq (Feedback Pipeline v2)
    nmIds: jsonb('nm_ids').notNull().default([]), // bigint[] - linked products (Feedback Pipeline v2)
    priority: integer('priority').default(0),
    isActive: boolean('is_active').default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    scopeIdx: index('knowledge_entries_scope_idx').on(t.workspaceId, t.scopeType, t.scopeKey),
    titleIdx: index('knowledge_entries_title_idx').on(t.workspaceId, t.title),
    typeIdx: index('knowledge_entries_type_idx').on(t.workspaceId, t.entryType, t.isActive),
    categoryIdx: index('knowledge_entries_category_idx').on(t.workspaceId, t.category),
  })
);

// ------------------------------
// FBS Schedules & Runs
// ------------------------------

export const fbsSchedules = pgTable(
  'fbs_schedules',
  {
    scheduleId: bigint('schedule_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }),
    daysOfWeek: jsonb('days_of_week').notNull().default([1, 2, 3, 4, 5, 6, 7]),
    sendTime: text('send_time').notNull().default('09:00'),
    timezone: text('timezone').notNull().default('Europe/Moscow'),
    telegramChatId: text('telegram_chat_id'),
    telegramEnabled: boolean('telegram_enabled').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    lastRunAt: timestamptz('last_run_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('fbs_schedules_workspace_idx').on(t.workspaceId),
    shopIdx: index('fbs_schedules_shop_idx').on(t.shopId),
  })
);

export const fbsRuns = pgTable(
  'fbs_runs',
  {
    runId: text('run_id').primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    scheduleId: bigint('schedule_id', { mode: 'number' }).references(() => fbsSchedules.scheduleId),
    shopId: bigint('shop_id', { mode: 'number' }),
    telegramChatId: text('telegram_chat_id'),
    status: text('status').notNull().default('queued'),
    errorText: text('error_text'),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('fbs_runs_workspace_idx').on(t.workspaceId, t.createdAt),
    statusIdx: index('fbs_runs_status_idx').on(t.status),
    scheduleIdx: index('fbs_runs_schedule_idx').on(t.scheduleId),
  })
);

export const fbsDocuments = pgTable(
  'fbs_documents',
  {
    docId: bigint('doc_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    runId: text('run_id').notNull().references(() => fbsRuns.runId, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
    fileName: text('file_name'),
    mime: text('mime'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('fbs_documents_run_idx').on(t.runId),
  })
);

// ------------------------------
// Cash Flow (ДДС)
// ------------------------------

export const cashflowSettings = pgTable('cashflow_settings', {
  workspaceId: bigint('workspace_id', { mode: 'number' }).primaryKey().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
  forecastWeeks: integer('forecast_weeks').notNull().default(8),
  includePlanned: boolean('include_planned').notNull().default(true),
  wbPayoutDay: integer('wb_payout_day').notNull().default(4),
  wbPayoutDelayDays: integer('wb_payout_delay_days').notNull().default(7),
  alertThreshold: text('alert_threshold'), // numeric as text for precision
  alertTelegram: boolean('alert_telegram').notNull().default(false),
  telegramChatId: text('telegram_chat_id'),
  // Ставка налога в basis points (10000 = 100%). 600 = 6% УСН доход (default), 1500 = 15%, 0 = без налога.
  taxRateBp: integer('tax_rate_bp').notNull().default(600),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

// Cashflow Categories (customizable)
export const cashflowCategories = pgTable(
  'cashflow_categories',
  {
    categoryId: bigint('category_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    code: text('code').notNull(), // unique identifier within workspace
    name: text('name').notNull(), // display name
    parentCode: text('parent_code'), // for hierarchy
    type: text('type').notNull(), // 'income' | 'expense'
    icon: text('icon'), // emoji or icon name
    color: text('color'), // hex color
    isSystem: boolean('is_system').notNull().default(false), // system categories can't be deleted
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('cashflow_categories_workspace_idx').on(t.workspaceId),
    codeUniq: uniqueIndex('cashflow_categories_code_uniq').on(t.workspaceId, t.code),
  })
);

export const cashflowPlannedItems = pgTable(
  'cashflow_planned_items',
  {
    itemId: bigint('item_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    name: text('name').notNull(),
    category: text('category').notNull(),
    amount: text('amount').notNull(), // numeric as text
    isRecurring: boolean('is_recurring').notNull().default(false),
    recurrenceType: text('recurrence_type'),
    recurrenceDay: integer('recurrence_day'),
    startDate: timestamptz('start_date').notNull(),
    endDate: timestamptz('end_date'),
    plannedDate: timestamptz('planned_date'),
    notes: text('notes'),
    isCompleted: boolean('is_completed').notNull().default(false),
    completedAt: timestamptz('completed_at'),
    actualAmount: text('actual_amount'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('cashflow_planned_workspace_idx').on(t.workspaceId, t.startDate),
    categoryIdx: index('cashflow_planned_category_idx').on(t.workspaceId, t.category),
  })
);

export const cashflowEntries = pgTable(
  'cashflow_entries',
  {
    entryId: bigint('entry_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    date: timestamptz('date').notNull(),
    category: text('category').notNull(),
    description: text('description'),
    amount: text('amount').notNull(),
    source: text('source').notNull().default('manual'),
    sourceId: text('source_id'),
    runningBalance: text('running_balance'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceDateIdx: index('cashflow_entries_workspace_date_idx').on(t.workspaceId, t.date),
    sourceIdx: index('cashflow_entries_source_idx').on(t.workspaceId, t.source, t.sourceId),
  })
);

export const cashflowWbPayouts = pgTable(
  'cashflow_wb_payouts',
  {
    payoutId: bigint('payout_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    reportId: text('report_id').notNull(),
    payoutDate: timestamptz('payout_date').notNull(),
    amount: text('amount').notNull(),
    saleAmount: text('sale_amount'),
    returnAmount: text('return_amount'),
    commissionAmount: text('commission_amount'),
    deliveryAmount: text('delivery_amount'),
    penaltyAmount: text('penalty_amount'),
    storageAmount: text('storage_amount'),
    otherAmount: text('other_amount'),
    isSynced: boolean('is_synced').notNull().default(false),
    syncedToEntryId: bigint('synced_to_entry_id', { mode: 'number' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    reportIdx: uniqueIndex('cashflow_wb_payouts_report_idx').on(t.workspaceId, t.reportId),
    dateIdx: index('cashflow_wb_payouts_date_idx').on(t.workspaceId, t.payoutDate),
  })
);

// ------------------------------
// Advertising Bidder
// ------------------------------

export const bidderRules = pgTable(
  'bidder_rules',
  {
    ruleId: bigint('rule_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    priority: integer('priority').notNull().default(0),
    campaignIds: jsonb('campaign_ids'), // BIGINT[] as jsonb
    targetType: text('target_type').notNull().default('all'),
    ruleType: text('rule_type').notNull(),
    conditions: jsonb('conditions').notNull().default({}),
    actionType: text('action_type').notNull(),
    actionValue: integer('action_value').notNull(),
    minBid: integer('min_bid').notNull().default(50),
    maxBid: integer('max_bid').notNull().default(10000),
    maxChangePerHour: integer('max_change_per_hour').default(500),
    activeHours: jsonb('active_hours'),
    activeDays: jsonb('active_days'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('bidder_rules_workspace_idx').on(t.workspaceId, t.isActive),
  })
);

export const bidderActions = pgTable(
  'bidder_actions',
  {
    actionId: bigint('action_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    ruleId: bigint('rule_id', { mode: 'number' }).references(() => bidderRules.ruleId, { onDelete: 'set null' }),
    campaignId: bigint('campaign_id', { mode: 'number' }).notNull(),
    actionType: text('action_type').notNull(),
    previousValue: integer('previous_value'),
    newValue: integer('new_value'),
    reason: text('reason'),
    context: jsonb('context'),
    status: text('status').notNull().default('pending'),
    errorText: text('error_text'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    appliedAt: timestamptz('applied_at'),
  },
  (t) => ({
    workspaceIdx: index('bidder_actions_workspace_idx').on(t.workspaceId, t.createdAt),
    campaignIdx: index('bidder_actions_campaign_idx').on(t.campaignId, t.createdAt),
    ruleIdx: index('bidder_actions_rule_idx').on(t.ruleId, t.createdAt),
  })
);

export const bidderSettings = pgTable('bidder_settings', {
  workspaceId: bigint('workspace_id', { mode: 'number' }).primaryKey().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
  isEnabled: boolean('is_enabled').notNull().default(false),
  checkIntervalMinutes: integer('check_interval_minutes').notNull().default(60),
  globalMinBid: integer('global_min_bid').notNull().default(50),
  globalMaxBid: integer('global_max_bid').notNull().default(10000),
  globalMaxDailySpend: integer('global_max_daily_spend'),
  killSwitchEnabled: boolean('kill_switch_enabled').notNull().default(false),
  killSwitchReason: text('kill_switch_reason'),
  killSwitchAt: timestamptz('kill_switch_at'),
  notifyTelegram: boolean('notify_telegram').notNull().default(false),
  telegramChatId: text('telegram_chat_id'),
  notifyOnChange: boolean('notify_on_change').notNull().default(true),
  notifyOnError: boolean('notify_on_error').notNull().default(true),
  lastRunAt: timestamptz('last_run_at'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

// Bidder Keywords (whitelist / blacklist / auto-minus)
export const bidderKeywords = pgTable(
  'bidder_keywords',
  {
    keywordId: bigint('keyword_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    campaignId: bigint('campaign_id', { mode: 'number' }), // null = global for workspace
    keyword: text('keyword').notNull(),
    listType: text('list_type').notNull(), // 'whitelist' | 'blacklist' | 'auto_minus'
    source: text('source').notNull().default('manual'), // 'manual' | 'auto'
    reason: text('reason'), // why it was added (for auto)
    stats: jsonb('stats').notNull().default({}), // {impressions, clicks, orders, drr, ctr}
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('bidder_keywords_workspace_idx').on(t.workspaceId, t.listType),
    campaignIdx: index('bidder_keywords_campaign_idx').on(t.campaignId, t.listType),
    keywordUniq: uniqueIndex('bidder_keywords_uniq').on(t.workspaceId, t.campaignId, t.keyword, t.listType),
  })
);

// Bidder Keyword Auto-Rules (when to auto-add to minus)
export const bidderKeywordAutoRules = pgTable(
  'bidder_keyword_auto_rules',
  {
    ruleId: bigint('rule_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    // Conditions for auto-minus
    minImpressions: integer('min_impressions').notNull().default(100), // after X impressions
    minDays: integer('min_days').notNull().default(7), // over Y days
    maxConversions: integer('max_conversions').notNull().default(0), // with 0 conversions
    maxDrrPct: integer('max_drr_pct'), // or DRR > X%
    minCtrPct: integer('min_ctr_pct'), // or CTR < X% (in basis points, 50 = 0.5%)
    // Action
    action: text('action').notNull().default('add_to_minus'), // 'add_to_minus' | 'notify'
    notifyOnly: boolean('notify_only').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('bidder_keyword_auto_rules_workspace_idx').on(t.workspaceId, t.isActive),
  })
);

// Bidder Alerts (budget, DRR, campaign status)
export const bidderAlerts = pgTable(
  'bidder_alerts',
  {
    alertId: bigint('alert_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    campaignId: bigint('campaign_id', { mode: 'number' }),
    alertType: text('alert_type').notNull(), // 'budget_low' | 'budget_critical' | 'daily_limit' | 'drr_high' | 'campaign_stopped'
    severity: text('severity').notNull().default('warning'), // 'info' | 'warning' | 'critical'
    title: text('title').notNull(),
    message: text('message'),
    context: jsonb('context').notNull().default({}), // {budget, spent, drr, etc}
    isRead: boolean('is_read').notNull().default(false),
    notifiedAt: timestamptz('notified_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('bidder_alerts_workspace_idx').on(t.workspaceId, t.createdAt),
    unreadIdx: index('bidder_alerts_unread_idx').on(t.workspaceId, t.isRead),
    campaignIdx: index('bidder_alerts_campaign_idx').on(t.campaignId, t.createdAt),
  })
);

// ------------------------------
// WB Advertising Campaigns
// ------------------------------

export const wbCampaigns = pgTable(
  'wb_campaigns',
  {
    campaignId: bigint('campaign_id', { mode: 'number' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }),
    name: text('name').notNull().default(''),
    status: integer('status').notNull().default(0), // -1=deleted, 4=ready, 7=finished, 8=cancelled, 9=active, 11=paused
    type: integer('type').notNull().default(8), // 8=unified
    paymentType: text('payment_type').notNull().default('cpm'),
    dailyBudget: integer('daily_budget').notNull().default(0),
    currentBid: integer('current_bid'),
    createTime: timestamptz('create_time'),
    changeTime: timestamptz('change_time'),
    startTime: timestamptz('start_time'),
    endTime: timestamptz('end_time'),
    // Today's stats
    todaySpend: integer('today_spend').notNull().default(0),
    todayViews: integer('today_views').notNull().default(0),
    todayClicks: integer('today_clicks').notNull().default(0),
    todayOrders: integer('today_orders').notNull().default(0),
    todayDrr: numeric('today_drr', { precision: 5, scale: 2 }),
    // Metadata
    nmIds: jsonb('nm_ids').default([]),
    keywords: jsonb('keywords').default([]),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('wb_campaigns_workspace_idx').on(t.workspaceId),
    statusIdx: index('wb_campaigns_status_idx').on(t.workspaceId, t.status),
    shopIdx: index('wb_campaigns_shop_idx').on(t.shopId),
  })
);

// ------------------------------
// Audit Log
// ------------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    logId: bigint('log_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).references(() => workspaces.workspaceId, { onDelete: 'set null' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    userId: bigint('user_id', { mode: 'number' }).references(() => users.userId, { onDelete: 'set null' }),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    details: jsonb('details'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('audit_log_workspace_idx').on(t.workspaceId, t.createdAt),
    shopIdx: index('audit_log_shop_idx').on(t.shopId, t.createdAt),
    userIdx: index('audit_log_user_idx').on(t.userId, t.createdAt),
    actionIdx: index('audit_log_action_idx').on(t.action, t.createdAt),
    resourceIdx: index('audit_log_resource_idx').on(t.resourceType, t.resourceId),
  })
);

// ------------------------------
// SEO Position Tracking
// ------------------------------

export const seoKeywords = pgTable(
  'seo_keywords',
  {
    keywordId: bigint('keyword_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }),
    keyword: text('keyword').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    alertThreshold: integer('alert_threshold'), // alert if position drops below this
    lastCheckedAt: timestamptz('last_checked_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceKeywordIdx: uniqueIndex('seo_keywords_workspace_keyword_idx').on(t.workspaceId, t.shopId, t.keyword),
    activeIdx: index('seo_keywords_active_idx').on(t.workspaceId, t.isActive),
  })
);

export const seoKeywordProducts = pgTable(
  'seo_keyword_products',
  {
    keywordId: bigint('keyword_id', { mode: 'number' }).notNull().references(() => seoKeywords.keywordId, { onDelete: 'cascade' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(), // WB product nmId
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.keywordId, t.nmId] }),
    nmIdx: index('seo_keyword_products_nm_idx').on(t.nmId),
  })
);

export const seoPositionSnapshots = pgTable(
  'seo_position_snapshots',
  {
    snapshotId: bigint('snapshot_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    keywordId: bigint('keyword_id', { mode: 'number' }).notNull().references(() => seoKeywords.keywordId, { onDelete: 'cascade' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    addressId: bigint('address_id', { mode: 'number' }), // null = default/no specific address
    position: integer('position'), // null if not found in top 300
    page: integer('page'),
    totalProducts: integer('total_products'), // total products in search
    cpm: integer('cpm'), // if product is promoted, its CPM
    isPromo: boolean('is_promo').notNull().default(false),
    checkedAt: timestamptz('checked_at').notNull().defaultNow(),
  },
  (t) => ({
    keywordDateIdx: index('seo_position_snapshots_keyword_date_idx').on(t.keywordId, t.checkedAt),
    nmDateIdx: index('seo_position_snapshots_nm_date_idx').on(t.nmId, t.checkedAt),
    addressIdx: index('seo_position_snapshots_address_idx').on(t.addressId, t.checkedAt),
  })
);

export const seoAlerts = pgTable(
  'seo_alerts',
  {
    alertId: bigint('alert_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    keywordId: bigint('keyword_id', { mode: 'number' }).notNull().references(() => seoKeywords.keywordId, { onDelete: 'cascade' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    previousPosition: integer('previous_position'),
    currentPosition: integer('current_position'),
    alertType: text('alert_type').notNull(), // 'dropped' | 'recovered' | 'lost'
    isRead: boolean('is_read').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    keywordIdx: index('seo_alerts_keyword_idx').on(t.keywordId),
    unreadIdx: index('seo_alerts_unread_idx').on(t.keywordId, t.isRead),
  })
);

// SEO Addresses for geo-specific monitoring
export const seoAddresses = pgTable(
  'seo_addresses',
  {
    addressId: bigint('address_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    name: text('name').notNull(), // "Москва, Тверская 1"
    dest: text('dest'), // WB dest parameter for this location
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('seo_addresses_workspace_idx').on(t.workspaceId),
    workspaceNameUniq: uniqueIndex('seo_addresses_workspace_name_uniq').on(t.workspaceId, t.name),
  })
);

// SEO Settings per workspace
export const seoSettings = pgTable('seo_settings', {
  workspaceId: bigint('workspace_id', { mode: 'number' }).primaryKey().references(() => workspaces.workspaceId),
  shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
  checkIntervalHours: integer('check_interval_hours').notNull().default(12), // 6, 12, 24
  alertOnDropPositions: integer('alert_on_drop_positions').notNull().default(5), // alert if drops by X positions
  alertOnCompetitorPriceDropPct: integer('alert_on_competitor_price_drop_pct').notNull().default(15), // alert if competitor drops price by X%
  alertOnNewCompetitorTopN: integer('alert_on_new_competitor_top_n').notNull().default(10), // alert if new competitor in top N
  alertOnExitTop: integer('alert_on_exit_top').notNull().default(50), // alert if exits TOP-X
  alertOnEnterTop: integer('alert_on_enter_top').notNull().default(10), // alert (positive) if enters TOP-X
  notifyTelegram: boolean('notify_telegram').notNull().default(true),
  notifyEmail: boolean('notify_email').notNull().default(false),
  lastCheckAt: timestamptz('last_check_at'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

// SEO Competitors monitoring
export const seoCompetitors = pgTable(
  'seo_competitors',
  {
    competitorId: bigint('competitor_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(), // competitor's product nmId
    name: text('name').notNull(), // "ChehloMania"
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('seo_competitors_workspace_idx').on(t.workspaceId),
    workspaceNmUniq: uniqueIndex('seo_competitors_workspace_nm_uniq').on(t.workspaceId, t.nmId),
  })
);

// SEO Competitor Keywords link table
export const seoCompetitorKeywords = pgTable(
  'seo_competitor_keywords',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    competitorId: bigint('competitor_id', { mode: 'number' }).notNull().references(() => seoCompetitors.competitorId, { onDelete: 'cascade' }),
    keywordId: bigint('keyword_id', { mode: 'number' }).notNull().references(() => seoKeywords.keywordId, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.competitorId, t.keywordId] }),
    workspaceIdx: index('seo_competitor_keywords_workspace_idx').on(t.workspaceId),
  })
);

// SEO Competitor Positions history
export const seoCompetitorPositions = pgTable(
  'seo_competitor_positions',
  {
    positionId: bigint('position_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    competitorId: bigint('competitor_id', { mode: 'number' }).notNull().references(() => seoCompetitors.competitorId, { onDelete: 'cascade' }),
    keywordId: bigint('keyword_id', { mode: 'number' }).notNull().references(() => seoKeywords.keywordId, { onDelete: 'cascade' }),
    addressId: bigint('address_id', { mode: 'number' }),
    checkedAt: timestamptz('checked_at').notNull(),
    position: integer('position'),
    page: integer('page'),
    // Price & metrics tracking for alerts
    price: integer('price'), // current price in kopecks
    originalPrice: integer('original_price'), // price before discount
    discount: smallint('discount'), // discount %
    feedbacks: integer('feedbacks'), // reviews count
    rating: real('rating'),
    isPromo: boolean('is_promo').default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    competitorTimeIdx: index('seo_competitor_positions_competitor_time_idx').on(t.competitorId, t.checkedAt),
    workspaceTimeIdx: index('seo_competitor_positions_workspace_time_idx').on(t.workspaceId, t.checkedAt),
  })
);

// SEO Keyword Tags
export const seoKeywordTags = pgTable(
  'seo_keyword_tags',
  {
    tagId: bigint('tag_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    name: text('name').notNull(), // "Высокочастотные", "Брендовые", "Сезонные"
    color: text('color'), // hex color
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('seo_keyword_tags_workspace_idx').on(t.workspaceId),
    workspaceNameUniq: uniqueIndex('seo_keyword_tags_workspace_name_uniq').on(t.workspaceId, t.name),
  })
);

// Link table: keywords <-> tags
export const seoKeywordTagLinks = pgTable(
  'seo_keyword_tag_links',
  {
    keywordId: bigint('keyword_id', { mode: 'number' }).notNull().references(() => seoKeywords.keywordId, { onDelete: 'cascade' }),
    tagId: bigint('tag_id', { mode: 'number' }).notNull().references(() => seoKeywordTags.tagId, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.keywordId, t.tagId] }),
    tagIdx: index('seo_keyword_tag_links_tag_idx').on(t.tagId),
  })
);

// ------------------------------
// Notification Settings
// ------------------------------

export const notificationSettings = pgTable(
  'notification_settings',
  {
    settingId: bigint('setting_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.userId, { onDelete: 'cascade' }),

    telegramChatId: text('telegram_chat_id'),
    telegramEnabled: boolean('telegram_enabled').default(false),

    notifyTasks: boolean('notify_tasks').default(true),
    notifyAlerts: boolean('notify_alerts').default(true),
    notifyReminders: boolean('notify_reminders').default(true),
    notifyFeedback: boolean('notify_feedback').default(false),

    notifyBeforeMinutes: integer('notify_before_minutes').default(30),
    quietHoursStart: text('quiet_hours_start'), // '22:00'
    quietHoursEnd: text('quiet_hours_end'), // '08:00'
    timezone: text('timezone').default('Europe/Moscow'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceUserUniq: uniqueIndex('notification_settings_workspace_user_uniq').on(t.workspaceId, t.userId),
    userIdx: index('notification_settings_user_idx').on(t.userId),
    telegramIdx: index('notification_settings_telegram_idx').on(t.telegramChatId),
  })
);

// =====================
// Supplies 2.0
// =====================

export const supplyPriorityWarehouses = pgTable(
  'supply_priority_warehouses',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    warehouseId: integer('warehouse_id').notNull(),
    warehouseName: text('warehouse_name').notNull(),
    priority: integer('priority'),
    regions: text('regions').array(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceWarehouseUniq: uniqueIndex('supply_priority_warehouses_ws_wh_uniq').on(t.workspaceId, t.warehouseId),
  })
);

export const supplyBoxSettings = pgTable(
  'supply_box_settings',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }),
    itemsPerBox: integer('items_per_box').notNull().default(10),
    // F-13 v2 (0131): per-ws/SKU порог коэф приёмки для алёрта (по умолчанию 1.0
    // = только free-slot'ы). Также можно включить автоброн ниже этого порога.
    alertCoeffThreshold: numeric('alert_coeff_threshold', { precision: 4, scale: 2 }).default('1.0'),
    autoBookEnabled: boolean('auto_book_enabled').default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceNmUniq: uniqueIndex('supply_box_settings_ws_nm_uniq').on(t.workspaceId, t.nmId),
  })
);

export const supplyDrivers = pgTable(
  'supply_drivers',
  {
    driverId: bigint('driver_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    carModel: text('car_model').notNull(),
    carNumber: text('car_number').notNull(),
    isDefault: boolean('is_default').default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('supply_drivers_workspace_idx').on(t.workspaceId),
  })
);

export const supplyDrafts = pgTable(
  'supply_drafts',
  {
    draftId: bigint('draft_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    name: text('name'),
    warehouseId: integer('warehouse_id'),
    warehouseName: text('warehouse_name'),
    plannedDate: text('planned_date'),
    status: text('status').notNull().default('draft'),
    totalItems: integer('total_items').default(0),
    totalQty: integer('total_qty').default(0),
    totalBoxes: integer('total_boxes').default(0),
    sourceRegions: text('source_regions').array(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('supply_drafts_workspace_idx').on(t.workspaceId),
    statusIdx: index('supply_drafts_status_idx').on(t.workspaceId, t.status),
  })
);

export const supplyDraftItems = pgTable(
  'supply_draft_items',
  {
    itemId: bigint('item_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    draftId: bigint('draft_id', { mode: 'number' }).notNull().references(() => supplyDrafts.draftId, { onDelete: 'cascade' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    vendorCode: text('vendor_code'),
    title: text('title'),
    barcode: text('barcode'),
    quantity: integer('quantity').notNull(),
    quantityAdjusted: integer('quantity_adjusted'),
    itemsPerBox: integer('items_per_box'),
    boxesCount: integer('boxes_count'),
    currentStock: integer('current_stock'),
    avgDailySales: text('avg_daily_sales'),
    daysOfStock: text('days_of_stock'),
    regionBreakdown: jsonb('region_breakdown'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    draftIdx: index('supply_draft_items_draft_idx').on(t.draftId),
  })
);

export const supplyBookingQueue = pgTable(
  'supply_booking_queue',
  {
    queueId: bigint('queue_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    // draftId nullable since migration 0115 — AI ставит preorder без UI-draft.
    draftId: bigint('draft_id', { mode: 'number' }).references(() => supplyDrafts.draftId, { onDelete: 'cascade' }),
    // preorderId added 0115 — связь с WB preorder. Cron бронирует слот этого preorder.
    preorderId: bigint('preorder_id', { mode: 'number' }),
    warehouseId: integer('warehouse_id').notNull(),
    desiredDate: text('desired_date').notNull(),
    // Coefficient threshold (default 1.0 ≈ free). Cron бронирует когда factual coeff ≤ this.
    maxCoefficient: numeric('max_coefficient', { precision: 4, scale: 2 }).default('1.0'),
    status: text('status').notNull().default('waiting'),
    attempts: integer('attempts').default(0),
    lastAttemptAt: timestamptz('last_attempt_at'),
    nextAttemptAt: timestamptz('next_attempt_at'),
    bookedAt: timestamptz('booked_at'),
    expiresAt: timestamptz('expires_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index('supply_booking_queue_status_idx').on(t.status, t.nextAttemptAt),
  })
);

export const supplies = pgTable(
  'supplies',
  {
    supplyId: bigint('supply_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    draftId: bigint('draft_id', { mode: 'number' }).references(() => supplyDrafts.draftId),
    wbSupplyId: text('wb_supply_id').unique(),
    warehouseId: integer('warehouse_id'),
    warehouseName: text('warehouse_name'),
    deliveryDate: text('delivery_date'),
    status: text('status').notNull().default('created'),
    itemsCount: integer('items_count'),
    totalQty: integer('total_qty'),
    totalBoxes: integer('total_boxes'),
    acceptanceCoefficient: text('acceptance_coefficient'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    deliveredAt: timestamptz('delivered_at'),
    acceptedAt: timestamptz('accepted_at'),
  },
  (t) => ({
    workspaceIdx: index('supplies_workspace_idx').on(t.workspaceId),
    statusIdx: index('supplies_status_idx').on(t.workspaceId, t.status),
    wbIdIdx: index('supplies_wb_id_idx').on(t.wbSupplyId),
  })
);

export const supplyBoxes = pgTable(
  'supply_boxes',
  {
    boxId: bigint('box_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    supplyId: bigint('supply_id', { mode: 'number' }).notNull().references(() => supplies.supplyId, { onDelete: 'cascade' }),
    wbTrbxId: text('wb_trbx_id'),
    boxNumber: integer('box_number').notNull(),
    items: jsonb('items').notNull(),
    stickerFile: text('sticker_file'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    supplyIdx: index('supply_boxes_supply_idx').on(t.supplyId),
  })
);

export const supplyDocuments = pgTable(
  'supply_documents',
  {
    docId: bigint('doc_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    supplyId: bigint('supply_id', { mode: 'number' }).notNull().references(() => supplies.supplyId, { onDelete: 'cascade' }),
    docType: text('doc_type').notNull(),
    fileName: text('file_name').notNull(),
    fileData: text('file_data').notNull(),
    fileSize: integer('file_size'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    supplyIdx: index('supply_documents_supply_idx').on(t.supplyId),
  })
);

export const supplyPasses = pgTable(
  'supply_passes',
  {
    passId: bigint('pass_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    supplyId: bigint('supply_id', { mode: 'number' }).references(() => supplies.supplyId, { onDelete: 'set null' }),
    wbPassId: integer('wb_pass_id'),
    warehouseId: integer('warehouse_id').notNull(),
    driverFirstName: text('driver_first_name').notNull(),
    driverLastName: text('driver_last_name').notNull(),
    carModel: text('car_model').notNull(),
    carNumber: text('car_number').notNull(),
    validUntil: timestamptz('valid_until'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('supply_passes_workspace_idx').on(t.workspaceId),
    supplyIdx: index('supply_passes_supply_idx').on(t.supplyId),
  })
);

export const supplySlotsCache = pgTable(
  'supply_slots_cache',
  {
    cacheId: bigint('cache_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    warehouseId: integer('warehouse_id').notNull(),
    date: text('date').notNull(),
    coefficient: text('coefficient'),
    available: boolean('available').default(true),
    fetchedAt: timestamptz('fetched_at').notNull().defaultNow(),
  },
  (t) => ({
    lookupUniq: uniqueIndex('supply_slots_cache_lookup_uniq').on(t.workspaceId, t.warehouseId, t.date),
  })
);

export const warehouseRegionMapping = pgTable(
  'warehouse_region_mapping',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    warehouseId: integer('warehouse_id').notNull(),
    warehouseName: text('warehouse_name').notNull(),
    regionName: text('region_name').notNull(),
    priority: integer('priority').default(1),
  },
  (t) => ({
    warehouseRegionUniq: uniqueIndex('warehouse_region_mapping_wh_region_uniq').on(t.warehouseId, t.regionName),
  })
);

// Region to warehouse mapping
export const regionWarehouseMapping = pgTable(
  'region_warehouse_mapping',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    regionName: text('region_name').notNull(),
    warehouseId: integer('warehouse_id').notNull(),
    priority: integer('priority').default(1),
    deliveryDays: integer('delivery_days').default(3),
  },
  (t) => ({
    regionWarehouseUniq: uniqueIndex('region_warehouse_mapping_region_wh_uniq').on(t.regionName, t.warehouseId),
  })
);

// WB warehouses directory (synced from API)
export const wbWarehouses = pgTable('wb_warehouses', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  address: text('address'),
  workTime: text('work_time'),
  region: text('region'),
  isActive: boolean('is_active').default(true),
  isTransitActive: boolean('is_transit_active').default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// ============================================================================
// WB FBW Supplies
// ============================================================================

// WB FBW Supplies
export const wbSupplies = pgTable(
  'wb_supplies',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    wbSupplyId: integer('wb_supply_id'),           // supplyID от WB
    wbPreorderId: integer('wb_preorder_id').notNull(), // preorderID от WB
    statusId: smallint('status_id').notNull().default(1),
    boxTypeId: smallint('box_type_id'),
    warehouseId: integer('warehouse_id'),
    warehouseName: text('warehouse_name'),
    transitWarehouseId: integer('transit_warehouse_id'),
    transitWarehouseName: text('transit_warehouse_name'),
    supplyDate: date('supply_date'),
    factDate: timestamptz('fact_date'),
    acceptanceCost: integer('acceptance_cost'),  // копейки
    paidAcceptanceCoef: real('paid_acceptance_coef'),
    storageCoef: text('storage_coef'),
    deliveryCoef: text('delivery_coef'),
    quantity: integer('quantity').default(0),
    acceptedQuantity: integer('accepted_quantity').default(0),
    readyForSaleQty: integer('ready_for_sale_qty').default(0),
    phone: text('phone'),
    rejectReason: text('reject_reason'),
    isBoxOnPallet: boolean('is_box_on_pallet').default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    syncedAt: timestamptz('synced_at'),
  },
  (t) => ({
    workspaceIdx: index('wb_supplies_workspace_idx').on(t.workspaceId),
    statusIdx: index('wb_supplies_status_idx').on(t.statusId),
    wbSupplyIdx: index('wb_supplies_wb_supply_idx').on(t.wbSupplyId),
    wbPreorderIdx: index('wb_supplies_wb_preorder_idx').on(t.wbPreorderId),
    supplyDateIdx: index('wb_supplies_supply_date_idx').on(t.supplyDate),
    // Legacy uniqueIndex on (workspace_id, wb_supply_id, wb_preorder_id) was
    // dropped in migration 0120 — it masked the C2 upsert fix (see 0116/0120).
    // The current isolation key is (workspace_id, shop_id, wb_preorder_id),
    // defined as workspaceShopPreorderUniq below / migration 0116.
  })
);

// WB Supply Items (goods in supply)
export const wbSupplyItems = pgTable(
  'wb_supply_items',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    supplyId: bigint('supply_id', { mode: 'number' }).notNull().references(() => wbSupplies.id, { onDelete: 'cascade' }),
    barcode: text('barcode').notNull(),
    vendorCode: text('vendor_code'),
    nmId: bigint('nm_id', { mode: 'number' }),
    quantity: integer('quantity').notNull(),
    acceptedQuantity: integer('accepted_quantity').default(0),
    readyForSaleQty: integer('ready_for_sale_qty').default(0),
    needKiz: boolean('need_kiz').default(false),
    tnved: text('tnved'),
    techSize: text('tech_size'),
    color: text('color'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    supplyIdx: index('wb_supply_items_supply_idx').on(t.supplyId),
    barcodeIdx: index('wb_supply_items_barcode_idx').on(t.barcode),
    nmIdIdx: index('wb_supply_items_nm_id_idx').on(t.nmId),
  })
);

// WB Supply Boxes (packages/pallets)
export const wbSupplyBoxes = pgTable(
  'wb_supply_boxes',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    supplyId: bigint('supply_id', { mode: 'number' }).notNull().references(() => wbSupplies.id, { onDelete: 'cascade' }),
    packageCode: text('package_code').notNull(),  // WB_XXXXXXXXXX
    quantity: integer('quantity').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    supplyIdx: index('wb_supply_boxes_supply_idx').on(t.supplyId),
    packageCodeIdx: index('wb_supply_boxes_package_code_idx').on(t.packageCode),
  })
);

// WB Supply Box Items (contents of boxes)
export const wbSupplyBoxItems = pgTable(
  'wb_supply_box_items',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    boxId: bigint('box_id', { mode: 'number' }).notNull().references(() => wbSupplyBoxes.id, { onDelete: 'cascade' }),
    barcode: text('barcode').notNull(),
    quantity: integer('quantity').notNull(),
  },
  (t) => ({
    boxIdx: index('wb_supply_box_items_box_idx').on(t.boxId),
  })
);

// WB Transit Tariffs (cached)
export const wbTransitTariffs = pgTable(
  'wb_transit_tariffs',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    transitWarehouseName: text('transit_warehouse_name').notNull(),
    destinationWarehouseName: text('destination_warehouse_name').notNull(),
    activeFrom: timestamptz('active_from'),
    boxTariff: jsonb('box_tariff'),  // WbVolumeTariff[]
    palletTariff: integer('pallet_tariff'),  // ₽
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    routeUniq: uniqueIndex('wb_transit_tariffs_route_uniq').on(t.transitWarehouseName, t.destinationWarehouseName),
  })
);

// (SEO tables defined above in "SEO Position Tracking" section)

// ============================================================================
// WB API 2.0 Analytics Tables (Phase 0.6)
// ============================================================================

// Search Queries from WB API (official data, not scraped)
export const wbSearchQueries = pgTable(
  'wb_search_queries',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    date: timestamptz('date').notNull(),
    query: text('query').notNull(),
    position: integer('position'),
    views: integer('views').default(0),
    clicks: integer('clicks').default(0),
    orders: integer('orders').default(0),
    ctr: real('ctr').default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsNmDateIdx: index('wb_search_queries_ws_nm_date_idx').on(t.workspaceId, t.nmId, t.date),
    wsDateIdx: index('wb_search_queries_ws_date_idx').on(t.workspaceId, t.date),
  })
);

// Prices History (daily snapshots)
export const wbPricesHistory = pgTable(
  'wb_prices_history',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    date: timestamptz('date').notNull(),
    price: integer('price'),           // в копейках
    discount: integer('discount'),     // %
    spp: integer('spp'),               // %
    clubDiscount: integer('club_discount'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsNmDateIdx: index('wb_prices_history_ws_nm_date_idx').on(t.workspaceId, t.nmId, t.date),
    wsNmDateUniq: uniqueIndex('wb_prices_history_ws_nm_date_uniq').on(t.workspaceId, t.nmId, t.date),
  })
);

// Hidden Products (from WB reports)
export const wbHiddenProducts = pgTable(
  'wb_hidden_products',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    reason: text('reason'),
    hiddenAt: timestamptz('hidden_at'),
    detectedAt: timestamptz('detected_at').notNull().defaultNow(),
    isResolved: boolean('is_resolved').default(false),
    resolvedAt: timestamptz('resolved_at'),
  },
  (t) => ({
    wsIdx: index('wb_hidden_products_ws_idx').on(t.workspaceId),
    wsNmUniq: uniqueIndex('wb_hidden_products_ws_nm_uniq').on(t.workspaceId, t.nmId),
  })
);

// Deductions / Penalties (штрафы)
export const wbDeductionsDaily = pgTable(
  'wb_deductions_daily',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }),
    nmId: bigint('nm_id', { mode: 'number' }),
    date: timestamptz('date').notNull(),
    type: text('type').notNull(),       // 'penalty' | 'compensation' | 'fine' | 'storage' | 'logistics'
    amount: integer('amount').notNull(), // в копейках
    reason: text('reason'),
    documentNumber: text('document_number'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsDateIdx: index('wb_deductions_daily_ws_date_idx').on(t.workspaceId, t.date),
    wsTypeIdx: index('wb_deductions_daily_ws_type_idx').on(t.workspaceId, t.type),
  })
);

// Stocks History (daily snapshots by warehouse)
export const wbStocksDaily = pgTable(
  'wb_stocks_daily',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    date: timestamptz('date').notNull(),
    warehouseId: integer('warehouse_id'),
    warehouseName: text('warehouse_name'),
    qty: integer('qty').default(0),
    inWayToClient: integer('in_way_to_client').default(0),
    inWayFromClient: integer('in_way_from_client').default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsNmDateIdx: index('wb_stocks_daily_ws_nm_date_idx').on(t.workspaceId, t.nmId, t.date),
    wsDateIdx: index('wb_stocks_daily_ws_date_idx').on(t.workspaceId, t.date),
  })
);

// Storage Costs (daily by warehouse)
export const wbStorageDaily = pgTable(
  'wb_storage_daily',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    date: timestamptz('date').notNull(),
    warehouseId: integer('warehouse_id'),
    warehouseName: text('warehouse_name'),
    volume: real('volume'),             // м³
    cost: integer('cost'),              // в копейках
    days: integer('days'),              // дней хранения
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsNmDateIdx: index('wb_storage_daily_ws_nm_date_idx').on(t.workspaceId, t.nmId, t.date),
  })
);

// Returns (customer returns)
export const wbReturns = pgTable(
  'wb_returns',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    returnId: bigint('return_id', { mode: 'number' }).notNull(),
    orderId: bigint('order_id', { mode: 'number' }),
    nmId: bigint('nm_id', { mode: 'number' }),
    status: text('status'),             // 'pending' | 'approved' | 'rejected'
    reason: text('reason'),
    customerComment: text('customer_comment'),
    photos: jsonb('photos'),            // string[] - photo URLs
    approvedAt: timestamptz('approved_at'),
    rejectedAt: timestamptz('rejected_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    wsIdx: index('wb_returns_ws_idx').on(t.workspaceId),
    returnIdx: uniqueIndex('wb_returns_return_idx').on(t.workspaceId, t.returnId),
    statusIdx: index('wb_returns_status_idx').on(t.workspaceId, t.status),
  })
);

// Chats with customers
export const wbChats = pgTable(
  'wb_chats',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    chatId: text('chat_id').notNull(),
    /** WB Buyer Chat replySign (криптоподпись для отправки сообщений).
     *  Заполняется при синке чатов. Nullable — старые записи без подписи
     *  заставляют executor подтянуть её on-the-fly. См. migration 0116. */
    replySign: text('reply_sign'),
    nmId: bigint('nm_id', { mode: 'number' }),
    orderId: bigint('order_id', { mode: 'number' }),
    buyerId: text('buyer_id'),
    lastMessage: text('last_message'),
    lastMessageAt: timestamptz('last_message_at'),
    unreadCount: integer('unread_count').default(0),
    status: text('status').default('open'),  // 'open' | 'closed'
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    wsIdx: index('wb_chats_ws_idx').on(t.workspaceId),
    chatIdx: uniqueIndex('wb_chats_chat_idx').on(t.workspaceId, t.chatId),
    statusIdx: index('wb_chats_status_idx').on(t.workspaceId, t.status),
  })
);

// Region Sales (from WB reports)
export const wbRegionSales = pgTable(
  'wb_region_sales',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    date: timestamptz('date').notNull(),
    regionId: integer('region_id'),
    regionName: text('region_name'),
    districtName: text('district_name'),
    orders: integer('orders').default(0),
    sales: integer('sales').default(0),  // в копейках
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsNmDateIdx: index('wb_region_sales_ws_nm_date_idx').on(t.workspaceId, t.nmId, t.date),
    wsDateIdx: index('wb_region_sales_ws_date_idx').on(t.workspaceId, t.date),
    regionIdx: index('wb_region_sales_region_idx').on(t.regionId),
  })
);

// ======================================================================
// AI Agent tables
// ======================================================================

/**
 * AI Agent conversations (chat threads).
 * Each conversation belongs to a workspace and optionally to a user.
 */
export const agentConversations = pgTable(
  'agent_conversations',
  {
    conversationId: bigint('conversation_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    userId: bigint('user_id', { mode: 'number' }).references(() => users.userId, { onDelete: 'set null' }),

    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    agentType: text('agent_type').notNull().default('assistant'), // assistant | feedback | pricing | bidder | supply | seo
    title: text('title'),
    status: text('status').notNull().default('active'), // active | archived | processing | ready | error

    // LangGraph thread reference (for checkpoint resume)
    threadId: text('thread_id'),
    
    // Error tracking
    errorMessage: text('error_message'),

    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('agent_conversations_workspace_idx').on(t.workspaceId, t.updatedAt),
    userIdx: index('agent_conversations_user_idx').on(t.userId),
    threadIdx: uniqueIndex('agent_conversations_thread_uniq').on(t.threadId),
  })
);

/**
 * Agent tasks for background processing.
 * Created when user triggers AI analysis from UI (Pulse, Finance, etc.)
 */
export const agentTasks = pgTable(
  'agent_tasks',
  {
    taskId: bigint('task_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    conversationId: bigint('conversation_id', { mode: 'number' }).notNull().references(() => agentConversations.conversationId, { onDelete: 'cascade' }),
    
    contextHash: text('context_hash').notNull(), // hash of page+filters for deduplication
    page: text('page').notNull(), // pulse | finance | dynamics | etc.
    filters: jsonb('filters').notNull().default({}),
    summary: jsonb('summary'), // aggregated data for context
    selectedItems: jsonb('selected_items'), // selected products if any
    message: text('message').notNull(), // user's question
    
    status: text('status').notNull().default('queued'), // queued | processing | completed | failed
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),
    
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
  },
  (t) => ({
    workspaceIdx: index('agent_tasks_workspace_idx').on(t.workspaceId, t.createdAt),
    statusIdx: index('agent_tasks_status_idx').on(t.status),
    dedupIdx: index('agent_tasks_dedup_idx').on(t.workspaceId, t.contextHash, t.createdAt),
  })
);

/**
 * Messages within AI conversations.
 * Stores the full chat history including tool calls.
 */
export const agentMessages = pgTable(
  'agent_messages',
  {
    messageId: bigint('message_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    conversationId: bigint('conversation_id', { mode: 'number' }).notNull().references(() => agentConversations.conversationId, { onDelete: 'cascade' }),

    role: text('role').notNull(), // user | assistant | system | tool
    content: text('content'),

    // For assistant messages with tool calls
    toolCalls: jsonb('tool_calls'), // [{ id, name, args, result }]

    // For widget messages
    widgetType: text('widget_type'), // price_slider | funnel_diagram | ...
    widgetProps: jsonb('widget_props'),

    // Attachments: files produced by agent tools (e.g. supply slip PDF).
    // Array of { url, fileName, mime, sizeBytes }.
    attachments: jsonb('attachments'),

    // SSE event tracking
    sseEventId: text('sse_event_id'),

    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    conversationIdx: index('agent_messages_conversation_idx').on(t.conversationId, t.createdAt),
  })
);

/**
 * Agent actions requiring confirmation or logging completed actions.
 * Supports human-in-the-loop: agent proposes → user approves → action executes.
 */
export const agentActions = pgTable(
  'agent_actions',
  {
    actionId: bigint('action_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    conversationId: bigint('conversation_id', { mode: 'number' }).references(() => agentConversations.conversationId, { onDelete: 'set null' }),

    actionType: text('action_type').notNull(), // set_price | reply_feedback | update_bid | start_campaign | stop_campaign | create_supply
    // Status lifecycle (Action Queue, migration 0117):
    //   queued → running → executed             (happy path)
    //                    → failed:retryable → queued (retry, up to 3 attempts)
    //                    → failed:permanent (terminal)
    //                    → cancelled (by user)
    // Legacy values kept for backwards-compatibility: pending | approved | rejected | executed | failed
    status: text('status').notNull().default('queued'),

    // What the agent wants to do
    payload: jsonb('payload').notNull().default({}), // { nmId, newPrice, oldPrice, ... }
    rationale: text('rationale'), // AI's reasoning for this action

    // ─── Action Queue (migration 0117) ─────────────────────────────────────
    // Idempotency: sha256(workspaceId|shopId|toolName|sortedArgs|conversationTurn).
    // Re-enqueueing the same logical command returns the existing actionId.
    idempotencyKey: text('idempotency_key'),
    retryCount: integer('retry_count').notNull().default(0),
    lastError: text('last_error'),
    queuedAt: timestamptz('queued_at'),
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    nextRetryAt: timestamptz('next_retry_at'),
    userId: bigint('user_id', { mode: 'number' }).references(() => users.userId, { onDelete: 'set null' }),
    // ──────────────────────────────────────────────────────────────────────

    // After execution
    result: jsonb('result'), // { success, wbResponse, error }
    executedAt: timestamptz('executed_at'),

    // Who approved/rejected
    decidedBy: bigint('decided_by', { mode: 'number' }).references(() => users.userId, { onDelete: 'set null' }),
    decidedAt: timestamptz('decided_at'),
    decisionNote: text('decision_note'),

    // Link to triggering event
    eventId: bigint('event_id', { mode: 'number' }).references(() => wbEvents.eventId, { onDelete: 'set null' }),

    // Multi-Agent v2 (migration 0070): domain agent attribution, V&V tracking
    agentName: text('agent_name'), // 'pricing' | 'reviews' | 'ads' | ... (null = legacy / universal)
    correlationId: uuid('correlation_id'), // links action to agent_execution_run / related actions
    verificationStatus: text('verification_status').default('pending'), // pending | verified | drift | failed
    verificationAttempts: integer('verification_attempts').default(0),
    agentSource: text('agent_source'), // 'user_chat' | 'autonomous' | 'rule_engine' | 'monitor'

    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('agent_actions_workspace_idx').on(t.workspaceId, t.status),
    conversationIdx: index('agent_actions_conversation_idx').on(t.conversationId),
    statusIdx: index('agent_actions_status_idx').on(t.status, t.createdAt),
    correlationIdx: index('agent_actions_correlation_idx').on(t.correlationId),
    agentNameIdx: index('agent_actions_agent_name_idx').on(t.agentName, t.createdAt),
    // Action Queue (migration 0117)
    idempotencyKeyIdx: uniqueIndex('agent_actions_idempotency_key_uniq').on(t.idempotencyKey),
  })
);

/**
 * Optimistic locks for agent actions.
 * Prevents concurrent modifications to the same resource.
 * User always overrides agent — lock is advisory.
 */
export const agentLocks = pgTable(
  'agent_locks',
  {
    lockId: bigint('lock_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),

    resourceType: text('resource_type').notNull(), // price | bid | feedback_reply | campaign
    resourceId: text('resource_id').notNull(), // nmId or campaignId or feedbackId

    lockedBy: text('locked_by').notNull(), // 'agent:<runId>' or 'user:<userId>'
    expiresAt: timestamptz('expires_at').notNull(),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    resourceUniq: uniqueIndex('agent_locks_resource_uniq').on(t.workspaceId, t.resourceType, t.resourceId),
    expiresIdx: index('agent_locks_expires_idx').on(t.expiresAt),
  })
);

/**
 * Per-workspace agent settings (extends wbAlertSettings, does NOT duplicate).
 * wbAlertSettings keeps alert thresholds (maxDrrFactPct, minDaysOfStock, etc.)
 * agentSettings adds AI-specific behaviour toggles.
 */
export const agentSettings = pgTable(
  'agent_settings',
  {
    settingId: bigint('setting_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),

    // Auto-reply
    autoReplyPositive: boolean('auto_reply_positive').default(false), // auto-send replies to 4-5 star reviews
    autoReplyNeutral: boolean('auto_reply_neutral').default(false),
    autoReplyRequiresApproval: boolean('auto_reply_requires_approval').default(true), // human-in-the-loop

    // Pricing
    autoPriceProtectOos: boolean('auto_price_protect_oos').default(false), // raise price when stock critical
    minMarginPct: integer('min_margin_pct'), // minimum margin threshold
    maxPriceChangePct: integer('max_price_change_pct').default(10), // max single price change %

    // Bidder
    autoBidOptimize: boolean('auto_bid_optimize').default(false),
    maxBidRub: bigint('max_bid_rub', { mode: 'number' }), // max bid in kopecks

    // Notifications
    telegramChatId: text('telegram_chat_id'), // per-workspace telegram chat
    telegramCritical: boolean('telegram_critical').default(false),
    telegramBriefing: boolean('telegram_briefing').default(false),

    // Agent behaviour
    agentModel: text('agent_model'), // override default model per workspace
    agentMaxTokensPerDay: integer('agent_max_tokens_per_day'),

    // Pricing Engine
    pricingEnabled: boolean('pricing_enabled').default(false),
    pricingMode: text('pricing_mode').default('manual'), // manual | semi_auto | full_auto
    pricingDefaultStrategies: jsonb('pricing_default_strategies').default([]),

    // Feedback Pipeline v2
    replyTone: text('reply_tone').default('friendly'), // neutral | friendly | emotional | premium
    replyCrossSellFrequency: integer('reply_cross_sell_frequency').default(3),
    replyCrossSellProducts: jsonb('reply_cross_sell_products').default([]),
    replyMaxLength: integer('reply_max_length').default(500),
    replyForbiddenWords: jsonb('reply_forbidden_words').default([]),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceUniq: uniqueIndex('agent_settings_workspace_uniq').on(t.workspaceId),
  })
);

/**
 * AI Agent events — proactive alerts and suggestions.
 * Triggered by background scans (OOS, margin drop, review spike, etc.)
 */
export const agentEvents = pgTable(
  'agent_events',
  {
    eventId: bigint('event_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),

    // Event type and source
    eventType: text('event_type').notNull(), // oos_warning | margin_drop | review_spike | order_drop | price_war | stock_forecast
    severity: text('severity').notNull().default('info'), // info | warning | critical
    source: text('source').notNull().default('agent'), // agent | system | user

    // Content
    title: text('title').notNull(),
    description: text('description'),
    
    // Related entities
    nmId: bigint('nm_id', { mode: 'number' }),
    productTitle: text('product_title'),

    // Suggested action
    suggestedAction: text('suggested_action'), // reprice | pause_ads | restock | reply_review
    actionArgs: jsonb('action_args'), // { newPrice: 1500, reason: "..." }

    // Status
    status: text('status').notNull().default('pending'), // pending | applied | dismissed | snoozed | expired
    snoozedUntil: timestamptz('snoozed_until'),
    appliedAt: timestamptz('applied_at'),
    appliedBy: bigint('applied_by', { mode: 'number' }).references(() => users.userId),

    // Link to conversation if user clicked "details"
    conversationId: bigint('conversation_id', { mode: 'number' }).references(() => agentConversations.conversationId),

    // Multi-Agent v2 (migration 0070)
    agentSource: text('agent_source'), // which agent produced this event (pricing | ads | monitor | ...)
    correlationId: uuid('correlation_id'),

    // Metadata
    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('agent_events_workspace_idx').on(t.workspaceId, t.status, t.createdAt),
    typeIdx: index('agent_events_type_idx').on(t.eventType, t.createdAt),
    nmIdIdx: index('agent_events_nmid_idx').on(t.nmId),
    correlationIdx: index('agent_events_correlation_idx').on(t.correlationId),
  })
);

// ── Pricing Engine ───────────────────────────────────────────

export const pricingStrategies = pgTable(
  'pricing_strategies',
  {
    strategyId: bigint('strategy_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    strategyType: text('strategy_type').notNull(), // maximize_profit | hold_supply | demand_up | demand_down | turnover | negative_reviews | atc_optimize | aggressive_sale | oos_protection
    isActive: boolean('is_active').notNull().default(true),
    config: jsonb('config').notNull().default({}),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    wsNmStrategyUniq: uniqueIndex('pricing_strategies_ws_nm_type_uniq').on(t.workspaceId, t.nmId, t.strategyType),
    wsIdx: index('pricing_strategies_ws_idx').on(t.workspaceId),
  })
);

export const pricingDecisions = pgTable(
  'pricing_decisions',
  {
    decisionId: bigint('decision_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    strategyType: text('strategy_type').notNull(),
    oldPriceKop: bigint('old_price_kop', { mode: 'number' }).notNull(),
    newPriceKop: bigint('new_price_kop', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    constraintsApplied: jsonb('constraints_applied').notNull().default({}),
    status: text('status').notNull().default('proposed'), // proposed | approved | applied | rejected | skipped
    actionId: bigint('action_id', { mode: 'number' }).references(() => agentActions.actionId),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsIdx: index('pricing_decisions_ws_idx').on(t.workspaceId, t.nmId, t.createdAt),
  })
);

// ── Feedback Pipeline v2 ─────────────────────────────────────

export const feedbackReplyLog = pgTable(
  'feedback_reply_log',
  {
    logId: bigint('log_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    feedbackId: text('feedback_id').notNull(),
    nmId: bigint('nm_id', { mode: 'number' }),
    sentiment: text('sentiment'), // positive | neutral | negative
    toneUsed: text('tone_used'),
    kbEntriesUsed: jsonb('kb_entries_used').notNull().default([]),
    crossSellIncluded: boolean('cross_sell_included').notNull().default(false),
    replyText: text('reply_text').notNull(),
    status: text('status').notNull().default('sent'), // sent | rejected | failed
    approvedBy: bigint('approved_by', { mode: 'number' }).references(() => users.userId),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('feedback_reply_log_ws_idx').on(t.workspaceId, t.createdAt),
    dedupIdx: uniqueIndex('feedback_reply_log_fb_uniq').on(t.workspaceId, t.feedbackId),
  })
);

// ------------------------------
// Document Hub (NotebookLM-style)
// ------------------------------

export const documents = pgTable(
  'documents',
  {
    documentId: bigserial('document_id', { mode: 'number' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    uploadedBy: bigint('uploaded_by', { mode: 'number' }),
    title: text('title').notNull(),
    fileName: text('file_name'),
    fileType: text('file_type').notNull(), // pdf | docx | xlsx | txt | md | image
    fileSizeBytes: integer('file_size_bytes'),
    storagePath: text('storage_path'), // local file path or S3 key
    fullText: text('full_text'), // extracted plain text
    category: text('category'), // user-defined document category
    tags: jsonb('tags').notNull().default([]),
    nmIds: jsonb('nm_ids').notNull().default([]), // linked product IDs
    isKnowledgeBase: boolean('is_knowledge_base').notNull().default(false), // available to feedback agent
    status: text('status').notNull().default('uploaded'), // uploaded | processing | indexed | error
    chunkCount: integer('chunk_count').default(0),
    pageCount: integer('page_count'),
    errorMessage: text('error_message'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    deletedAt: timestamptz('deleted_at'), // soft delete
  },
  (t) => ({
    wsIdx: index('documents_ws_idx').on(t.workspaceId, t.status),
    wsActiveIdx: index('documents_ws_active_idx').on(t.workspaceId, t.deletedAt),
  })
);

export const documentChunks = pgTable(
  'document_chunks',
  {
    chunkId: bigserial('chunk_id', { mode: 'number' }).primaryKey(),
    documentId: bigint('document_id', { mode: 'number' }).notNull(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(), // denormalized for efficient vector search
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }), // denormalized from documents
    content: text('content').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    pageNumber: integer('page_number'),
    tokenCount: integer('token_count'),
    contentHash: text('content_hash'), // SHA-256 for dedup
    embedding: vector('embedding'), // vector(1024) - Voyage-3 or text-embedding-3-small
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    docIdx: index('doc_chunks_doc_idx').on(t.documentId),
    wsIdx: index('doc_chunks_ws_idx').on(t.workspaceId),
    hashIdx: index('doc_chunks_hash_idx').on(t.workspaceId, t.contentHash),
  })
);

// ============================================================
// Reconciliation Log
// ============================================================

export const wbReconciliationLog = pgTable(
  'wb_reconciliation_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    date: text('date').notNull(), // YYYY-MM-DD
    checkName: text('check_name').notNull(),
    expected: bigint('expected', { mode: 'number' }).notNull().default(0),
    actual: bigint('actual', { mode: 'number' }).notNull().default(0),
    delta: bigint('delta', { mode: 'number' }).notNull().default(0),
    deltaPercent: real('delta_percent').notNull().default(0),
    status: text('status').notNull().default('ok'), // ok | warn | error
    details: text('details'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsDateIdx: index('reconciliation_ws_date_idx').on(t.workspaceId, t.date),
    statusIdx: index('reconciliation_status_idx').on(t.status),
  })
);

// ============================================================
// Creative Audit Experiments
// ============================================================

export const creativeAuditExperiments = pgTable(
  'creative_audit_experiments',
  {
    experimentId: bigint('experiment_id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    auditId: bigint('audit_id', { mode: 'number' }).notNull().references(() => creativeAuditRunsFinal.id, { onDelete: 'cascade' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),

    // What was applied
    appliedTitle: boolean('applied_title').notNull().default(false),
    appliedDescription: boolean('applied_description').notNull().default(false),
    appliedCharacteristics: jsonb('applied_characteristics').notNull().default([]),

    // Snapshot before changes
    beforeSnapshot: jsonb('before_snapshot').notNull(),

    // Baseline metrics
    baselineMetrics: jsonb('baseline_metrics').notNull(),
    baselineDate: text('baseline_date').notNull(),

    // Status
    status: text('status').notNull().default('running'), // running | completed | reverted

    // Result
    resultMetrics: jsonb('result_metrics'),
    resultDate: text('result_date'),
    resultDelta: jsonb('result_delta'),
    resultVerdict: text('result_verdict'), // positive | neutral | negative

    // Timestamps
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
    revertedAt: timestamptz('reverted_at'),
  },
  (t) => ({
    wsIdx: index('creative_experiments_ws_idx').on(t.workspaceId, t.status, t.createdAt),
    nmIdx: index('creative_experiments_nm_idx').on(t.workspaceId, t.nmId),
  })
);

// ============================================================
// Creative Image Generations
// ============================================================

export const creativeImageGenerations = pgTable(
  'creative_image_generations',
  {
    generationId: bigint('generation_id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    auditId: bigint('audit_id', { mode: 'number' }).references(() => creativeAuditRunsFinal.id, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),

    // Input
    prompt: text('prompt').notNull(),
    referencePhotoUrl: text('reference_photo_url'),
    designerBrief: text('designer_brief'),
    generationType: text('generation_type').notNull(), // infographic | lifestyle | product_shot | animation

    // Output
    generatedImages: jsonb('generated_images').notNull().default([]),
    selectedIndex: integer('selected_index'),

    // Status
    status: text('status').notNull().default('pending'), // pending | generating | completed | uploaded | failed
    errorMessage: text('error_message'),

    // Upload tracking
    uploadedToWb: boolean('uploaded_to_wb').notNull().default(false),
    uploadedPhotoNumber: integer('uploaded_photo_number'),
    abTestId: bigint('ab_test_id', { mode: 'number' }).references(() => abPhotoTests.testId, { onDelete: 'set null' }),

    // Cost
    costUsd: text('cost_usd'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsIdx: index('creative_generations_ws_idx').on(t.workspaceId, t.status, t.createdAt),
  })
);

// ============================================================
// VISUAL STUDIO TABLES
// ============================================================

/**
 * Проекты визуальной студии (сохранённые работы)
 */
export const studioProjects = pgTable(
  'studio_projects',
  {
    projectId: bigint('project_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: integer('nm_id'), // Связь с товаром (опционально)
    name: text('name').notNull(),
    type: text('type').notNull().default('image'), // 'image' | 'infographic' | 'rich_content' | 'animation'
    canvasData: jsonb('canvas_data'), // Fabric.js JSON
    thumbnail: text('thumbnail'), // URL превью
    status: text('status').notNull().default('draft'), // 'draft' | 'saved' | 'exported'
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('studio_projects_workspace_idx').on(t.workspaceId),
    nmIdIdx: index('studio_projects_nm_id_idx').on(t.nmId),
    typeIdx: index('studio_projects_type_idx').on(t.type),
  })
);

/**
 * Ассеты студии (загруженные изображения, шрифты)
 */
export const studioAssets = pgTable(
  'studio_assets',
  {
    assetId: bigint('asset_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .references(() => users.userId, { onDelete: 'set null' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    projectId: bigint('project_id', { mode: 'number' })
      .references(() => studioProjects.projectId, { onDelete: 'set null' }),
    type: text('type').notNull(), // 'image' | 'font' | 'template' | 'sticker' | 'generated'
    name: text('name'),
    url: text('url').notNull(),
    metadata: jsonb('metadata'), // { width, height, fileSize, mimeType, source, kind, model }
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('studio_assets_workspace_idx').on(t.workspaceId),
    workspaceUserIdx: index('studio_assets_workspace_user_idx').on(t.workspaceId, t.userId, t.createdAt),
    projectIdx: index('studio_assets_project_idx').on(t.projectId),
    typeIdx: index('studio_assets_type_idx').on(t.type),
  })
);

/**
 * Пресеты генерации (настройки камеры, освещения, стиля)
 */
export const studioPresets = pgTable(
  'studio_presets',
  {
    presetId: bigint('preset_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: text('category'), // 'studio' | 'lifestyle' | 'product' | 'clothing'
    settings: jsonb('settings').notNull(), // { camera, lighting, style, pose, background, model, temperature }
    isSystem: boolean('is_system').notNull().default(false), // Системные пресеты
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('studio_presets_workspace_idx').on(t.workspaceId),
    categoryIdx: index('studio_presets_category_idx').on(t.category),
  })
);

/**
 * История сгенерированных наборов промптов для Studio.
 * Точка входа — nmId товара. Если был привязан аудит — сохраняется auditId.
 * Позволяет пользователю не запускать LLM заново для того же товара.
 */
export const studioPromptSuggestions = pgTable(
  'studio_prompt_suggestions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    auditId: bigint('audit_id', { mode: 'number' }),
    userId: bigint('user_id', { mode: 'number' }).references(() => users.userId, { onDelete: 'set null' }),
    promptsJson: jsonb('prompts_json').notNull(),            // SuggestedPrompt[]
    productContextJson: jsonb('product_context_json').notNull(), // snapshot title/category/brand/photosCount
    modelUsed: text('model_used').notNull().default('claude-sonnet-4-6'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    label: text('label'),  // опциональная пользовательская метка вроде «Для осенней коллекции»
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsNmCreatedIdx: index('studio_prompt_suggestions_ws_nm_created_idx').on(t.workspaceId, t.nmId, t.createdAt),
    wsCreatedIdx: index('studio_prompt_suggestions_ws_created_idx').on(t.workspaceId, t.createdAt),
  })
);

/**
 * Транзакции кредитов за AI операции
 */
export const studioCredits = pgTable(
  'studio_credits',
  {
    creditId: bigint('credit_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    operation: text('operation').notNull(), // 'generate_image' | 'remove_bg' | 'upscale' | 'video'
    creditsUsed: integer('credits_used').notNull(),
    model: text('model'), // 'gemini-flash' | 'gemini-pro' | 'rembg' | 'esrgan'
    metadata: jsonb('metadata'), // { prompt, taskId, projectId, ... }
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('studio_credits_workspace_idx').on(t.workspaceId),
    createdIdx: index('studio_credits_created_idx').on(t.createdAt),
    operationIdx: index('studio_credits_operation_idx').on(t.operation),
  })
);

/**
 * AI задачи в очереди (для асинхронной обработки)
 */
export const studioTasks = pgTable(
  'studio_tasks',
  {
    taskId: text('task_id').primaryKey(), // UUID
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    // Per-shop scoping. The other studio_* tables already have shop_id;
    // tasks were a gap that let multi-shop workspaces see each other's
    // generation jobs in the UI. Nullable for legacy rows during backfill;
    // new inserts must always set it from request context.
    shopId: integer('shop_id').references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    projectId: bigint('project_id', { mode: 'number' })
      .references(() => studioProjects.projectId, { onDelete: 'set null' }),
    type: text('type').notNull(), // 'remove_bg' | 'generate' | 'upscale' | 'video'
    status: text('status').notNull().default('pending'), // 'pending' | 'processing' | 'completed' | 'failed'
    input: jsonb('input').notNull(), // Входные данные
    output: jsonb('output'), // Результат
    error: text('error'),
    progress: integer('progress').default(0), // 0-100
    creditsUsed: integer('credits_used'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
  },
  (t) => ({
    workspaceIdx: index('studio_tasks_workspace_idx').on(t.workspaceId),
    shopIdx: index('studio_tasks_shop_idx').on(t.shopId),
    statusIdx: index('studio_tasks_status_idx').on(t.status),
    createdIdx: index('studio_tasks_created_idx').on(t.createdAt),
  })
);

// Самовыкупы (ручной ввод пользователем)
export const wbSelfPurchases = pgTable(
  'wb_self_purchases',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'cascade' }),
    nmId: bigint('nm_id', { mode: 'number' }),
    date: text('date').notNull(), // YYYY-MM-DD
    
    quantity: integer('quantity').notNull().default(1), // Кол-во самовыкупов
    amountKopecks: bigint('amount_kopecks', { mode: 'number' }).notNull().default(0), // Сумма расхода (цена покупки)
    purpose: text('purpose'), // Цель: 'review' | 'photo' | 'test' | 'other'
    orderId: text('order_id'), // ID заказа WB (опционально)
    comment: text('comment'),
    
    createdByUserId: bigint('created_by_user_id', { mode: 'number' }).references(() => users.userId),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceDateIdx: index('wb_self_purchases_workspace_date_idx').on(t.workspaceId, t.date),
    workspaceNmIdx: index('wb_self_purchases_workspace_nm_idx').on(t.workspaceId, t.nmId),
    shopIdx: index('wb_self_purchases_shop_idx').on(t.shopId),
  })
);

// Компенсации (из WB API, парсятся из reportDetailByPeriod)
export const wbCompensations = pgTable(
  'wb_compensations',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'cascade' }),
    nmId: bigint('nm_id', { mode: 'number' }),
    date: text('date').notNull(), // YYYY-MM-DD (sale_dt)
    
    operationType: text('operation_type').notNull(), // Тип: 'damage' | 'loss' | 'logistics' | 'other'
    amountKopecks: bigint('amount_kopecks', { mode: 'number' }).notNull().default(0),
    description: text('description'), // supplier_oper_name
    rrdId: bigint('rrd_id', { mode: 'number' }), // ID записи из WB API
    
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    workspaceDateIdx: index('wb_compensations_workspace_date_idx').on(t.workspaceId, t.date),
    workspaceNmIdx: index('wb_compensations_workspace_nm_idx').on(t.workspaceId, t.nmId),
    rrdIdUniq: uniqueIndex('wb_compensations_rrd_id_uniq').on(t.workspaceId, t.rrdId),
  })
);

// ── Multi-Agent v2 Foundation (migration 0070) ─────────────────────

/**
 * Audit trail for each LLM subagent invocation.
 * One row per runPricingAgent / runBidderAgent / runSupplyAgent call.
 */
export const agentExecutionRuns = pgTable(
  'agent_execution_runs',
  {
    runId: uuid('run_id').primaryKey().defaultRandom(),
    agentName: text('agent_name').notNull(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    // FK to marketplace_shops added in migration 0104 (DB-level gate against
    // orphan shop references). ON DELETE SET NULL — historical runs survive
    // shop removal but lose scope.
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    correlationId: uuid('correlation_id'),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    finishedAt: timestamptz('finished_at'),
    tokensInput: integer('tokens_input'),
    tokensOutput: integer('tokens_output'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    status: text('status').notNull().default('running'), // running | done | failed | timeout
    inputSnapshot: jsonb('input_snapshot'),
    output: jsonb('output'),
    error: text('error'),
  },
  (t) => ({
    workspaceIdx: index('agent_runs_workspace_idx').on(t.workspaceId, t.startedAt),
    agentNameIdx: index('agent_runs_agent_name_idx').on(t.agentName, t.startedAt),
    correlationIdx: index('agent_runs_correlation_idx').on(t.correlationId),
    wsShopStartedIdx: index('agent_execution_runs_ws_shop_started_idx').on(t.workspaceId, t.shopId, t.startedAt),
  })
);

/**
 * V&V (Verify & Validate) checks for dangerous actions.
 * Multi-level verification: immediate, deferred_30s, deferred_5min, impact_24h.
 */
export const agentVerificationChecks = pgTable(
  'agent_verification_checks',
  {
    checkId: uuid('check_id').primaryKey().defaultRandom(),
    actionId: bigint('action_id', { mode: 'number' }).notNull().references(() => agentActions.actionId, { onDelete: 'cascade' }),
    // Denormalised shop_id (added migration 0104) — keeps per-shop dashboards
    // and Monitor cron simple: filter directly without joining agent_actions.
    // Backfilled from agent_actions.shop_id; kept in sync by scheduleVerification.
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    checkType: text('check_type').notNull(), // immediate | deferred_30s | deferred_5min | impact_24h
    scheduledAt: timestamptz('scheduled_at').notNull(),
    executedAt: timestamptz('executed_at'),
    result: text('result'), // pass | drift | fail | timeout (null = not executed yet)
    details: jsonb('details'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    scheduledIdx: index('verif_checks_scheduled_idx').on(t.scheduledAt), // partial idx "WHERE result IS NULL" — applied in SQL only
    actionIdx: index('verif_checks_action_idx').on(t.actionId),
    shopIdx: index('agent_verification_checks_shop_idx').on(t.shopId),
  })
);

/**
 * Event sourcing — raw stream for Monitor Agent (Phase 4).
 * Every significant state change or agent action writes here.
 */
export const systemEvents = pgTable(
  'system_events',
  {
    eventId: uuid('event_id').primaryKey().defaultRandom(),
    ts: timestamptz('ts').notNull().defaultNow(),
    agentName: text('agent_name'),
    eventType: text('event_type').notNull(),
    workspaceId: bigint('workspace_id', { mode: 'number' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    entityType: text('entity_type'), // card | campaign | supply | feedback | chat | price
    entityId: text('entity_id'),
    payload: jsonb('payload'),
    correlationId: uuid('correlation_id'),
  },
  (t) => ({
    tsIdx: index('system_events_ts_idx').on(t.ts),
    wsTypeIdx: index('system_events_ws_type_idx').on(t.workspaceId, t.eventType, t.ts),
    correlationIdx: index('system_events_correlation_idx').on(t.correlationId),
    entityIdx: index('system_events_entity_idx').on(t.entityType, t.entityId),
    wsShopTsIdx: index('system_events_ws_shop_ts_idx').on(t.workspaceId, t.shopId, t.ts),
  })
);

/**
 * User-defined YAML rules per domain agent.
 * Scope: global (workspace) | category | nmid_list.
 */
export const agentDomainRules = pgTable(
  'agent_domain_rules',
  {
    ruleId: bigserial('rule_id', { mode: 'number' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'cascade' }),
    agentName: text('agent_name').notNull(),
    scopeType: text('scope_type').notNull().default('global'), // global | category | nmid_list
    scopeValue: jsonb('scope_value'), // e.g. [12345, 67890] or { categoryId: 1234 }
    ruleYaml: text('rule_yaml').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    wsAgentIdx: index('agent_rules_ws_agent_idx').on(t.workspaceId, t.agentName, t.enabled),
    wsShopAgentIdx: index('agent_domain_rules_ws_shop_agent_idx').on(t.workspaceId, t.shopId, t.agentName),
  })
);

// ============================================================================
// AI Agents runtime tables (Phase 1 MVP: Supply + SEO)
// ============================================================================

/**
 * Единая история запусков специализированных AI-агентов (supply, seo, ...).
 * Создаётся при старте runner'а, обновляется финальным статусом.
 */
export const agentRunResults = pgTable(
  'agent_run_results',
  {
    runId: text('run_id').primaryKey(),
    agentName: text('agent_name').notNull(), // 'supply' | 'seo' | 'pricing' | ...
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }),
    trigger: text('trigger').notNull(), // 'cron' | 'manual' | 'subagent' | 'api'
    status: text('status').notNull(), // 'running' | 'done' | 'failed'
    summary: text('summary'),
    metrics: jsonb('metrics'), // counts / avgs / tokens
    error: text('error'),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    finishedAt: timestamptz('finished_at'),
  },
  (t) => ({
    wsAgentTimeIdx: index('agent_run_results_ws_agent_time_idx').on(t.workspaceId, t.agentName, t.startedAt),
  }),
);

/**
 * Рекомендации Supply-агента. Каждый run пополняет таблицу; старые
 * рекомендации остаются для истории (можно смотреть тренд).
 */
export const agentSupplyRecommendations = pgTable(
  'agent_supply_recommendations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: text('run_id').notNull().references(() => agentRunResults.runId, { onDelete: 'cascade' }),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull(),
    shopId: bigint('shop_id', { mode: 'number' }),
    nmId: bigint('nm_id', { mode: 'number' }).notNull(),
    productTitle: text('product_title'),
    currentStock: integer('current_stock').notNull(),
    avgDailySales: real('avg_daily_sales').notNull(),
    daysOfStock: real('days_of_stock'),
    recommendedQty: integer('recommended_qty').notNull(),
    urgency: text('urgency').notNull(), // 'critical' | 'high' | 'medium' | 'low'
    reason: text('reason'),
    applied: boolean('applied').notNull().default(false),
    appliedAt: timestamptz('applied_at'),
    // 0131: warehouse + economic decision-support fields. NULL когда
    // рекомендация была сгенерирована старым агентом (qty-only).
    warehouseId: integer('warehouse_id'),
    warehouseName: text('warehouse_name'),
    expectedCoefficient: numeric('expected_coefficient', { precision: 4, scale: 2 }),
    acceptanceCostKop: bigint('acceptance_cost_kop', { mode: 'number' }),
    transitCostKop: bigint('transit_cost_kop', { mode: 'number' }),
    storageCost14dKop: bigint('storage_cost_14d_kop', { mode: 'number' }),
    expectedRevenueKop: bigint('expected_revenue_kop', { mode: 'number' }),
    expectedRoiKop: bigint('expected_roi_kop', { mode: 'number' }),
    targetRegion: text('target_region'),
    recommendedAtForDate: text('recommended_at_for_date'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsNmIdx: index('agent_supply_reco_ws_nm_idx').on(t.workspaceId, t.nmId),
    wsRunIdx: index('agent_supply_reco_ws_run_idx').on(t.workspaceId, t.runId),
  }),
);

// ── FBS supplies mirror (0131) ──────────────────────────────────────────────
// WB FBS поставки имеют textual id вида `WB-GI-XXXXXXXXX` (а не bigint),
// поэтому отдельная таблица, не reuse wb_supplies (FBW).
export const wbFbsSupplies = pgTable(
  'wb_fbs_supplies',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    wbSupplyId: text('wb_supply_id').notNull(), // 'WB-GI-241734101'
    name: text('name'),
    cargoType: integer('cargo_type'),
    destinationOfficeId: integer('destination_office_id'),
    recommendedWhId: integer('recommended_wh_id'),
    closedAt: timestamptz('closed_at'),
    scanDt: timestamptz('scan_dt'),
    rejectDt: timestamptz('reject_dt'),
    done: boolean('done').default(false),
    ordersCount: integer('orders_count').default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    syncedAt: timestamptz('synced_at'),
  },
  (t) => ({
    wsSupplyUniq: uniqueIndex('wb_fbs_supplies_ws_supply_uniq').on(t.workspaceId, t.wbSupplyId),
    wsDoneIdx: index('wb_fbs_supplies_workspace_done_idx').on(t.workspaceId, t.done),
  }),
);

export const wbFbsSupplyOrders = pgTable(
  'wb_fbs_supply_orders',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    fbsSupplyPk: bigint('fbs_supply_pk', { mode: 'number' }).notNull().references(() => wbFbsSupplies.id, { onDelete: 'cascade' }),
    wbOrderId: bigint('wb_order_id', { mode: 'number' }).notNull(),
    status: text('status'),
    addedAt: timestamptz('added_at').notNull().defaultNow(),
  },
  (t) => ({
    pairUniq: uniqueIndex('wb_fbs_supply_orders_pair_uniq').on(t.fbsSupplyPk, t.wbOrderId),
    orderIdx: index('wb_fbs_supply_orders_order_idx').on(t.wbOrderId),
  }),
);

// История ROI-решений (для будущих ML-моделей и обоснования decline).
export const supplyRoiHistory = pgTable(
  'supply_roi_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).references(() => marketplaceShops.shopId, { onDelete: 'set null' }),
    nmId: bigint('nm_id', { mode: 'number' }),
    warehouseId: integer('warehouse_id'),
    quantity: integer('quantity'),
    acceptanceCostKop: bigint('acceptance_cost_kop', { mode: 'number' }),
    transitCostKop: bigint('transit_cost_kop', { mode: 'number' }),
    storageCostKop: bigint('storage_cost_kop', { mode: 'number' }),
    expectedRevenueKop: bigint('expected_revenue_kop', { mode: 'number' }),
    expectedMarginKop: bigint('expected_margin_kop', { mode: 'number' }),
    roiKop: bigint('roi_kop', { mode: 'number' }),
    decision: text('decision'), // 'approved' | 'declined' | 'forced'
    preorderId: integer('preorder_id'),
    fbsSupplyId: text('fbs_supply_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    wsNmIdx: index('supply_roi_history_ws_nm_idx').on(t.workspaceId, t.nmId, t.createdAt),
  }),
);

/**
 * Per-(workspace, shop, sync_type) backfill cursor for the overnight walker.
 * See pulse-api/src/jobs/backfillWalker.ts.
 *
 * Walker walks `oldest_covered` backward in CHUNK_DAYS steps until it reaches
 * `target_oldest`. On a successful tick, `oldest_covered` advances backward
 * and `last_error` clears. On WB 429 / quota failures, `oldest_covered`
 * stays put and `last_error` records the cause so the next tick retries
 * the same window.
 */
export const wbBackfillProgress = pgTable(
  'wb_backfill_progress',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' }).notNull()
      .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
    shopId: bigint('shop_id', { mode: 'number' }).notNull()
      .references(() => marketplaceShops.shopId, { onDelete: 'cascade' }),
    syncType: text('sync_type').notNull(), // 'orders_sales' | 'finance' | 'funnel' | 'adv'
    targetOldest: date('target_oldest').notNull(),
    oldestCovered: date('oldest_covered'),
    newestCovered: date('newest_covered'),
    lastAdvancedAt: timestamptz('last_advanced_at'),
    lastError: text('last_error'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.shopId, t.syncType] }),
  }),
);

