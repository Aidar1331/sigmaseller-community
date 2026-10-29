/**
 * WB Cookie Manager
 * 
 * Uses Playwright + Stealth to solve antibot challenge and get cookies.
 * Cookies are then used for fast HTTP requests.
 */

import { chromium } from 'playwright-extra';
import type { Browser, BrowserContext } from 'playwright-core';
import stealth from 'puppeteer-extra-plugin-stealth';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'wbCookieManager' });

// Apply stealth plugin
chromium.use(stealth());

interface WbCookies {
  cookies: Array<{ name: string; value: string; domain: string }>;
  userAgent: string;
  obtainedAt: number;
  expiresAt: number;
}

// Cache cookies in memory
let cachedCookies: WbCookies | null = null;
let browserInstance: Browser | null = null;

const COOKIE_LIFETIME_MS = 60 * 60 * 1000; // 1 hour
const PROXY_URL = process.env.WB_SEARCH_PROXY;

/**
 * Parse proxy URL into Playwright format
 */
function parseProxy(proxyUrl: string | undefined): { server: string; username?: string; password?: string } | undefined {
  if (!proxyUrl) return undefined;
  
  try {
    const url = new URL(proxyUrl);
    return {
      server: `${url.protocol}//${url.host}`,
      username: url.username || undefined,
      password: url.password || undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Get or create browser instance
 */
async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }
  
  logger.info('Launching stealth browser');
  
  browserInstance = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  
  return browserInstance;
}

/**
 * Solve antibot challenge and get cookies
 */
async function obtainCookies(): Promise<WbCookies> {
  const browser = await getBrowser();
  const proxy = parseProxy(PROXY_URL);
  
  logger.info({ proxy: proxy?.server ?? null }, 'Creating context');
  
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
  
  const contextOptions: any = {
    userAgent,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    viewport: { width: 1920, height: 1080 },
  };
  
  if (proxy) {
    contextOptions.proxy = proxy;
  }
  
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  
  try {
    logger.info('Navigating to WB');
    
    // Go to main page first
    await page.goto('https://www.wildberries.ru/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    
    // Wait for antibot to resolve
    logger.info('Waiting for antibot challenge');
    
    await page.waitForFunction(() => {
      const title = document.title;
      return !title.includes('Почти готово') && !title.includes('429');
    }, { timeout: 30000 });
    
    // Additional wait to ensure cookies are set
    await page.waitForTimeout(2000);
    
    // Get cookies
    const cookies = await context.cookies();
    const wbCookies = cookies.filter(c => 
      c.domain.includes('wildberries') || c.domain.includes('.wb.ru')
    );
    
    logger.info({ cookiesCount: wbCookies.length }, 'Got cookies');
    
    const result: WbCookies = {
      cookies: wbCookies.map(c => ({ name: c.name, value: c.value, domain: c.domain })),
      userAgent,
      obtainedAt: Date.now(),
      expiresAt: Date.now() + COOKIE_LIFETIME_MS,
    };
    
    return result;
  } finally {
    await context.close();
  }
}

/**
 * Get valid cookies, refreshing if needed
 */
export async function getWbCookies(): Promise<WbCookies> {
  // Check if cached cookies are still valid
  if (cachedCookies && Date.now() < cachedCookies.expiresAt) {
    logger.debug('Using cached cookies');
    return cachedCookies;
  }
  
  logger.info('Refreshing cookies');
  cachedCookies = await obtainCookies();
  return cachedCookies;
}

/**
 * Format cookies for HTTP request header
 */
export function formatCookieHeader(cookies: WbCookies): string {
  return cookies.cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * Force refresh cookies (e.g., after 403/429)
 */
export async function refreshWbCookies(): Promise<WbCookies> {
  logger.info('Force refreshing cookies');
  cachedCookies = null;
  return getWbCookies();
}

/**
 * Cleanup browser on shutdown
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}
