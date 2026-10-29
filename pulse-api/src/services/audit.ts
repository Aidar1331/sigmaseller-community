/**
 * Audit logging service
 * 
 * Logs user actions for security and debugging
 */

import { db } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { FastifyRequest } from 'fastify';
import log from '../lib/logger.js';

const logger = log.child({ module: 'audit' });

export type AuditAction =
  | 'login'
  | 'logout'
  | 'register'
  | 'password_change'
  | 'team.invite'
  | 'team.join'
  | 'team.leave'
  | 'team.role_change'
  | 'team.remove'
  | 'shop.create'
  | 'shop.update'
  | 'shop.delete'
  | 'cogs.update'
  | 'price.update'
  | 'tag.create'
  | 'tag.update'
  | 'tag.delete'
  | 'sync.start'
  | 'sync.complete'
  | 'fbs.run'
  | 'subscription.create'
  | 'subscription.cancel'
  | 'seo.keyword_add'
  | 'seo.keyword_delete'
  | 'feedback.answer'
  | 'api_key.create'
  | 'api_key.delete';

export type ResourceType =
  | 'user'
  | 'workspace'
  | 'shop'
  | 'product'
  | 'tag'
  | 'cogs'
  | 'subscription'
  | 'invite'
  | 'sync'
  | 'fbs_run'
  | 'seo_keyword'
  | 'feedback'
  | 'api_key';

interface LogParams {
  workspaceId?: number | null;
  userId?: number | null;
  action: AuditAction | string;
  resourceType: ResourceType | string;
  resourceId?: string | number | null;
  details?: Record<string, any>;
  request?: FastifyRequest;
}

/**
 * Log an audit event
 */
export async function logAudit(params: LogParams): Promise<void> {
  try {
    const ipAddress = params.request
      ? (params.request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        params.request.ip
      : null;

    const userAgent = params.request
      ? (params.request.headers['user-agent'] as string) || null
      : null;

    await db.insert(auditLog).values({
      workspaceId: params.workspaceId ?? null,
      userId: params.userId ?? null,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId ? String(params.resourceId) : null,
      details: params.details ?? null,
      ipAddress,
      userAgent,
    });
  } catch (error) {
    // Don't fail the main operation if audit logging fails
    logger.error({ err: error }, 'Failed to log audit event');
  }
}

/**
 * Create audit logger bound to a request
 */
export function createAuditLogger(request: FastifyRequest, workspaceId?: number) {
  const userId = (request as any).userId as number | undefined;

  return {
    log: (
      action: AuditAction | string,
      resourceType: ResourceType | string,
      resourceId?: string | number,
      details?: Record<string, any>
    ) => {
      return logAudit({
        workspaceId,
        userId,
        action,
        resourceType,
        resourceId,
        details,
        request,
      });
    },
  };
}

/**
 * Common audit events
 */
export const AuditEvents = {
  login: (userId: number, request: FastifyRequest) =>
    logAudit({ userId, action: 'login', resourceType: 'user', resourceId: userId, request }),

  logout: (userId: number, request: FastifyRequest) =>
    logAudit({ userId, action: 'logout', resourceType: 'user', resourceId: userId, request }),

  teamInvite: (workspaceId: number, userId: number, inviteId: number, role: string, request: FastifyRequest) =>
    logAudit({
      workspaceId,
      userId,
      action: 'team.invite',
      resourceType: 'invite',
      resourceId: inviteId,
      details: { role },
      request,
    }),

  teamJoin: (workspaceId: number, userId: number, role: string, request: FastifyRequest) =>
    logAudit({
      workspaceId,
      userId,
      action: 'team.join',
      resourceType: 'workspace',
      resourceId: workspaceId,
      details: { role },
      request,
    }),

  teamRemove: (workspaceId: number, removedUserId: number, byUserId: number, request: FastifyRequest) =>
    logAudit({
      workspaceId,
      userId: byUserId,
      action: 'team.remove',
      resourceType: 'user',
      resourceId: removedUserId,
      request,
    }),

  syncStart: (workspaceId: number, userId: number | undefined, syncType: string, request?: FastifyRequest) =>
    logAudit({
      workspaceId,
      userId,
      action: 'sync.start',
      resourceType: 'sync',
      details: { syncType },
      request,
    }),

  feedbackAnswer: (workspaceId: number, userId: number, feedbackId: string, request: FastifyRequest) =>
    logAudit({
      workspaceId,
      userId,
      action: 'feedback.answer',
      resourceType: 'feedback',
      resourceId: feedbackId,
      request,
    }),
};
