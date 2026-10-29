import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { knowledgeEntries } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { requireRole } from '../plugins/roleCheck.js';

export const knowledgeBaseRoutes: FastifyPluginAsync = async (app) => {
  // List entries
  app.get('/knowledge-base', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);

    const entries = await db.select()
      .from(knowledgeEntries)
      .where(and(eq(knowledgeEntries.workspaceId, wsId), eq(knowledgeEntries.isActive, true)))
      .orderBy(desc(knowledgeEntries.updatedAt))
      .limit(200);

    return { entries };
  });

  // Create entry
  app.post('/knowledge-base', { preHandler: requireRole('manager') }, async (req) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const body = z.object({
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(5000),
      scopeType: z.string().default('workspace'),
      scopeKey: z.string().default('default'),
      entryType: z.enum(['faq', 'complaint_solution', 'product_feature', 'brand_voice', 'general']).default('general'),
      category: z.string().optional(),
      nmIds: z.array(z.number()).default([]),
      tags: z.array(z.string()).default([]),
      priority: z.number().int().min(0).max(100).default(0),
    }).parse(req.body);

    const [entry] = await db.insert(knowledgeEntries).values({
      workspaceId: wsId,
      ...body,
    }).returning();

    return { entry };
  });

  // Update entry
  app.put('/knowledge-base/:id', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const entryId = Number((req.params as any).id);
    const body = z.object({
      title: z.string().min(1).max(200).optional(),
      content: z.string().min(1).max(5000).optional(),
      entryType: z.enum(['faq', 'complaint_solution', 'product_feature', 'brand_voice', 'general']).optional(),
      category: z.string().optional(),
      nmIds: z.array(z.number()).optional(),
      tags: z.array(z.string()).optional(),
      priority: z.number().int().min(0).max(100).optional(),
    }).parse(req.body);

    const [updated] = await db.update(knowledgeEntries)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(knowledgeEntries.entryId, entryId), eq(knowledgeEntries.workspaceId, wsId)))
      .returning();

    if (!updated) return reply.code(404).send({ error: 'Not found' });
    return { entry: updated };
  });

  // Delete (soft)
  app.delete('/knowledge-base/:id', { preHandler: requireRole('manager') }, async (req) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const entryId = Number((req.params as any).id);

    await db.update(knowledgeEntries)
      .set({ isActive: false })
      .where(and(eq(knowledgeEntries.entryId, entryId), eq(knowledgeEntries.workspaceId, wsId)));

    return { ok: true };
  });
};
