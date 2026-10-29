/**
 * WB Balance API
 * Host: https://finance-api.wildberries.ru
 *
 * ⚠️ Rate limit: 1 req/min
 */

import { wbGetJson } from './wbClient.js';

const FINANCE_API = 'https://finance-api.wildberries.ru';

// ============================================================================
// Types
// ============================================================================

export interface WbBalance {
  currency: string;       // "RUB"
  current: number;        // Текущий баланс (рубли)
  forWithdraw: number;    // Доступно к выводу (рубли)
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get seller account balance
 * GET /api/v1/account/balance
 * ⚠️ Rate limit: 1 req/min
 */
export async function getBalance(apiKey: string): Promise<WbBalance> {
  const raw = await wbGetJson<{ currency: string; current: number; for_withdraw: number }>(
    `${FINANCE_API}/api/v1/account/balance`,
    apiKey,
    1,
    { maxRetries: 1 }
  );
  
  // Normalize response (snake_case -> camelCase)
  return {
    currency: raw.currency,
    current: raw.current,
    forWithdraw: raw.for_withdraw,
  };
}

// ============================================================================
// Formatting helpers
// ============================================================================

/**
 * Format balance for display
 */
export function formatBalance(balance: WbBalance): string {
  const formatter = new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: balance.currency || 'RUB',
    minimumFractionDigits: 2,
  });
  
  return formatter.format(balance.current);
}

/**
 * Format withdrawable amount
 */
export function formatWithdrawable(balance: WbBalance): string {
  const formatter = new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: balance.currency || 'RUB',
    minimumFractionDigits: 2,
  });
  
  return formatter.format(balance.forWithdraw);
}
