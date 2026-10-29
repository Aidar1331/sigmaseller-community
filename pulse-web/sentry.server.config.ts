import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  
  // Performance Monitoring
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  // Filter out noisy errors
  ignoreErrors: [
    'ECONNRESET',
    'ETIMEDOUT',
  ],

  // Don't send in development
  enabled: process.env.NODE_ENV === 'production' || !!process.env.SENTRY_DEBUG,
});
