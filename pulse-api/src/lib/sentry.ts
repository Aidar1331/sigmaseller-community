import * as Sentry from '@sentry/node';
import { env } from '../env.js';
import log from './logger.js';

const logger = log.child({ module: 'sentry' });

let initialized = false;

export function initSentry() {
  if (initialized || !env.SENTRY_DSN) {
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: process.env.npm_package_version || '1.0.0',
    
    // Performance monitoring
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,
    
    // Filter out noisy errors
    ignoreErrors: [
      'ECONNRESET',
      'ETIMEDOUT',
      'socket hang up',
    ],
    
    beforeSend(event) {
      // Don't send in development unless explicitly enabled
      if (env.NODE_ENV !== 'production' && !process.env.SENTRY_DEBUG) {
        return null;
      }
      return event;
    },
  });

  initialized = true;
  logger.info('Sentry initialized');
}

export function captureError(error: Error, context?: Record<string, any>) {
  if (!env.SENTRY_DSN) {
    logger.error({ err: error }, 'Error (no DSN)');
    return;
  }

  Sentry.withScope((scope) => {
    if (context) {
      scope.setExtras(context);
    }
    Sentry.captureException(error);
  });
}

export function setUser(userId: number, email?: string) {
  Sentry.setUser({ id: String(userId), email });
}

export function clearUser() {
  Sentry.setUser(null);
}

export { Sentry };
