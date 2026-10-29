/**
 * Agent Domain Rules CRUD API (Multi-Agent v2).
 *
 * GET    /agent-rules/:workspaceId        — List rules (optional filter by agentName)
 * GET    /agent-rules/:workspaceId/:ruleId — Get single rule
 * POST   /agent-rules/:workspaceId        — Create rule
 * PATCH  /agent-rules/:workspaceId/:ruleId — Update rule (yaml, enabled, scope)
 * DELETE /agent-rules/:workspaceId/:ruleId — Delete rule
 *
 * rule_yaml is validated as well-formed YAML (parse check). Domain-specific
 * schema validation happens per-agent in Phase 1+ (pricingRulesSchema etc.).
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentDomainRules } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';

const KNOWN_AGENTS = ['pricing', 'reviews', 'ads', 'supply', 'seo', 'chat', 'fbs'] as const;
const SCOPE_TYPES = ['global', 'category', 'nmid_list'] as const;

const createSchema = z.object({
  agentName: z.enum(KNOWN_AGENTS),
  shopId: z.number().int().positive().nullable().optional(),
  scopeType: z.enum(SCOPE_TYPES).default('global'),
  scopeValue: z.any().optional(),
  ruleYaml: z.string().min(1).max(50000),
  enabled: z.boolean().default(true),
});

const updateSchema = z.object({
  scopeType: z.enum(SCOPE_TYPES).optional(),
  scopeValue: z.any().optional(),
  ruleYaml: z.string().min(1).max(50000).optional(),
  enabled: z.boolean().optional(),
});

export const agentRulesRoutes: FastifyPluginAsync = async (app) => {
  // GET /agent-rules/:workspaceId
  app.get('/agent-rules/:workspaceId', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const { agentName, shopId } = z.object({
      agentName: z.enum(KNOWN_AGENTS).optional(),
      // When set, returns only shop-scoped rules for that shop.
      // When omitted, returns all rules (both global and per-shop) for the workspace.
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const conditions = [eq(agentDomainRules.workspaceId, workspaceId)];
    if (agentName) conditions.push(eq(agentDomainRules.agentName, agentName));
    if (shopId != null) conditions.push(eq(agentDomainRules.shopId, shopId));

    const rules = await db
      .select()
      .from(agentDomainRules)
      .where(and(...conditions))
      .orderBy(desc(agentDomainRules.updatedAt));

    return { rules, count: rules.length };
  });

  // GET /agent-rules/:workspaceId/:ruleId
  app.get('/agent-rules/:workspaceId/:ruleId', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { workspaceId, ruleId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
      ruleId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const [rule] = await db
      .select()
      .from(agentDomainRules)
      .where(and(eq(agentDomainRules.ruleId, ruleId), eq(agentDomainRules.workspaceId, workspaceId)))
      .limit(1);

    if (!rule) return reply.code(404).send({ error: 'rule_not_found' });
    return { rule };
  });

  // POST /agent-rules/:workspaceId
  app.post('/agent-rules/:workspaceId', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = createSchema.parse(req.body);

    const [rule] = await db
      .insert(agentDomainRules)
      .values({
        workspaceId,
        shopId: body.shopId ?? null,
        agentName: body.agentName,
        scopeType: body.scopeType,
        scopeValue: body.scopeValue ?? null,
        ruleYaml: body.ruleYaml,
        enabled: body.enabled,
      })
      .returning();

    return reply.code(201).send({ rule });
  });

  // PATCH /agent-rules/:workspaceId/:ruleId
  app.patch('/agent-rules/:workspaceId/:ruleId', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { workspaceId, ruleId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
      ruleId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const body = updateSchema.parse(req.body);

    const patch: Partial<typeof agentDomainRules.$inferInsert> = { updatedAt: new Date() };
    if (body.scopeType !== undefined) patch.scopeType = body.scopeType;
    if (body.scopeValue !== undefined) patch.scopeValue = body.scopeValue;
    if (body.ruleYaml !== undefined) patch.ruleYaml = body.ruleYaml;
    if (body.enabled !== undefined) patch.enabled = body.enabled;

    const [rule] = await db
      .update(agentDomainRules)
      .set(patch)
      .where(and(eq(agentDomainRules.ruleId, ruleId), eq(agentDomainRules.workspaceId, workspaceId)))
      .returning();

    if (!rule) return reply.code(404).send({ error: 'rule_not_found' });
    return { rule };
  });

  // DELETE /agent-rules/:workspaceId/:ruleId
  app.delete('/agent-rules/:workspaceId/:ruleId', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { workspaceId, ruleId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
      ruleId: z.coerce.number().int().positive(),
    }).parse(req.params);

    const [deleted] = await db
      .delete(agentDomainRules)
      .where(and(eq(agentDomainRules.ruleId, ruleId), eq(agentDomainRules.workspaceId, workspaceId)))
      .returning();

    if (!deleted) return reply.code(404).send({ error: 'rule_not_found' });
    return reply.code(204).send();
  });
};
