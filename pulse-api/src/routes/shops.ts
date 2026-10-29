import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { marketplaceShops } from '../db/schema.js';
import { wbGetJson, inspectWbToken } from '../integrations/wb/wbClient.js';
import { encrypt, safeDecrypt, apiKeyHash } from '../lib/crypto.js';
import { requireRole } from '../plugins/roleCheck.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'shops' });

export const shopsRoutes: FastifyPluginAsync = async (app) => {
  // -----------------------------------------------------------------------
  // Capabilities (DECISIONS #103 follow-up): derived per-shop flags
  // (jam_status, token_status) computed on-the-fly from `wb_sync_runs`.
  //
  // Используется в UI (бейджи на странице магазина) и AI-агентом
  // (новый tool query_shop_capabilities) чтобы не предлагать Jam-only
  // фичи на shop'ах без подписки и не звонить в expired-токен endpoint'ы.
  //
  // VIEW определена в migration 0120_marketplace_shops_capabilities.sql
  // и переcчитывается на каждое чтение (всегда актуальна).
  // -----------------------------------------------------------------------
  app.get('/shops/:workspaceId/capabilities', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const rows = await db.execute<{
      workspace_id: number;
      shop_id: number;
      shop_name: string;
      platform: string;
      is_active: boolean;
      jam_status: 'active' | 'inactive' | 'unknown';
      jam_last_check_at: Date | null;
      token_status: 'valid' | 'expired' | 'unknown';
    }>(sql`
      SELECT workspace_id, shop_id, shop_name, platform, is_active,
             jam_status, jam_last_check_at, token_status
        FROM marketplace_shops_capabilities
       WHERE workspace_id = ${params.workspaceId}
       ORDER BY shop_id
    `);

    return {
      workspaceId: params.workspaceId,
      shops: rows.rows.map((r) => ({
        shopId: r.shop_id,
        shopName: r.shop_name,
        platform: r.platform,
        isActive: r.is_active,
        jamStatus: r.jam_status,
        jamLastCheckAt: r.jam_last_check_at,
        tokenStatus: r.token_status,
        // Human-readable hint for UI tooltip
        jamStatusNote:
          r.jam_status === 'active' ? 'Jam-подписка активна — все аналитические фичи доступны.' :
          r.jam_status === 'inactive' ? 'Jam-подписка неактивна — SEO-mining, search-report и часть bidder-аналитики недоступны.' :
          'Подписка ещё не проверена. Дождитесь следующего cron`а search-queries-sync (04:00 МСК).',
      })),
    };
  });

  // -----------------------------------------------------------------------
  // List shops for a workspace (hides API key)
  // -----------------------------------------------------------------------
  app.get('/shops/:workspaceId', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({ platform: z.enum(['wb', 'ozon', 'ym', 'all']).optional() }).parse(req.query);

    const platform = query.platform ?? 'wb';
    const platformValue = platform === 'ym' ? 'yandex_market' : platform;

    const where = [eq(marketplaceShops.workspaceId, params.workspaceId)];
    if (platformValue !== 'all') {
      where.push(eq(marketplaceShops.platform, platformValue));
    }

    const rows = await db
      .select({
        shopId: marketplaceShops.shopId,
        platform: marketplaceShops.platform,
        name: marketplaceShops.name,
        wbDeliveryType: marketplaceShops.wbDeliveryType,
        taxRegime: marketplaceShops.taxRegime,
        vatPct: marketplaceShops.vatPct,
        isActive: marketplaceShops.isActive,
        createdAt: marketplaceShops.createdAt,
      })
      .from(marketplaceShops)
      .where(and(...where))
      .orderBy(asc(marketplaceShops.createdAt));

    return { workspaceId: params.workspaceId, rows };
  });

  // -----------------------------------------------------------------------
  // Validate a WB API token (without saving)
  // -----------------------------------------------------------------------
  // Note: No workspace check needed — called during first-shop setup when
  // the user may not yet be bound to a workspace. We DO require auth AND a
  // tight per-route rate limit (H11): without it, an authenticated attacker
  // could probe whether a guessed WB key is valid at the global 100/min
  // ceiling. 10/min still supports legit "I mistyped, try again" UX; bulk
  // probing is firmly out of band.
  app.post('/shops/validate-token', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    // Require authenticated user (auth plugin handles this)
    if (!(req as any).user) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    const body = z
      .object({
        wbApiKey: z.string().min(10, 'Токен слишком короткий'),
      })
      .parse((req as any).body ?? {});

    // Локальная проверка типа токена (без сетевого вызова) — отсекает
    // Персональные / чужие Сервисные / просроченные до того как полетим
    // в WB. Это даёт юзеру понятную ошибку (а не сырое 401/403 от WB).
    const inspection = inspectWbToken(body.wbApiKey);
    if (!inspection.ok) {
      return reply.status(400).send({ valid: false, message: inspection.reason ?? 'Токен не подходит' });
    }

    try {
      // Test with a lightweight WB API call (use content-api which has higher rate limit)
      // Direct fetch — interceptor подмешает X-Client-Secret автоматически.
      const res = await fetch('https://content-api.wildberries.ru/content/v2/get/cards/list', {
        method: 'POST',
        headers: {
          'Authorization': body.wbApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ settings: { cursor: { limit: 1 } } }),
        signal: AbortSignal.timeout(20_000), // 20s — WB API can be slow
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status} ${text.slice(0, 100)}`);
      }
      // If we get here without error, the token is valid
      const note = inspection.kind === 'test' ? ' (тестовый токен)' : '';
      return { valid: true, message: `Токен действителен${note}`, kind: inspection.kind };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes('401') || msg.includes('403')) {
        return reply.status(400).send({
          valid: false,
          message: 'Неверный или просроченный токен WB API. Возможные причины: 1) Скопирована не вся строка (токен начинается с «eyJ» и содержит две точки). 2) У токена нет нужных доступов — создайте новый токен с полным доступом (все категории: Контент, Статистика, Аналитика, Цены и скидки, Маркетплейс, Реклама, Поставки, Отзывы, Финансы).',
        });
      }
      // Provide user-friendly message for network errors
      const isNetwork = msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT');
      const userMsg = isNetwork
        ? 'Не удалось подключиться к серверам Wildberries. Проверьте интернет-соединение или попробуйте позже.'
        : `Ошибка проверки: ${msg.slice(0, 200)}`;
      return reply.status(400).send({ valid: false, message: userMsg });
    }
  });

  // -----------------------------------------------------------------------
  // Create a new shop
  // -----------------------------------------------------------------------
  app.post('/shops/:workspaceId', { preHandler: requireRole('manager') },async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(128),
        platform: z.enum(['wb', 'ozon', 'yandex_market']).optional(),
        apiKey: z.string().min(1).optional(),
        clientId: z.string().optional(),
        wbApiKey: z.string().optional(),
        wbDeliveryType: z.enum(['fbo', 'fbs']).default('fbs'),
        taxRegime: z.enum(['usn6', 'usn15', 'osno', 'patent', 'ausn8', 'ausn20']).default('usn15'),
        vatPct: z.coerce.number().min(0).max(100).default(0),
      })
      .parse((req as any).body ?? {});

    const platform = body.platform ?? 'wb';
    const apiKey = body.apiKey ?? body.wbApiKey;
    if (!apiKey) return reply.status(400).send({ error: 'missing_api_key', message: 'API ключ обязателен' });

    if (platform === 'ozon' && !body.clientId) {
      return reply.status(400).send({ error: 'missing_client_id', message: 'Client-Id обязателен для Ozon' });
    }
    if (platform === 'yandex_market' && !body.clientId) {
      return reply.status(400).send({ error: 'missing_campaign_id', message: 'Campaign ID обязателен для Яндекс Маркета' });
    }

    // Validate token first (WB only) — use content-api (faster, no rate limit queue)
    if (platform === 'wb') {
      // Сначала локальная проверка типа JWT — отказываем Персональным/чужим
      // Сервисным до сетевого вызова с понятным сообщением.
      const inspection = inspectWbToken(apiKey);
      if (!inspection.ok) {
        return reply.status(400).send({ error: 'invalid_token_type', message: inspection.reason ?? 'Токен не подходит' });
      }
      try {
        const res = await fetch('https://content-api.wildberries.ru/content/v2/get/cards/list', {
          method: 'POST',
          headers: {
            'Authorization': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ settings: { cursor: { limit: 1 } } }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`${res.status} ${text.slice(0, 100)}`);
        }
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        return reply.status(400).send({ error: 'invalid_token', message: `Токен не прошёл проверку: ${msg.slice(0, 200)}` });
      }
    }

    // Encrypt the API key before storing
    const encryptedApiKey = encrypt(apiKey);
    // H16: compute and store a stable hash for per-workspace dedup.
    const hashedApiKey = apiKeyHash(apiKey);

    const row = await db
      .insert(marketplaceShops)
      .values({
        workspaceId: params.workspaceId,
        platform,
        name: body.name.trim(),
        apiKey: encryptedApiKey,
        apiKeyHash: hashedApiKey,
        clientId: body.clientId ?? null,
        wbDeliveryType: body.wbDeliveryType,
        taxRegime: body.taxRegime,
        vatPct: body.vatPct,
        updatedAt: new Date(),
      })
      .returning({
        shopId: marketplaceShops.shopId,
        platform: marketplaceShops.platform,
        name: marketplaceShops.name,
        wbDeliveryType: marketplaceShops.wbDeliveryType,
        taxRegime: marketplaceShops.taxRegime,
        vatPct: marketplaceShops.vatPct,
        isActive: marketplaceShops.isActive,
        createdAt: marketplaceShops.createdAt,
      });

    // Trigger initial data sync in background (WB only)
    if (platform === 'wb') {
      try {
        const { getQueue, JOB_INITIAL_SYNC } = await import('../jobs/queue.js');
        const boss = await getQueue();
        await boss.send(JOB_INITIAL_SYNC, { workspaceId: params.workspaceId, shopId: row[0].shopId }, {
          retryLimit: 1,
          expireInSeconds: 3600,
        });
        logger.info({ workspaceId: params.workspaceId, shopId: row[0].shopId }, 'Enqueued initial sync for workspace');
      } catch (e) {
        logger.error({ err: e }, 'Failed to enqueue initial sync');
      }
    }

    return { ok: true, shop: row[0] };
  });

  // -----------------------------------------------------------------------
  // Update shop (name, taxRegime, deliveryType)
  // -----------------------------------------------------------------------
  app.patch('/shops/:workspaceId/:shopId', { preHandler: requireRole('manager') },async (req, reply) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        shopId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const body = z
      .object({
        name: z.string().min(1).max(128).optional(),
        apiKey: z.string().optional(),
        clientId: z.string().optional(),
        wbDeliveryType: z.enum(['fbo', 'fbs']).optional(),
        taxRegime: z.enum(['usn6', 'usn15', 'osno', 'patent', 'ausn8', 'ausn20']).optional(),
        vatPct: z.coerce.number().min(0).max(100).optional(),
        isActive: z.boolean().optional(),
      })
      .parse((req as any).body ?? {});


    const updates: Record<string, any> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.apiKey !== undefined) {
      updates.apiKey = encrypt(body.apiKey);
      // H16: keep hash in sync — UPDATE without this would leave a stale
      // dedup hash pointing at the previous token.
      updates.apiKeyHash = apiKeyHash(body.apiKey);
    }
    if (body.clientId !== undefined) updates.clientId = body.clientId;
    if (body.wbDeliveryType !== undefined) updates.wbDeliveryType = body.wbDeliveryType;
    if (body.taxRegime !== undefined) updates.taxRegime = body.taxRegime;
    if (body.vatPct !== undefined) updates.vatPct = String(body.vatPct);
    if (body.isActive !== undefined) updates.isActive = body.isActive;

    const row = await db
      .update(marketplaceShops)
      .set(updates)
      .where(and(
        eq(marketplaceShops.shopId, params.shopId),
        eq(marketplaceShops.workspaceId, params.workspaceId)
      ))
      .returning({
        shopId: marketplaceShops.shopId,
        platform: marketplaceShops.platform,
        name: marketplaceShops.name,
        wbDeliveryType: marketplaceShops.wbDeliveryType,
        taxRegime: marketplaceShops.taxRegime,
        vatPct: marketplaceShops.vatPct,
        isActive: marketplaceShops.isActive,
      });

    if (!row.length) return reply.code(404).send({ ok: false, error: 'not_found' });
    return { ok: true, shop: row[0] };
  });

  // -----------------------------------------------------------------------
  // Delete shop (cascade - removes all related data)
  // -----------------------------------------------------------------------
  app.delete('/shops/:workspaceId/:shopId', { preHandler: requireRole('owner') }, async (req, reply) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        shopId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    // Verify shop exists and belongs to workspace
    const shop = await db
      .select({ shopId: marketplaceShops.shopId })
      .from(marketplaceShops)
      .where(and(
        eq(marketplaceShops.shopId, params.shopId),
        eq(marketplaceShops.workspaceId, params.workspaceId)
      ))
      .limit(1);

    if (!shop.length) {
      return reply.code(404).send({ ok: false, error: 'not_found' });
    }

    try {
      await db.transaction(async (tx) => {
        const shopId = params.shopId;
        
        // Level 3: grandchildren (delete via subquery)
        await tx.execute(sql.raw(`DELETE FROM bidder_actions WHERE rule_id IN (SELECT rule_id FROM bidder_rules WHERE shop_id = ${shopId})`));
        await tx.execute(sql.raw(`DELETE FROM pulse_preset_events WHERE preset_id IN (SELECT preset_id FROM pulse_presets WHERE shop_id = ${shopId})`));
        await tx.execute(sql.raw(`DELETE FROM pulse_preset_group_settings WHERE preset_id IN (SELECT preset_id FROM pulse_presets WHERE shop_id = ${shopId})`));
        await tx.execute(sql.raw(`DELETE FROM pulse_preset_metric_settings WHERE preset_id IN (SELECT preset_id FROM pulse_presets WHERE shop_id = ${shopId})`));
        await tx.execute(sql.raw(`DELETE FROM wb_event_comments WHERE event_id IN (SELECT event_id FROM wb_events WHERE shop_id = ${shopId})`));
        
        // Level 2 & 1: direct children of marketplace_shops
        const dependentTables = [
          'bidder_rules', 'pulse_presets', 'wb_events',
          'wb_tag_products', 'wb_tags',
          'wb_orders_sales_daily_product_warehouses', 'wb_orders_sales_daily_product_regions',
          'wb_orders_sales_daily_warehouses', 'wb_orders_sales_daily_regions',
          'wb_orders_sales_daily_products', 'wb_orders_sales_daily',
          'wb_funnel_daily_products', 'wb_funnel_daily',
          'wb_adv_daily_products', 'wb_adv_daily',
          'wb_finance_daily_products', 'wb_finance_daily', 'wb_finance_weekly_products',
          'wb_fbs_shipments_daily_products',
          'wb_stocks_current', 'wb_stocks_daily_products', 'wb_stocks_daily',
          'wb_storage_daily', 'wb_deductions_daily',
          'wb_spp_weekly', 'wb_supplies', 'wb_search_queries',
          'wb_prices_history', 'wb_returns', 'wb_chats',
          'wb_region_sales', 'wb_cogs',
          'wb_campaigns', 'wb_hidden_products', 'wb_cards', 'wb_card_snapshots', 'wb_sync_runs',
          // wb_supply_box_items, wb_supply_boxes, wb_supply_items не имеют
          // shop_id — каскадятся автоматически через FK ON DELETE CASCADE
          // от wb_supplies (которое выше в списке и имеет shop_id).
          'fbs_runs', 'fbs_schedules', 'seo_keywords'
        ];
        
        for (const table of dependentTables) {
          await tx.execute(sql.raw(`DELETE FROM "${table}" WHERE shop_id = ${shopId}`));
        }
        
        // Finally delete the shop itself
        await tx.delete(marketplaceShops).where(eq(marketplaceShops.shopId, shopId));
      });

      logger.info({ shopId: params.shopId, workspaceId: params.workspaceId }, 'Shop deleted with cascade');
      return { ok: true, deleted: params.shopId };
    } catch (err) {
      logger.error({ err, shopId: params.shopId }, 'Failed to delete shop');
      return reply.code(500).send({ ok: false, error: 'delete_failed', message: String(err).slice(0, 500) });
    }
  });

  // -----------------------------------------------------------------------
  // Get WB API key for a workspace (owner only — sensitive data)
  // SECURITY: Only owner can see the API key, and only masked version
  // -----------------------------------------------------------------------
  app.get('/shops/:workspaceId/api-key', { preHandler: requireRole('owner') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const row = await db
      .select({ apiKey: marketplaceShops.apiKey })
      .from(marketplaceShops)
      .where(and(
        eq(marketplaceShops.workspaceId, params.workspaceId),
        eq(marketplaceShops.platform, 'wb'),
        eq(marketplaceShops.isActive, true)
      ))
      .limit(1);

    if (!row.length) {
      return reply.status(404).send({ error: 'no_shop', message: 'Нет подключённых магазинов' });
    }

    // SECURITY: Return only masked key — never expose full API key to client
    const decryptedApiKey = safeDecrypt(row[0].apiKey);
    if (!decryptedApiKey) {
      return reply.status(500).send({ error: 'decryption_failed', message: 'Не удалось расшифровать API ключ' });
    }
    
    // Mask: show only last 4 characters
    const masked = '•'.repeat(Math.max(0, decryptedApiKey.length - 4)) + decryptedApiKey.slice(-4);
    return { 
      wbApiKeyMasked: masked,
      hasKey: true,
      keyLength: decryptedApiKey.length,
    };
  });
};
