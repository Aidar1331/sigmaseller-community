/**
 * rembg Service - Background Removal
 * Self-hosted, бесплатно для пользователей
 */

import FormData from 'form-data';
import { env } from '../../env.js';

const REMBG_URL = env.REMBG_URL || 'http://localhost:7000';

export interface RemoveBgOptions {
  /** Модель для удаления фона */
  model?: 'birefnet-general-lite' | 'birefnet-general' | 'birefnet-portrait' | 'u2net' | 'isnet-anime';
  /** Улучшенная обработка краёв (волосы, мех) */
  alphaMatting?: boolean;
  /** Порог переднего плана для alpha matting (0-255) */
  alphaMattingForegroundThreshold?: number;
  /** Порог фона для alpha matting (0-255) */
  alphaMattingBackgroundThreshold?: number;
  /** Размер эрозии для alpha matting */
  alphaMattingErosionSize?: number;
}

/**
 * Удалить фон с изображения
 */
export async function removeBackground(
  imageBuffer: Buffer,
  options: RemoveBgOptions = {}
): Promise<Buffer> {
  const {
    model = 'birefnet-general-lite',
    alphaMatting = false,
    alphaMattingForegroundThreshold = 240,
    alphaMattingBackgroundThreshold = 10,
    alphaMattingErosionSize = 10,
  } = options;

  const formData = new FormData();
  formData.append('file', imageBuffer, {
    filename: 'image.png',
    contentType: 'image/png',
  });

  // Build query params
  const params = new URLSearchParams();
  params.set('model', model);
  
  if (alphaMatting) {
    params.set('a', 'true');
    params.set('af', String(alphaMattingForegroundThreshold));
    params.set('ab', String(alphaMattingBackgroundThreshold));
    params.set('ae', String(alphaMattingErosionSize));
  }

  const url = `${REMBG_URL}/api/remove?${params.toString()}`;

  const response = await fetch(url, {
    method: 'POST',
    body: formData as any,
    headers: formData.getHeaders(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`rembg error: ${response.status} ${response.statusText} - ${text}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Проверить доступность rembg сервиса
 */
export async function healthCheck(): Promise<{ ok: boolean; model?: string; error?: string }> {
  try {
    const response = await fetch(`${REMBG_URL}/api/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    
    if (response.ok) {
      return { ok: true, model: 'birefnet-general-lite' };
    }
    return { ok: false, error: `Status ${response.status}` };
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}

/**
 * Получить список доступных моделей
 */
export const AVAILABLE_MODELS = [
  { id: 'birefnet-general-lite', name: 'BiRefNet General Lite', description: 'Быстрый, хорошее качество (рекомендуется)', speed: 'fast' },
  { id: 'birefnet-general', name: 'BiRefNet General', description: 'Лучшее качество, медленнее', speed: 'medium' },
  { id: 'birefnet-portrait', name: 'BiRefNet Portrait', description: 'Оптимизирован для людей', speed: 'medium' },
  { id: 'u2net', name: 'U²-Net', description: 'Классическая модель, стабильная', speed: 'fast' },
  { id: 'isnet-anime', name: 'ISNet Anime', description: 'Для аниме и иллюстраций', speed: 'fast' },
] as const;
