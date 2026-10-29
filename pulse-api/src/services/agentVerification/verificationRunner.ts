// Cron handler registered in jobs/scheduler.ts (JOBS.VERIFICATION_RUNNER).
// Registered only when env.ENABLE_MULTI_AGENT === '1'.

import { logJobs as logger } from '../../lib/logger.js';
import { runPendingChecks } from './index.js';

export async function runVerificationRunner(): Promise<void> {
  const started = Date.now();
  const summary = await runPendingChecks();

  // Only log when there was actual work — avoids spam from the every-minute tick
  // while the queue is idle (Phase 0 will spend most of its time empty).
  if (summary.checked > 0) {
    logger.info(
      { ...summary, durationMs: Date.now() - started },
      'agent-verification-runner completed batch',
    );
  }
}
