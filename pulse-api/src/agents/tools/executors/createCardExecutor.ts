/**
 * `create_card` executor. No ownership (we're creating new). Checks WB
 * card-creation limits at run time; refuses if 0 available.
 */
import { getWbApiKey } from '../../../integrations/wb/wbClient.js';
import { createCard, getCardLimits } from '../../../integrations/wb/content.js';
import { assertAgentAuth } from '../locks.js';
import type { ActionExecutor } from '../actionQueue.js';

interface Args {
  subjectID: number;
  vendorCode: string;
  title: string;
  description: string;
  brand: string;
  dimensions: { length: number; width: number; height: number };
  characteristics: Array<{ id: number; value: string | string[] }>;
  sizes: Array<{ techSize: string; wbSize?: string; skus: string[] }>;
}
const retryable = (m: string) => /\b5\d\d\b|timeout|econn|rate-limit|429/i.test(m);

export const createCardExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as Args;
  if (!a.vendorCode || !a.title) return { status: 'error', error: 'bad args', retryable: false };
  try { await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId); }
  catch (err) { return { status: 'error', error: `auth: ${err instanceof Error ? err.message : err}`, retryable: false }; }

  try {
    const apiKey = await getWbApiKey(ctx.workspaceId, ctx.shopId ?? undefined);
    if (!apiKey) return { status: 'error', error: 'WB API key missing', retryable: false };

    const limits = await getCardLimits(apiKey);
    if ((limits.freeLimits ?? 0) + (limits.paidLimits ?? 0) <= 0) {
      return { status: 'error', error: 'card creation limits exhausted', retryable: false };
    }

    const result = await createCard(apiKey, {
      subjectID: a.subjectID,
      variants: [{
        vendorCode: a.vendorCode, title: a.title, description: a.description,
        brand: a.brand, dimensions: a.dimensions,
        characteristics: a.characteristics, sizes: a.sizes,
      }],
    });
    if (result.error) {
      return { status: 'error', error: result.errorText ?? 'create_card failed', retryable: false };
    }
    return { status: 'success', result: { vendorCode: a.vendorCode, title: a.title, message: `✅ Карточка "${a.title}" (${a.vendorCode}) создана` } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: retryable(msg) };
  }
};
