/**
 * Returns API Routes
 * 
 * Manage buyer returns
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../plugins/roleCheck.js';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { extractShopId } from '../plugins/shopFilter.js';
import {
  getReturns,
  getReturnDetails,
  approveReturn,
  rejectReturn,
  getReturnsStatistics,
} from '../integrations/wb/returns.js';

export const returnsRoutes: FastifyPluginAsync = async (app) => {
  // GET /returns/:workspaceId
  // List returns
  app.get<{
    Params: { workspaceId: string };
    Querystring: {
      status?: 'pending' | 'approved' | 'rejected' | 'processing';
      from?: string;
      to?: string;
      nmId?: string;
      limit?: string;
      offset?: string;
    };
  }>('/returns/:workspaceId', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { status, from, to, nmId, limit, offset } = request.query;

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return { error: 'No WB API key configured', data: [], total: 0 };
    }

    try {
      // status legacy → isArchive: «approved/rejected» = в архиве, остальное = на рассмотрении.
      const isArchive = status === 'approved' || status === 'rejected';
      const result = await getReturns(apiKey, {
        isArchive,
        nmId: nmId ? Number(nmId) : undefined,
        limit: limit ? Number(limit) : 50,
        offset: offset ? Number(offset) : 0,
      });
      void from; void to;

      return result;
    } catch (e: any) {
      return { error: e.message, data: [], total: 0 };
    }
  });

  // GET /returns/:workspaceId/statistics
  // Get returns statistics
  app.get<{
    Params: { workspaceId: string };
    Querystring: { from?: string; to?: string };
  }>('/returns/:workspaceId/statistics', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { from, to } = request.query;

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return { error: 'No WB API key configured' };
    }

    try {
      const stats = await getReturnsStatistics(apiKey, {
        dateFrom: from,
        dateTo: to,
      });

      return stats;
    } catch (e: any) {
      return { error: e.message };
    }
  });

  // GET /returns/:workspaceId/:returnId
  // Get single return details
  app.get<{
    Params: { workspaceId: string; returnId: string };
  }>('/returns/:workspaceId/:returnId', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const returnId = Number(request.params.returnId);

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return { error: 'No WB API key configured' };
    }

    try {
      const returnData = await getReturnDetails(apiKey, returnId);
      return returnData;
    } catch (e: any) {
      return { error: e.message };
    }
  });

  // PATCH /returns/:workspaceId/:returnId/approve
  // Approve a return
  app.patch<{
    Params: { workspaceId: string; returnId: string };
    Body: { comment?: string };
  }>('/returns/:workspaceId/:returnId/approve', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const returnId = Number(request.params.returnId);
    const { comment } = request.body || {};

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', ok: false });
    }

    try {
      await approveReturn(apiKey, { returnId, comment });
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });

  // PATCH /returns/:workspaceId/:returnId/reject
  // Reject a return
  app.patch<{
    Params: { workspaceId: string; returnId: string };
    Body: { reason: string; comment?: string };
  }>('/returns/:workspaceId/:returnId/reject', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const returnId = Number(request.params.returnId);
    const { reason, comment } = request.body;

    if (!reason) {
      return reply.code(400).send({ error: 'Reason is required', ok: false });
    }

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', ok: false });
    }

    try {
      await rejectReturn(apiKey, { returnId, reason, comment });
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });
};
