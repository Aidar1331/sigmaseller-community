import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { checkWorkspaceAccess, extractWorkspaceId } from './workspace.js';
import { isValidApiKey } from '../lib/security.js';
import { ForbiddenError } from '../lib/errors.js';
import { runWithAiWorkspace } from '../lib/sellerAiContext.js';

const plugin: FastifyPluginAsync = async app => {
  app.addHook('preHandler', (req, _reply, done) => {
    const ids = [req.params, req.query, req.body].flatMap(value => {
      const raw = (value as Record<string, unknown> | undefined)?.workspaceId;
      return raw === undefined || raw === null || raw === '' ? [] : [Number(raw)];
    });
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size > 1) {
      done(new ForbiddenError('Некорректный или неоднозначный магазин')); return;
    }
    const id = extractWorkspaceId(req);
    if (!id) { runWithAiWorkspace(null, done); return; }
    const check = async () => {
      const apiKey = req.headers['x-api-key'];
      const trusted = typeof apiKey === 'string' && isValidApiKey(apiKey);
      if (!trusted && (!req.user || !(await checkWorkspaceAccess(req.user.userId, id)))) {
        throw new ForbiddenError('Нет доступа к этому магазину');
      }
      // Callback executes the rest of Fastify's lifecycle in this isolated context.
      runWithAiWorkspace(id, done);
    };
    void check().catch(done);
  });
};

export default fp(plugin, { name: 'seller-ai-context', dependencies: ['auth-plugin', 'workspace-plugin'] });
