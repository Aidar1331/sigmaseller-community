/**
 * Central structured logger for the entire application.
 * Re-exports the pino instance from jobLogger and adds convenience child loggers.
 *
 * Usage:
 *   import { log } from '../lib/logger.js';
 *   log.info({ wsId: 123, nmId: 456 }, 'Price updated');
 *   log.error({ err }, 'Failed to sync');
 *
 *   // Or create a child logger for a module:
 *   const logger = log.child({ module: 'pricingEngine' });
 *   logger.info('Evaluation started');
 */

import pino from 'pino';
import { env } from '../env.js';

export const log = pino({
  level: env.LOG_LEVEL ?? 'info',
  redact: ['password', 'recoveryCode', 'body.password', 'body.recoveryCode', 'req.body.password', 'req.body.recoveryCode', 'apiKey', 'key', 'encrypted_key', 'body.apiKey', 'req.body.apiKey', 'headers.authorization'],
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

/** Pre-configured child loggers for major subsystems */
export const logAgent = log.child({ module: 'agent' });
export const logPricing = log.child({ module: 'pricing' });
export const logFeedback = log.child({ module: 'feedback' });
export const logTaskMonitor = log.child({ module: 'taskMonitor' });
export const logDocHub = log.child({ module: 'documentHub' });
export const logJobs = log.child({ module: 'jobs' });
export const logSeo = log.child({ module: 'seo' });

export default log;
