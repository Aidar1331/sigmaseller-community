/**
 * Tools: Campaign management — Start, pause, update bids.
 * DANGEROUS: must be invoked ONLY through executeNode after user confirmation.
 *
 * Security contract:
 *  - `_confirmed`/`_userId`/`_shopId`/`_workspaceId` are SERVER-injected by
 *    `graph.ts:executeNode`.
 *  - Lock acquisition lives at graph level (`tools/locks.ts`) — no per-tool
 *    locks here. Fixes the prior race where the per-tool lock was released
 *    before WB API confirmation.
 */

import { db } from '../../db/client.js';
import { agentActions } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { wbStartCampaign, wbPauseCampaign, wbUpdateCampaignBid } from '../../integrations/wb/wbActions.js';
import { assertAgentAuth } from './locks.js';
import { env } from '../../env.js';
import { enqueueAction } from './actionQueue.js';

// ============================================================================
// Start Campaign
// ============================================================================

interface ActionStartCampaignArgs {
  campaignId: number;
  rationale: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  // Server-injected by executeNode — never trust values supplied by the LLM.
  _confirmed?: boolean;
}

export async function actionStartCampaign(args: ActionStartCampaignArgs): Promise<string> {
  // Failsafe: must only be reached via graph.executeNode.
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_start_campaign must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  await assertAgentAuth(args._userId, wsId);

  // Ownership: campaign must belong to this workspace (and shop if given).
  const ownedRes = await db.execute<{ exists: number }>(sql`
    SELECT 1 AS exists FROM wb_campaigns
    WHERE workspace_id = ${wsId} AND campaign_id = ${args.campaignId}
      ${args._shopId ? sql`AND (shop_id = ${args._shopId} OR shop_id IS NULL)` : sql``}
    LIMIT 1
  `);
  if (!Array.isArray(((ownedRes as any).rows ?? ownedRes)) || (((ownedRes as any).rows ?? ownedRes) as any[]).length === 0) {
    return JSON.stringify({ status: 'error', error: `Кампания ${args.campaignId} не найдена в этом workspace.` });
  }

  // Action Queue path
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId, shopId: args._shopId ?? null, userId: args._userId ?? null, conversationId: null,
      actionType: 'start_campaign', toolArgs: { campaignId: args.campaignId }, rationale: args.rationale,
    });
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Запуск кампании ${args.campaignId} уже в очереди [actionId:${enq.actionId}].`
        : `✓ Запуск кампании ${args.campaignId} поставлен в очередь [actionId:${enq.actionId}].`,
    });
  }

  const [action] = await db.insert(agentActions).values({
    workspaceId: wsId,
    shopId: args._shopId ?? null,
    actionType: 'start_campaign',
    status: 'pending',
    payload: { campaignId: args.campaignId },
    rationale: args.rationale,
    decidedBy: args._userId ? BigInt(args._userId) as any : null,
    decidedAt: new Date(),
  }).returning();

  try {
    const result = await wbStartCampaign(wsId, args._shopId!, args.campaignId);

    await db.update(agentActions)
      .set({
        status: result.success ? 'executed' : 'failed',
        result: { success: false, error: result.error },
        executedAt: new Date(),
      })
      .where(eq(agentActions.actionId, action.actionId));

    if (!result.success) {
      return JSON.stringify({
        status: 'error',
        actionId: action.actionId,
        message: `Не удалось запустить кампанию: ${result.error}`,
      });
    }

    return JSON.stringify({
      status: 'success',
      actionId: action.actionId,
      message: `✅ Рекламная кампания ${args.campaignId} запущена`,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    await db.update(agentActions)
      .set({ status: 'failed', result: { success: false, error: errorMsg }, executedAt: new Date() })
      .where(eq(agentActions.actionId, action.actionId));
    return JSON.stringify({ status: 'error', message: errorMsg });
  }
}

// ============================================================================
// Pause Campaign
// ============================================================================

interface ActionPauseCampaignArgs {
  campaignId: number;
  rationale: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  _confirmed?: boolean;
}

export async function actionPauseCampaign(args: ActionPauseCampaignArgs): Promise<string> {
  // Pre-flight + queue (mirror of start_campaign). We don't refactor to a
  // common helper yet — the legacy paths below still differ in WB API call,
  // result handling, and log strings. Once all three are queue-only we can
  // collapse them.
  const __wsIdPause = args._workspaceId;
  if (args._confirmed === true && __wsIdPause) {
    await assertAgentAuth(args._userId, __wsIdPause);
    const ownedRes = await db.execute<{ exists: number }>(sql`
      SELECT 1 AS exists FROM wb_campaigns
      WHERE workspace_id = ${__wsIdPause} AND campaign_id = ${args.campaignId}
        ${args._shopId ? sql`AND (shop_id = ${args._shopId} OR shop_id IS NULL)` : sql``}
      LIMIT 1
    `);
    if (!Array.isArray(((ownedRes as any).rows ?? ownedRes)) || (((ownedRes as any).rows ?? ownedRes) as any[]).length === 0) {
      return JSON.stringify({ status: 'error', error: `Кампания ${args.campaignId} не найдена в этом workspace.` });
    }
    if (env.ENABLE_ACTION_QUEUE === '1') {
      const enq = await enqueueAction({
        workspaceId: __wsIdPause, shopId: args._shopId ?? null, userId: args._userId ?? null, conversationId: null,
        actionType: 'pause_campaign', toolArgs: { campaignId: args.campaignId }, rationale: args.rationale,
      });
      return JSON.stringify({
        status: enq.reused ? 'already_queued' : 'queued',
        actionId: enq.actionId,
        message: enq.reused
          ? `Пауза кампании ${args.campaignId} уже в очереди [actionId:${enq.actionId}].`
          : `✓ Пауза кампании ${args.campaignId} поставлена в очередь [actionId:${enq.actionId}].`,
      });
    }
  }

  // Failsafe: must only be reached via graph.executeNode.
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_pause_campaign must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  await assertAgentAuth(args._userId, wsId);

  // Ownership: кампания должна принадлежать этому workspace (и shop, если
  // указан). Без проверки агент мог бы остановить чужую кампанию по запросу
  // вида «останови кампанию 12345» — LLM нельзя доверять выбор id.
  const ownedRes = await db.execute<{ exists: number }>(sql`
    SELECT 1 AS exists FROM wb_campaigns
    WHERE workspace_id = ${wsId} AND campaign_id = ${args.campaignId}
      ${args._shopId ? sql`AND (shop_id = ${args._shopId} OR shop_id IS NULL)` : sql``}
    LIMIT 1
  `);
  if (!Array.isArray(((ownedRes as any).rows ?? ownedRes)) || (((ownedRes as any).rows ?? ownedRes) as any[]).length === 0) {
    return JSON.stringify({ status: 'error', error: `Кампания ${args.campaignId} не найдена в этом workspace.` });
  }

  const [action] = await db.insert(agentActions).values({
    workspaceId: wsId,
    shopId: args._shopId ?? null,
    actionType: 'pause_campaign',
    status: 'pending',
    payload: { campaignId: args.campaignId },
    rationale: args.rationale,
    decidedBy: args._userId ? BigInt(args._userId) as any : null,
    decidedAt: new Date(),
  }).returning();

  try {
    const result = await wbPauseCampaign(wsId, args._shopId!, args.campaignId);

    await db.update(agentActions)
      .set({
        status: result.success ? 'executed' : 'failed',
        result: { success: false, error: result.error },
        executedAt: new Date(),
      })
      .where(eq(agentActions.actionId, action.actionId));

    if (!result.success) {
      return JSON.stringify({
        status: 'error',
        actionId: action.actionId,
        message: `Не удалось остановить кампанию: ${result.error}`,
      });
    }

    return JSON.stringify({
      status: 'success',
      actionId: action.actionId,
      message: `✅ Рекламная кампания ${args.campaignId} остановлена`,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    await db.update(agentActions)
      .set({ status: 'failed', result: { success: false, error: errorMsg }, executedAt: new Date() })
      .where(eq(agentActions.actionId, action.actionId));
    return JSON.stringify({ status: 'error', message: errorMsg });
  }
}

// ============================================================================
// Update Bid
// ============================================================================

interface ActionUpdateBidArgs {
  campaignId: number;
  nmId: number;
  bidKopecks: number;
  rationale: string;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
  _confirmed?: boolean;
}

export async function actionUpdateBid(args: ActionUpdateBidArgs): Promise<string> {
  // Failsafe: must only be reached via graph.executeNode.
  if (args._confirmed !== true) {
    return JSON.stringify({
      status: 'error',
      error: 'action_update_bid must be confirmed by the user via executeNode',
    });
  }

  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  await assertAgentAuth(args._userId, wsId);

  // Ownership check via wb_cards: nmId must belong to this workspace
  // (and shop, if shopId is provided). Closes the TODO that was here.
  const ownedRes = await db.execute<{ exists: number }>(sql`
    SELECT 1 AS exists
    FROM wb_cards
    WHERE workspace_id = ${wsId}
      AND nm_id = ${args.nmId}
      ${args._shopId ? sql`AND (shop_id = ${args._shopId} OR shop_id IS NULL)` : sql``}
    LIMIT 1
  `);
  const ownedRows = (ownedRes as any).rows ?? ownedRes;
  if (!Array.isArray(ownedRows) || ownedRows.length === 0) {
    return JSON.stringify({
      status: 'error',
      error: `Артикул ${args.nmId} не найден в карточках этого workspace. Проверьте принадлежность.`,
    });
  }

  // ─── Action Queue path (feature-flagged) ────────────────────────────────
  if (env.ENABLE_ACTION_QUEUE === '1') {
    const enq = await enqueueAction({
      workspaceId: wsId,
      shopId: args._shopId ?? null,
      userId: args._userId ?? null,
      conversationId: null,
      actionType: 'update_bid',
      toolArgs: { campaignId: args.campaignId, nmId: args.nmId, bidKopecks: args.bidKopecks },
      rationale: args.rationale,
    });
    const bidRubQ = (args.bidKopecks / 100).toFixed(2);
    return JSON.stringify({
      status: enq.reused ? 'already_queued' : 'queued',
      actionId: enq.actionId,
      message: enq.reused
        ? `Команда update_bid уже в очереди [actionId:${enq.actionId}].`
        : `✓ Ставка ${bidRubQ} ₽ для nmId=${args.nmId} в кампании ${args.campaignId} поставлена в очередь [actionId:${enq.actionId}].`,
    });
  }
  // ────────────────────────────────────────────────────────────────────────

  const bidRub = (args.bidKopecks / 100).toFixed(2);

  const [action] = await db.insert(agentActions).values({
    workspaceId: wsId,
    shopId: args._shopId ?? null,
    actionType: 'update_bid',
    status: 'pending',
    payload: { campaignId: args.campaignId, nmId: args.nmId, bidKopecks: args.bidKopecks },
    rationale: args.rationale,
    decidedBy: args._userId ? BigInt(args._userId) as any : null,
    decidedAt: new Date(),
  }).returning();

  try {
    const result = await wbUpdateCampaignBid(wsId, args._shopId!, args.campaignId, args.nmId, args.bidKopecks);

    await db.update(agentActions)
      .set({
        status: result.success ? 'executed' : 'failed',
        result: { success: false, error: result.error },
        executedAt: new Date(),
      })
      .where(eq(agentActions.actionId, action.actionId));

    if (!result.success) {
      return JSON.stringify({
        status: 'error',
        actionId: action.actionId,
        message: `Не удалось изменить ставку: ${result.error}`,
      });
    }

    return JSON.stringify({
      status: 'success',
      actionId: action.actionId,
      message: `✅ Ставка для товара ${args.nmId} в кампании ${args.campaignId} изменена на ${bidRub} ₽`,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    await db.update(agentActions)
      .set({ status: 'failed', result: { success: false, error: errorMsg }, executedAt: new Date() })
      .where(eq(agentActions.actionId, action.actionId));
    return JSON.stringify({ status: 'error', message: errorMsg });
  }
}
