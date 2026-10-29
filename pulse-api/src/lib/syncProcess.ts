import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/** Bound the whole child-process lifetime, including npx/tsx descendants.
 * Shared by scheduled, manual and initial synchronizations in each service.
 * The API and worker have separate memory limits and separate queues here.
 */
export function createSyncSpawner(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error('WB_SYNC_CONCURRENCY must be an integer between 1 and 4');
  }
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (command: string, args: string[], options: SpawnOptions): Promise<ChildProcess> => {
    if (active >= concurrency) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) next(); // transfer the occupied slot without a gap
      else active--;
    };
    try {
      const child = spawn(command, args, options);
      // close follows exit/error and waits for inherited stdio to close.
      child.once('close', release);
      child.once('error', () => {}); // callers also handle/report spawn failure
      return child;
    } catch (error) { release(); throw error; }
  };
}

export const spawnSyncProcess = createSyncSpawner(Number(process.env.WB_SYNC_CONCURRENCY ?? '1'));
