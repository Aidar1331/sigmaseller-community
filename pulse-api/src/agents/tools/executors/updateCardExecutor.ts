/**
 * `update_card` executor. Ownership in wb_cards.
 *
 * Шлёт частичный patch в WB через safeUpdateCard — она читает текущую карточку
 * и не теряет данные (title/description/characteristics/photos), которые
 * executor не меняет.
 *
 * История: до 2026-06-05 использовал PATCH напрямую, но у WB на этом endpoint
 * сейчас Allow: POST (verified 2026-05-14), поэтому executor падал с 405 и
 * фактически не работал. Переписан под POST через safeUpdateCard, заодно
 * защитили карточку от потери остальных полей.
 */
import { eq, and } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { wbCards } from '../../../db/schema.js';
import { assertAgentAuth } from '../locks.js';
import { getWbApiKey } from '../../../integrations/wb/wbClient.js';
import { safeUpdateCard } from '../../../integrations/wb/content.js';
import type { ActionExecutor } from '../actionQueue.js';

interface Args { nmId: number; title?: string; description?: string; }
const retryable = (m: string) => /\b5\d\d\b|timeout|econn|rate-limit|429/i.test(m);

export const updateCardExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as Args;
  if (!a.nmId || a.nmId <= 0) return { status: 'error', error: 'bad nmId', retryable: false };
  if (!a.title && !a.description) return { status: 'error', error: 'need title or description', retryable: false };
  try { await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId); }
  catch (err) { return { status: 'error', error: `auth: ${err instanceof Error ? err.message : err}`, retryable: false }; }

  const [card] = await db
    .select({ raw: wbCards.raw, title: wbCards.title })
    .from(wbCards)
    .where(and(eq(wbCards.workspaceId, ctx.workspaceId), eq(wbCards.nmId, a.nmId)))
    .limit(1);
  if (!card) return { status: 'error', error: `card ${a.nmId} not in workspace`, retryable: false };

  try {
    const apiKey = await getWbApiKey(ctx.workspaceId, ctx.shopId ?? undefined);
    if (!apiKey) return { status: 'error', error: 'WB API key missing', retryable: false };

    const patch: { title?: string; description?: string } = {};
    if (a.title) patch.title = a.title;
    if (a.description) patch.description = a.description;

    const result = await safeUpdateCard(apiKey, a.nmId, patch);
    if (result.error) {
      return { status: 'error', error: result.errorText ?? 'update failed', retryable: false };
    }

    // Update local cache (только видимая часть, raw остаётся как был)
    const cardData = card.raw as any;
    const updatedRaw = { ...cardData };
    if (a.title) updatedRaw.title = a.title;
    if (a.description) updatedRaw.description = a.description;
    await db.update(wbCards).set({ raw: updatedRaw, title: a.title ?? cardData?.title })
      .where(and(eq(wbCards.workspaceId, ctx.workspaceId), eq(wbCards.nmId, a.nmId)));

    return { status: 'success', result: { nmId: a.nmId, message: `✅ Карточка ${a.nmId} обновлена` } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: retryable(msg) };
  }
};
