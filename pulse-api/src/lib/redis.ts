/**
 * Redis Client for BullMQ
 */

import { Redis } from 'ioredis';
import { env } from '../env.js';

// Lazy init singleton
let redisClient: Redis | null = null;

export function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis(env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null, // Required for BullMQ
      enableReadyCheck: false,
    });
    
    redisClient.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });
    
    redisClient.on('connect', () => {
      console.log('[Redis] Connected');
    });
  }
  
  return redisClient;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

// Export singleton for direct use
export const redis = {
  get client() {
    return getRedis();
  },
};
