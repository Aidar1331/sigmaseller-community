/**
 * WB Campaigns Sync
 * Fetches all campaigns from WB Advert API and stores them in DB
 */

import { db } from '../../db/client.js';
import { wbCampaigns, marketplaceShops } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getCampaignCounts, getCampaigns } from './advert.js';
import { safeDecrypt } from '../../lib/crypto.js';

/**
 * WB API v2 advert response structure
 * GET /api/advert/v2/adverts returns { adverts: WbAdvertV2[] }
 */
interface WbAdvertV2 {
  id: number;
  status: number;
  bid_type?: string; // 'unified' | 'manual'
  currency?: string;
  settings?: {
    name?: string;
    payment_type?: string; // 'cpm' | 'cpc'
    placements?: {
      search?: boolean;
      recommendations?: boolean;
    };
  };
  timestamps?: {
    created?: string;
    updated?: string;
    started?: string;
    deleted?: string;
  };
  nm_settings?: Array<{
    nm_id: number;
    bids_kopecks?: {
      search?: number;
      recommendations?: number;
    };
    subject?: {
      id?: number;
      name?: string;
    };
  }>;
}

const STATUS_LABELS: Record<number, string> = {
  [-1]: 'deleted',
  4: 'ready',
  7: 'finished',
  8: 'cancelled',
  9: 'active',
  11: 'paused',
};

export interface CampaignSyncResult {
  synced: number;
  created: number;
  updated: number;
  errors: string[];
}

/**
 * Get API key for workspace (advert API uses same key as marketplace)
 * When shopId is provided, looks up that specific shop's key.
 */
async function getAdvertApiKey(workspaceId: number, shopId?: number): Promise<string | null> {
  const conditions = [
    eq(marketplaceShops.workspaceId, workspaceId),
    eq(marketplaceShops.platform, 'wb'),
    eq(marketplaceShops.isActive, true),
  ];
  if (shopId) conditions.push(eq(marketplaceShops.shopId, shopId));

  const [shop] = await db
    .select()
    .from(marketplaceShops)
    .where(and(...conditions))
    .limit(1);

  if (!shop?.apiKey) return null;
  return safeDecrypt(shop.apiKey) ?? shop.apiKey;
}

/**
 * Sync all campaigns from WB to database
 */
export async function syncCampaigns(workspaceId: number, shopId?: number): Promise<CampaignSyncResult> {
  const result: CampaignSyncResult = {
    synced: 0,
    created: 0,
    updated: 0,
    errors: [],
  };

  const apiKey = await getAdvertApiKey(workspaceId, shopId);
  if (!apiKey) {
    result.errors.push('No API key found for workspace');
    return result;
  }

  try {
    // Get campaign counts and IDs
    const counts = await getCampaignCounts(apiKey);
    
    // Collect all campaign IDs
    const allIds: number[] = [];
    for (const group of counts.adverts || []) {
      for (const item of group.advert_list || []) {
        allIds.push(item.advertId);
      }
    }

    if (allIds.length === 0) {
      return result;
    }

    // Fetch campaign details in batches of 50
    const batchSize = 50;
    const allCampaigns: WbAdvertV2[] = [];

    for (let i = 0; i < allIds.length; i += batchSize) {
      const batchIds = allIds.slice(i, i + batchSize);
      try {
        const response = await getCampaigns(apiKey, { ids: batchIds });
        // WB API v2 returns { adverts: [...] }
        const rawAdverts: any[] = Array.isArray(response) ? response : (response.adverts || []);
        allCampaigns.push(...rawAdverts);
      } catch (err: any) {
        result.errors.push(`Batch ${i}-${i + batchSize}: ${err.message}`);
      }
      // Rate limit delay
      await new Promise(r => setTimeout(r, 250));
    }

    // Upsert campaigns with proper WB v2 field mapping
    for (const advert of allCampaigns) {
      try {
        // WB v2 uses 'id' not 'advertId', settings.name, timestamps.created etc.
        const campaignId = (advert as any).id ?? (advert as any).advertId;
        if (!campaignId) {
          result.errors.push(`Campaign skipped: no id field`);
          continue;
        }

        const name = advert.settings?.name ?? (advert as any).name ?? '';
        const paymentType = advert.settings?.payment_type ?? (advert as any).paymentType ?? 'cpm';
        const createTime = advert.timestamps?.created ?? (advert as any).createTime;
        const changeTime = advert.timestamps?.updated ?? (advert as any).changeTime;
        const startTime = advert.timestamps?.started ?? (advert as any).startTime;
        const endTime = advert.timestamps?.deleted ?? (advert as any).endTime;

        // Extract nm_ids from nm_settings
        const nmIds = advert.nm_settings?.map(s => s.nm_id).filter(Boolean) ?? [];

        // Get max bid from nm_settings (current bid)
        let currentBid: number | null = null;
        if (advert.nm_settings?.length) {
          const maxBid = Math.max(
            ...advert.nm_settings.map(s =>
              Math.max(s.bids_kopecks?.search ?? 0, s.bids_kopecks?.recommendations ?? 0)
            )
          );
          if (maxBid > 0) currentBid = maxBid;
        }

        const existing = await db
          .select()
          .from(wbCampaigns)
          .where(eq(wbCampaigns.campaignId, campaignId))
          .limit(1);

        const data = {
          campaignId,
          workspaceId,
          shopId: shopId || null,
          name,
          status: advert.status,
          type: 9, // WB v2 doesn't return type separately, default to auction
          paymentType,
          dailyBudget: (advert as any).dailyBudget || 0,
          currentBid,
          nmIds,
          createTime: createTime ? new Date(createTime) : null,
          changeTime: changeTime ? new Date(changeTime) : null,
          startTime: startTime ? new Date(startTime) : null,
          endTime: null as Date | null, // deleted timestamp is not the same as endTime
          updatedAt: new Date(),
        };

        if (existing.length > 0) {
          await db
            .update(wbCampaigns)
            .set(data)
            .where(eq(wbCampaigns.campaignId, campaignId));
          result.updated++;
        } else {
          await db.insert(wbCampaigns).values({
            ...data,
            createdAt: new Date(),
          });
          result.created++;
        }
        result.synced++;
      } catch (err: any) {
        const cId = (advert as any).id ?? (advert as any).advertId ?? 'unknown';
        result.errors.push(`Campaign ${cId}: ${err.message}`);
      }
    }

    return result;
  } catch (err: any) {
    result.errors.push(`Sync failed: ${err.message}`);
    return result;
  }
}

/**
 * Get all campaigns for workspace from DB
 */
export async function getCampaignsFromDb(
  workspaceId: number,
  options?: { status?: number; shopId?: number }
) {
  let query = db
    .select()
    .from(wbCampaigns)
    .where(eq(wbCampaigns.workspaceId, workspaceId));

  const campaigns = await query;

  // Filter in JS (Drizzle doesn't chain .where well)
  let filtered = campaigns;
  if (options?.status !== undefined) {
    filtered = filtered.filter(c => c.status === options.status);
  }
  if (options?.shopId !== undefined) {
    filtered = filtered.filter(c => c.shopId === options.shopId);
  }

  return filtered.map(c => ({
    ...c,
    statusLabel: STATUS_LABELS[c.status] || 'unknown',
  }));
}
