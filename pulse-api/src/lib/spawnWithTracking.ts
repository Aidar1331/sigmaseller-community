/**
 * Spawn child process with proper tracking and status updates
 * Replaces fire-and-forget spawn+unref pattern
 */

import { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { spawnSyncProcess } from './syncProcess.js';
import { openSync, mkdirSync, writeSync } from 'node:fs';
import { db } from '../db/client.js';
import { wbSyncRuns } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import log from './logger.js';

const logger = log.child({ module: 'spawnWithTracking' });

/** F-9: количество последних строк stderr/stdout, которые на failure
 * выливаем в journalctl через logger.error. Без этого `out/*.log` файлы
 * на проде остаются «слепыми» для `ops logs` и приходится копаться вручную. */
const TAIL_LINES_ON_FAILURE = 50;

/**
 * Set of currently-running child processes spawned via `spawnAndWait`.
 * Used by `server.ts` shutdown handler to terminate children gracefully
 * (SIGTERM, then SIGKILL after a grace period) and mark their
 * `wb_sync_runs` rows as failed instead of leaving them stuck in 'running'.
 *
 * Keyed by ChildProcess to allow signal-and-track without duplicate
 * bookkeeping. The associated runId is needed only when iterating for the
 * shutdown UPDATE — kept on a parallel WeakMap so callers don't see it.
 */
const activeChildren = new Map<ChildProcess, { runId: string; stage: string; workspaceId: number }>();

export function getActiveChildren(): ReadonlyMap<ChildProcess, { runId: string; stage: string; workspaceId: number }> {
  return activeChildren;
}

export interface SpawnConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number; // Default: 30 minutes
  logDir?: string;
  logPrefix?: string;
}

export interface SpawnResult {
  success: boolean;
  code: number | null;
  signal: string | null;
  durationMs: number;
  logPath: string;
}

/**
 * Spawn a child process and wait for completion
 * Updates wbSyncRuns status on completion
 */
export async function spawnAndWait(
  runId: string,
  workspaceId: number,
  stage: string,
  config: SpawnConfig
): Promise<SpawnResult> {
  const timeoutMs = config.timeoutMs ?? 30 * 60 * 1000; // 30 minutes default
  // F-017d: under systemd `ProtectSystem=strict`, the project root is read-only.
  // SPAWN_LOG_DIR override (e.g. /srv/sigmaseller/logs/sync) keeps writes in an allowed path.
  const logDir = config.logDir ?? process.env.SPAWN_LOG_DIR ?? 'out';
  const logPrefix = config.logPrefix ?? 'sync';

  mkdirSync(logDir, { recursive: true });
  const logPath = `${logDir}/${logPrefix}-${workspaceId}-${runId}-${Date.now()}.log`;
  const logFd = openSync(logPath, 'a');

  // Auto-resolve SHOP_ID if not provided — prevents NULL shop_id in synced data
  if (!config.env?.SHOP_ID && workspaceId) {
    try {
      const { rows } = await db.execute(
        require('drizzle-orm').sql`SELECT shop_id FROM marketplace_shops WHERE workspace_id = ${workspaceId} AND platform = 'wb' AND is_active = true ORDER BY created_at DESC LIMIT 1`
      );
      const shopId = (rows as any)?.[0]?.shop_id;
      if (shopId) {
        config.env = { ...config.env, SHOP_ID: String(shopId) };
        logger.info({ workspaceId, shopId }, 'Auto-resolved SHOP_ID for sync');
      }
    } catch { /* best-effort */ }
  }

  const startTime = Date.now();

  // Update stage to running
  await db.update(wbSyncRuns)
    .set({ stage: `${stage}:running`, updatedAt: new Date() })
    .where(eq(wbSyncRuns.runId, runId));

  const child = await spawnSyncProcess(config.command, config.args, {
      cwd: config.cwd ?? process.cwd(),
      env: { ...process.env, ...config.env },
      // F-9: 'pipe' для stdout/stderr вместо direct logFd — позволяет
      // одновременно писать в файл И копить tail для journalctl на failure.
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

  return new Promise<SpawnResult>((resolve) => {

    // Tail buffer для F-9. Собираем последние N строк объединённо
    // (stdout + stderr) — чаще всего полезен последний кусок текста
    // независимо от потока.
    const tailRing: string[] = [];
    let leftover = '';
    const onChunk = (chunk: Buffer) => {
      try { writeSync(logFd, chunk); } catch {}
      const text = leftover + chunk.toString('utf8');
      const lines = text.split('\n');
      leftover = lines.pop() ?? '';
      for (const line of lines) {
        tailRing.push(line);
        if (tailRing.length > TAIL_LINES_ON_FAILURE) tailRing.shift();
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    activeChildren.set(child, { runId, stage, workspaceId });

    let resolved = false;
    let timeoutId: NodeJS.Timeout | undefined;

    const cleanup = async (code: number | null, signal: string | null) => {
      if (resolved) return;
      resolved = true;

      activeChildren.delete(child);

      if (timeoutId) clearTimeout(timeoutId);
      
      const durationMs = Date.now() - startTime;
      const success = code === 0;
      
      // Update sync run status
      const finalStage = success 
        ? `${stage}:done` 
        : signal === 'SIGTERM' 
          ? `${stage}:timeout`
          : `${stage}:failed:${code}`;
      
      try {
        const updateFields: Record<string, unknown> = {
          stage: finalStage,
          updatedAt: new Date(),
        };

        if (success) {
          // Mark run as done — stage still tracks multi-step progress
          updateFields.status = 'done';
          updateFields.finishedAt = new Date();
        } else {
          updateFields.status = 'failed';
          updateFields.finishedAt = new Date();
          updateFields.error = signal === 'SIGTERM'
            ? `${stage} timed out`
            : `${stage} exited with code ${code}`;
        }

        await db.update(wbSyncRuns)
          .set(updateFields)
          .where(eq(wbSyncRuns.runId, runId));
      } catch (err) {
        logger.error({ err, runId }, 'Failed to update status');
      }

      // F-9: на failure — выливаем последние строки stdout/stderr в journalctl,
      // чтобы `ops logs` показал причину без лазания в /srv/sigmaseller/pulse-api/out/*.log.
      if (!success) {
        const tail = tailRing.slice(-TAIL_LINES_ON_FAILURE).join('\n');
        logger.error(
          { runId, stage, code, signal, durationMs, logPath, tail },
          'child process failed (tail of stdout+stderr included)',
        );
      }

      resolve({ success, code, signal, durationMs, logPath });
    };

    child.on('exit', (code, signal) => {
      cleanup(code, signal);
    });

    child.on('error', (err) => {
      logger.error({ err, runId }, 'Process error');
      cleanup(-1, null);
    });

    // Timeout handling
    timeoutId = setTimeout(() => {
      if (!resolved) {
        logger.warn({ runId, timeoutMs }, 'Timeout, killing process');
        child.kill('SIGTERM');
        // Give it 5 seconds to exit gracefully, then SIGKILL
        setTimeout(() => {
          if (!resolved) {
            child.kill('SIGKILL');
          }
        }, 5000);
      }
    }, timeoutMs);
  });
}

/**
 * Run a sequence of spawn commands
 * Stops on first failure
 */
export async function spawnSequence(
  runId: string,
  workspaceId: number,
  baseStage: string,
  steps: Array<{ name: string; config: SpawnConfig }>
): Promise<{ success: boolean; failedStep?: string; results: SpawnResult[] }> {
  const results: SpawnResult[] = [];

  for (const step of steps) {
    const stage = `${baseStage}:${step.name}`;
    const result = await spawnAndWait(runId, workspaceId, stage, step.config);
    results.push(result);

    if (!result.success) {
      return { success: false, failedStep: step.name, results };
    }
  }

  return { success: true, results };
}
