import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../plugins/roleCheck.js';
import { aiSingleRateLimit } from '../lib/expensiveRouteLimits.js';

export const seoGeneratorRoutes: FastifyPluginAsync = async (app) => {
  app.post('/seo/generate', {
    preHandler: requireRole('manager'),
    config: aiSingleRateLimit,
  }, async (req) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const body = z.object({
      nmId: z.number(),
      tone: z.enum(['informative', 'marketing', 'premium']).default('marketing'),
      keywords: z.array(z.string()).optional(),
      competitorTexts: z.array(z.string()).optional(),
    }).parse(req.body);

    const { generateSeoTexts } = await import('../services/seoGenerator/index.js');
    const result = await generateSeoTexts({ wsId, ...body });
    return result;
  });
};
