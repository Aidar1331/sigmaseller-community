/**
 * WB API Write Actions
 * 
 * Unified module for all WB API write operations used by AI agent.
 * Wraps existing integrations with consistent error handling and logging.
 */

import { getWbApiKey, wbPostJson, wbGetJson } from './wbClient.js';
import { sendWbFeedbackAnswer } from './feedbacks.js';
import { startCampaign, pauseCampaign, setBids } from './advert.js';

// ============================================================================
// Result Types
// ============================================================================

export interface WbActionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  wbResponse?: unknown;
}

// ============================================================================
// Prices API
// https://discounts-prices-api.wildberries.ru/api/v2/upload/task
// ============================================================================

const PRICES_API_BASE = 'https://discounts-prices-api.wildberries.ru/api/v2';

interface PriceUploadItem {
  nmID: number;
  price: number;      // New price in rubles (NOT kopecks!)
  discount?: number;  // Discount percent (0-100)
}

interface PriceUploadResponse {
  uploadId?: number;
  alreadyExists?: boolean;
  data?: {
    uploadID: number;
  };
  error?: boolean;
  errorText?: string;
}

/**
 * Fetch the current price + seller discount for a product directly from WB.
 *
 * Endpoint: GET /api/v2/list/goods/filter?filterNmID={nmId}
 * Returns the base price (`price`, rubles), seller discount % (`discount`),
 * and final price after the discount (`discountedPrice`). This is the SAME
 * data shown in the WB seller cabinet — authoritative for current pricing.
 */
export interface WbCurrentPrice {
  nmId: number;
  vendorCode?: string;
  basePriceRub: number;       // «Цена продавца до скидки»
  discountPct: number;        // «Скидка продавца», %
  finalPriceRub: number;      // «Цена со скидкой» (после скидки продавца, до СПП)
  clubDiscountPct?: number;
  clubFinalPriceRub?: number;
}

export async function wbGetCurrentPrice(
  workspaceId: number,
  shopId: number,
  nmId: number,
): Promise<WbActionResult<WbCurrentPrice | null>> {
  try {
    const apiKey = await getWbApiKey(workspaceId, shopId);
    const url = `${PRICES_API_BASE}/list/goods/filter?limit=10&offset=0&filterNmID=${nmId}`;
    const response = await wbGetJson<{
      data?: {
        listGoods?: Array<{
          nmID: number;
          vendorCode?: string;
          discount?: number;
          clubDiscount?: number;
          sizes?: Array<{ price?: number; discountedPrice?: number; clubDiscountedPrice?: number }>;
        }>;
      };
      error?: boolean;
      errorText?: string;
    }>(url, apiKey);

    if (response.error) {
      return { success: false, error: response.errorText || 'WB price list failed', wbResponse: response };
    }
    const item = response.data?.listGoods?.find((g) => g.nmID === nmId);
    if (!item) return { success: true, data: null, wbResponse: response };

    // WB returns one entry per product; each may have multiple sizes. For
    // multi-size SKUs we take the first size as representative — agent UX
    // shows a single "current price" line, not a size matrix. Edge case
    // (per-size pricing) is rare and out of scope for the confirmation prompt.
    const size = item.sizes?.[0];
    const basePriceRub = Number(size?.price ?? 0);
    const finalPriceRub = Number(size?.discountedPrice ?? basePriceRub);
    return {
      success: true,
      data: {
        nmId: item.nmID,
        vendorCode: item.vendorCode,
        basePriceRub,
        discountPct: Number(item.discount ?? 0),
        finalPriceRub,
        clubDiscountPct: item.clubDiscount != null ? Number(item.clubDiscount) : undefined,
        clubFinalPriceRub: size?.clubDiscountedPrice != null ? Number(size.clubDiscountedPrice) : undefined,
      },
      wbResponse: response,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: `wbGetCurrentPrice failed: ${message}` };
  }
}

/**
 * Set price for a product on WB.
 * 
 * @param workspaceId - Workspace ID to get API key
 * @param nmId - Product nmID
 * @param priceRub - New price in rubles
 * @param discount - Optional discount percent (0-100)
 */
export async function wbSetPrice(
  workspaceId: number,
  shopId: number,
  nmId: number,
  priceRub: number,
  discount?: number
): Promise<WbActionResult<{ uploadId: number }>> {
  try {
    // Scope by shopId — multi-shop workspaces have a distinct WB JWT per shop.
    // Without scoping getWbApiKey falls back to the default (first active) shop
    // and WB then rejects with "All item Nos. are specified incorrectly"
    // because the nmId isn't in THAT seller's catalog.
    const apiKey = await getWbApiKey(workspaceId, shopId);
    
    const payload: { data: PriceUploadItem[] } = {
      data: [{
        nmID: nmId,
        price: Math.round(priceRub), // WB expects integer rubles
        ...(discount !== undefined && { discount: Math.round(discount) }),
      }],
    };

    const response = await wbPostJson<PriceUploadResponse & { data?: any }>(
      `${PRICES_API_BASE}/upload/task`,
      apiKey,
      payload
    );

    // Check for WB-level errors
    if (response.error || response.errorText) {
      return {
        success: false,
        error: response.errorText || 'WB price upload failed',
        wbResponse: response,
      };
    }

    // WB v2 Prices API accepts the task and returns either:
    //   { data: { id: <uuid|number> }, error: false }        — current
    //   { uploadId: <int> }                                  — legacy
    //   { data: { uploadID: <int> } }                        — variant
    // A queued task with no synchronous id is still a success — we treat the
    // absence of `error`/`errorText` as the authoritative signal and surface
    // whatever task identifier is present (may be 0 when WB defers id return).
    const d = (response.data ?? {}) as Record<string, unknown>;
    const uploadId =
      (response.uploadId as number | undefined) ??
      (d.uploadID as number | undefined) ??
      (d.id as number | undefined) ??
      0;

    return {
      success: true,
      data: { uploadId: typeof uploadId === 'number' ? uploadId : 0 },
      wbResponse: response,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      success: false,
      error: `wbSetPrice failed: ${message}`,
    };
  }
}

/**
 * Set prices for multiple products at once.
 * 
 * @param workspaceId - Workspace ID
 * @param items - Array of { nmId, priceRub, discount? }
 */
export async function wbSetPricesBatch(
  workspaceId: number,
  shopId: number,
  items: Array<{ nmId: number; priceRub: number; discount?: number }>
): Promise<WbActionResult<{ uploadId: number }>> {
  try {
    const apiKey = await getWbApiKey(workspaceId, shopId);
    
    const payload = {
      data: items.map(item => ({
        nmID: item.nmId,
        price: Math.round(item.priceRub),
        ...(item.discount !== undefined && { discount: Math.round(item.discount) }),
      })),
    };

    const response = await wbPostJson<PriceUploadResponse>(
      `${PRICES_API_BASE}/upload/task`,
      apiKey,
      payload
    );

    if (response.error || response.errorText) {
      return {
        success: false,
        error: response.errorText || 'WB batch price upload failed',
        wbResponse: response,
      };
    }

    const d = (response.data ?? {}) as Record<string, unknown>;
    const uploadId =
      (response.uploadId as number | undefined) ??
      (d.uploadID as number | undefined) ??
      (d.id as number | undefined) ??
      0;

    return {
      success: true,
      data: { uploadId: typeof uploadId === 'number' ? uploadId : 0 },
      wbResponse: response,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      success: false,
      error: `wbSetPricesBatch failed: ${message}`,
    };
  }
}

// ============================================================================
// Feedbacks API (wrapper around existing integration)
// ============================================================================

/**
 * Reply to a feedback (review) on WB.
 * 
 * @param workspaceId - Workspace ID
 * @param feedbackId - Feedback ID (string)
 * @param text - Reply text
 */
export async function wbReplyFeedback(
  workspaceId: number,
  shopId: number,
  feedbackId: string,
  text: string
): Promise<WbActionResult<void>> {
  try {
    await sendWbFeedbackAnswer(workspaceId, shopId, feedbackId, text);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      success: false,
      error: `wbReplyFeedback failed: ${message}`,
    };
  }
}

// ============================================================================
// Advert API (wrappers around existing integration)
// ============================================================================

/**
 * Start an advertising campaign.
 * 
 * @param workspaceId - Workspace ID
 * @param campaignId - Campaign/advert ID
 */
export async function wbStartCampaign(
  workspaceId: number,
  shopId: number,
  campaignId: number
): Promise<WbActionResult<void>> {
  try {
    const apiKey = await getWbApiKey(workspaceId, shopId);
    await startCampaign(apiKey, campaignId);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      success: false,
      error: `wbStartCampaign failed: ${message}`,
    };
  }
}

/**
 * Pause an advertising campaign.
 * 
 * @param workspaceId - Workspace ID
 * @param campaignId - Campaign/advert ID
 */
export async function wbPauseCampaign(
  workspaceId: number,
  shopId: number,
  campaignId: number
): Promise<WbActionResult<void>> {
  try {
    const apiKey = await getWbApiKey(workspaceId, shopId);
    await pauseCampaign(apiKey, campaignId);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      success: false,
      error: `wbPauseCampaign failed: ${message}`,
    };
  }
}

/**
 * Update bid for a product in a campaign.
 * 
 * @param workspaceId - Workspace ID
 * @param campaignId - Campaign/advert ID
 * @param nmId - Product nmID
 * @param bidKopecks - Bid in kopecks
 * @param placement - Placement type
 */
export async function wbUpdateCampaignBid(
  workspaceId: number,
  shopId: number,
  campaignId: number,
  nmId: number,
  bidKopecks: number,
  placement: 'combined' | 'search' | 'recommendations' = 'combined'
): Promise<WbActionResult<void>> {
  try {
    const apiKey = await getWbApiKey(workspaceId, shopId);
    await setBids(apiKey, [{
      advertId: campaignId,
      nmId,
      bid: bidKopecks,
      placement,
    }]);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      success: false,
      error: `wbUpdateCampaignBid failed: ${message}`,
    };
  }
}

/**
 * Update bids for multiple products.
 * 
 * @param workspaceId - Workspace ID
 * @param bids - Array of bid updates
 */
export async function wbUpdateBidsBatch(
  workspaceId: number,
  shopId: number,
  bids: Array<{
    campaignId: number;
    nmId: number;
    bidKopecks: number;
    placement?: 'combined' | 'search' | 'recommendations';
  }>
): Promise<WbActionResult<void>> {
  try {
    const apiKey = await getWbApiKey(workspaceId, shopId);
    await setBids(
      apiKey,
      bids.map(b => ({
        advertId: b.campaignId,
        nmId: b.nmId,
        bid: b.bidKopecks,
        placement: b.placement ?? 'combined',
      }))
    );
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      success: false,
      error: `wbUpdateBidsBatch failed: ${message}`,
    };
  }
}
