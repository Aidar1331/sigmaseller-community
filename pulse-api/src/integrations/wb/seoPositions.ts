/**
 * WB SEO Positions - Get product positions in search results
 * Based on wb-private-api patterns
 */

import { withRetry } from '../../lib/rateLimiter.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'seoPositions' });

// WB destinations (regions)
// Codes can be found via WB API or browser network tab
// Format: negative numbers for most regions
export const DESTINATIONS = {
  MOSCOW: -1257786,
  SPB: -1123422,
  KRASNODAR: -1113276,
  KAZAN: 12358062,
  NOVOSIBIRSK: -1221148,
  // TODO: Verify Ekaterinburg code - was incorrectly set to same as Krasnodar
  // Common Ekaterinburg dest codes: -1113276 (wrong), possible: -1255563 or similar
  EKATERINBURG: -1255563, // Updated - needs verification
  // Additional regions can be added as needed
  SAMARA: -140294,
  CHELYABINSK: -1407693,
  ROSTOV: -1113276, // Verify this too
} as const;

interface SearchProduct {
  id: number;
  root: number;
  kindId: number;
  brand: string;
  brandId: number;
  siteBrandId: number;
  colors: any[];
  subjectId: number;
  subjectParentId: number;
  name: string;
  supplier: string;
  supplierId: number;
  supplierRating: number;
  supplierFlags: number;
  pics: number;
  rating: number;
  reviewRating: number;
  feedbacks: number;
  panelPromoId: number;
  promoTextCard: string;
  promoTextCat: string;
  volume: number;
  viewFlags: number;
  sizes: any[];
  totalQuantity: number;
  logs?: any;
  isNew?: boolean;
  time1?: number;
  time2?: number;
  sale?: number;
  priceU?: number;
  salePriceU?: number;
}

interface SearchResponse {
  state: number;
  version: number;
  payloadVersion: number;
  data: {
    products: SearchProduct[];
    total: number;
  };
}

interface ProductPosition {
  nmId: number;
  position: number;
  page: number;
  positionOnPage: number;
  isPromo: boolean;
  brand: string;
  name: string;
  price: number;
  rating: number;
  feedbacks: number;
  supplierId: number;
}

interface SearchAd {
  advertId: number;
  nmId: number;
  position: number;
  cpm: number;
  subjectId: number;
}

interface SearchAdsResponse {
  pages: Record<number, number[]>; // page -> positions with ads
  adverts: SearchAd[];
  prioritySubjects: number[];
}

/**
 * Search products by keyword and get their positions
 */
export async function searchProducts(
  keyword: string,
  options: {
    pages?: number;
    destination?: number;
    sort?: 'popular' | 'rate' | 'priceup' | 'pricedown' | 'newly';
  } = {}
): Promise<SearchProduct[]> {
  const {
    pages = 5,
    destination = DESTINATIONS.MOSCOW,
    sort = 'popular',
  } = options;

  const allProducts: SearchProduct[] = [];

  for (let page = 1; page <= pages; page++) {
    const url = buildSearchUrl(keyword, page, destination, sort);
    
    try {
      const response = await withRetry(async () => {
        const res = await fetch(url, {
          headers: getSearchHeaders(keyword),
        });
        
        if (!res.ok) {
          throw new Error(`Search failed: ${res.status}`);
        }
        
        return res.json() as Promise<SearchResponse>;
      });

      if (response.data?.products) {
        allProducts.push(...response.data.products);
      }

      // Small delay between pages
      await sleep(300);
    } catch (error) {
      logger.error({ err: error, page }, 'Error fetching search page');
      break;
    }
  }

  return allProducts;
}

/**
 * Find position of specific product(s) in search results
 */
export async function findProductPositions(
  keyword: string,
  nmIds: number[],
  options: {
    maxPages?: number;
    destination?: number;
  } = {}
): Promise<Map<number, ProductPosition>> {
  const {
    maxPages = 20,
    destination = DESTINATIONS.MOSCOW,
  } = options;

  const nmIdSet = new Set(nmIds);
  const positions = new Map<number, ProductPosition>();
  const pageSize = 100;

  for (let page = 1; page <= maxPages; page++) {
    const url = buildSearchUrl(keyword, page, destination, 'popular');
    
    try {
      const response = await withRetry(async () => {
        const res = await fetch(url, {
          headers: getSearchHeaders(keyword),
        });
        
        if (!res.ok) {
          throw new Error(`Search failed: ${res.status}`);
        }
        
        return res.json() as Promise<SearchResponse>;
      });

      const products = response.data?.products || [];
      
      for (let i = 0; i < products.length; i++) {
        const product = products[i];
        
        if (nmIdSet.has(product.id)) {
          const globalPosition = (page - 1) * pageSize + i + 1;
          
          positions.set(product.id, {
            nmId: product.id,
            position: globalPosition,
            page,
            positionOnPage: i + 1,
            isPromo: !!(product.logs && product.logs.cpm),
            brand: product.brand,
            name: product.name,
            price: product.salePriceU ? product.salePriceU / 100 : 0,
            rating: product.rating,
            feedbacks: product.feedbacks,
            supplierId: product.supplierId,
          });
          
          nmIdSet.delete(product.id);
        }
      }

      // Found all products or reached end
      if (nmIdSet.size === 0 || products.length < pageSize) {
        break;
      }

      await sleep(300);
    } catch (error) {
      logger.error({ err: error, page }, 'Error searching page');
      break;
    }
  }

  // Mark not found products
  for (const nmId of nmIdSet) {
    positions.set(nmId, {
      nmId,
      position: -1, // Not found
      page: -1,
      positionOnPage: -1,
      isPromo: false,
      brand: '',
      name: '',
      price: 0,
      rating: 0,
      feedbacks: 0,
      supplierId: 0,
    });
  }

  return positions;
}

/**
 * Get advertisers in search results with their CPM
 */
export async function getSearchAds(
  keyword: string,
  destination: number = DESTINATIONS.MOSCOW
): Promise<SearchAdsResponse> {
  const encodedKeyword = encodeURIComponent(keyword);
  const url = `https://catalog-ads.wildberries.ru/api/v5/search?keyword=${encodedKeyword}`;

  try {
    const response = await withRetry(async () => {
      const res = await fetch(url, {
        headers: {
          'Accept': '*/*',
          'Origin': 'https://www.wildberries.ru',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
          'Referer': `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodedKeyword}`,
        },
      });

      if (!res.ok) {
        throw new Error(`Ads search failed: ${res.status}`);
      }

      return res.json() as Promise<{
        prioritySubjects?: number[];
        adverts?: Array<{ id: number; nmId: number; position?: number; cpm?: number; subjectId?: number }>;
        pages?: Record<string, number[]>;
      }>;
    });

    // Parse ads response
    const adverts: SearchAd[] = [];
    const pages: Record<number, number[]> = {};
    const prioritySubjects: number[] = response?.prioritySubjects || [];

    if (response?.adverts) {
      for (const advert of response.adverts) {
        adverts.push({
          advertId: advert.id,
          nmId: advert.nmId,
          position: advert.position || 0,
          cpm: advert.cpm || 0,
          subjectId: advert.subjectId || 0,
        });
      }
    }

    if (response?.pages) {
      for (const [pageNum, positions] of Object.entries(response.pages)) {
        pages[parseInt(pageNum)] = positions as number[];
      }
    }

    return { pages, adverts, prioritySubjects };
  } catch (error) {
    logger.error({ err: error }, 'Error getting ads');
    return { pages: {}, adverts: [], prioritySubjects: [] };
  }
}

/**
 * Track keyword positions over time for a workspace
 */
export interface KeywordTrackingResult {
  keyword: string;
  checkedAt: Date;
  destination: number;
  products: ProductPosition[];
  ads: SearchAdsResponse;
}

export async function trackKeywordPositions(
  keyword: string,
  nmIds: number[],
  destination: number = DESTINATIONS.MOSCOW
): Promise<KeywordTrackingResult> {
  const [positions, ads] = await Promise.all([
    findProductPositions(keyword, nmIds, { destination }),
    getSearchAds(keyword, destination),
  ]);

  return {
    keyword,
    checkedAt: new Date(),
    destination,
    products: Array.from(positions.values()),
    ads,
  };
}

// Helper functions

function buildSearchUrl(
  keyword: string,
  page: number,
  destination: number,
  sort: string
): string {
  const encodedKeyword = encodeURIComponent(keyword);
  return `https://search.wb.ru/exactmatch/ru/common/v4/search?appType=1&curr=rub&dest=${destination}&page=${page}&query=${encodedKeyword}&resultset=catalog&sort=${sort}&spp=30&suppressSpellcheck=false`;
}

function getSearchHeaders(keyword: string): Record<string, string> {
  return {
    'Accept': '*/*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Origin': 'https://www.wildberries.ru',
    'Referer': `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(keyword)}`,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
