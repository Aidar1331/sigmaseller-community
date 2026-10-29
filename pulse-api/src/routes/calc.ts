import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../plugins/roleCheck.js';
import { calcAbTest } from '../agents/tools/calcAbTest.js';

export const calcRoutes: FastifyPluginAsync = async (app) => {
  app.post('/calc/ab-test', { preHandler: requireRole('viewer') }, async (req) => {
    const body = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        shopId: z.coerce.number().int().positive().optional(),
        nmId: z.coerce.number().int().positive(),
        changeDate: z.string().min(10).max(10),
        periodDaysBefore: z.coerce.number().int().min(1).max(90).optional(),
        periodDaysAfter: z.coerce.number().int().min(1).max(90).optional(),
        changeDescription: z.string().min(1).max(500),
      })
      .parse(req.body);

    const raw = await calcAbTest({
      nmId: body.nmId,
      changeDate: body.changeDate,
      periodDaysBefore: body.periodDaysBefore,
      periodDaysAfter: body.periodDaysAfter,
      changeDescription: body.changeDescription,
      _workspaceId: body.workspaceId,
      _shopId: body.shopId,
    });

    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  });
};
