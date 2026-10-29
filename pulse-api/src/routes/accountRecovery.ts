import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { verifyPassword } from '../lib/password.js';
import { UnauthorizedError } from '../lib/errors.js';
import { issueRecoveryCode, resetWithRecoveryCode } from '../services/recoveryCodes.js';

export const accountRecoveryRoutes: FastifyPluginAsync = async app => {
  app.post('/auth/recovery-code', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!req.user) throw new UnauthorizedError('Войдите в аккаунт');
    const body = z.object({ password: z.string().min(1).max(1024) }).strict().parse(req.body);
    const [user] = await db.select({ userId: users.userId, passwordHash: users.passwordHash }).from(users).where(eq(users.userId, req.user.userId)).limit(1);
    if (!user?.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) throw new UnauthorizedError('Неверный пароль');
    reply.header('Cache-Control', 'no-store');
    return { recoveryCode: await issueRecoveryCode(user.userId) };
  });
  app.post('/auth/reset-with-code', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ email: z.string().email().transform(s => s.toLowerCase().trim()), recoveryCode: z.string().min(64).max(100).regex(/^[a-fA-F0-9\s-]+$/), password: z.string().min(8).max(1024) }).strict().parse(req.body);
    const replacementCode = await resetWithRecoveryCode(body.email, body.recoveryCode, body.password);
    if (!replacementCode) throw new UnauthorizedError('Email или код восстановления неверен');
    reply.header('Cache-Control', 'no-store');
    return { ok: true, recoveryCode: replacementCode };
  });
};
