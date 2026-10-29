/**
 * WB Passes API (пропуска на склады)
 * Host: https://marketplace-api.wildberries.ru
 */

import { wbGetJson, wbPostJson, wbPutJson, wbDeleteJson } from './wbClient.js';

const MARKETPLACE_API = 'https://marketplace-api.wildberries.ru';

// ============================================================================
// Types
// ============================================================================

export interface WbPass {
  id: number;
  firstName: string;
  lastName: string;
  carModel: string;
  carNumber: string;
  officeName: string;
  officeAddress: string;
  officeId: number;
  dateEnd: string;  // ISO datetime (48 часов от создания)
}

export interface CreatePassData {
  firstName: string;
  lastName: string;
  carModel: string;
  carNumber: string;
  officeId: number;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get seller's passes
 * GET /api/v3/passes
 * Rate limit: 300 req/min
 */
export async function getPasses(apiKey: string): Promise<WbPass[]> {
  return wbGetJson<WbPass[]>(`${MARKETPLACE_API}/api/v3/passes`, apiKey);
}

/**
 * Create pass (valid for 48 hours)
 * POST /api/v3/passes
 *
 * ⚠️ Rate limit: 1 запрос в 10 МИНУТ на аккаунт!
 * Валидация: общая длина ФИО 6-100 символов, номер авто — только буквы и цифры
 */
export async function createPass(
  apiKey: string,
  data: CreatePassData
): Promise<{ id: number }> {
  return wbPostJson<{ id: number }>(
    `${MARKETPLACE_API}/api/v3/passes`,
    apiKey,
    data,
    1,
    { maxRetries: 1 } // Don't retry - strict rate limit
  );
}

/**
 * Update pass
 * PUT /api/v3/passes/{passId}
 * Rate limit: 300 req/min
 */
export async function updatePass(
  apiKey: string,
  passId: number,
  data: CreatePassData
): Promise<void> {
  await wbPutJson(`${MARKETPLACE_API}/api/v3/passes/${passId}`, apiKey, data);
}

/**
 * Delete pass
 * DELETE /api/v3/passes/{passId}
 * Rate limit: 300 req/min
 */
export async function deletePass(apiKey: string, passId: number): Promise<void> {
  await wbDeleteJson(`${MARKETPLACE_API}/api/v3/passes/${passId}`, apiKey);
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate pass data
 */
export function validatePassData(data: CreatePassData): { valid: boolean; error?: string } {
  const fullNameLength = data.firstName.length + data.lastName.length;
  
  if (fullNameLength < 6) {
    return { valid: false, error: 'ФИО должно быть минимум 6 символов' };
  }
  
  if (fullNameLength > 100) {
    return { valid: false, error: 'ФИО не должно превышать 100 символов' };
  }
  
  if (!/^[A-Za-zА-Яа-яЁё0-9]+$/.test(data.carNumber)) {
    return { valid: false, error: 'Номер авто должен содержать только буквы и цифры' };
  }
  
  if (!data.carModel.trim()) {
    return { valid: false, error: 'Укажите модель автомобиля' };
  }
  
  if (!data.officeId || data.officeId <= 0) {
    return { valid: false, error: 'Укажите склад' };
  }
  
  return { valid: true };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Calculate time remaining for pass
 */
export function getPassTimeRemaining(pass: WbPass): {
  hours: number;
  minutes: number;
  expired: boolean;
  expiresAt: Date;
} {
  const expiresAt = new Date(pass.dateEnd);
  const now = Date.now();
  const diff = expiresAt.getTime() - now;

  if (diff <= 0) {
    return { hours: 0, minutes: 0, expired: true, expiresAt };
  }

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  return { hours, minutes, expired: false, expiresAt };
}

/**
 * Format pass time remaining
 */
export function formatPassTimeRemaining(pass: WbPass): string {
  const { hours, minutes, expired } = getPassTimeRemaining(pass);
  
  if (expired) return 'Истёк';
  if (hours > 0) return `${hours}ч ${minutes}м`;
  return `${minutes}м`;
}
