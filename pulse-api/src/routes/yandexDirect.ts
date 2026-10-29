// @ts-nocheck -- recovered from deployed JavaScript; shared-account routes are admin-only.
import { z } from 'zod';
import { env } from '../env.js';
import { requireRole } from '../plugins/roleCheck.js';
import { isAdminUserAsync } from '../lib/security.js';
import { ForbiddenError } from '../lib/errors.js';
import { checkYandexDirect, yandexDirectRequest, YandexDirectError } from '../integrations/yandexDirect/client.js';
function config() {
    const token = env.YANDEX_DIRECT_OAUTH_TOKEN;
    if (!token)
        return null;
    return { token, clientLogin: env.YANDEX_DIRECT_CLIENT_LOGIN };
}
export const yandexDirectRoutes = async (app) => {
    // This legacy integration uses the operator's account, not a seller credential.
    const requireOperator = async (req) => {
        if (!(await isAdminUserAsync(req.user?.userId))) throw new ForbiddenError('Интеграция доступна только администратору сервиса');
    };
    app.get('/integrations/yandex-direct/:workspaceId/status', {
        preHandler: [requireRole('owner'), requireOperator],
    }, async (_req, reply) => {
        const direct = config();
        if (!direct) {
            return { configured: false, connected: false, clientIdConfigured: Boolean(env.YANDEX_DIRECT_CLIENT_ID) };
        }
        try {
            const probe = await checkYandexDirect(direct);
            return {
                configured: true,
                connected: true,
                clientIdConfigured: Boolean(env.YANDEX_DIRECT_CLIENT_ID),
                clientLoginConfigured: Boolean(direct.clientLogin),
                probe,
            };
        }
        catch (error) {
            const status = error instanceof YandexDirectError && error.status === 429 ? 429 : 502;
            return reply.code(status).send({
                configured: true,
                connected: false,
                error: error instanceof Error ? error.message : 'Yandex Direct request failed',
            });
        }
    });
    app.get('/integrations/yandex-direct/:workspaceId/campaigns', {
        preHandler: [requireRole('owner'), requireOperator],
    }, async (req, reply) => {
        const direct = config();
        if (!direct)
            return reply.code(503).send({ error: 'Yandex Direct is not configured' });
        const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
        const payload = await yandexDirectRequest(direct, 'campaigns', {
            method: 'get',
            params: {
                SelectionCriteria: {},
                FieldNames: ['Id', 'Name', 'State', 'Status', 'Type', 'StartDate'],
                Page: { Limit: query.limit },
            },
        });
        return {
            rows: payload?.result?.Campaigns ?? [],
            limitedBy: payload?.result?.LimitedBy ?? null,
        };
    });
};
