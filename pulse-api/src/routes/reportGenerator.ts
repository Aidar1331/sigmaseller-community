/**
 * AI Report Generation routes — weekly/monthly analytics reports.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../plugins/roleCheck.js';
import { heavyReportRateLimit } from '../lib/expensiveRouteLimits.js';

export const reportGeneratorRoutes: FastifyPluginAsync = async (app) => {
  // Generate report
  app.post('/reports/generate', {
    preHandler: requireRole('manager'),
    config: heavyReportRateLimit,
  }, async (req) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const body = z.object({
      period: z.enum(['weekly', 'monthly']).default('weekly'),
    }).parse(req.body);

    const { generateReport } = await import('../services/reportGenerator/index.js');
    const report = await generateReport(wsId, body.period);

    return { report };
  });
};
