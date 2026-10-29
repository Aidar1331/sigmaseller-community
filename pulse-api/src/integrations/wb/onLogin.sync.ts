// DEPRECATED: This script is no longer used. The /wb/:workspaceId/sync/start
// endpoint now enqueues a pg-boss 'initial-full-sync' job instead of spawning
// this script via guardedSpawn. Kept for reference only.

import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'onLoginSync' });

// Orchestrator to run after user "logged in" (i.e., we have WB_API_KEY).
// Phase order:
// 1) Funnel history (7d) via /products/history (fast)
// 2) Sync cards (content + main photo) into DB
// 3) Funnel daily totals via /products for 30/60/90 days (slow)

function run(cmd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const label = [cmd, ...args].join(' ');
  logger.info({ command: label }, 'Running command');
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    throw new Error(`${label} exited with code ${result.status}`);
  }
}

async function main() {
  const rawDays = process.env.DAYS_BACK_LIST || '30,60,90';
  const daysBackList = rawDays
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
  if (!daysBackList.length) {
    throw new Error('DAYS_BACK_LIST must contain comma-separated integers, got: ' + rawDays);
  }

  const workspaceId = process.env.WORKSPACE_ID;
  if (!workspaceId || !/^\d+$/.test(workspaceId)) {
    throw new Error('WORKSPACE_ID environment variable is required and must be a positive integer, got: ' + workspaceId);
  }

  const runId = process.env.RUN_ID || '';
  const shopIdEnv = process.env.SHOP_ID || '';
  const shopEnv: Record<string, string> = shopIdEnv ? { SHOP_ID: shopIdEnv } : {};

  const { updateRunStage, markRunDone, markRunFailed } = await import('./syncRun.js');

  try {
    // 1) 7-day history (limited by WB) -> DB
    if (runId) await updateRunStage(runId, { stage: 'history_7d' });
    run('npm', ['run', '-s', 'wb:funnel:history:to-db'], { WORKSPACE_ID: workspaceId, ...shopEnv });

    // 2) cards -> db (content + main photo)
    if (runId) await updateRunStage(runId, { stage: 'cards' });
    run('npx', ['tsx', 'src/integrations/wb/cards.sync.ts'], {
      WORKSPACE_ID: workspaceId,
      RUN_AS_SCRIPT: '1',
      ...shopEnv,
    });

    // 3) /products daily backfills (30/60/90) -> DB
    for (const d of daysBackList) {
      if (d === '30' && runId) await updateRunStage(runId, { stage: 'funnel_30d' });
      if (d === '60' && runId) await updateRunStage(runId, { stage: 'funnel_60d' });
      if (d === '90' && runId) await updateRunStage(runId, { stage: 'funnel_90d' });
      run('npx', ['tsx', 'src/integrations/wb/funnelProductsDaily.toDb.ts'], {
        WORKSPACE_ID: workspaceId,
        DAYS_BACK_LIST: d,
        LIMIT: '1000',
        RATE_DELAY_MS: '21000',
        ...shopEnv,
      });
    }

    if (runId) await markRunDone(runId);
  } catch (e: any) {
    if (runId) await markRunFailed(runId, String(e?.message ?? e));
    throw e;
  }
}

main().catch((e) => {
  logger.error({ err: e }, 'onLoginSync failed');
  process.exitCode = 1;
});
