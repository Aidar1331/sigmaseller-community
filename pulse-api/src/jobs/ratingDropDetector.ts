import { log } from '../lib/logger.js';
import { detectRatingDropsAllWorkspaces } from '../services/eventDetectors/ratingDrop.js';

const logger = log.child({ module: 'ratingDropDetector' });

export async function runRatingDropDetector(): Promise<void> {
  const start = Date.now();
  const result = await detectRatingDropsAllWorkspaces();
  logger.info({ result, durationMs: Date.now() - start }, 'ratingDrop detector done');
}
