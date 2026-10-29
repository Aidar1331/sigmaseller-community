/**
 * Team management API
 * 
 * Allows workspace owners to manage team members:
 * - List members
 * - Invite new members
 * - Change roles
 * - Remove members
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, isNull, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workspaceMembers, workspaceInvites, users, workspaces } from '../db/schema.js';
import { requireRole, permissions, Role } from '../plugins/roleCheck.js';
import { randomBytes } from 'crypto';

// Schemas
const inviteSchema = z.object({
  email: z.string().email().optional(),
  role: z.enum(['supervisor', 'manager', 'observer']).default('observer'),
  expiresInDays: z.number().min(1).max(30).default(7),
});

const updateRoleSchema = z.object({
  role: z.enum(['supervisor', 'manager', 'observer']),
});

export const teamRoutes: FastifyPluginAsync = async (app) => {
  // ─────────────────────────────────────────────
  // GET /team/:workspaceId/members
  // List all team members
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
  }>('/team/:workspaceId/members', {
    preHandler: requireRole('viewer'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);

    const members = await db
      .select({
        userId: workspaceMembers.userId,
        email: users.email,
        role: workspaceMembers.role,
        invitedBy: workspaceMembers.invitedBy,
        createdAt: workspaceMembers.createdAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.userId))
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(desc(workspaceMembers.createdAt));

    return { members };
  });

  // ─────────────────────────────────────────────
  // POST /team/:workspaceId/invite
  // Create invite link
  // ─────────────────────────────────────────────
  app.post<{
    Params: { workspaceId: string };
    Body: z.infer<typeof inviteSchema>;
  }>('/team/:workspaceId/invite', {
    preHandler: requireRole('owner'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const userId = (request as any).user?.userId;
    const body = inviteSchema.parse(request.body);

    // Generate unique token
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000);

    const [invite] = await db
      .insert(workspaceInvites)
      .values({
        workspaceId,
        role: body.role,
        token,
        createdBy: userId,
        expiresAt,
      })
      .returning();

    // Get workspace name for the invite link
    const workspace = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.workspaceId, workspaceId))
      .limit(1);

    return {
      inviteId: invite.inviteId,
      token,
      role: invite.role,
      expiresAt: invite.expiresAt,
      workspaceName: workspace[0]?.name || 'Unknown',
      // Frontend should construct full URL
      inviteCode: token,
    };
  });

  // ─────────────────────────────────────────────
  // GET /team/:workspaceId/invites
  // List pending invites
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
  }>('/team/:workspaceId/invites', {
    preHandler: requireRole('owner'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const now = new Date();

    const invites = await db
      .select({
        inviteId: workspaceInvites.inviteId,
        role: workspaceInvites.role,
        token: workspaceInvites.token,
        expiresAt: workspaceInvites.expiresAt,
        createdAt: workspaceInvites.createdAt,
      })
      .from(workspaceInvites)
      .where(
        and(
          eq(workspaceInvites.workspaceId, workspaceId),
          isNull(workspaceInvites.usedAt),
          gt(workspaceInvites.expiresAt, now)
        )
      )
      .orderBy(desc(workspaceInvites.createdAt));

    return { invites };
  });

  // ─────────────────────────────────────────────
  // DELETE /team/:workspaceId/invites/:inviteId
  // Revoke an invite
  // ─────────────────────────────────────────────
  app.delete<{
    Params: { workspaceId: string; inviteId: string };
  }>('/team/:workspaceId/invites/:inviteId', {
    preHandler: requireRole('owner'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const inviteId = Number(request.params.inviteId);

    const result = await db
      .delete(workspaceInvites)
      .where(
        and(
          eq(workspaceInvites.inviteId, inviteId),
          eq(workspaceInvites.workspaceId, workspaceId)
        )
      )
      .returning();

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Invite not found' });
    }

    return { success: true };
  });

  // ─────────────────────────────────────────────
  // POST /team/join/:token
  // Accept invite and join workspace
  // ─────────────────────────────────────────────
  app.post<{
    Params: { token: string };
  }>('/team/join/:token', async (request, reply) => {
    const { token } = request.params;
    const userId = (request as any).user?.userId;

    if (!userId) {
      return reply.status(401).send({ error: 'Must be logged in to join' });
    }

    // Find valid invite
    const now = new Date();
    const [invite] = await db
      .select()
      .from(workspaceInvites)
      .where(
        and(
          eq(workspaceInvites.token, token),
          isNull(workspaceInvites.usedAt),
          gt(workspaceInvites.expiresAt, now)
        )
      )
      .limit(1);

    if (!invite) {
      return reply.status(404).send({ error: 'Invalid or expired invite' });
    }

    // Check if already a member
    const existing = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, invite.workspaceId),
          eq(workspaceMembers.userId, userId)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      return reply.status(409).send({ error: 'Already a member of this workspace' });
    }

    // Add as member
    await db.insert(workspaceMembers).values({
      workspaceId: invite.workspaceId,
      userId,
      role: invite.role,
      invitedBy: invite.createdBy,
    });

    // Mark invite as used
    await db
      .update(workspaceInvites)
      .set({ usedAt: now, usedBy: userId })
      .where(eq(workspaceInvites.inviteId, invite.inviteId));

    // Get workspace info
    const workspace = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.workspaceId, invite.workspaceId))
      .limit(1);

    return {
      success: true,
      workspaceId: invite.workspaceId,
      workspaceName: workspace[0]?.name || 'Unknown',
      role: invite.role,
    };
  });

  // ─────────────────────────────────────────────
  // PATCH /team/:workspaceId/members/:userId/role
  // Change member role
  // ─────────────────────────────────────────────
  app.patch<{
    Params: { workspaceId: string; userId: string };
    Body: z.infer<typeof updateRoleSchema>;
  }>('/team/:workspaceId/members/:userId/role', {
    preHandler: requireRole('owner'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const targetUserId = Number(request.params.userId);
    const currentUserId = (request as any).user?.userId;
    const body = updateRoleSchema.parse(request.body);

    // Can't change own role
    if (targetUserId === currentUserId) {
      return reply.status(400).send({ error: 'Cannot change your own role' });
    }

    // Check target is not owner
    const target = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId)
        )
      )
      .limit(1);

    if (target.length === 0) {
      return reply.status(404).send({ error: 'Member not found' });
    }

    if (target[0].role === 'owner') {
      return reply.status(400).send({ error: 'Cannot change owner role' });
    }

    // Update role
    await db
      .update(workspaceMembers)
      .set({ role: body.role })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId)
        )
      );

    return { success: true, newRole: body.role };
  });

  // ─────────────────────────────────────────────
  // DELETE /team/:workspaceId/members/:userId
  // Remove member from workspace
  // ─────────────────────────────────────────────
  app.delete<{
    Params: { workspaceId: string; userId: string };
  }>('/team/:workspaceId/members/:userId', {
    preHandler: requireRole('owner'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const targetUserId = Number(request.params.userId);
    const currentUserId = (request as any).user?.userId;

    // Can't remove self
    if (targetUserId === currentUserId) {
      return reply.status(400).send({ error: 'Cannot remove yourself' });
    }

    // Check target is not owner
    const target = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId)
        )
      )
      .limit(1);

    if (target.length === 0) {
      return reply.status(404).send({ error: 'Member not found' });
    }

    if (target[0].role === 'owner') {
      return reply.status(400).send({ error: 'Cannot remove workspace owner' });
    }

    // Remove member
    await db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId)
        )
      );

    return { success: true };
  });

  // ─────────────────────────────────────────────
  // POST /team/:workspaceId/leave
  // Leave workspace (for non-owners)
  // ─────────────────────────────────────────────
  app.post<{
    Params: { workspaceId: string };
  }>('/team/:workspaceId/leave', async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const userId = (request as any).user?.userId;

    if (!userId) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    // Check current role
    const member = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId)
        )
      )
      .limit(1);

    if (member.length === 0) {
      return reply.status(404).send({ error: 'Not a member of this workspace' });
    }

    if (member[0].role === 'owner') {
      return reply.status(400).send({ error: 'Owner cannot leave. Transfer ownership first.' });
    }

    // Remove self
    await db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId)
        )
      );

    return { success: true };
  });

  // ─────────────────────────────────────────────
  // GET /team/:workspaceId/my-role
  // Get current user's role
  // ─────────────────────────────────────────────
  app.get<{
    Params: { workspaceId: string };
  }>('/team/:workspaceId/my-role', async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const userId = (request as any).user?.userId;

    if (!userId) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const member = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId)
        )
      )
      .limit(1);

    if (member.length === 0) {
      return { role: null, isMember: false };
    }

    return {
      role: member[0].role,
      isMember: true,
      permissions: {
        canManageTeam: permissions.canManageTeam(member[0].role as Role),
        canEditData: permissions.canEditData(member[0].role as Role),
        canRunOperations: permissions.canRunOperations(member[0].role as Role),
        canManageSubscription: permissions.canManageSubscription(member[0].role as Role),
        canManageShops: permissions.canManageShops(member[0].role as Role),
      },
    };
  });

  // =========================================================================
  // WB USERS (Seller Account Users from WB API)
  // =========================================================================

  const { getWbApiKey } = await import('../integrations/wb/wbClient.js');
  const { getUsers, inviteUser, updateUser, deleteUser, getRoles, getPermissions } = await import('../integrations/wb/users.js');

  /**
   * Get WB seller account users
   */
  app.get<{
    Params: { workspaceId: string };
  }>('/team/:workspaceId/wb-users', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);

    const _shopId = (request.query as any)?.shopId ? Number((request.query as any).shopId) : undefined;
    let apiKey: string;
    try {
      apiKey = await getWbApiKey(workspaceId, _shopId);
    } catch {
      return { error: 'No WB API key configured', users: [] };
    }
    if (!apiKey) {
      return { error: 'No WB API key configured', users: [] };
    }

    try {
      const result = await getUsers(apiKey);
      return result;
    } catch (e: any) {
      return { error: e.message, users: [] };
    }
  });

  /**
   * Get WB roles
   */
  app.get<{
    Params: { workspaceId: string };
  }>('/team/:workspaceId/wb-roles', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);

    const _shopId = (request.query as any)?.shopId ? Number((request.query as any).shopId) : undefined;
    let apiKey: string;
    try {
      apiKey = await getWbApiKey(workspaceId, _shopId);
    } catch {
      return { error: 'No WB API key configured', roles: [] };
    }
    if (!apiKey) {
      return { error: 'No WB API key configured', roles: [] };
    }

    try {
      const result = await getRoles(apiKey);
      return result;
    } catch (e: any) {
      return { error: e.message, roles: [] };
    }
  });

  /**
   * Get WB permissions
   */
  app.get<{
    Params: { workspaceId: string };
  }>('/team/:workspaceId/wb-permissions', {
    preHandler: requireRole('viewer'),
  }, async (request) => {
    const workspaceId = Number(request.params.workspaceId);

    const _shopId = (request.query as any)?.shopId ? Number((request.query as any).shopId) : undefined;
    const apiKey = await getWbApiKey(workspaceId, _shopId);
    if (!apiKey) {
      return { error: 'No WB API key configured', permissions: [] };
    }

    try {
      const result = await getPermissions(apiKey);
      return result;
    } catch (e: any) {
      return { error: e.message, permissions: [] };
    }
  });

  /**
   * Invite WB user
   */
  app.post<{
    Params: { workspaceId: string };
    Body: {
      email: string;
      firstName: string;
      lastName: string;
      roleId?: number;
      permissions?: string[];
    };
  }>('/team/:workspaceId/wb-users', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const { email, firstName, lastName, roleId, permissions } = request.body;

    const _shopId = (request.query as any)?.shopId ? Number((request.query as any).shopId) : undefined;
    const apiKey = await getWbApiKey(workspaceId, _shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', ok: false });
    }

    try {
      const result = await inviteUser(apiKey, { email, firstName, lastName, roleId, permissions });
      return { ok: true, ...result };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });

  /**
   * Update WB user
   */
  app.patch<{
    Params: { workspaceId: string; userId: string };
    Body: {
      firstName?: string;
      lastName?: string;
      roleId?: number;
      permissions?: string[];
      isActive?: boolean;
    };
  }>('/team/:workspaceId/wb-users/:userId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const userId = Number(request.params.userId);
    const { firstName, lastName, roleId, permissions, isActive } = request.body;

    const _shopId = (request.query as any)?.shopId ? Number((request.query as any).shopId) : undefined;
    const apiKey = await getWbApiKey(workspaceId, _shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', ok: false });
    }

    try {
      const result = await updateUser(apiKey, userId, { firstName, lastName, roleId, permissions, isActive });
      return { ok: true, ...result };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });

  /**
   * Delete WB user
   */
  app.delete<{
    Params: { workspaceId: string; userId: string };
  }>('/team/:workspaceId/wb-users/:userId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const workspaceId = Number(request.params.workspaceId);
    const userId = Number(request.params.userId);

    const _shopId = (request.query as any)?.shopId ? Number((request.query as any).shopId) : undefined;
    const apiKey = await getWbApiKey(workspaceId, _shopId);
    if (!apiKey) {
      return reply.code(400).send({ error: 'No WB API key configured', ok: false });
    }

    try {
      await deleteUser(apiKey, userId);
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const code = /not\s*found/i.test(msg) ? 404 : 502;
      return reply.code(code).send({ error: msg, ok: false });
    }
  });
};
