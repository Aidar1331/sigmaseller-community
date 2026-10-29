/**
 * Chunking utilities for processing large datasets without OOM
 */

import log from './logger.js';

const logger = log.child({ module: 'chunking' });

/**
 * Split array into chunks of specified size
 */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Process items in chunks with concurrency control
 * 
 * @param items - Items to process
 * @param processor - Async function to process each item
 * @param options - Chunk size and concurrency settings
 */
export async function processInChunks<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  options: {
    chunkSize?: number;
    concurrency?: number;
    delayBetweenChunks?: number;
    onProgress?: (processed: number, total: number) => void;
  } = {}
): Promise<R[]> {
  const {
    chunkSize = 100,
    concurrency = 5,
    delayBetweenChunks = 0,
    onProgress,
  } = options;

  const results: R[] = [];
  const chunks = chunk(items, chunkSize);
  let processed = 0;

  for (const itemChunk of chunks) {
    // Process chunk with concurrency limit
    const chunkResults = await processWithConcurrency(
      itemChunk,
      processor,
      concurrency,
      processed
    );
    results.push(...chunkResults);
    
    processed += itemChunk.length;
    onProgress?.(processed, items.length);

    // Delay between chunks to avoid rate limiting
    if (delayBetweenChunks > 0 && processed < items.length) {
      await sleep(delayBetweenChunks);
    }
  }

  return results;
}

/**
 * Process items with concurrency limit
 */
async function processWithConcurrency<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  concurrency: number,
  startIndex: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      try {
        results[index] = await processor(items[index], startIndex + index);
      } catch (error) {
        // Rethrow to stop all workers
        throw error;
      }
    }
  }

  // Create worker pool
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

/**
 * Process items in batches for database operations
 * Useful for bulk inserts/updates
 */
export async function batchProcess<T>(
  items: T[],
  batchFn: (batch: T[]) => Promise<void>,
  batchSize = 500
): Promise<void> {
  const batches = chunk(items, batchSize);
  
  for (const batch of batches) {
    await batchFn(batch);
  }
}

/**
 * Async generator for streaming large datasets
 * Useful when you can't load all data into memory
 */
export async function* streamInChunks<T>(
  fetchChunk: (offset: number, limit: number) => Promise<T[]>,
  chunkSize = 1000
): AsyncGenerator<T[], void, unknown> {
  let offset = 0;
  
  while (true) {
    const chunk = await fetchChunk(offset, chunkSize);
    
    if (chunk.length === 0) {
      break;
    }
    
    yield chunk;
    
    if (chunk.length < chunkSize) {
      break;
    }
    
    offset += chunk.length;
  }
}

/**
 * Memory-safe batch insert for Drizzle ORM
 */
export async function batchInsert<T extends Record<string, any>>(
  db: any,
  table: any,
  values: T[],
  options: {
    batchSize?: number;
    onConflict?: 'ignore' | 'update';
  } = {}
): Promise<void> {
  const { batchSize = 500, onConflict = 'ignore' } = options;
  const batches = chunk(values, batchSize);

  for (const batch of batches) {
    const query = db.insert(table).values(batch);
    
    if (onConflict === 'ignore') {
      await query.onConflictDoNothing();
    } else {
      // For update, caller should handle the specific columns
      await query;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Log memory usage (for debugging OOM issues)
 */
export function logMemoryUsage(label?: string): void {
  const usage = process.memoryUsage();
  logger.info({
    label,
    heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
    rssMB: Math.round(usage.rss / 1024 / 1024),
  }, 'Memory usage');
}
