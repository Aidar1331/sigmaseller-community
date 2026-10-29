/**
 * Unified chat sessions backed by `agent_conversations` + `agent_messages`
 * (rev 27L — unified-AI rewrite of rev 26b).
 *
 * Bot conversations now live in the SAME tables as the website's /ai page:
 *   - agent_conversations.meta = { source: 'telegram', tgChatId: '...' }
 *   - agent_type = 'assistant' so they appear in /ai list alongside web chats
 *   - status = 'active' until closed by /newchat (then 'archived')
 *
 * Public surface kept identical to the previous chatSessions.ts so llm.ts
 * and handlers.ts didn't need to change — the `sessionId` returned is now
 * an agent_conversations.conversation_id.
 *
 * Auto-title heuristic: first 40 chars of the first user message. No LLM
 * call (cheap, deterministic). Web side may overwrite via its own LLM
 * later — that's fine, the column is the same.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import log from '../../lib/logger.js';
import type { MemTurn } from './chatMemory.js';

const logger = log.child({ module: 'tgBot/chatSessions' });

export interface ChatSessionRow {
  sessionId: number;
  title: string | null;
  startedAt: string;
  lastMsgAt: string;
  closedAt: string | null;
}

/**
 * Resolve the user's primary workspace_id. Bot conversations must be
 * attached to a workspace (agent_conversations.workspace_id NOT NULL).
 * For now we pick the user's first workspace via workspace_members; if
 * the user is in multiple workspaces we could later add an active-ws
 * scope like activeShop.ts.
 */
async function resolveWorkspaceId(userId: number): Promise<number | null> {
  const rows = await db.execute(sql<{ workspace_id: number }>`
    SELECT workspace_id::int AS workspace_id
      FROM workspace_members
     WHERE user_id = ${userId}
     ORDER BY workspace_id
     LIMIT 1;
  `);
  const r = rows.rows[0] as any;
  return r ? Number(r.workspace_id) : null;
}

/**
 * Find or create the user's currently-open Telegram conversation.
 * "Open" = agent_conversations.status='active' AND meta->>'source'='telegram'
 * AND meta->>'tgChatId' matches.
 */
export async function getOrCreateActiveSession(
  userId: number,
  tgChatId: string,
): Promise<number> {
  const open = await db.execute(sql<{ conversation_id: number }>`
    SELECT conversation_id FROM agent_conversations
     WHERE user_id = ${userId}
       AND status = 'active'
       AND meta->>'source' = 'telegram'
       AND meta->>'tgChatId' = ${tgChatId}
     ORDER BY updated_at DESC
     LIMIT 1;
  `);
  const row = open.rows[0] as any;
  if (row) return Number(row.conversation_id);

  const workspaceId = await resolveWorkspaceId(userId);
  if (!workspaceId) {
    throw new Error(`user ${userId} has no workspace — cannot open conversation`);
  }
  const created = await db.execute(sql<{ conversation_id: number }>`
    INSERT INTO agent_conversations (workspace_id, user_id, agent_type, status, meta)
    VALUES (
      ${workspaceId},
      ${userId},
      'assistant',
      'active',
      ${JSON.stringify({ source: 'telegram', tgChatId })}::jsonb
    )
    RETURNING conversation_id;
  `);
  return Number((created.rows[0] as any).conversation_id);
}

export async function closeSession(sessionId: number): Promise<void> {
  await db.execute(sql`
    UPDATE agent_conversations SET status = 'archived', updated_at = NOW()
     WHERE conversation_id = ${sessionId} AND status = 'active';
  `);
}

/**
 * Close any active Telegram conversation for this user and open a new one.
 * Returns the new conversation_id.
 */
export async function startNewSession(userId: number, tgChatId: string): Promise<number> {
  await db.execute(sql`
    UPDATE agent_conversations SET status = 'archived', updated_at = NOW()
     WHERE user_id = ${userId}
       AND status = 'active'
       AND meta->>'source' = 'telegram'
       AND meta->>'tgChatId' = ${tgChatId};
  `);
  const workspaceId = await resolveWorkspaceId(userId);
  if (!workspaceId) {
    throw new Error(`user ${userId} has no workspace — cannot start new conversation`);
  }
  const created = await db.execute(sql<{ conversation_id: number }>`
    INSERT INTO agent_conversations (workspace_id, user_id, agent_type, status, meta)
    VALUES (
      ${workspaceId},
      ${userId},
      'assistant',
      'active',
      ${JSON.stringify({ source: 'telegram', tgChatId })}::jsonb
    )
    RETURNING conversation_id;
  `);
  return Number((created.rows[0] as any).conversation_id);
}

export async function appendMessage(
  sessionId: number,
  role: 'user' | 'assistant' | 'tool',
  content: string,
  toolCalls?: unknown,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO agent_messages (conversation_id, role, content, tool_calls)
      VALUES (
        ${sessionId},
        ${role},
        ${content},
        ${toolCalls != null ? JSON.stringify(toolCalls) : null}::jsonb
      );
    `);
    await db.execute(sql`
      UPDATE agent_conversations SET updated_at = NOW() WHERE conversation_id = ${sessionId};
    `);
  } catch (err) {
    logger.warn({ err: (err as Error).message, sessionId }, 'appendMessage failed');
  }
}

/**
 * Cheap auto-title heuristic — first 40 chars of the first user message,
 * trimmed at the last word boundary. Skips if title already set or zero
 * user messages.
 */
export async function maybeSetAutoTitle(sessionId: number, userText: string): Promise<void> {
  try {
    const existing = await db.execute(sql<{ title: string | null; n: number }>`
      SELECT c.title,
             (SELECT COUNT(*)::int FROM agent_messages m
               WHERE m.conversation_id = c.conversation_id AND m.role = 'user') AS n
        FROM agent_conversations c
       WHERE c.conversation_id = ${sessionId};
    `);
    const row = existing.rows[0] as any;
    if (!row || row.title) return;
    if (Number(row.n) < 1) return;

    const cleaned = userText.replace(/\s+/g, ' ').trim();
    let title = cleaned.slice(0, 40);
    if (cleaned.length > 40) {
      const lastSpace = title.lastIndexOf(' ');
      if (lastSpace > 20) title = title.slice(0, lastSpace);
      title += '…';
    }

    await db.execute(sql`
      UPDATE agent_conversations SET title = ${title} WHERE conversation_id = ${sessionId};
    `);
  } catch (err) {
    logger.warn({ err: (err as Error).message, sessionId }, 'auto-title failed');
  }
}

export interface SessionListItem {
  sessionId: number;
  title: string;
  lastMsgAt: Date;
  msgCount: number;
}

/**
 * List the user's recent telegram-origin conversations, both active and
 * archived. We surface only telegram-origin ones in /chats so the bot
 * UI doesn't accidentally show conversations the user started in the
 * web kabinet (which they can already see on the web side).
 */
export async function listRecentSessions(userId: number, limit = 10): Promise<SessionListItem[]> {
  const rows = await db.execute(sql`
    SELECT c.conversation_id, c.title, c.updated_at AS last_msg_at,
           (SELECT COUNT(*)::int FROM agent_messages m WHERE m.conversation_id = c.conversation_id) AS msg_count
      FROM agent_conversations c
     WHERE c.user_id = ${userId}
       AND c.meta->>'source' = 'telegram'
     ORDER BY c.updated_at DESC
     LIMIT ${limit};
  `);
  return (rows.rows as any[]).map((r) => ({
    sessionId: Number(r.conversation_id),
    title: r.title ?? 'Без названия',
    lastMsgAt: new Date(r.last_msg_at),
    msgCount: Number(r.msg_count),
  }));
}

/**
 * Hydrate Redis-style turns from agent_messages for the last N messages.
 * Used by /chats resume — only user+assistant turns; tool messages stay
 * in the DB but aren't part of the LLM context replay.
 */
export async function loadRecentTurns(sessionId: number, limit = 20): Promise<MemTurn[]> {
  const rows = await db.execute(sql`
    SELECT role, content, EXTRACT(EPOCH FROM created_at) * 1000 AS t
      FROM agent_messages
     WHERE conversation_id = ${sessionId}
       AND role IN ('user', 'assistant')
     ORDER BY created_at DESC
     LIMIT ${limit};
  `);
  return (rows.rows as any[])
    .filter((r) => r.content != null)
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: String(r.content), t: Number(r.t) }))
    .reverse();
}

export async function getSessionTitle(sessionId: number): Promise<string | null> {
  const rows = await db.execute(sql<{ title: string | null }>`
    SELECT title FROM agent_conversations WHERE conversation_id = ${sessionId};
  `);
  const row = rows.rows[0] as any;
  return row?.title ?? null;
}

/**
 * Format a "X minutes ago" / "вчера" / "DD.MM" label for /chats list.
 * Pure utility, no DB.
 */
export function relativeTimeRu(at: Date): string {
  const now = Date.now();
  const diffMin = Math.floor((now - at.getTime()) / 60_000);
  if (diffMin < 1) return 'только что';
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} ч назад`;
  if (diffHr < 48) return 'вчера';
  const dd = String(at.getDate()).padStart(2, '0');
  const mm = String(at.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}`;
}
