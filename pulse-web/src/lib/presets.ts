import { apiFetch } from './api';

export type PulsePreset = {
  presetId: number;
  workspaceId: number;
  name: string;
  description: string | null;
  isPinned: boolean;
  sortOrder: number;
  config: any;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export async function listPresets(workspaceId: number): Promise<PulsePreset[]> {
  const res = await apiFetch(`/presets?workspaceId=${workspaceId}`);
  return res.presets as PulsePreset[];
}

export async function createPreset(input: {
  workspaceId: number;
  actorUserId: number;
  name: string;
  description?: string;
  config: any;
}): Promise<PulsePreset> {
  const res = await apiFetch('/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return res.preset as PulsePreset;
}

export async function updatePreset(
  presetId: number,
  workspaceId: number,
  input: { actorUserId: number; name?: string; description?: string | null; config?: any; isPinned?: boolean; sortOrder?: number }
): Promise<PulsePreset> {
  const res = await apiFetch(`/presets/${presetId}?workspaceId=${workspaceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return res.preset as PulsePreset;
}

export async function deletePreset(presetId: number, workspaceId: number): Promise<void> {
  await apiFetch(`/presets/${presetId}?workspaceId=${workspaceId}`, {
    method: 'DELETE',
  });
}
