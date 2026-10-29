/**
 * Tool: action_send_chat_message — Send a chat message to a buyer on WB.
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 *
 * Security contract:
 *  - `_confirmed`/`_userId`/`_shopId`/`_workspaceId` are SERVER-injected by
 *    `graph.ts:executeNode`.
 *  - Lock acquisition lives at graph level — no per-tool locks here.
 */

import { db } from '../../db/client.js';
import { agentActions } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { sendMessage } from '../../integrations/wb/chats.js';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';

interface ActionSendChatMessageArgs {
  chatId: string;
  text: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  // Server-injected by executeNode — never trust values supplied by the LLM.
  _confirmed?: boolean;
}

export async function actionSendChatMessage(args: ActionSendChatMessageArgs): Promise<string> {
  // Failsafe: must only be reached via graph.executeNode.
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_send_chat_message must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  // Auth check: user must be manager+ in workspace
  try {
    await assertAgentAuth(args._userId, wsId);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }

  // Ownership: chat must be in wb_chats for this workspace.
  const ownedRes = await db.execute<{ exists: number }>(sql`
    SELECT 1 AS exists FROM wb_chats
    WHERE workspace_id = ${wsId} AND chat_id = ${args.chatId}
    LIMIT 1
  `);
  if (!Array.isArray(((ownedRes as any).rows ?? ownedRes)) || (((ownedRes as any).rows ?? ownedRes) as any[]).length === 0) {
    return JSON.stringify({ status: 'error', error: `Чат ${args.chatId} не найден в этом workspace.` });
  }

  // Action Queue path
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId, shopId: args._shopId ?? null, userId: args._userId ?? null, conversationId: null,
      actionType: 'send_chat_message',
      toolArgs: { chatId: args.chatId, text: args.text },
      rationale: 'Сообщение покупателю в чате',
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Сообщение в чат ${args.chatId} уже в очереди [actionId:${enq.actionId}].`
        : `✓ Сообщение в чат ${args.chatId} поставлено в очередь [actionId:${enq.actionId}].`,
    });
  }

  let action: any = null;
  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    // Log action as pending
    [action] = await db.insert(agentActions).values({
      workspaceId: wsId,
      shopId: args._shopId ?? null,
      actionType: 'send_chat_message',
      status: 'pending',
      payload: { chatId: args.chatId, text: args.text },
      rationale: `Сообщение покупателю в чате`,
      decidedBy: args._userId ? (BigInt(args._userId) as any) : null,
      decidedAt: new Date(),
    }).returning();

    // Call WB API
    const result = await sendMessage(apiKey, args.chatId, args.text);

    // Mark as executed
    await db.update(agentActions)
      .set({
        status: 'executed',
        executedAt: new Date(),
        completedAt: new Date(),
        result: { messageId: result.messageId },
      })
      .where(eq(agentActions.actionId, action.actionId));

    return JSON.stringify({
      status: 'success',
      actionId: Number(action.actionId),
      messageId: result.messageId,
      message: `Сообщение в чат ${args.chatId} отправлено успешно.`,
    });
  } catch (err: any) {
    if (action?.actionId) {
      await db.update(agentActions).set({ status: 'failed' }).where(eq(agentActions.actionId, action.actionId)).catch(() => {});
    }
    return JSON.stringify({
      status: 'failed',
      error: err.message || 'Ошибка при отправке сообщения в чат',
    });
  }
}
