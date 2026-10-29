import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { pulseMetricGroups, pulseMetricsCatalog } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';

export const metricsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/metrics/catalog', { preHandler: requireRole('viewer') },async (req) => {
    z.object({}).parse(req.query);

    const groups = await db
      .select()
      .from(pulseMetricGroups)
      .orderBy(asc(pulseMetricGroups.sortOrder));

    const metrics = await db
      .select()
      .from(pulseMetricsCatalog)
      .orderBy(asc(pulseMetricsCatalog.groupId), asc(pulseMetricsCatalog.sortOrder));

    return { groups, metrics };
  });
};
