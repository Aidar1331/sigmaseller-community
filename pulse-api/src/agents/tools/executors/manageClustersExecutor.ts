/**
 * `manage_clusters` executor. Ownership in wb_campaigns.
 */
import { eq, and } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { marketplaceShops, wbCampaigns } from '../../../db/schema.js';
import { assertAgentAuth } from '../locks.js';
import { safeDecrypt } from '../../../lib/crypto.js';
import type { ActionExecutor } from '../actionQueue.js';

interface Args {
  campaignId: number;
  action: 'set_minus' | 'set_bid';
  minusPhrases?: string[];
  clusterBids?: Array<{ cluster: string; bidKop: number }>;
}
const retryable = (m: string) => /\b5\d\d\b|timeout|econn|rate-limit|429/i.test(m);

export const manageClustersExecutor: ActionExecutor = async (args, ctx) => {
  const a = args as unknown as Args;
  if (!a.campaignId) return { status: 'error', error: 'bad campaignId', retryable: false };
  if (a.action !== 'set_minus' && a.action !== 'set_bid') return { status: 'error', error: 'bad action', retryable: false };
  try { await assertAgentAuth(ctx.userId ?? undefined, ctx.workspaceId); }
  catch (err) { return { status: 'error', error: `auth: ${err instanceof Error ? err.message : err}`, retryable: false }; }

  const owned = await db.select({ id: wbCampaigns.campaignId }).from(wbCampaigns)
    .where(and(eq(wbCampaigns.workspaceId, ctx.workspaceId), eq(wbCampaigns.campaignId, a.campaignId))).limit(1);
  if (owned.length === 0) return { status: 'error', error: `campaignId=${a.campaignId} not in workspace`, retryable: false };

  const [shop] = await db.select({ apiKey: marketplaceShops.apiKey }).from(marketplaceShops)
    .where(eq(marketplaceShops.workspaceId, ctx.workspaceId)).limit(1);
  if (!shop?.apiKey) return { status: 'error', error: 'shop api_key missing', retryable: false };
  const apiKey = safeDecrypt(shop.apiKey);
  if (!apiKey) return { status: 'error', error: 'decrypt failed', retryable: false };

  const { url, body } = a.action === 'set_minus'
    ? { url: 'https://advert-api.wildberries.ru/adv/v0/normquery/set-minus', body: { id: a.campaignId, phrases: a.minusPhrases ?? [] } }
    : { url: 'https://advert-api.wildberries.ru/adv/v0/normquery/bids',     body: { id: a.campaignId, bids: (a.clusterBids ?? []).map((b) => ({ normquery: b.cluster, bid: b.bidKop })) } };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { status: 'error', error: `WB ${res.status}: ${errText.slice(0, 400)}`, retryable: res.status >= 500 || res.status === 429 };
    }
    const msg = a.action === 'set_minus' ? 'Минус-фразы установлены' : 'Ставки кластеров обновлены';
    return { status: 'success', result: { campaignId: a.campaignId, message: `✅ ${msg} для кампании ${a.campaignId}` } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: msg, retryable: retryable(msg) };
  }
};
