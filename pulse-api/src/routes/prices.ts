import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getWbApiKey, wbGetJson, wbPostJson } from '../integrations/wb/wbClient.js';
import { requireRole } from '../plugins/roleCheck.js';
import { extractShopId } from '../plugins/shopFilter.js';

const BASE = 'https://discounts-prices-api.wildberries.ru/api/v2';

export const pricesRoutes: FastifyPluginAsync = async (app) => {
  // List goods with prices (pagination)
  app.get('/prices/:workspaceId/goods', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(1000).default(100),
        offset: z.coerce.number().int().min(0).default(0),
        filterNmID: z.coerce.number().int().optional(),
      })
      .parse(req.query);

    const shopId = extractShopId(req);
    const apiKey = await getWbApiKey(params.workspaceId, shopId);
    const qs = new URLSearchParams({
      limit: String(q.limit),
      offset: String(q.offset),
    });
    if (q.filterNmID) qs.set('filterNmID', String(q.filterNmID));

    const url = `${BASE}/list/goods/filter?${qs.toString()}`;
    try {
      const data = await wbGetJson(url, apiKey);
      return { workspaceId: params.workspaceId, data };
    } catch (err: any) {
      req.log.error({ err: err?.message, url }, 'prices/goods fetch failed');
      throw err;
    }
  });

  // List goods by nmList (POST)
  app.post('/prices/:workspaceId/goods', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ nmList: z.array(z.coerce.number().int().positive()).min(1).max(1000) }).parse(req.body);
    const shopId = extractShopId(req);
    const apiKey = await getWbApiKey(params.workspaceId, shopId);
    const data = await wbPostJson(`${BASE}/list/goods/filter`, apiKey, body);
    return { workspaceId: params.workspaceId, data };
  });

  // List sizes with prices (by nmID)
  app.get('/prices/:workspaceId/goods/sizes', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const q = z
      .object({
        nmID: z.coerce.number().int().positive(),
        limit: z.coerce.number().int().min(1).max(1000),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const shopId = extractShopId(req);
    const apiKey = await getWbApiKey(params.workspaceId, shopId);
    const qs = new URLSearchParams({
      nmID: String(q.nmID),
      limit: String(q.limit),
      offset: String(q.offset),
    });
    const url = `${BASE}/list/goods/size/nm?${qs.toString()}`;
    const data = await wbGetJson(url, apiKey);
    return { workspaceId: params.workspaceId, data };
  });

  // Quarantine goods
  app.get('/prices/:workspaceId/quarantine', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(1000),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const shopId = extractShopId(req);
    const apiKey = await getWbApiKey(params.workspaceId, shopId);
    const qs = new URLSearchParams({
      limit: String(q.limit),
      offset: String(q.offset),
    });
    const data = await wbGetJson(`${BASE}/quarantine/goods?${qs.toString()}`, apiKey);
    return { workspaceId: params.workspaceId, data };
  });

  // Upload prices/discounts
  app.post('/prices/:workspaceId/upload', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ data: z.array(z.any()).min(1).max(1000) }).parse(req.body);
    const shopId = extractShopId(req);
    const apiKey = await getWbApiKey(params.workspaceId, shopId);
    const data = await wbPostJson(`${BASE}/upload/task`, apiKey, body);
    return { workspaceId: params.workspaceId, data };
  });

  // Upload size prices
  app.post('/prices/:workspaceId/upload/size', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ data: z.array(z.any()).min(1).max(1000) }).parse(req.body);
    const shopId = extractShopId(req);
    const apiKey = await getWbApiKey(params.workspaceId, shopId);
    const data = await wbPostJson(`${BASE}/upload/task/size`, apiKey, body);
    return { workspaceId: params.workspaceId, data };
  });

  // Upload club discounts
  app.post('/prices/:workspaceId/upload/club-discount', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ data: z.array(z.any()).min(1).max(1000) }).parse(req.body);
    const shopId = extractShopId(req);
    const apiKey = await getWbApiKey(params.workspaceId, shopId);
    const data = await wbPostJson(`${BASE}/upload/task/club-discount`, apiKey, body);
    return { workspaceId: params.workspaceId, data };
  });

  // Upload status — состояние обработанной загрузки цен/скидок.
  // 2026-05-26: WB переименовала /history/tasks → /buffer/tasks. Поддерживаем
  // оба роут-пути, бэкенд идёт на актуальный /buffer/tasks.
  const uploadStatusHandler = async (req: any) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const q = z.object({ uploadID: z.coerce.number().int().positive() }).parse(req.query);
    const shopId = extractShopId(req);
    const apiKey = await getWbApiKey(params.workspaceId, shopId);
    const qs = new URLSearchParams({ uploadID: String(q.uploadID) });
    const data = await wbGetJson(`${BASE}/buffer/tasks?${qs.toString()}`, apiKey);
    return { workspaceId: params.workspaceId, data };
  };
  app.get('/prices/:workspaceId/history/tasks', { preHandler: requireRole('viewer') }, uploadStatusHandler);
  app.get('/prices/:workspaceId/buffer/tasks', { preHandler: requireRole('viewer') }, uploadStatusHandler);

  // Upload details
  app.get('/prices/:workspaceId/history/goods', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const q = z
      .object({
        uploadID: z.coerce.number().int().positive(),
        limit: z.coerce.number().int().min(1).max(1000),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const shopId = extractShopId(req);
    const apiKey = await getWbApiKey(params.workspaceId, shopId);
    const qs = new URLSearchParams({
      uploadID: String(q.uploadID),
      limit: String(q.limit),
      offset: String(q.offset),
    });
    // 2026-05-26: /history/goods/task → /buffer/goods/task.
    const data = await wbGetJson(`${BASE}/buffer/goods/task?${qs.toString()}`, apiKey);
    return { workspaceId: params.workspaceId, data };
  });

  // Alias под актуальное имя endpoint'а (см. историю /history → /buffer выше).
  app.get('/prices/:workspaceId/buffer/goods/task', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const q = z
      .object({
        uploadID: z.coerce.number().int().positive(),
        limit: z.coerce.number().int().min(1).max(1000),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const shopId = extractShopId(req);
    const apiKey = await getWbApiKey(params.workspaceId, shopId);
    const qs = new URLSearchParams({
      uploadID: String(q.uploadID),
      limit: String(q.limit),
      offset: String(q.offset),
    });
    const data = await wbGetJson(`${BASE}/buffer/goods/task?${qs.toString()}`, apiKey);
    return { workspaceId: params.workspaceId, data };
  });

  // Price history for a specific product
  // GET /api/v2/history/goods/price
  app.get('/prices/:workspaceId/history/price', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const q = z
      .object({
        nmID: z.coerce.number().int().positive(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const shopId = extractShopId(req);
    const apiKey = await getWbApiKey(params.workspaceId, shopId);
    const qs = new URLSearchParams({
      nmID: String(q.nmID),
      limit: String(q.limit),
      offset: String(q.offset),
    });
    const data = await wbGetJson(`${BASE}/history/goods/price?${qs.toString()}`, apiKey);
    return { workspaceId: params.workspaceId, data };
  });
};
