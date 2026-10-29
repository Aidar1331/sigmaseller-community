import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage<{ workspaceId: number | null }>();

export function currentAiWorkspace(): number | null {
  return context.getStore()?.workspaceId ?? null;
}

export function runWithAiWorkspace<T>(workspaceId: number | null, work: () => T): T {
  if (workspaceId !== null && (!Number.isSafeInteger(workspaceId) || workspaceId <= 0)) {
    throw new Error('Invalid AI workspace');
  }
  const current = currentAiWorkspace();
  if (current !== null && current !== workspaceId) throw new Error('Cannot change AI workspace inside an operation');
  return context.run({ workspaceId }, work);
}

export function resolveAiWorkspace(explicit?: number): number {
  const current = currentAiWorkspace();
  if (explicit !== undefined && current !== null && explicit !== current) {
    throw new Error('AI workspace does not match the current operation');
  }
  const id = explicit ?? current;
  if (!id || !Number.isSafeInteger(id) || id <= 0) throw new Error('AI workspace is required');
  return id;
}
