/**
 * Structured logging for background jobs
 * 
 * Outputs JSON logs with job context:
 * - jobName
 * - workspaceId
 * - durationMs
 * - status: 'started' | 'completed' | 'failed'
 * - error (if failed)
 * - recordCount (if applicable)
 */

import pino from 'pino';
import { env } from '../env.js';

const logger = pino({
  level: env.LOG_LEVEL,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  }),
});

export interface JobContext {
  jobName: string;
  workspaceId?: number;
  runId?: string;
}

export interface JobResult {
  recordCount?: number;
  [key: string]: any;
}

/**
 * Log job start
 */
export function logJobStart(ctx: JobContext) {
  logger.info({
    ...ctx,
    status: 'started',
    timestamp: new Date().toISOString(),
  }, `Job ${ctx.jobName} started`);
}

/**
 * Log job completion
 */
export function logJobComplete(ctx: JobContext, startTime: number, result?: JobResult) {
  const durationMs = Date.now() - startTime;
  
  logger.info({
    ...ctx,
    status: 'completed',
    durationMs,
    ...(result?.recordCount !== undefined && { recordCount: result.recordCount }),
    timestamp: new Date().toISOString(),
  }, `Job ${ctx.jobName} completed in ${durationMs}ms`);
}

/**
 * Log job failure
 */
export function logJobError(ctx: JobContext, startTime: number, error: Error) {
  const durationMs = Date.now() - startTime;
  
  logger.error({
    ...ctx,
    status: 'failed',
    durationMs,
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name,
    },
    timestamp: new Date().toISOString(),
  }, `Job ${ctx.jobName} failed: ${error.message}`);
}

/**
 * Wrap a job function with logging
 */
export function withJobLogging<T>(
  jobName: string,
  workspaceId?: number,
) {
  return async (fn: () => Promise<T & JobResult>): Promise<T> => {
    const ctx: JobContext = { jobName, workspaceId };
    const startTime = Date.now();
    
    logJobStart(ctx);
    
    try {
      const result = await fn();
      logJobComplete(ctx, startTime, result);
      return result;
    } catch (error) {
      logJobError(ctx, startTime, error as Error);
      throw error;
    }
  };
}

export default logger;
