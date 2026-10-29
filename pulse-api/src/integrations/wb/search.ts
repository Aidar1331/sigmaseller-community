/**
 * WB Search integration via Playwright
 * 
 * Uses stealth browser to bypass antibot and parse search results directly.
 * This is more reliable than API calls which get blocked.
 * 
 * Rate limit: 50 requests/hour (safe limit to avoid IP ban)
 */

/// <reference lib="dom" />

import { chromium } from 'playwright-extra';
import type { Browser, Page } from 'playwright-core';
import stealth from 'puppeteer-extra-plugin-stealth';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'wbSearch' });

// Apply stealth plugin
chromium.use(stealth());

// ============ RATE LIMITER (60 req/hour for 20 keywords × 3 pages) ============
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const requestTimestamps: number[] = [];

function checkRateLimit(): { allowed: boolean; waitMs: number; remaining: number } {
  const now = Date.now();
  // Remove old timestamps outside the window
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_WINDOW_MS) {
    requestTimestamps.shift();
  }
  
  const remaining = RATE_LIMIT - requestTimestamps.length;
  
  if (requestTimestamps.length >= RATE_LIMIT) {
    const oldestInWindow = requestTimestamps[0];
    const waitMs = oldestInWindow + RATE_WINDOW_MS - now;
    return { allowed: false, waitMs, remaining: 0 };
  }
  
  return { allowed: true, waitMs: 0, remaining };
}

function recordRequest(): void {
  requestTimestamps.push(Date.now());
}

export function getRateLimitStatus(): { used: number; limit: number; remaining: number; resetsIn: number } {
  const now = Date.now();
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_WINDOW_MS) {
    requestTimestamps.shift();
  }
  const used = requestTimestamps.length;
  const resetsIn = requestTimestamps.length > 0 
    ? Math.max(0, requestTimestamps[0] + RATE_WINDOW_MS - now) 
    : 0;
  return { used, limit: RATE_LIMIT, remaining: RATE_LIMIT - used, resetsIn };
}

// Random delay for natural behavior (2-5 seconds)
function randomDelay(): Promise<void> {
  const ms = 2000 + Math.random() * 3000;
  return new Promise(r => setTimeout(r, ms));
}

export interface WbSearchProduct {
  article: number;         // Артикул (nmId)
  position: number;        // Позиция в выдаче
  name: string;            // Название
  brand: string;           // Бренд
  price: number;           // Текущая цена (копейки)
  originalPrice: number;   // Цена до скидки (копейки)
  discount: number;        // Скидка %
  rating: number;          // Рейтинг
  feedbacks: number;       // Количество отзывов
  photoUrl: string;        // URL главного фото
  isPromo: boolean;        // Рекламный товар
  log?: { cpm?: number };  // Рекламные данные (если есть)
}

export interface WbSearchResult {
  products: WbSearchProduct[];
  total: number;
}

export interface ProductPosition {
  nmId: number;
  position: number | null;
  page: number | null;
  cpm: number | null;
  isPromo: boolean;
}

// Browser instance (reused)
let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }
  
  logger.info('Launching stealth browser');
  browserInstance = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  
  return browserInstance;
}

/**
 * Search WB using Playwright (parses page directly)
 * Rate limited to 50 requests/hour
 */
export async function searchWb(
  keyword: string,
  page: number = 1
): Promise<WbSearchResult> {
  // Check rate limit
  const rateStatus = checkRateLimit();
  if (!rateStatus.allowed) {
    const waitMin = Math.ceil(rateStatus.waitMs / 60000);
    throw new Error(`Rate limit exceeded (50/hour). Try again in ${waitMin} minutes.`);
  }
  
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
    locale: 'ru-RU',
    viewport: { width: 1920, height: 1080 },
  });
  
  const browserPage = await context.newPage();
  
  try {
    const url = `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(keyword)}&page=${page}`;
    const status = getRateLimitStatus();
    logger.info({ keyword, page, remaining: status.remaining, limit: status.limit }, 'Loading search page');
    
    await browserPage.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    
    // Record the request after successful navigation
    recordRequest();
    
    // Wait for antibot if needed
    const title = await browserPage.title();
    if (title.includes('Почти готово')) {
      logger.info('Waiting for antibot');
      await browserPage.waitForFunction(
        () => !document.title.includes('Почти готово'),
        { timeout: 30000 }
      );
    }
    
    // Wait for products to load
    await browserPage.waitForSelector('[data-nm-id]', { timeout: 15000 }).catch(() => {});
    
    // Small delay for dynamic content
    await browserPage.waitForTimeout(1000);
    
    // Calculate base position for this page
    const basePosition = (page - 1) * 100; // Assume max 100 per page
    
    // Extract product data with extended info
    const products = await browserPage.evaluate((basePos: number) => {
      const cards = document.querySelectorAll('[data-nm-id]');
      return Array.from(cards).map((el, index) => {
        const article = parseInt(el.getAttribute('data-nm-id') || '0', 10);
        const nameEl = el.querySelector('.product-card__name, .goods-name');
        const brandEl = el.querySelector('.product-card__brand, .brand-name');
        
        // Prices
        const salePriceEl = el.querySelector('.price__lower-price, .price-commission__current');
        const originalPriceEl = el.querySelector('.price__old, .price-commission__old');
        const price = parseInt(salePriceEl?.textContent?.replace(/\D/g, '') || '0', 10);
        const originalPrice = parseInt(originalPriceEl?.textContent?.replace(/\D/g, '') || '0', 10) || price;
        const discount = originalPrice > price 
          ? Math.round((1 - price / originalPrice) * 100) 
          : 0;
        
        const ratingEl = el.querySelector('.product-card__rating, .rating, .star-rating__stars');
        const feedbackEl = el.querySelector('.product-card__count, .count');
        
        // Photo URL
        const imgEl = el.querySelector('img');
        const photoUrl = imgEl?.src || imgEl?.getAttribute('data-src') || '';
        
        // Check if promoted (рекламный)
        const isPromo = el.classList.contains('product-card--advert') || 
                       !!el.querySelector('.product-card__advert') ||
                       !!el.querySelector('[class*="advert"]');
        
        return {
          article,
          position: basePos + index + 1,
          name: nameEl?.textContent?.trim() || '',
          brand: brandEl?.textContent?.trim() || '',
          price: price * 100,
          originalPrice: originalPrice * 100,
          discount,
          rating: parseFloat(ratingEl?.textContent?.replace(',', '.') || '0'),
          feedbacks: parseInt(feedbackEl?.textContent?.replace(/\D/g, '') || '0', 10),
          photoUrl,
          isPromo,
        };
      });
    }, basePosition);
    
    // Get total count
    const totalText = await browserPage.evaluate(() => {
      const countEl = document.querySelector('.goods-count, .searching-results__count');
      return countEl?.textContent || '0';
    });
    const total = parseInt(totalText.replace(/\D/g, '') || '0', 10);
    
    logger.info({ productsCount: products.length, total }, 'Search results found');
    
    return { products, total };
  } finally {
    await context.close();
  }
}

/**
 * Find positions of specific products in search results
 */
export async function findProductPositions(
  keyword: string,
  nmIds: number[],
  maxPages: number = 3
): Promise<{
  positions: ProductPosition[];
  totalProducts: number;
}> {
  const nmIdSet = new Set(nmIds);
  const foundPositions: Map<number, ProductPosition> = new Map();
  let totalProducts = 0;
  let globalPosition = 0;

  for (let page = 1; page <= maxPages; page++) {
    try {
      const result = await searchWb(keyword, page);

      if (page === 1) {
        totalProducts = result.total;
      }

      if (result.products.length === 0) {
        break;
      }

      for (const product of result.products) {
        globalPosition++;

        if (nmIdSet.has(product.article) && !foundPositions.has(product.article)) {
          const isPromo = !!(product.log?.cpm);
          foundPositions.set(product.article, {
            nmId: product.article,
            position: globalPosition,
            page,
            cpm: product.log?.cpm || null,
            isPromo,
          });
        }
      }

      // All products found
      if (foundPositions.size === nmIdSet.size) {
        break;
      }

      // Random delay between pages (2-5 sec for natural behavior)
      await randomDelay();
    } catch (error) {
      logger.error({ err: error, page, keyword }, 'Error searching page');
      break;
    }
  }

  // Build result with nulls for not found products
  const positions: ProductPosition[] = nmIds.map((nmId) => {
    const found = foundPositions.get(nmId);
    return found || {
      nmId,
      position: null,
      page: null,
      cpm: null,
      isPromo: false,
    };
  });

  return { positions, totalProducts };
}

/**
 * Check position of your product across multiple keywords
 * Optimized: stops early when product is found, minimizes requests
 * 
 * @param nmId - Your product nmId
 * @param keywords - List of keywords to check
 * @param maxPages - Max pages to search per keyword (default 3 = top 90)
 * @returns Position data for each keyword
 */
export async function checkPositions(
  nmId: number,
  keywords: string[],
  maxPages: number = 3
): Promise<{
  results: Array<{
    keyword: string;
    position: number | null;
    page: number | null;
    totalProducts: number;
    neighbors: WbSearchProduct[]; // Products around your position (±3)
  }>;
  requestsUsed: number;
  rateLimitRemaining: number;
}> {
  const results: Array<{
    keyword: string;
    position: number | null;
    page: number | null;
    totalProducts: number;
    neighbors: WbSearchProduct[];
  }> = [];
  
  let requestsUsed = 0;
  
  for (const keyword of keywords) {
    // Check rate limit before each keyword
    const rateStatus = checkRateLimit();
    if (!rateStatus.allowed) {
      logger.warn({ processed: results.length, total: keywords.length }, 'Rate limit hit, stopping');
      break;
    }
    
    let found = false;
    let position: number | null = null;
    let foundPage: number | null = null;
    let totalProducts = 0;
    let neighbors: WbSearchProduct[] = [];
    let allProducts: WbSearchProduct[] = [];
    
    for (let page = 1; page <= maxPages && !found; page++) {
      try {
        const result = await searchWb(keyword, page);
        requestsUsed++;
        
        if (page === 1) {
          totalProducts = result.total;
        }
        
        allProducts.push(...result.products);
        
        // Check if our product is on this page
        const ourProduct = result.products.find(p => p.article === nmId);
        if (ourProduct) {
          found = true;
          position = ourProduct.position;
          foundPage = page;
          
          // Get neighbors (±3 positions)
          const ourIndex = allProducts.findIndex(p => p.article === nmId);
          const start = Math.max(0, ourIndex - 3);
          const end = Math.min(allProducts.length, ourIndex + 4);
          neighbors = allProducts.slice(start, end).filter(p => p.article !== nmId);
          
          logger.info({ nmId, position, keyword }, 'Product found in search');
        }
        
        // If no products, stop searching this keyword
        if (result.products.length === 0) {
          break;
        }
        
        // Delay between pages
        if (!found && page < maxPages) {
          await randomDelay();
        }
      } catch (error: any) {
        if (error.message.includes('Rate limit')) {
          logger.warn({ keyword }, 'Rate limit hit during keyword search');
          break;
        }
        logger.error({ err: error, keyword, page }, 'Error on keyword page');
        break;
      }
    }
    
    results.push({
      keyword,
      position,
      page: foundPage,
      totalProducts,
      neighbors,
    });
    
    // Small delay between keywords
    if (keywords.indexOf(keyword) < keywords.length - 1) {
      await randomDelay();
    }
  }
  
  const finalStatus = getRateLimitStatus();
  
  return {
    results,
    requestsUsed,
    rateLimitRemaining: finalStatus.remaining,
  };
}

/**
 * Batch check: maximum keywords with minimum requests
 * Use when you have many keywords and limited quota
 * Only checks first page (top 30) per keyword
 */
export async function quickCheckPositions(
  nmId: number,
  keywords: string[]
): Promise<{
  results: Array<{
    keyword: string;
    position: number | null;  // null = not in top 30
    totalProducts: number;
  }>;
  requestsUsed: number;
}> {
  const results: Array<{
    keyword: string;
    position: number | null;
    totalProducts: number;
  }> = [];
  
  let requestsUsed = 0;
  
  for (const keyword of keywords) {
    const rateStatus = checkRateLimit();
    if (!rateStatus.allowed) {
      logger.warn({ processed: results.length, total: keywords.length }, 'Rate limit hit');
      break;
    }
    
    try {
      const result = await searchWb(keyword, 1);
      requestsUsed++;
      
      const ourProduct = result.products.find(p => p.article === nmId);
      
      results.push({
        keyword,
        position: ourProduct?.position || null,
        totalProducts: result.total,
      });
      
      if (ourProduct) {
        logger.info({ keyword, position: ourProduct.position }, 'Product found in quick check');
      } else {
        logger.info({ keyword }, 'Product not in top 30');
      }
      
      // Delay between keywords
      if (keywords.indexOf(keyword) < keywords.length - 1) {
        await randomDelay();
      }
    } catch (error: any) {
      if (error.message.includes('Rate limit')) break;
      logger.error({ err: error, keyword }, 'Error on keyword quick check');
      results.push({ keyword, position: null, totalProducts: 0 });
    }
  }
  
  return { results, requestsUsed };
}

/**
 * Get search suggestions
 */
export async function getSearchSuggestions(query: string): Promise<string[]> {
  // For now, return empty - suggestions require API
  return [];
}

/**
 * Cleanup browser
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}
