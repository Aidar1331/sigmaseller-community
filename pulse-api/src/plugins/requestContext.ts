/**
 * Request context plugin for structured logging
 * 
 * Adds contextual information to all log messages:
 * - requestId
 * - workspaceId
 * - userId
 * - route
 * - method
 * - durationMs (on response)
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { randomUUID } from 'crypto';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    startTime: number;
  }
}

const requestContextPlugin: FastifyPluginAsync = async (app) => {
  // Add request ID and start time
  app.addHook('onRequest', async (request) => {
    request.requestId = (request.headers['x-request-id'] as string) || randomUUID();
    request.startTime = Date.now();
    
    // Add context to child logger
    request.log = request.log.child({
      requestId: request.requestId,
    });
  });

  // Log request with context
  app.addHook('preHandler', async (request) => {
    const workspaceId = (request.params as any)?.workspaceId 
      || (request.query as any)?.workspaceId 
      || (request.body as any)?.workspaceId;
    const userId = (request as any).userId;

    // Enrich logger with user/workspace context
    request.log = request.log.child({
      ...(workspaceId && { workspaceId: Number(workspaceId) }),
      ...(userId && { userId }),
      route: request.routeOptions?.url || request.url,
      method: request.method,
    });
  });

  // Log response with duration
  app.addHook('onResponse', async (request, reply) => {
    const durationMs = Date.now() - request.startTime;
    
    request.log.info({
      statusCode: reply.statusCode,
      durationMs,
    }, 'request completed');
  });

  // Add request ID to response headers
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-ID', request.requestId);
  });
};

export default fp(requestContextPlugin, { name: 'request-context' });
