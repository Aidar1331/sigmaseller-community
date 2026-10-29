/**
 * WB Advert API Integration
 * https://advert-api.wildberries.ru
 */

const ADVERT_API_BASE = 'https://advert-api.wildberries.ru';

// Rate limiting: 5 req/sec with 200ms interval
const DELAY_BETWEEN_REQUESTS = 250; // ms

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WbCampaign {
  advertId: number;
  name: string;
  status: number; // -1=deleted, 4=ready, 7=finished, 8=cancelled, 9=active, 11=paused
  type: number; // 8=unified
  paymentType: string; // cpm | cpc
  dailyBudget: number;
  createTime: string;
  changeTime: string;
  startTime?: string;
  endTime?: string;
}

export interface WbCampaignCounts {
  adverts: Array<{
    type: number;
    status: number;
    count: number;
    advert_list: Array<{ advertId: number; changeTime: string }>;
  }>;
  all: number;
}

export interface WbBidResult {
  advertId: number;
  nmId: number;
  bid: number;
  status: string;
  error?: string;
}

export interface WbMinBid {
  nmId: number;
  bid: number; // kopecks
  placement: string;
}

// ==================== CAMPAIGNS ====================

/**
 * Get campaign counts and IDs grouped by status/type
 */
export async function getCampaignCounts(apiKey: string): Promise<WbCampaignCounts> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v1/promotion/count`, {
    headers: { Authorization: apiKey },
  });

  if (!response.ok) {
    throw new Error(`WB API error: ${response.status} ${await response.text()}`);
  }

  return response.json() as Promise<WbCampaignCounts>;
}

/**
 * Get detailed campaign info
 */
export async function getCampaigns(
  apiKey: string,
  options?: {
    ids?: number[];
    statuses?: number[]; // -1, 4, 7, 8, 9, 11
    paymentType?: 'cpm' | 'cpc';
  }
): Promise<{ adverts: WbCampaign[] }> {
  const params = new URLSearchParams();

  if (options?.ids?.length) {
    params.set('ids', options.ids.join(','));
  }
  if (options?.statuses?.length) {
    params.set('statuses', options.statuses.join(','));
  }
  if (options?.paymentType) {
    params.set('payment_type', options.paymentType);
  }

  const url = `${ADVERT_API_BASE}/api/advert/v2/adverts?${params}`;
  const response = await fetch(url, {
    headers: { Authorization: apiKey },
  });

  if (!response.ok) {
    throw new Error(`WB API error: ${response.status} ${await response.text()}`);
  }

  return response.json() as Promise<{ adverts: WbCampaign[] }>;
}

/**
 * Get all active and paused campaigns
 */
export async function getActiveCampaigns(apiKey: string): Promise<WbCampaign[]> {
  const result = await getCampaigns(apiKey, { statuses: [9, 11] }); // active + paused
  return result.adverts ?? [];
}

// ==================== CAMPAIGN CONTROL ====================

/**
 * Start a campaign (from ready or paused)
 */
export async function startCampaign(apiKey: string, advertId: number): Promise<void> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v0/start?id=${advertId}`, {
    headers: { Authorization: apiKey },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to start campaign ${advertId}: ${text}`);
  }
}

/**
 * Pause a campaign
 */
export async function pauseCampaign(apiKey: string, advertId: number): Promise<void> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v0/pause?id=${advertId}`, {
    headers: { Authorization: apiKey },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to pause campaign ${advertId}: ${text}`);
  }
}

/**
 * Stop (finish) a campaign
 */
export async function stopCampaign(apiKey: string, advertId: number): Promise<void> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v0/stop?id=${advertId}`, {
    headers: { Authorization: apiKey },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to stop campaign ${advertId}: ${text}`);
  }
}

// ==================== BIDS ====================

/**
 * Get minimum bids for products
 */
export async function getMinBids(
  apiKey: string,
  advertId: number,
  nmIds: number[],
  paymentType: 'cpm' | 'cpc' = 'cpm',
  placementTypes: ('combined' | 'search' | 'recommendation')[] = ['combined']
): Promise<{ bids: WbMinBid[] }> {
  const response = await fetch(`${ADVERT_API_BASE}/api/advert/v1/bids/min`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      advert_id: advertId,
      nm_ids: nmIds,
      payment_type: paymentType,
      placement_types: placementTypes,
    }),
  });

  if (!response.ok) {
    throw new Error(`WB API error: ${response.status} ${await response.text()}`);
  }

  return response.json() as Promise<any>;
}

/**
 * Set bids for products in campaigns
 * Bid is in kopecks
 */
export async function setBids(
  apiKey: string,
  bids: Array<{
    advertId: number;
    nmId: number;
    bid: number; // kopecks
    placement: 'combined' | 'search' | 'recommendations';
  }>
): Promise<{ bids: WbBidResult[] }> {
  // Max 50 bids per request
  const chunks: typeof bids[] = [];
  for (let i = 0; i < bids.length; i += 50) {
    chunks.push(bids.slice(i, i + 50));
  }

  const allResults: WbBidResult[] = [];

  for (const chunk of chunks) {
    const response = await fetch(`${ADVERT_API_BASE}/api/advert/v1/bids`, {
      method: 'PATCH',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bids: chunk.map((b) => ({
          advert_id: b.advertId,
          nm_id: b.nmId,
          bid: b.bid,
          placement: b.placement,
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(`WB API error: ${response.status} ${await response.text()}`);
    }

    const result = await response.json() as { bids?: WbBidResult[] };
    allResults.push(...(result.bids ?? []));

    if (chunks.length > 1) {
      await sleep(DELAY_BETWEEN_REQUESTS);
    }
  }

  return { bids: allResults };
}

// ==================== MINUS PHRASES ====================

/**
 * Set excluded (minus) phrases for a campaign
 */
export async function setMinusPhrases(
  apiKey: string,
  advertId: number,
  phrases: string[]
): Promise<void> {
  const response = await fetch(
    `${ADVERT_API_BASE}/adv/v1/search/set-excluded?id=${advertId}`,
    {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ excluded: phrases }),
    }
  );

  if (!response.ok) {
    throw new Error(`WB API error: ${response.status} ${await response.text()}`);
  }
}

// ==================== PRODUCTS ====================

/**
 * Add/remove products from campaigns
 */
export async function updateCampaignProducts(
  apiKey: string,
  updates: Array<{
    advertId: number;
    add?: number[]; // nmIds to add
    delete?: number[]; // nmIds to remove
  }>
): Promise<void> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v0/auction/nms`, {
    method: 'PATCH',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      nms: updates.map((u) => ({
        advert_id: u.advertId,
        add: u.add ?? [],
        delete: u.delete ?? [],
      })),
    }),
  });

  if (!response.ok) {
    throw new Error(`WB API error: ${response.status} ${await response.text()}`);
  }
}

// ==================== STATISTICS ====================

// ==================== STATISTICS TYPES ====================

export interface WbProductStats {
  nmId: number;
  sum: number;        // spend in rubles
  views: number;
  clicks: number;
  atbs: number;       // add to basket
  orders: number;
  sum_price: number;  // orders sum in rubles
}

export interface WbDayStats {
  date: string;
  sum: number;        // total spend
  views: number;
  clicks: number;
  atbs: number;
  orders: number;
  sum_price: number;
  apps?: WbProductStats[];  // per-product breakdown
}

export interface WbCampaignFullStats {
  advertId: number;
  days: WbDayStats[];
}

/**
 * Get campaign statistics with per-product breakdown
 * Uses v3 GET endpoint: /adv/v3/fullstats?ids=...&beginDate=...&endDate=...
 * Max date range: 31 days. Only for statuses 7,9,11.
 */
export async function getCampaignStats(
  apiKey: string,
  advertId: number | number[],
  dateFrom: string,
  dateTo: string
): Promise<WbCampaignFullStats[]> {
  const ids = Array.isArray(advertId) ? advertId.join(',') : String(advertId);
  const url = `${ADVERT_API_BASE}/adv/v3/fullstats?ids=${ids}&beginDate=${dateFrom}&endDate=${dateTo}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: apiKey },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WB API error: ${response.status} ${text}`);
  }

  const data = await response.json();
  // v3 may return null when there's no data
  if (!data) return [];
  return data as WbCampaignFullStats[];
}

/**
 * Extract per-product stats from campaign stats response
 * Handles various WB response formats (apps, nm, items, products, nms)
 */
export function extractProductStats(dayStats: WbDayStats): WbProductStats[] {
  const candidates = [
    (dayStats as any)?.apps,
    (dayStats as any)?.nm,
    (dayStats as any)?.items,
    (dayStats as any)?.products,
    (dayStats as any)?.nms,
    (dayStats as any)?.nmStats,
  ];

  for (const arr of candidates) {
    if (!Array.isArray(arr)) continue;
    const result: WbProductStats[] = [];
    for (const r of arr) {
      const nmId = Number(r?.nmId ?? r?.nmid ?? r?.nmID ?? r?.nm_id);
      const sum = Number(r?.sum ?? r?.spent ?? r?.spend ?? r?.cost ?? 0);
      if (!Number.isFinite(nmId) || nmId <= 0) continue;
      result.push({
        nmId,
        sum,
        views: Number(r?.views ?? 0),
        clicks: Number(r?.clicks ?? 0),
        atbs: Number(r?.atbs ?? 0),
        orders: Number(r?.orders ?? 0),
        sum_price: Number(r?.sum_price ?? r?.sumPrice ?? 0),
      });
    }
    if (result.length > 0) return result;
  }

  return [];
}

// ==================== BUDGET ====================

/**
 * Get campaign budget info
 */
export async function getCampaignBudget(
  apiKey: string,
  advertId: number
): Promise<{ budget: number; dailyBudget: number }> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v1/budget?id=${advertId}`, {
    headers: { Authorization: apiKey },
  });

  if (!response.ok) {
    throw new Error(`WB API error: ${response.status} ${await response.text()}`);
  }

  return response.json() as Promise<any>;
}

/**
 * Deposit to campaign budget
 */
export async function depositToCampaign(
  apiKey: string,
  advertId: number,
  amountKopecks: number
): Promise<void> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v1/budget/deposit`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: advertId,
      sum: amountKopecks,
      type: 1, // from balance
    }),
  });

  if (!response.ok) {
    throw new Error(`WB API error: ${response.status} ${await response.text()}`);
  }
}

// ==================== NORMQUERY (КЛАСТЕРЫ) ====================

export interface NormqueryCluster {
  cluster: number;
  phrase: string;
  count: number;
  views?: number;
  clicks?: number;
  ctr?: number;
  orders?: number;
  sum?: number;
  nmId?: number;
  excluded?: boolean;
}

export interface NormqueryBid {
  cluster: number;
  bid: number; // kopecks
}

export interface NormqueryBidUpdate {
  cluster: number;
  bid: number; // kopecks
}

export interface MinusPhrase {
  phrase: string;
}

export interface NormqueryStats {
  cluster: number;
  phrase: string;
  views: number;
  clicks: number;
  ctr: number;
  orders: number;
  sum: number; // spend in rubles
  sumPrice: number; // orders sum in rubles
}

export interface NormqueryDayStats {
  date: string;
  clusters: NormqueryStats[];
}

/**
 * 1. Get bids for normquery clusters
 * POST /adv/v0/normquery/get-bids
 */
export async function getNormqueryBids(
  apiKey: string,
  advertId: number
): Promise<NormqueryBid[]> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v0/normquery/get-bids`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ advertId }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WB API error: ${response.status} ${text}`);
  }

  const data = await response.json() as any;
  return data?.bids ?? data ?? [];
}

/**
 * 2. Set bids for normquery clusters
 * POST /adv/v0/normquery/bids
 */
export async function setNormqueryBids(
  apiKey: string,
  advertId: number,
  bids: NormqueryBidUpdate[]
): Promise<void> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v0/normquery/bids`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ advertId, bids }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WB API error: ${response.status} ${text}`);
  }
}

/**
 * 3. Delete (reset) normquery cluster bids
 * DELETE /adv/v0/normquery/bids
 */
export async function deleteNormqueryBids(
  apiKey: string,
  advertId: number,
  clusters: number[]
): Promise<void> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v0/normquery/bids`, {
    method: 'DELETE',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ advertId, clusters }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WB API error: ${response.status} ${text}`);
  }
}

/**
 * 4. Get minus phrases for normquery
 * POST /adv/v0/normquery/get-minus
 */
export async function getNormqueryMinus(
  apiKey: string,
  advertId: number
): Promise<string[]> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v0/normquery/get-minus`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ advertId }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WB API error: ${response.status} ${text}`);
  }

  const data = await response.json() as any;
  return data?.excluded ?? data ?? [];
}

/**
 * 5. Set minus phrases for normquery
 * POST /adv/v0/normquery/set-minus
 */
export async function setNormqueryMinus(
  apiKey: string,
  advertId: number,
  excluded: string[]
): Promise<void> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v0/normquery/set-minus`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ advertId, excluded }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WB API error: ${response.status} ${text}`);
  }
}

/**
 * 6. Get list of normquery clusters
 * POST /adv/v0/normquery/list
 * WB API requires: { items: [{ advertId, nmId }] }
 */
export async function getNormqueryList(
  apiKey: string,
  advertId: number,
  active?: boolean,
  nmIds?: number[]
): Promise<NormqueryCluster[]> {
  // WB API v2 format requires items array with {advertId, nmId}
  const body: Record<string, unknown> = nmIds && nmIds.length > 0
    ? { items: nmIds.map(nmId => ({ advertId, nmId })) }
    : { advertId };
  if (active !== undefined) {
    body.active = active;
  }

  const response = await fetch(`${ADVERT_API_BASE}/adv/v0/normquery/list`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WB API error: ${response.status} ${text}`);
  }

  const text = await response.text();
  if (!text || text === 'null') return [];
  const data = JSON.parse(text) as any;

  // WB API returns { items: [{ advertId, nmId, normQueries: { active: string[], excluded: string[] } }] }
  // active/excluded are arrays of STRINGS (search phrases), not objects
  if (data?.items && Array.isArray(data.items)) {
    const allClusters: NormqueryCluster[] = [];
    let idx = 0;
    for (const item of data.items) {
      const nq = item?.normQueries;
      const nmId = item?.nmId;
      if (nq?.active && Array.isArray(nq.active)) {
        for (const phrase of nq.active) {
          if (typeof phrase === 'string') {
            allClusters.push({ cluster: idx++, phrase, count: 0, nmId, excluded: false });
          } else if (typeof phrase === 'object' && phrase) {
            // Fallback for object format: { id, normQuery, count, ... }
            allClusters.push({
              cluster: phrase.id ?? phrase.cluster ?? idx++,
              phrase: phrase.normQuery ?? phrase.phrase ?? phrase.query ?? '',
              count: phrase.count ?? phrase.views ?? 0,
              views: phrase.views,
              clicks: phrase.clicks,
              ctr: phrase.ctr,
              orders: phrase.orders,
              sum: phrase.sum ?? phrase.spend,
              nmId,
              excluded: false,
            });
          }
        }
      }
      if (nq?.excluded && Array.isArray(nq.excluded)) {
        for (const phrase of nq.excluded) {
          if (typeof phrase === 'string') {
            allClusters.push({ cluster: idx++, phrase, count: 0, nmId, excluded: true });
          }
        }
      }
    }
    return allClusters;
  }
  return data?.clusters ?? data ?? [];
}

/**
 * 7. Get normquery cluster stats (aggregated for period)
 * POST /adv/v0/normquery/stats
 */
export async function getNormqueryStats(
  apiKey: string,
  advertId: number,
  dateFrom: string,
  dateTo: string
): Promise<NormqueryStats[]> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v0/normquery/stats`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ advertId, dateFrom, dateTo }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WB API error: ${response.status} ${text}`);
  }

  const data = await response.json() as any;
  return data?.stats ?? data ?? [];
}

/**
 * 8. Get normquery cluster stats by day
 * POST /adv/v1/normquery/stats
 */
export async function getNormqueryStatsByDay(
  apiKey: string,
  advertId: number,
  dateFrom: string,
  dateTo: string
): Promise<NormqueryDayStats[]> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v1/normquery/stats`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ advertId, dateFrom, dateTo }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WB API error: ${response.status} ${text}`);
  }

  const data = await response.json() as any;
  return data?.days ?? data ?? [];
}

// ==================== HELPER FUNCTIONS ====================

export const CAMPAIGN_STATUS = {
  DELETED: -1,
  READY: 4,
  FINISHED: 7,
  CANCELLED: 8,
  ACTIVE: 9,
  PAUSED: 11,
} as const;

export function getStatusLabel(status: number): string {
  switch (status) {
    case -1:
      return 'Удалена';
    case 4:
      return 'Готова к запуску';
    case 7:
      return 'Завершена';
    case 8:
      return 'Отменена';
    case 9:
      return 'Активна';
    case 11:
      return 'На паузе';
    default:
      return `Статус ${status}`;
  }
}

// ==================== CAMPAIGN CREATION ====================

export interface CreateCampaignParams {
  type: 'auction' | 'auto' | 'search' | 'catalog'; // 4=catalog, 5=card, 6=search, 7=recommend, 8=auto, 9=auction
  name: string;
  dailyBudget?: number;
  nmIds: number[];
  subjectId?: number;
  cpm?: number;
}

/**
 * Create a new advertising campaign
 * POST /adv/v2/seacat/save-ad
 */
export async function createCampaign(
  apiKey: string,
  params: CreateCampaignParams
): Promise<{ advertId: number }> {
  // Map type to WB type code
  const typeMap: Record<string, number> = {
    catalog: 4,
    card: 5,
    search: 6,
    recommend: 7,
    auto: 8,
    auction: 9,
  };

  const type = typeMap[params.type] ?? 9;

  const body: Record<string, any> = {
    type,
    name: params.name,
    nms: params.nmIds,
  };

  if (params.dailyBudget) {
    body.dailyBudget = params.dailyBudget;
  }
  if (params.subjectId) {
    body.subjectId = params.subjectId;
  }
  if (params.cpm) {
    body.cpm = params.cpm;
  }

  const response = await fetch(`${ADVERT_API_BASE}/adv/v2/seacat/save-ad`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WB API error creating campaign: ${response.status} ${text}`);
  }

  const data = await response.json() as { advertId: number };
  return data;
}

/**
 * Get campaign types
 */
export function getCampaignTypes() {
  return [
    { value: 'auto', label: 'Автоматическая', description: 'WB сам выбирает места показа' },
    { value: 'auction', label: 'Аукцион', description: 'Показы в поиске и каталоге по ставке' },
    { value: 'search', label: 'Поиск', description: 'Только в результатах поиска' },
    { value: 'catalog', label: 'Каталог', description: 'Только в каталоге категорий' },
  ];
}

// ==================== BALANCE ====================

/**
 * Get advertiser balance
 * GET /adv/v1/balance
 */
export async function getAdvertBalance(apiKey: string): Promise<{ balance: number; bonus: number }> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v1/balance`, {
    headers: { Authorization: apiKey },
  });

  if (!response.ok) {
    throw new Error(`WB API error: ${response.status} ${await response.text()}`);
  }

  return response.json() as Promise<{ balance: number; bonus: number }>;
}

// ==================== CAMPAIGN PRODUCTS & BIDS ====================

export interface CampaignProduct {
  nmId: number;
  bid: number; // kopecks
  subjectId?: number;
  subjectName?: string;
}

/**
 * Get products in a campaign with their bids
 * GET /adv/v0/advert?id=
 */
export async function getCampaignProducts(
  apiKey: string,
  advertId: number
): Promise<CampaignProduct[]> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v0/advert?id=${advertId}`, {
    headers: { Authorization: apiKey },
  });

  if (!response.ok) {
    throw new Error(`WB API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as any;
  
  // v2 API returns { params: [{ nms: [nmId], price: bid }] }
  // or nm_settings for newer format
  const products: CampaignProduct[] = [];
  
  // Handle nm_settings format (unified campaigns)
  if (data?.nm_settings && Array.isArray(data.nm_settings)) {
    for (const nm of data.nm_settings) {
      const bid = nm.bids_kopecks?.search || nm.bids_kopecks?.combined || nm.bid || 0;
      products.push({
        nmId: nm.nm_id || nm.nmId,
        bid,
        subjectId: nm.subject?.id,
        subjectName: nm.subject?.name,
      });
    }
  }
  
  // Handle params format (older campaigns)
  if (data?.params && Array.isArray(data.params)) {
    for (const param of data.params) {
      const nms = param.nms || param.nmIds || [];
      const bid = param.price || param.cpm || 0;
      for (const nmId of nms) {
        products.push({
          nmId,
          bid,
          subjectId: param.subjectId,
          subjectName: param.subjectName,
        });
      }
    }
  }
  
  return products;
}

/**
 * Set daily budget for a campaign
 * POST /adv/v0/daily-budget
 */
export async function setCampaignDailyBudget(
  apiKey: string,
  advertId: number,
  dailyBudget: number
): Promise<void> {
  const response = await fetch(`${ADVERT_API_BASE}/adv/v0/daily-budget`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ advertId, dailyBudget }),
  });

  if (!response.ok) {
    throw new Error(`WB API error: ${response.status} ${await response.text()}`);
  }
}
