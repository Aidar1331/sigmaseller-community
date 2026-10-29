/**
 * Session cleanup job
 * Removes expired sessions from userSessions table
 */

import { db } from '../db/client.js';
import { userSessions } from '../db/schema.js';
import { lt } from 'drizzle-orm';
import { logJobs as logger } from '../lib/logger.js';

/**
 * Delete expired sessions
 * Called via pg-boss scheduler
 */
export async function runSessionCleanup(): Promise<{ deleted: number }> {
  const now = new Date();
  
  const result = await db
    .delete(userSessions)
    .where(lt(userSessions.expiresAt, now))
    .returning({ sessionId: userSessions.sessionId });
  
  const deleted = result.length;
  
  if (deleted > 0) {
    logger.info({ deleted }, 'deleted expired sessions');
  }
  
  return { deleted };
}
