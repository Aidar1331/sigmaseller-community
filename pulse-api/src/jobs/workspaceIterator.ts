import { runWithAiWorkspace } from '../lib/sellerAiContext.js';
/**
 * Helper for iterating jobs over all active workspaces
 */

import { getActiveWorkspaceIds } from '../lib/guardedSpawn.js';

export interface WorkspaceJobConfig {
  /** Override workspace ID from env (for debugging) */
  overrideWorkspaceId?: number;
  /** Environment variable name for override (e.g., 'FINANCE_SYNC_WORKSPACE_ID') */
  overrideEnvVar?: string;
}

/**
 * Get workspace IDs to process.
 * If override is set in env, uses only that workspace.
 * Otherwise, returns all active workspaces.
 */
export async function getWorkspacesToProcess(config: WorkspaceJobConfig = {}): Promise<number[]> {
  // Check for override
  const overrideEnv = config.overrideEnvVar
    ? process.env[config.overrideEnvVar]
    : undefined;

  if (overrideEnv && overrideEnv !== 'all') {
    const id = Number.parseInt(overrideEnv, 10);
    if (Number.isFinite(id) && id > 0) {
      return [id];
    }
  }

  if (config.overrideWorkspaceId) {
    return [config.overrideWorkspaceId];
  }

  // Get all active workspaces
  return getActiveWorkspaceIds();
}

/**
 * Run a job function for each workspace with bounded concurrency.
 * Processes workspaces in batches (default 5) using Promise.allSettled.
 */
export async function forEachWorkspace<T>(
  config: WorkspaceJobConfig,
  jobFn: (workspaceId: number) => Promise<T>,
  concurrency = 5,
): Promise<Map<number, T | Error>> {
  const workspaceIds = await getWorkspacesToProcess(config);
  const results = new Map<number, T | Error>();

  // Process in batches of `concurrency`
  for (let i = 0; i < workspaceIds.length; i += concurrency) {
    const batch = workspaceIds.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map(async (wsId) => ({ wsId, result: await runWithAiWorkspace(wsId, () => jobFn(wsId)) }))
    );

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results.set(outcome.value.wsId, outcome.value.result);
      } else {
        // Extract wsId from the batch position
        const idx = settled.indexOf(outcome);
        const wsId = batch[idx];
        results.set(wsId, outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason)));
      }
    }
  }

  return results;
}
