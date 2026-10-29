/**
 * pulse-workers entry point.
 *
 * Owns all background work in a split-deploy:
 *   - pg-boss cron scheduler (WB syncs, AI agent runners, reminders, etc.)
 *   - Studio BullMQ worker (image/video generation)
 *   - Multi-Agent v2 domain-agent registry (when ENABLE_MULTI_AGENT=1)
 *
 * The API process (server.ts) sets DISABLE_INTERNAL_JOBS=1 so it skips the
 * same startup, leaving only HTTP and migrations to it.
 *
 * Runs no HTTP listener, no Fastify, no auth plugin — just queues.
 *
 * Operational contract:
 *   - SIGTERM → stop scheduler gracefully (let in-flight jobs finish via
 *     pg-boss's own grace period), then exit 0.
 *   - Unhandled rejection / uncaught exception → log + exit 1 so systemd
 *     restarts us.
 */

import { assertNoPlatformAiKeys } from '../services/sellerAiCredentials.js';
import '../env.js'; // loads dotenv + validates env (must be first)
import { initSentry, captureError } from '../lib/sentry.js';
import { log } from '../lib/logger.js';
import { initializeJobs, stopScheduler } from './scheduler.js';
import { startStudioWorker } from './studioQueue.js';
import { bootstrapDomainAgents } from '../agents/supervisor/bootstrap.js';
import { registerAgentActionRunner } from './agentActionRunner.js';
import { registerAllActionExecutors } from '../agents/tools/executors/index.js';
import { registerAgentTaskWorker } from './agentTaskWorker.js';

assertNoPlatformAiKeys();

// Sentry init is best-effort — no DSN means it logs a warning and no-ops.
try {
  initSentry();
} catch (err) {
  log.warn({ err }, 'Sentry init failed in worker (continuing without it)');
}

// Multi-Agent v2: register domain agents (no-op when flag=0).
try {
  bootstrapDomainAgents();
} catch (err) {
  log.error({ err }, 'Failed to bootstrap multi-agent registry in worker');
}

// pg-boss scheduler — registers all cron jobs and starts consuming.
try {
  await initializeJobs();
  log.info('pulse-workers: pg-boss scheduler started');
} catch (err) {
  log.fatal({ err }, 'pulse-workers: failed to start pg-boss scheduler');
  process.exit(1);
}

// Action Queue runner — consumes the `agent-action-runner` pg-boss queue.
// Each enqueued AI-agent action (price change, feedback reply, etc.) is
// claimed atomically, executed, and marked terminal. See actionQueue.ts.
//
// Order matters: register per-tool executors FIRST so the runner has them
// available before it claims its first job.
try {
  registerAllActionExecutors();
  await registerAgentActionRunner();
  log.info('pulse-workers: agent-action-runner registered (with executors)');
} catch (err) {
  log.error({ err }, 'pulse-workers: failed to register agent-action-runner');
}

// Studio AI worker (BullMQ).
await registerAgentTaskWorker();

// Studio AI worker (BullMQ).
try {
  startStudioWorker();
  log.info('pulse-workers: Studio AI worker started');
} catch (err) {
  log.error({ err }, 'pulse-workers: Studio AI worker failed to start (generation will not process)');
}

log.info('pulse-workers: ready');

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'pulse-workers: shutting down');
  try {
    await stopScheduler();
    log.info('pulse-workers: scheduler stopped');
  } catch (err) {
    log.error({ err }, 'pulse-workers: failed to stop scheduler cleanly');
  }
  process.exit(0);
};

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT',  () => { void shutdown('SIGINT');  });

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'pulse-workers: unhandled promise rejection');
  try { captureError(reason instanceof Error ? reason : new Error(String(reason))); } catch {}
});

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'pulse-workers: uncaught exception — exiting');
  try { captureError(err); } catch {}
  process.exit(1);
});
