import type { FastifyRequest } from 'fastify';

/**
 * Extract shopId from query params.
 * Used by routes to get the optional shopId filter value.
 * The frontend api.ts already injects shopId into every request's query params.
 */
export function extractShopId(request: FastifyRequest): number | undefined {
  const raw = (request.query as any)?.shopId;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
