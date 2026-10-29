/**
 * Action Queue status endpoints.
 *
 * UI uses these to poll progress of dangerous AI agent actions that were
 * enqueued from a chat turn ("set price on 5 SKUs + reply to 10 reviews"
 * lives as 15 rows in `agent_actions`; the UI shows their evolving status).
 *
 * Endpoints:
 *   GET /agent-actions?ids=1,2,3                 — point-lookup by id list
 *   GET /agent-actions/by-conversation/:convId   — all actions in a chat thread
 *
 * Both endpoints honour workspace isolation: the workspace plugin already
 * extracts and validates `workspaceId` from the session; we filter agent_actions
 * by that workspaceId so a user can't peek at another tenant's queue by
 * guessing actionIds.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentActions } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';
import { BadRequestError } from '../lib/errors.js';

const MAX_IDS_PER_QUERY = 50;

function getWorkspaceId(req: any): number {
  // requireRole middleware валидирует доступ, но НЕ декорирует request
  // полем workspaceId. Поэтому читаем из query/params/body — там же где
  // его берёт сам roleCheck (см. plugins/roleCheck.ts:108-115).
  const bodyWid = typeof req?.body?.workspaceId !== 'undefined' ? Number(req.body.workspaceId) : NaN;
  const ws = Number(req?.params?.workspaceId) || Number(req?.query?.workspaceId) || (Number.isFinite(bodyWid) ? bodyWid : NaN);
  if (!ws || !Number.isFinite(ws)) {
    throw new BadRequestError('workspaceId required (pass as ?workspaceId=N)');
  }
  return ws;
}

interface ActionStatusRow {
  actionId: number;
  status: string;
  actionType: string;
  retryCount: number;
  lastError: string | null;
  queuedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  result: unknown;
  conversationId: number | null;
}

function projectRow(r: typeof agentActions.$inferSelect): ActionStatusRow {
  return {
    actionId: Number(r.actionId),
    status: r.status,
    actionType: r.actionType,
    retryCount: r.retryCount ?? 0,
    lastError: r.lastError ?? null,
    queuedAt: r.queuedAt ?? null,
    startedAt: r.startedAt ?? null,
    completedAt: r.completedAt ?? null,
    result: r.result ?? null,
    conversationId: r.conversationId !== null && r.conversationId !== undefined ? Number(r.conversationId) : null,
  };
}

export const agentActionsRoutes: FastifyPluginAsync = async (app) => {
  // ───────────────────────────────────────────────────────────────────────
  // GET /agent-actions?ids=1,2,3
  //
  // Point lookup. Returns rows in the SAME order as the input ids; missing
  // ids are silently dropped (UI should compare lengths to detect them).
  // ───────────────────────────────────────────────────────────────────────
  app.get('/agent-actions', { preHandler: requireRole('viewer') }, async (req) => {
    const wsId = getWorkspaceId(req as never);
    const { ids: rawIds } = z
      .object({
        ids: z.string().min(1),
      })
      .parse(req.query);

    const ids = rawIds
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (ids.length === 0) {
      return { actions: [] as ActionStatusRow[] };
    }
    if (ids.length > MAX_IDS_PER_QUERY) {
      throw new BadRequestError(`too many ids (max ${MAX_IDS_PER_QUERY})`);
    }

    const rows = await db
      .select()
      .from(agentActions)
      .where(and(
        eq(agentActions.workspaceId, wsId),
        inArray(agentActions.actionId, ids as number[]),
      ));

    // Preserve client-requested order; this matters for the UI which renders
    // the batch as "1 of 15", "2 of 15", ...
    const byId = new Map(rows.map((r) => [Number(r.actionId), r]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean) as Array<typeof agentActions.$inferSelect>;

    return { actions: ordered.map(projectRow) };
  });

  // ───────────────────────────────────────────────────────────────────────
  // GET /agent-actions/by-conversation/:conversationId
  //
  // All actions linked to one chat conversation. Useful when the UI doesn't
  // remember the actionIds (e.g. after page reload) but still has the
  // conversationId from the URL.
  // ───────────────────────────────────────────────────────────────────────
  app.get('/agent-actions/by-conversation/:conversationId', { preHandler: requireRole('viewer') }, async (req) => {
    const wsId = getWorkspaceId(req as never);
    const { conversationId } = z
      .object({ conversationId: z.coerce.number().int().positive() })
      .parse(req.params);

    const rows = await db
      .select()
      .from(agentActions)
      .where(and(
        eq(agentActions.workspaceId, wsId),
        eq(agentActions.conversationId, conversationId),
      ))
      .orderBy(agentActions.queuedAt as never);

    return { conversationId, actions: rows.map(projectRow) };
  });
};
