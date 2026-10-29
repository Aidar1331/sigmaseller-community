import { issueRecoveryCode } from '../services/recoveryCodes.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { eq, and, gte, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import {
  users,
  userSessions,
  userRefreshTokens,
  workspaces,
  workspaceMembers,
} from '../db/schema.js';
import { verifyPassword, hashPassword } from '../lib/password.js';
import { UnauthorizedError, ConflictError, ValidationError, BadRequestError, ForbiddenError } from '../lib/errors.js';
import { env } from '../env.js';
import {
  sendPasswordResetEmail,
  sendWelcomeEmail,
  sendVerificationEmail,
} from '../lib/email.js';
import log from '../lib/logger.js';
import { sendTelegramPerUser } from '../integrations/telegram.js';

const logger = log.child({ module: 'auth' });

/* ────────────────────────────────────────────────────────────────
 *  Helpers
 * ──────────────────────────────────────────────────────────────── */

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function zodParse<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    throw new ValidationError(message);
  }
  return result.data;
}

/** Parse "7d", "24h", "30m", "15m" into milliseconds. */
function parseExpiry(expr: string, fallbackMs: number): number {
  const match = expr.match(/^(\d+)([dhm])$/);
  if (!match) return fallbackMs;
  const n = Number(match[1]);
  switch (match[2]) {
    case 'd':
      return n * 24 * 3600 * 1000;
    case 'h':
      return n * 3600 * 1000;
    case 'm':
      return n * 60 * 1000;
    default:
      return fallbackMs;
  }
}

const jwtSecret = new TextEncoder().encode(env.JWT_SECRET);

// Access token (short): default 15 min so a leaked cookie decays fast.
// Refresh token (long): default 30 d, stored hashed in user_refresh_tokens.
const ACCESS_EXPIRY_MS = parseExpiry(env.JWT_ACCESS_EXPIRES_IN ?? env.JWT_EXPIRES_IN ?? '15m', 15 * 60 * 1000);
const REFRESH_EXPIRY_MS = parseExpiry(env.JWT_REFRESH_EXPIRES_IN ?? '30d', 30 * 24 * 3600 * 1000);

// Account lockout: 5 consecutive failures → 15-minute lock, per plan.
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

/* ────────────────────────────────────────────────────────────────
 *  Cookie helpers
 * ──────────────────────────────────────────────────────────────── */

/**
 * Set session + refresh cookies and issue CSRF token.
 *
 * - `session` — access JWT, httpOnly, SameSite=Lax so top-level returns
 *   from YooKassa etc. still carry the cookie.
 * - `refresh` — opaque random token, httpOnly, scoped to `/auth/refresh`
 *   so it never leaks on other paths.
 * - `csrf` — random per-session string, NOT httpOnly. Client reads it
 *   and echoes it as `X-CSRF-Token` on mutating requests. See
 *   plugins/csrf.ts.
 */
async function issueSessionCookies(
  reply: FastifyReply,
  userId: number,
  email: string,
): Promise<{ accessExpiresAt: Date; refreshExpiresAt: Date; sessionId: string }> {
  const sessionId = randomUUID();
  const now = Date.now();
  const accessExpiresAt = new Date(now + ACCESS_EXPIRY_MS);
  const refreshExpiresAt = new Date(now + REFRESH_EXPIRY_MS);

  // Session row covers the refresh-token lifetime. The access JWT itself
  // can expire sooner; auth plugin only checks DB session existence.
  await db.insert(userSessions).values({
    sessionId,
    userId,
    expiresAt: refreshExpiresAt,
  });

  const rawRefresh = `${sessionId}.${randomUUID()}.${randomUUID()}`;
  const refreshHash = sha256(rawRefresh);
  await db.insert(userRefreshTokens).values({
    sessionId,
    userId,
    tokenHash: refreshHash,
    expiresAt: refreshExpiresAt,
  });

  // aud/iss claims (H12): prevent token-confusion attacks if JWT_SECRET ever
  // leaks or is reused across services. NOT YET enforced in verify (plugins/auth.ts)
  // because old session JWTs in flight don't carry these — flipping to strict
  // verify would log everyone out. Schedule strict enforcement once typical
  // session TTL has elapsed (JWT_ACCESS_EXPIRES_IN default 15m + REFRESH 30d).
  const accessToken = await new SignJWT({
    sub: String(userId),
    sid: sessionId,
    email,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(accessExpiresAt)
    .setAudience('pulse-api')
    .setIssuer('pulse')
    .sign(jwtSecret);

  const csrfToken = randomUUID();

  const secure = env.NODE_ENV === 'production';
  // F-008 migration: clear legacy `refresh` cookie at path=/auth that users may
  // still have in their browser from before the path fix. Without this, the
  // browser sends both old and new cookies on /api/proxy/auth/refresh — the
  // server can pick the wrong one and 401, defeating the whole fix.
  reply.clearCookie('refresh', { path: '/auth' });
  reply.setCookie('session', accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(ACCESS_EXPIRY_MS / 1000),
  });
  reply.setCookie('refresh', rawRefresh, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    // F-008: must be '/' because frontend hits Next.js proxy at
    // /api/proxy/auth/refresh — a narrower path scope (e.g. '/auth') causes
    // the browser to omit the cookie on that URL, breaking silent refresh.
    path: '/',
    maxAge: Math.floor(REFRESH_EXPIRY_MS / 1000),
  });
  reply.setCookie('csrf', csrfToken, {
    httpOnly: false, // must be JS-readable so the client can echo it
    secure,
    // H15: SameSite=Strict on CSRF. We never need the token on cross-site
    // navigations — same-origin XHR via `apiFetch` reads it in JS and echoes
    // it as a header. Strict limits the blast radius of a stolen token if the
    // user is tricked into clicking a malicious cross-site link.
    sameSite: 'strict',
    path: '/',
    maxAge: Math.floor(REFRESH_EXPIRY_MS / 1000),
  });

  return { accessExpiresAt, refreshExpiresAt, sessionId };
}

function clearAllAuthCookies(reply: FastifyReply) {
  reply.clearCookie('session', { path: '/' });
  reply.clearCookie('refresh', { path: '/' });
  // Also clear legacy path scope so logout actually invalidates old cookies.
  reply.clearCookie('refresh', { path: '/auth' });
  reply.clearCookie('csrf', { path: '/' });
}

/* ────────────────────────────────────────────────────────────────
 *  Routes
 * ──────────────────────────────────────────────────────────────── */

export const authRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /auth/register
   * Creates user + personal workspace + owner membership.
   * Sends email verification link. Login is allowed immediately;
   * /payments/* is blocked until email_verified=true.
   */
  app.post('/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (env.REGISTRATION_DISABLED === '1') {
      throw new ForbiddenError(
        'Регистрация временно закрыта. Оставьте email в листе ожидания — напишем, когда откроем.',
      );
    }

    const body = zodParse(
      z.object({
        email: z.string().email(),
        password: z.string().min(8, 'Password must be at least 8 characters'),
        name: z.string().min(1).max(200).optional(),
      }),
      req.body,
    );

    const [existing] = await db
      .select({ userId: users.userId })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (existing) throw new ConflictError('Email already registered');

    const passwordHash = await hashPassword(body.password);

    // Generate verify token up-front so we can insert it inside the tx.
    const rawVerifyToken = randomUUID();
    const verifyExpires = new Date(Date.now() + 24 * 3600 * 1000);

    const result = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: body.email,
          passwordHash,
          emailVerifyToken: sha256(rawVerifyToken),
          emailVerifyExpiresAt: verifyExpires,
        })
        .returning();
      if (!user) throw new Error('Failed to create user');

      const workspaceName = body.name || `${body.email.split('@')[0]}'s workspace`;
      const [workspace] = await tx.insert(workspaces).values({ name: workspaceName }).returning();
      if (!workspace) throw new Error('Failed to create workspace');

      await tx.insert(workspaceMembers).values({
        workspaceId: workspace.workspaceId,
        userId: user.userId,
        role: 'owner',
      });

      const recoveryCode = await issueRecoveryCode(user.userId, tx);
      return { user, workspace, recoveryCode };
    });

    const { accessExpiresAt } = await issueSessionCookies(
      reply,
      result.user.userId,
      result.user.email,
    );

    // Admin-broadcast: notify all is_admin=true users via their linked
    // Telegram about a new registration. Best-effort — никакая ошибка
    // здесь не должна валить сам signup.
    (async () => {
      try {
        const admins = await db
          .select({ userId: users.userId })
          .from(users)
          .where(eq(users.isAdmin, true));
        const text = [
          '🎉 <b>Новый пользователь</b>',
          `Email: <code>${result.user.email}</code>`,
          `Workspace: <b>${result.workspace.name}</b> (ID ${result.workspace.workspaceId})`,
          `User ID: ${result.user.userId}`,
        ].join('\n');
        await Promise.allSettled(
          admins.map((a) => sendTelegramPerUser(a.userId, text)),
        );
      } catch (err) {
        logger.error({ err }, 'Failed to broadcast register alert to admins');
      }
    })();

    // Community edition does not send paid email.
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send({
      recoveryCode: result.recoveryCode,
      user: {
        userId: result.user.userId,
        email: result.user.email,
        emailVerified: false,
      },
      workspace: {
        workspaceId: result.workspace.workspaceId,
        name: result.workspace.name,
      },
      expiresAt: accessExpiresAt.toISOString(),
    });
  });

  /**
   * POST /auth/waitlist
   * Складывает email в signup_waitlist. Работает всегда — даже когда
   * регистрация открыта (можно использовать как лид-форму на лендинге).
   * Дубли по email тихо игнорируем (returning 200).
   */
  app.post('/auth/waitlist', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = zodParse(
      z.object({
        email: z.string().email(),
        name: z.string().min(1).max(200).optional(),
        source: z.string().max(100).optional(),
      }),
      req.body,
    );

    const ua = req.headers['user-agent'] ?? null;
    const ip = req.ip ?? null;

    await db.execute(sql`
      INSERT INTO signup_waitlist (email, name, source, user_agent, ip)
      VALUES (${body.email}, ${body.name ?? null}, ${body.source ?? null}, ${ua}, ${ip}::inet)
      ON CONFLICT (email) DO NOTHING
    `);

    // Broadcast в TG админам — но best-effort, не валим запрос.
    (async () => {
      try {
        const admins = await db
          .select({ userId: users.userId })
          .from(users)
          .where(eq(users.isAdmin, true));
        const text = [
          '📝 <b>Новая заявка в лист ожидания</b>',
          `Email: <code>${body.email}</code>`,
          body.name ? `Имя: ${body.name}` : null,
          body.source ? `Источник: ${body.source}` : null,
        ].filter(Boolean).join('\n');
        await Promise.allSettled(
          admins.map((a) => sendTelegramPerUser(a.userId, text)),
        );
      } catch (err) {
        logger.error({ err }, 'Failed to broadcast waitlist alert to admins');
      }
    })();

    return reply.code(200).send({ ok: true });
  });

  /**
   * POST /auth/login
   * Account lockout: 5 consecutive failures per email → 15-minute lock.
   * Generic "invalid email or password" on any failure so lockout state
   * can't be probed by attackers.
   */
  app.post('/auth/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = zodParse(
      z.object({ email: z.string().email(), password: z.string().min(1) }),
      req.body,
    );

    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);

    if (!user || !user.passwordHash) {
      throw new UnauthorizedError('Неверный email или пароль');
    }

    // Lockout check BEFORE verifying password so a bot burning through
    // attempts can't time-probe whether the password was right.
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedError(
        'Аккаунт временно заблокирован после нескольких неудачных попыток. Попробуйте через 15 минут.',
      );
    }

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) {
      // Atomically bump counter; apply lockout if we hit the threshold.
      // Use make_interval so the duration is a bound numeric parameter,
      // not a string substitution into a quoted INTERVAL literal.
      await db.execute(sql`
        UPDATE users
        SET failed_login_attempts = failed_login_attempts + 1,
            locked_until = CASE
              WHEN failed_login_attempts + 1 >= ${LOCKOUT_THRESHOLD}
              THEN NOW() + make_interval(mins => ${LOCKOUT_MINUTES})
              ELSE locked_until
            END
        WHERE user_id = ${user.userId}
      `);
      throw new UnauthorizedError('Неверный email или пароль');
    }

    // Successful login: reset counter + lockout.
    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await db
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.userId, user.userId));
    }

    const { accessExpiresAt } = await issueSessionCookies(reply, user.userId, user.email);

    const memberRows = await db
      .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, user.userId));

    return {
      user: {
        userId: user.userId,
        email: user.email,
        emailVerified: user.emailVerified,
      },
      workspaces: memberRows,
      expiresAt: accessExpiresAt.toISOString(),
    };
  });

  /**
   * POST /auth/refresh
   * Accepts a valid `refresh` cookie, rotates it, and issues a new access
   * token. One-shot rotation: the old refresh row is marked revoked and
   * its session is replaced. If someone replays the old token after
   * rotation, we detect it (`revoked_at IS NOT NULL`) and nuke ALL the
   * user's sessions — standard OWASP refresh-rotation compromise defense.
   */
  app.post('/auth/refresh', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.cookies?.refresh;
    if (!raw) throw new UnauthorizedError('No refresh token');

    const tokenHash = sha256(raw);
    const [row] = await db
      .select()
      .from(userRefreshTokens)
      .where(eq(userRefreshTokens.tokenHash, tokenHash))
      .limit(1);

    if (!row) {
      clearAllAuthCookies(reply);
      throw new UnauthorizedError('Invalid refresh token');
    }

    // Replay of a rotated token → compromise suspected.
    if (row.revokedAt) {
      logger.warn({ userId: row.userId }, 'refresh token replay — revoking all sessions');
      await db.delete(userSessions).where(eq(userSessions.userId, row.userId));
      clearAllAuthCookies(reply);
      throw new UnauthorizedError('Refresh token replay detected');
    }

    if (row.expiresAt <= new Date()) {
      clearAllAuthCookies(reply);
      throw new UnauthorizedError('Refresh token expired');
    }

    const [user] = await db.select().from(users).where(eq(users.userId, row.userId)).limit(1);
    if (!user) {
      clearAllAuthCookies(reply);
      throw new UnauthorizedError('User no longer exists');
    }

    // Issue new access+refresh in a fresh session, then revoke the old row.
    const { accessExpiresAt, sessionId: newSessionId } = await issueSessionCookies(
      reply,
      user.userId,
      user.email,
    );

    await db
      .update(userRefreshTokens)
      .set({ revokedAt: new Date(), replacedBySessionId: newSessionId })
      .where(eq(userRefreshTokens.sessionId, row.sessionId));
    // Old access session is kept for a brief grace until its JWT expires
    // naturally (≤15 min). This avoids races where an in-flight request
    // using the old session 401s mid-flight. Cleanup cron picks it up.

    return {
      user: { userId: user.userId, email: user.email, emailVerified: user.emailVerified },
      expiresAt: accessExpiresAt.toISOString(),
    };
  });

  /**
   * POST /auth/logout
   * Invalidates the current session's access JWT and revokes its refresh.
   */
  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies.session;
    if (token) {
      try {
        const { payload } = await jwtVerify(token, jwtSecret);
        if (payload.sid && typeof payload.sid === 'string') {
          await db.delete(userSessions).where(eq(userSessions.sessionId, payload.sid));
          // user_refresh_tokens is ON DELETE CASCADE off user_sessions, so
          // this single delete cleans up both tables.
        }
      } catch {
        // Invalid/expired token — still clear cookies.
      }
    }
    clearAllAuthCookies(reply);
    return { ok: true };
  });

  /**
   * GET /auth/me
   */
  app.get('/auth/me', async (req) => {
    const user = (req as any).user;
    if (!user) throw new UnauthorizedError('Not authenticated');

    const memberRows = await db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        role: workspaceMembers.role,
        name: workspaces.name,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, user.userId));

    const [fullUser] = await db
      .select({ emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.userId, user.userId))
      .limit(1);

    const userWorkspaces = memberRows.map((r) => ({
      workspaceId: r.workspaceId,
      name: r.name,
      role: r.role,
    }));
    const defaultWorkspace =
      userWorkspaces.find((w) => w.role === 'owner') || userWorkspaces[0] || null;

    return {
      user: { ...user, emailVerified: fullUser?.emailVerified ?? false },
      workspaces: userWorkspaces,
      defaultWorkspace,
    };
  });

  /**
   * POST /auth/verify-email
   * Body: { token }
   * One-time: consumes the token and flips email_verified=true.
   */
  app.post('/auth/verify-email', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req) => {
    const body = zodParse(z.object({ token: z.string().uuid() }), req.body);
    const hashed = sha256(body.token);

    const [user] = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.emailVerifyToken, hashed),
          gte(users.emailVerifyExpiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!user) throw new BadRequestError('Ссылка подтверждения недействительна или истекла');

    await db
      .update(users)
      .set({
        emailVerified: true,
        emailVerifyToken: null,
        emailVerifyExpiresAt: null,
      })
      .where(eq(users.userId, user.userId));

    return { ok: true };
  });

  /**
   * POST /auth/resend-verification
   * Authenticated endpoint: re-sends the verification link if the current
   * user hasn't verified yet. Rate-limited to prevent email bombing.
   */
  app.post('/auth/resend-verification', {
    config: { rateLimit: { max: 3, timeWindow: '10 minutes' } },
  }, async (req) => { throw new BadRequestError('Письма отключены. Используйте личный код восстановления на странице входа.'); });

  /**
   * POST /auth/forgot-password
   * Body: { email }
   */
  app.post('/auth/forgot-password', {
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
  }, async (req) => { throw new BadRequestError('Письма отключены. Используйте личный код восстановления на странице входа.'); });

  /**
   * POST /auth/reset-password
   * Body: { token, password }
   */
  app.post('/auth/reset-password', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req) => {
    const body = zodParse(
      z.object({
        token: z.string().uuid(),
        password: z.string().min(8, 'Пароль должен быть минимум 8 символов'),
      }),
      req.body,
    );

    const hashedToken = sha256(body.token);
    const [user] = await db
      .select()
      .from(users)
      .where(
        and(eq(users.resetToken, hashedToken), gte(users.resetExpiresAt, new Date())),
      )
      .limit(1);
    if (!user) throw new UnauthorizedError('Ссылка недействительна или истекла');

    const passwordHash = await hashPassword(body.password);
    await db
      .update(users)
      .set({
        passwordHash,
        resetToken: null,
        resetExpiresAt: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      })
      .where(eq(users.userId, user.userId));

    // Password change invalidates every session (and by cascade, every refresh).
    await db.delete(userSessions).where(eq(userSessions.userId, user.userId));

    return { message: 'Пароль успешно изменён. Войдите с новым паролем.' };
  });
};
