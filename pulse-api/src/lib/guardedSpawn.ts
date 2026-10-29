import path from 'node:path';
import { spawnSyncProcess } from './syncProcess.js';
import { db } from '../db/client.js';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt } from 'drizzle-orm';
import { marketplaceShops, wbSyncRuns } from '../db/schema.js';

/**
 * F-017d: writable log directory for spawned children. Under systemd
 * `ProtectSystem=strict`, the project root is read-only; only the paths
 * listed in `ReadWritePaths` (currently `/srv/sigmaseller/pulse-api/storage`
 * and `/srv/sigmaseller/logs`) accept writes. Without this override, `mkdirSync('out')`
 * threw EROFS, killing every initial-sync before its first step.
 *
 * Defaults to `out/` (CWD-relative) so dev / CI keep working unchanged.
 */
const SPAWN_LOG_DIR = process.env.SPAWN_LOG_DIR ?? 'out';

// ── Constants ──────────────────────────────────────────────────────────

const TERMINAL_STAGES = ['done', 'failed', 'failed:timeout'] as const;
const SPAWN_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — WB API rate limits make heavy syncs slow

/**
 * Map npm script names → tsx file paths (relative to cwd).
 * On Windows, npm scripts with inline env vars (WORKSPACE_ID=1 tsx ...)
 * fail because cmd.exe interprets them as commands.
 * We bypass npm and run tsx directly.
 */
const SCRIPT_TO_FILE: Record<string, string> = {
  'wb:cards:sync': 'src/integrations/wb/cards.sync.ts',
  'wb:orders-sales:to-db': 'src/integrations/wb/ordersSales.toDb.ts',
  'wb:adv:to-db': 'src/integrations/wb/advSpend.toDb.ts',
  'wb:adv:products:to-db': 'src/integrations/wb/advSpendProducts.toDb.ts',
  'wb:finance:weekly-products:to-db': 'src/integrations/wb/financeWeeklyProducts.toDb.ts',
  'wb:funnel:history:to-db': 'src/integrations/wb/funnelHistory7d.toDb.ts',
  'wb:funnel:products:to-db': 'src/integrations/wb/funnelProductsDaily.toDb.ts',
  'wb:spp:weekly:to-db': 'src/integrations/wb/sppWeekly.toDb.ts',
};

function resolveSpawnCmd(npmScript: string): { cmd: string; args: string[] } {
  const file = SCRIPT_TO_FILE[npmScript];
  if (file) {
    return { cmd: 'npx', args: ['tsx', file] };
  }
  // Fallback: use npm run for unknown scripts
  return { cmd: 'npm', args: ['run', '-s', npmScript] };
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Returns distinct active workspaceIds (those with at least one active shop).
 */
export async function getActiveWorkspaceIds(): Promise<number[]> {
  const rows = await db
    .selectDistinct({ workspaceId: marketplaceShops.workspaceId })
    .from(marketplaceShops)
    .where(
      and(eq(marketplaceShops.platform, 'wb'), eq(marketplaceShops.isActive, true))
    );
  return rows.map((r) => r.workspaceId);
}

/**
 * Shop info for multi-shop sync
 */
export interface ShopInfo {
  shopId: number;
  workspaceId: number;
  name: string;
  apiKey: string;
  platform: string;
}

/**
 * Returns all active shops for a workspace (for multi-shop sync).
 */
export async function getActiveShopsForWorkspace(workspaceId: number): Promise<ShopInfo[]> {
  const rows = await db
    .select({
      shopId: marketplaceShops.shopId,
      workspaceId: marketplaceShops.workspaceId,
      name: marketplaceShops.name,
      apiKey: marketplaceShops.apiKey,
      platform: marketplaceShops.platform,
    })
    .from(marketplaceShops)
    .where(
      and(
        eq(marketplaceShops.workspaceId, workspaceId),
        eq(marketplaceShops.platform, 'wb'),
        eq(marketplaceShops.isActive, true)
      )
    );
  return rows;
}

/**
 * Returns all active shops across all workspaces (for global sync jobs).
 */
export async function getAllActiveShops(): Promise<ShopInfo[]> {
  const rows = await db
    .select({
      shopId: marketplaceShops.shopId,
      workspaceId: marketplaceShops.workspaceId,
      name: marketplaceShops.name,
      apiKey: marketplaceShops.apiKey,
      platform: marketplaceShops.platform,
    })
    .from(marketplaceShops)
    .where(
      and(
        eq(marketplaceShops.platform, 'wb'),
        eq(marketplaceShops.isActive, true)
      )
    );
  return rows;
}

/**
 * Check if there is already an active (non-terminal) sync run for this
 * workspace matching `stagePrefix`. Uses FOR UPDATE to prevent races
 * between concurrent requests (works across PM2/k8s instances).
 */
export async function getActiveRun(workspaceId: number, stagePrefix?: string) {

  const prefixCond = stagePrefix
    ? sql`AND ${wbSyncRuns.stage} LIKE ${stagePrefix + '%'}`
    : sql``;

  const rows = await db.execute<{ run_id: string; stage: string }>(sql`
    SELECT run_id, stage FROM wb_sync_runs
    WHERE workspace_id = ${workspaceId}
      AND stage NOT IN ('done', 'failed', 'failed:timeout')
      ${prefixCond}
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `);

  const result = rows as any;
  return result.rows?.[0] ?? result[0] ?? null;
}

/**
 * Spawn a child process with DB-lock protection:
 * 1. Reject if there's already an active run for this workspace+prefix.
 * 2. Create a run record with stage 'queued'.
 * 3. Spawn the process, set stage to 'running'.
 * 4. On exit: set stage to 'done' or 'failed:{code}'.
 * 5. Timeout after 10 min: kill + 'failed:timeout'.
 */
export async function guardedSpawn(
  workspaceId: number,
  npmScript: string,
  stagePrefix: string,
  extraEnv: Record<string, string> = {},
  shopId?: number,
) {

  const active = await getActiveRun(workspaceId, stagePrefix);
  if (active) {
    return {
      ok: false as const,
      conflict: true as const,
      activeRunId: active.run_id,
      activeStage: active.stage,
    };
  }

  const { randomUUID } = await import('node:crypto');
  const runId = randomUUID();

  await db.insert(wbSyncRuns).values({
    runId,
    workspaceId,
    stage: `${stagePrefix}:queued`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const logPath = path.join(SPAWN_LOG_DIR, `${stagePrefix}-${workspaceId}-${runId}.log`);

  const { mkdirSync, openSync, closeSync } = await import('node:fs');
  mkdirSync(SPAWN_LOG_DIR, { recursive: true });
  const outFd = openSync(logPath, 'a');

  const { cmd, args } = resolveSpawnCmd(npmScript);
  const isWin = process.platform === 'win32';
  const child = await spawnSyncProcess(cmd, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WORKSPACE_ID: String(workspaceId),
      ...(shopId ? { SHOP_ID: String(shopId) } : {}),
      RUN_ID: runId,
      // Signal to db/client.ts to use a smaller pg pool — children only
      // need a handful of connections, and the default max=40 would
      // oversubscribe Postgres when many children spawn concurrently.
      WB_SYNC_CHILD: '1',
      ...extraEnv,
    },
    stdio: ['ignore', outFd, outFd],
    detached: false,
    shell: isWin,
    ...(isWin ? { windowsHide: true } : {}),
  });

  await db
    .update(wbSyncRuns)
    .set({ stage: `${stagePrefix}:running`, updatedAt: new Date() })
    .where(eq(wbSyncRuns.runId, runId));

  const timer = setTimeout(async () => {
    try {
      child.kill('SIGTERM');
    } catch { /* already dead */ }
    try {
      await db
        .update(wbSyncRuns)
        .set({ stage: 'failed:timeout', error: `Killed after ${SPAWN_TIMEOUT_MS / 1000}s`, updatedAt: new Date() })
        .where(eq(wbSyncRuns.runId, runId));
    } catch { /* best-effort */ }
  }, SPAWN_TIMEOUT_MS);

  child.on('exit', async (code) => {
    clearTimeout(timer);
    try { closeSync(outFd); } catch { /* ignore */ }
    try {
      const stage = code === 0 ? 'done' : `failed:exit-${code ?? 'unknown'}`;
      const error = code === 0 ? null : `Process exited with code ${code}`;
      await db
        .update(wbSyncRuns)
        .set({ stage, error, updatedAt: new Date() })
        .where(eq(wbSyncRuns.runId, runId));
    } catch { /* best-effort */ }
  });

  child.unref();

  return { ok: true as const, runId, pid: child.pid, logPath };
}

/**
 * Like guardedSpawn but returns a Promise that resolves when the child exits.
 * Used for sequential multi-step sync (initial sync).
 * Does NOT use DB-lock (caller manages its own run record).
 */
export async function spawnAndWait(
  workspaceId: number,
  npmScript: string,
  extraEnv: Record<string, string> = {},
  timeoutMs = SPAWN_TIMEOUT_MS,
): Promise<{ ok: boolean; code: number | null }> {
  // Auto-resolve SHOP_ID if not provided
  if (!extraEnv.SHOP_ID) {
    try {
      const rows = await db
        .selectDistinct({ shopId: marketplaceShops.shopId })
        .from(marketplaceShops)
        .where(and(eq(marketplaceShops.workspaceId, workspaceId), eq(marketplaceShops.platform, 'wb'), eq(marketplaceShops.isActive, true)));
      if (rows[0]?.shopId) {
        extraEnv = { ...extraEnv, SHOP_ID: String(rows[0].shopId) };
      }
    } catch { /* best-effort */ }
  }

  const { mkdirSync, openSync, closeSync } = await import('node:fs');

  mkdirSync(SPAWN_LOG_DIR, { recursive: true });
  const logPath = path.join(SPAWN_LOG_DIR, `initial-sync-${workspaceId}-${npmScript.replace(/:/g, '-')}.log`);
  const outFd = openSync(logPath, 'a');

  const { cmd, args } = resolveSpawnCmd(npmScript);
  const isWin = process.platform === 'win32';
  const child = await spawnSyncProcess(cmd, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WORKSPACE_ID: String(workspaceId),
      WB_SYNC_CHILD: '1',
      ...extraEnv,
    },
    stdio: ['ignore', outFd, outFd],
    detached: false,
    shell: isWin,
    ...(isWin ? { windowsHide: true } : {}),
  });

  return new Promise<{ ok: boolean; code: number | null }>((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      resolve({ ok: false, code: null });
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      try { closeSync(outFd); } catch { /* ignore */ }
      resolve({ ok: code === 0, code });
    });

    child.on('error', () => {
      clearTimeout(timer);
      try { closeSync(outFd); } catch { /* ignore */ }
      resolve({ ok: false, code: null });
    });
  });
}
