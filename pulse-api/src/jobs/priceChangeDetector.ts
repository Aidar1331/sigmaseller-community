import { log } from '../lib/logger.js';
import { detectAllPriceEventsAllWorkspaces } from '../services/eventDetectors/priceChange.js';

const logger = log.child({ module: 'priceChangeDetector' });

export async function runPriceChangeDetector(): Promise<void> {
  const start = Date.now();
  // Запускаем все 3 детектора (sales-based + seller-cabinet + СПП).
  const result = await detectAllPriceEventsAllWorkspaces();
  logger.info({ result, durationMs: Date.now() - start }, 'price detectors done');
}
