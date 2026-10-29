/**
 * Chat API Routes
 * 
 * Manage buyer chats
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../plugins/roleCheck.js';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { extractShopId } from '../plugins/shopFilter.js';
import {
  getChats,
  getChatMessages,
  sendMessage,
  sendFile,
  sendImage,
  markChatAsRead,
  getUnreadCount,
} from '../integrations/wb/chats.js';

export const chatRoutes: FastifyPluginAsync = async (app) => {
  // GET /chat/:workspaceId
  // List chats
  app.get<{
    Params: { workspaceId: string };
    Querystring: {
      status?: 'active' | 'closed';
      unreadOnly?: string;
      limit?: string;
      offset?: string;
    };
  }>('/chat/:workspaceId', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { status, unreadOnly, limit, offset } = request.query;

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return { error: 'No WB API key configured', data: [], total: 0 };
    }

    try {
      // 2026-05-26: API мигрировал на cursor (next) вместо offset. Если в
      // query пришёл offset как строка-cursor — пробрасываем как next.
      const result = await getChats(apiKey, {
        status,
        unreadOnly: unreadOnly === 'true',
        limit: limit ? Number(limit) : 50,
        next: offset || undefined,
      });

      return result;
    } catch (e: any) {
      return { error: e.message, data: [], total: 0 };
    }
  });

  // GET /chat/:workspaceId/unread-count
  // Get unread count
  app.get<{
    Params: { workspaceId: string };
  }>('/chat/:workspaceId/unread-count', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return { error: 'No WB API key configured', count: 0 };
    }

    try {
      const result = await getUnreadCount(apiKey);
      return result;
    } catch (e: any) {
      return { error: e.message, count: 0 };
    }
  });

  // GET /chat/:workspaceId/:chatId/messages
  // Get chat messages
  app.get<{
    Params: { workspaceId: string; chatId: string };
    Querystring: { limit?: string; offset?: string };
  }>('/chat/:workspaceId/:chatId/messages', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);
    const { chatId } = request.params;
    const { limit, offset } = request.query;

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return { error: 'No WB API key configured', data: [] };
    }

    try {
      const result = await getChatMessages(apiKey, chatId, {
        limit: limit ? Number(limit) : 50,
        next: offset || undefined,
      });

      return result;
    } catch (e: any) {
      return { error: e.message, data: [] };
    }
  });

  // POST /chat/:workspaceId/:chatId/send
  // Send text message
  app.post<{
    Params: { workspaceId: string; chatId: string };
    Body: { text: string };
  }>('/chat/:workspaceId/:chatId/send', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const { chatId } = request.params;
    const { text } = request.body;

    if (!text?.trim()) {
      return reply.code(400).send({ error: 'Text is required', ok: false });
    }

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', ok: false });
    }

    try {
      const result = await sendMessage(apiKey, chatId, text);
      return { ok: true, messageId: result.messageId };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });

  // POST /chat/:workspaceId/:chatId/send/file
  // Send file
  app.post<{
    Params: { workspaceId: string; chatId: string };
    Body: { fileUrl: string; fileName: string };
  }>('/chat/:workspaceId/:chatId/send/file', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const { chatId } = request.params;
    const { fileUrl, fileName } = request.body;

    if (!fileUrl || !fileName) {
      return reply.code(400).send({ error: 'fileUrl and fileName are required', ok: false });
    }

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', ok: false });
    }

    try {
      const result = await sendFile(apiKey, chatId, fileUrl, fileName);
      return { ok: true, messageId: result.messageId };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });

  // POST /chat/:workspaceId/:chatId/send/image
  // Send image
  app.post<{
    Params: { workspaceId: string; chatId: string };
    Body: { imageUrl: string };
  }>('/chat/:workspaceId/:chatId/send/image', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const { chatId } = request.params;
    const { imageUrl } = request.body;

    if (!imageUrl) {
      return reply.code(400).send({ error: 'imageUrl is required', ok: false });
    }

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', ok: false });
    }

    try {
      const result = await sendImage(apiKey, chatId, imageUrl);
      return { ok: true, messageId: result.messageId };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });

  // POST /chat/:workspaceId/:chatId/read
  // Mark chat as read
  app.post<{
    Params: { workspaceId: string; chatId: string };
  }>('/chat/:workspaceId/:chatId/read', {
    preHandler: requireRole('viewer'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const { chatId } = request.params;

    const shopId = extractShopId(request);
    const apiKey = await getWbApiKey(workspaceId, shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', ok: false });
    }

    try {
      await markChatAsRead(apiKey, chatId);
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });
};
