import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentSettings } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';

const agentSettingsSchema = z.object({
  workspaceId: z.number().int().positive(),
  actorUserId: z.number().int().positive(),

  // Auto-reply
  autoReplyPositive: z.boolean().optional(),
  autoReplyNeutral: z.boolean().optional(),
  autoReplyRequiresApproval: z.boolean().optional(),

  // Pricing
  autoPriceProtectOos: z.boolean().optional(),
  minMarginPct: z.number().int().min(0).max(100).nullable().optional(),
  maxPriceChangePct: z.number().int().min(1).max(50).nullable().optional(),

  // Bidder
  autoBidOptimize: z.boolean().optional(),
  maxBidRub: z.number().int().min(0).nullable().optional(),

  // Notifications
  telegramChatId: z.string().nullable().optional(),
  telegramCritical: z.boolean().optional(),
  telegramBriefing: z.boolean().optional(),

  // Agent behaviour
  agentModel: z.string().nullable().optional(),
  agentMaxTokensPerDay: z.number().int().min(0).nullable().optional(),
});

export const agentSettingsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /agent-settings?workspaceId=...
   * Returns the single agent settings row for the workspace (or null if not yet created).
   */
  app.get('/agent-settings', { preHandler: requireRole('viewer') }, async (req) => {
    const q = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
      })
      .parse(req.query);

    const [row] = await db
      .select()
      .from(agentSettings)
      .where(eq(agentSettings.workspaceId, q.workspaceId))
      .limit(1);

    return { row: row ?? null };
  });

  /**
   * POST /agent-settings
   * Upsert agent settings for the workspace (create if missing, update if exists).
   */
  app.post('/agent-settings', { preHandler: requireRole('manager') }, async (req) => {
    const body = agentSettingsSchema.parse(req.body);
    const now = new Date();

    // Check if settings already exist
    const [existing] = await db
      .select({ settingId: agentSettings.settingId })
      .from(agentSettings)
      .where(eq(agentSettings.workspaceId, body.workspaceId))
      .limit(1);

    if (existing) {
      // Update existing
      const [row] = await db
        .update(agentSettings)
        .set({
          autoReplyPositive: body.autoReplyPositive,
          autoReplyNeutral: body.autoReplyNeutral,
          autoReplyRequiresApproval: body.autoReplyRequiresApproval,
          autoPriceProtectOos: body.autoPriceProtectOos,
          minMarginPct: body.minMarginPct,
          maxPriceChangePct: body.maxPriceChangePct,
          autoBidOptimize: body.autoBidOptimize,
          maxBidRub: body.maxBidRub,
          telegramChatId: body.telegramChatId,
          telegramCritical: body.telegramCritical,
          telegramBriefing: body.telegramBriefing,
          agentModel: body.agentModel,
          agentMaxTokensPerDay: body.agentMaxTokensPerDay,
          updatedAt: now,
        })
        .where(eq(agentSettings.workspaceId, body.workspaceId))
        .returning();

      return { row, created: false };
    }

    // Create new
    const [row] = await db
      .insert(agentSettings)
      .values({
        workspaceId: body.workspaceId,
        autoReplyPositive: body.autoReplyPositive ?? false,
        autoReplyNeutral: body.autoReplyNeutral ?? false,
        autoReplyRequiresApproval: body.autoReplyRequiresApproval ?? true,
        autoPriceProtectOos: body.autoPriceProtectOos ?? false,
        minMarginPct: body.minMarginPct ?? null,
        maxPriceChangePct: body.maxPriceChangePct ?? 10,
        autoBidOptimize: body.autoBidOptimize ?? false,
        maxBidRub: body.maxBidRub ?? null,
        telegramChatId: body.telegramChatId ?? null,
        telegramCritical: body.telegramCritical ?? false,
        telegramBriefing: body.telegramBriefing ?? false,
        agentModel: body.agentModel ?? null,
        agentMaxTokensPerDay: body.agentMaxTokensPerDay ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return { row, created: true };
  });

  /**
   * DELETE /agent-settings?workspaceId=...
   * Deletes the agent settings for the workspace (resets to defaults).
   */
  app.delete('/agent-settings', { preHandler: requireRole('owner') }, async (req) => {
    const q = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);

    const [row] = await db
      .delete(agentSettings)
      .where(eq(agentSettings.workspaceId, q.workspaceId))
      .returning();

    return { row: row ?? null, deleted: !!row };
  });
};
