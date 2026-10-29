/**
 * Content API Routes
 *
 * Manage WB product cards
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../plugins/roleCheck.js';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { extractShopId } from '../plugins/shopFilter.js';
import {
  getCardsList,
  getCard,
  safeUpdateCard,
  updateCards,
  getSubjectCharacteristics,
  getAllSubjects,
  getCardLimits,
} from '../integrations/wb/content.js';

// --- Zod schemas for input validation ---
const workspaceIdParam = z.object({ workspaceId: z.string().regex(/^\d+$/) });

const cardsListBody = z.object({
  cursor: z.object({
    nmID: z.number().optional(),
    updatedAt: z.string().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  }).optional(),
  filter: z.object({
    textSearch: z.string().optional(),
    withPhoto: z.number().optional(),
    tagIDs: z.array(z.number()).optional(),
    objectIDs: z.array(z.number()).optional(),
    brands: z.array(z.string()).optional(),
    imtID: z.number().optional(),
    nmID: z.number().optional(),
  }).optional(),
}).optional();

const updateCardBody = z.object({
  vendorCode: z.string().min(1, 'vendorCode is required'),
  title: z.string().optional(),
  description: z.string().optional(),
  characteristics: z.array(z.object({
    id: z.number(),
    value: z.union([z.string(), z.array(z.string())]),
  })).optional(),
  dimensions: z.object({
    length: z.number(),
    width: z.number(),
    height: z.number(),
  }).optional(),
});

const bulkUpdateBody = z.object({
  cards: z.array(z.object({
    nmID: z.number(),
    vendorCode: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    characteristics: z.array(z.object({
      id: z.number(),
      value: z.union([z.string(), z.array(z.string())]),
    })).optional(),
  })).min(1, 'cards array is required'),
});

export const contentRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Get cards list
   */
  app.post<{
    Params: { workspaceId: string };
    Body: {
      cursor?: { nmID?: number; updatedAt?: string; limit?: number };
      filter?: {
        textSearch?: string;
        withPhoto?: number;
        tagIDs?: number[];
        objectIDs?: number[];
        brands?: string[];
        imtID?: number;
        nmID?: number;
      };
    };
  }>('/content/:workspaceId/cards', {
    preHandler: requireRole('viewer'),
  }, async (request, reply) => {
    workspaceIdParam.parse(request.params);
    const parsed = cardsListBody.parse(request.body);
    const workspaceId = Number(request.params.workspaceId);
    const { cursor, filter } = parsed || {};

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', cards: [], cursor: null });
    }

    try {
      const result = await getCardsList(apiKey, {
        cursor: cursor ? { ...cursor, limit: cursor.limit || 100 } : { limit: 100 },
        filter,
      });

      return result;
    } catch (e: any) {
      return reply.code(502).send({ error: e.message, cards: [], cursor: null });
    }
  });

  /**
   * Get single card
   */
  app.get<{
    Params: { workspaceId: string; nmId: string };
  }>('/content/:workspaceId/cards/:nmId', {
    preHandler: requireRole('viewer'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const nmId = Number(request.params.nmId);

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', card: null });
    }

    try {
      const card = await getCard(apiKey, nmId);
      if (!card) {
        return reply.code(404).send({ error: 'Card not found', card: null });
      }
      return { card };
    } catch (e: any) {
      return reply.code(502).send({ error: e.message, card: null });
    }
  });

  /**
   * Update card
   */
  app.patch<{
    Params: { workspaceId: string; nmId: string };
    Body: {
      vendorCode: string;
      title?: string;
      description?: string;
      characteristics?: Array<{ id: number; value: string | string[] }>;
      dimensions?: { length: number; width: number; height: number };
    };
  }>('/content/:workspaceId/cards/:nmId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const nmId = Number(request.params.nmId);
    const { vendorCode, title, description, characteristics, dimensions } = updateCardBody.parse(request.body);

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', ok: false });
    }

    try {
      // safeUpdateCard читает текущую карточку и мержит patch, чтобы поля
      // которые не переданы в запросе не были занулены в WB.
      const result = await safeUpdateCard(apiKey, nmId, {
        title,
        description,
        characteristics,
        dimensions,
      });

      return { ok: !result.error, ...result };
    } catch (e: any) {
      return reply.code(502).send({ error: e.message, ok: false });
    }
  });

  /**
   * Bulk update cards.
   *
   * ВНИМАНИЕ: эта ручка отправляет payload в WB как есть (без safeUpdateCard).
   * Caller должен передавать ПОЛНЫЙ payload по каждой карточке. Если поле в
   * payload отсутствует — WB занулит его на карточке (включая characteristics).
   * Для безопасной частичной правки используй POST /content/:ws/cards/:nm.
   */
  app.patch<{
    Params: { workspaceId: string };
    Body: {
      cards: Array<{
        nmID: number;
        vendorCode: string;
        title?: string;
        description?: string;
        characteristics?: Array<{ id: number; value: string | string[] }>;
      }>;
    };
  }>('/content/:workspaceId/cards', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const { cards } = bulkUpdateBody.parse(request.body);

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', ok: false });
    }

    try {
      const result = await updateCards(apiKey, cards);
      return { ok: !result.error, ...result };
    } catch (e: any) {
      return reply.code(502).send({ error: e.message, ok: false });
    }
  });

  /**
   * Get characteristics for a subject (category)
   */
  app.get<{
    Params: { workspaceId: string; subjectId: string };
  }>('/content/:workspaceId/subjects/:subjectId/characteristics', {
    preHandler: requireRole('viewer'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const subjectId = Number(request.params.subjectId);

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', data: [] });
    }

    try {
      const result = await getSubjectCharacteristics(apiKey, subjectId);
      return result;
    } catch (e: any) {
      return reply.code(502).send({ error: e.message, data: [] });
    }
  });

  /**
   * Get all subjects (categories)
   */
  app.get<{
    Params: { workspaceId: string };
    Querystring: { name?: string; limit?: string; offset?: string };
  }>('/content/:workspaceId/subjects', {
    preHandler: requireRole('viewer'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const { name, limit, offset } = request.query;

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', data: [] });
    }

    try {
      const result = await getAllSubjects(apiKey, {
        name,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      return result;
    } catch (e: any) {
      return reply.code(502).send({ error: e.message, data: [] });
    }
  });

  /**
   * Get card limits
   */
  app.get<{
    Params: { workspaceId: string };
  }>('/content/:workspaceId/limits', {
    preHandler: requireRole('viewer'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured' });
    }

    try {
      const result = await getCardLimits(apiKey);
      return result;
    } catch (e: any) {
      return reply.code(502).send({ error: e.message });
    }
  });
};
