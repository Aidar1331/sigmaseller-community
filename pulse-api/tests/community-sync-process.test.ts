import { it, expect } from 'vitest';
import { createSyncSpawner } from '../src/lib/syncProcess.js';

it('bounds simultaneous real child processes across a burst and drains all waiting work', async () => {
  const spawn = createSyncSpawner(2);
  let running = 0, peak = 0, completed = 0;
  await Promise.all(Array.from({ length: 7 }, async () => {
    const child = await spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120)'], { stdio: 'ignore', windowsHide: true });
    running++; peak = Math.max(peak, running);
    await new Promise<void>(resolve => child.once('close', code => {
      expect(code).toBe(0); running--; completed++; resolve();
    }));
  }));
  expect(peak).toBe(2); expect(running).toBe(0); expect(completed).toBe(7);
});

it('releases the slot after a failed spawn so queued work can still run', async () => {
  const spawn = createSyncSpawner(1);
  const failed = await spawn('sigma-test-missing-command-72b6', [], { stdio: 'ignore', windowsHide: true });
  const closed = new Promise(resolve => failed.once('close', resolve));
  const next = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  await closed;
  const child = await next;
  expect(await new Promise(resolve => child.once('close', resolve))).toBe(0);
});
