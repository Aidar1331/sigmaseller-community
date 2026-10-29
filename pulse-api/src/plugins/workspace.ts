import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workspaceMembers, marketplaceShops } from '../db/schema.js';
import { ForbiddenError } from '../lib/errors.js';
import { isValidApiKey } from '../lib/security.js';
import { env } from '../env.js';

export type WorkspaceRole = 'owner' | 'supervisor' | 'manager' | 'observer' | 'viewer';

/** Canonical role hierarchy — single source of truth for permission checks. */
const ROLE_HIERARCHY: Record<WorkspaceRole, number> = {
  viewer: 1,
  observer: 1,
  manager: 2,
  supervisor: 3,
  owner: 4,
};

export interface WorkspaceMember {
  workspaceId: number;
  userId: number;
  role: WorkspaceRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    workspaceMember?: WorkspaceMember;
  }
}

/**
 * Extract workspaceId from request (params, query, or body)
 */
export function extractWorkspaceId(req: FastifyRequest): number | null {
  const params = (req.params as Record<string, unknown>) ?? {};
  const query = (req.query as Record<string, unknown>) ?? {};
  const body = (req.body as Record<string, unknown>) ?? {};

  const raw = params.workspaceId ?? query.workspaceId ?? body.workspaceId;
  if (raw === undefined || raw === null || raw === '') return null;
  
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Paths that don't require workspace authorization
 */
const BYPASS_PATHS = [
  '/health',
  '/auth/login',
  '/auth/logout',
  '/auth/me',
  '/auth/register',
  '/docs',
  '/documentation',
];

const BYPASS_PREFIXES = [
  '/docs/',
  '/documentation/',
  '/admin/',
];

/**
 * Check if user has access to workspace with minimum required role
 */
export async function checkWorkspaceAccess(
  userId: number,
  workspaceId: number,
  minRole?: WorkspaceRole
): Promise<WorkspaceMember | null> {
  const [member] = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .limit(1);

  if (!member) return null;

  if (minRole) {
    const memberLevel = ROLE_HIERARCHY[member.role as WorkspaceRole] ?? 0;
    const requiredLevel = ROLE_HIERARCHY[minRole] ?? 0;
    if (memberLevel < requiredLevel) return null;
  }

  return member as WorkspaceMember;
}

/**
 * Workspace authorization plugin
 * 
 * Checks that authenticated users have access to the workspace
 * they're trying to access (via workspaceId in params/query/body)
 */
const workspacePluginImpl: FastifyPluginAsync = async (app) => {
  app.log.info('Workspace authorization enabled');

  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0];

    // Skip bypass paths
    if (BYPASS_PATHS.includes(path)) return;
    for (const prefix of BYPASS_PREFIXES) {
      if (path.startsWith(prefix)) return;
    }

    // No workspace context → skip (let route handle it)
    const workspaceId = extractWorkspaceId(req);
    if (!workspaceId) return;

    // API key auth → skip workspace check (for scripts, cron, etc.)
    // But ONLY if the key is valid!
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string' && isValidApiKey(apiKey)) return;

    // No user context → skip (auth plugin will reject)
    const user = (req as any).user;
    if (!user?.userId) return;

    // Check workspace membership
    const member = await checkWorkspaceAccess(user.userId, workspaceId);
    if (!member) {
      throw new ForbiddenError('You do not have access to this workspace');
    }

    // Attach member info to request
    req.workspaceMember = member;

    // Validate shopId belongs to this workspace.
    // Read from params, query, body — the original code missed `params`, so a
    // route like `GET /shops/:shopId/...` would silently bypass the cross-shop
    // check. We now look in all three locations and reject any shopId that
    // doesn't match the workspace.
    const params = (req.params as Record<string, unknown>) ?? {};
    const query = (req.query as Record<string, unknown>) ?? {};
    const body = (req.body as Record<string, unknown>) ?? {};
    const rawShopId = params.shopId ?? query.shopId ?? body.shopId;
    if (rawShopId !== undefined && rawShopId !== null && rawShopId !== '') {
      const shopId = Number(rawShopId);
      if (Number.isFinite(shopId) && shopId > 0) {
        const [validShop] = await db
          .select({ shopId: marketplaceShops.shopId })
          .from(marketplaceShops)
          .where(and(
            eq(marketplaceShops.shopId, shopId),
            eq(marketplaceShops.workspaceId, workspaceId),
          ))
          .limit(1);
        if (!validShop) {
          // Audit: tampered or stale shopId. Log the workspace, the offered
          // shop, and the path so we can detect probing.
          req.log.warn(
            { workspaceId, attemptedShopId: shopId, path },
            'cross-workspace shopId rejected',
          );
          throw new ForbiddenError('Shop does not belong to this workspace');
        }
      } else {
        // Garbage non-numeric shopId — refuse rather than silently dropping it.
        throw new ForbiddenError('Invalid shopId');
      }
    }
  });
};

export default fp(workspacePluginImpl, {
  name: 'workspace-plugin',
  dependencies: ['auth-plugin'],
});

/**
 * Helper to require minimum role in a route handler
 */
export function requireRole(req: FastifyRequest, minRole: WorkspaceRole): void {
  const member = req.workspaceMember;
  if (!member) {
    throw new ForbiddenError('Workspace access required');
  }

  const memberLevel = ROLE_HIERARCHY[member.role] ?? 0;
  const requiredLevel = ROLE_HIERARCHY[minRole] ?? 0;

  if (memberLevel < requiredLevel) {
    throw new ForbiddenError(`This action requires ${minRole} role or higher`);
  }
}
