import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../plugins/roleCheck.js';
import { SELLER_AI_PROVIDERS, listSellerAiCredentials, saveSellerAiCredential, deleteSellerAiCredential } from '../services/sellerAiCredentials.js';

const paramsSchema = z.object({ workspaceId: z.coerce.number().int().positive(), provider: z.enum(SELLER_AI_PROVIDERS) });

export const sellerAiRoutes: FastifyPluginAsync = async app => {
  app.get('/ai/:workspaceId/providers', { preHandler: requireRole('viewer') }, async req => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    return { billingMode: 'seller', servicePrice: 0, automationMode: process.env.COMMUNITY_READ_ONLY_AUTOMATIONS === '0' ? 'enabled' : 'manual', canManage: (req as any).userRole === 'owner', providers: await listSellerAiCredentials(workspaceId) };
  });
  app.put('/ai/:workspaceId/providers/:provider', { preHandler: requireRole('owner') }, async req => {
    const { workspaceId, provider } = paramsSchema.parse(req.params);
    const { apiKey } = z.object({ apiKey: z.string().trim().min(10).max(4096).refine(s => !/[\r\n]/.test(s), 'Некорректный ключ'), acceptProviderCharges: z.literal(true) }).strict().parse(req.body);
    // Saving does not call the provider or spend any credits.
    await saveSellerAiCredential(workspaceId, provider, apiKey);
    return { ok: true, providers: await listSellerAiCredentials(workspaceId) };
  });
  app.delete('/ai/:workspaceId/providers/:provider', { preHandler: requireRole('owner') }, async req => {
    const { workspaceId, provider } = paramsSchema.parse(req.params);
    await deleteSellerAiCredential(workspaceId, provider);
    return { ok: true, providers: await listSellerAiCredentials(workspaceId) };
  });
};
