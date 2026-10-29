/**
 * Access-control middleware.
 *
 * Workspace roles, in descending privilege order:
 *
 *   owner > supervisor > manager > observer > viewer
 *
 * A handler decorated with `requireRole('manager')` accepts owner, supervisor,
 * and manager — but rejects observer and viewer (403).
 *
 *   - requireRole(role)  — gates by workspace membership AND role hierarchy.
 *   - requireAdmin()     — system admin (users.is_admin or ADMIN_USER_IDS)
 *                          or a valid API key. Used for /admin/* and refund.
 *
 * API-key auth bypasses workspace role gates: the key itself is the credential.
 *
 * History: an earlier "single-user workspace" simplification turned
 * `requireRole` into a no-op (only membership was checked). That made every
 * 'owner'-tagged route accessible to any workspace viewer. Now that team
 * invites (`/team/:ws/invite`) are wired up and can create non-owner members,
 * the no-op gate was a privilege-escalation hole. This file re-enforces the
 * hierarchy implied by every existing `requireRole('X')` call site.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workspaceMembers } from '../db/schema.js';
import { isValidApiKey, isAdminUserAsync } from '../lib/security.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'roleCheck' });

export type Role = 'owner' | 'supervisor' | 'manager' | 'observer' | 'viewer';

/**
 * Privilege rank — higher number = more privileged. Compared in
 * `hasMinimumRole` and `requireRole`. Keep the gap between tiers so that
 * inserting a new tier later doesn't require renumbering.
 */
const ROLE_RANK: Record<Role, number> = {
  viewer: 10,
  observer: 20,
  manager: 30,
  supervisor: 40,
  owner: 50,
};

/**
 * Return the role string stored for this (user, workspace), or null if the
 * user isn't a member.
 */
export async function getUserRole(userId: number, workspaceId: number): Promise<Role | null> {
  const member = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (member.length === 0) return null;
  return member[0].role as Role;
}

/**
 * Does `userRole` meet or exceed `requiredRole` in the privilege hierarchy?
 *
 * Examples:
 *   hasMinimumRole('owner', 'manager')    -> true
 *   hasMinimumRole('manager', 'owner')    -> false
 *   hasMinimumRole('viewer', 'viewer')    -> true
 *
 * Unknown role strings (legacy / DB drift) are treated as the most-restricted
 * tier (viewer) — fail closed.
 */
export function hasMinimumRole(userRole: Role, requiredRole: Role): boolean {
  const have = ROLE_RANK[userRole] ?? ROLE_RANK.viewer;
  const need = ROLE_RANK[requiredRole] ?? ROLE_RANK.viewer;
  return have >= need;
}

/**
 * preHandler: require that the request is an authenticated user who
 * belongs to the workspace in the route params, AND whose role meets or
 * exceeds `minimumRole`.
 */
export function requireRole(minimumRole: Role = 'viewer') {
  return async function checkMembership(request: FastifyRequest, reply: FastifyReply) {
    // API key auth has full access.
    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      if (!isValidApiKey(apiKey)) {
        return reply.status(403).send({ error: 'Invalid API key' });
      }
      logger.debug({ route: request.url, method: request.method }, 'API key access');
      return;
    }

    const userId = (request as any).user?.userId ?? (request as any).userId;
    if (!userId) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const bodyWid =
      typeof (request.body as any)?.workspaceId !== 'undefined'
        ? Number((request.body as any).workspaceId)
        : NaN;
    const workspaceId =
      Number((request.params as any).workspaceId) ||
      Number((request.query as any).workspaceId) ||
      (Number.isFinite(bodyWid) ? bodyWid : NaN);

    if (!workspaceId || isNaN(workspaceId)) {
      return reply.status(400).send({ error: 'Missing workspaceId' });
    }

    const userRole = await getUserRole(userId, workspaceId);
    if (!userRole) {
      return reply.status(403).send({ error: 'No access to this workspace' });
    }

    if (!hasMinimumRole(userRole, minimumRole)) {
      return reply.status(403).send({
        error: 'Insufficient role',
        required: minimumRole,
        actual: userRole,
      });
    }

    (request as any).userRole = userRole;
  };
}

/**
 * Decorator to add role info to request (still used by some handlers
 * that read `request.userRole` for UI hints — harmless under the new
 * model).
 */
export function attachRole() {
  return async function (request: FastifyRequest, _reply: FastifyReply) {
    const userId = (request as any).user?.userId ?? (request as any).userId;
    const workspaceId = Number((request.params as any).workspaceId);
    if (userId && workspaceId && !isNaN(workspaceId)) {
      const userRole = await getUserRole(userId, workspaceId);
      (request as any).userRole = userRole;
    }
  };
}

/**
 * Require system-admin access (not workspace-scoped). Used by /admin/*
 * and /payments/refund.
 */
export function requireAdmin() {
  return async function checkAdmin(request: FastifyRequest, reply: FastifyReply) {
    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      if (!isValidApiKey(apiKey)) {
        return reply.status(403).send({ error: 'Invalid API key' });
      }
      return;
    }

    const userId = (request as any).user?.userId;
    if (!userId) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    if (!(await isAdminUserAsync(userId))) {
      return reply.status(403).send({ error: 'Admin access required' });
    }
  };
}

/**
 * Permission helpers used by some route handlers for UI-side conditional
 * rendering or last-line server-side gates. Each predicate compares the
 * member's role against the minimum tier required for that capability.
 *
 * Keep these in sync with the `requireRole(...)` decorations on the
 * corresponding write endpoints.
 */
export const permissions = {
  canManageTeam: (role: Role) => hasMinimumRole(role, 'owner'),
  canManageSubscription: (role: Role) => hasMinimumRole(role, 'owner'),
  canManageShops: (role: Role) => hasMinimumRole(role, 'owner'),
  canEditPlan: (role: Role) => hasMinimumRole(role, 'owner'),
  canEditData: (role: Role) => hasMinimumRole(role, 'manager'),
  canRunOperations: (role: Role) => hasMinimumRole(role, 'manager'),
  canViewFinance: (role: Role) => hasMinimumRole(role, 'manager'),
  canViewData: (role: Role) => hasMinimumRole(role, 'viewer'),
};
