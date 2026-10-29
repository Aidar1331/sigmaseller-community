import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../plugins/roleCheck.js';
import { getBalance, getUsageHistory, topUp, checkBalance } from '../services/aiTokens.js';

export const aiBalanceRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /ai/:workspaceId/balance
   * Get current AI token balance for workspace
   */
  app.get('/ai/:workspaceId/balance', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const balance = await getBalance(params.workspaceId);
    // Display balance in whole rubles (floor for balance — never overstate spendable;
    // ceil for spent so that the visible total does not lag behind real deductions).
    return {
      ok: true,
      billingMode: 'seller',
      ...balance,
      balanceRub: Math.floor(balance.balanceKopecks / 100),
      totalSpentRub: Math.ceil(balance.totalSpentKopecks / 100),
      totalToppedUpRub: Math.floor(balance.totalToppedUpKopecks / 100),
    };
  });

  /**
   * GET /ai/:workspaceId/balance/check
   * Check if workspace has enough balance for an AI request
   */
  app.get('/ai/:workspaceId/balance/check', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    return checkBalance(params.workspaceId);
  });

  /**
   * GET /ai/:workspaceId/usage
   * Get AI usage history for workspace
   */
  app.get('/ai/:workspaceId/usage', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      })
      .parse(req.query);

    const result = await getUsageHistory({
      workspaceId: params.workspaceId,
      ...query,
    });

    return { ok: true, ...result };
  });

  /**
   * POST /ai/:workspaceId/top-up
   * Top up AI token balance (manual, for testing; production uses YooKassa webhook)
   */
  app.post('/ai/:workspaceId/top-up', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        amountKopecks: z.coerce.number().int().positive().optional(),
        amountRub: z.coerce.number().positive().optional(),
      })
      .parse((req as any).body ?? {});

    const amountKopecks = body.amountKopecks ?? (body.amountRub ? Math.round(body.amountRub * 100) : 0);
    if (amountKopecks <= 0) {
      return reply.code(400).send({ ok: false, error: 'Amount must be positive' });
    }

    const userId = (req as any).user?.userId;
    if (!userId) {
      return reply.code(401).send({ ok: false, error: 'Unauthorized: userId not found' });
    }
    const result = await topUp({
      workspaceId: params.workspaceId,
      userId,
      amountKopecks,
    });

    return {
      ok: true,
      newBalanceKopecks: result.newBalanceKopecks,
      newBalanceRub: result.newBalanceKopecks / 100,
    };
  });
};
