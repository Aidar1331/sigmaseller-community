import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface WorkspaceState {
  workspaceId: number | null;
  shopId: number | null;
  shopName: string | null;
  setWorkspaceId: (id: number) => void;
  setShopId: (id: number | null) => void;
  setWorkspaceAndShop: (workspaceId: number, shopId: number, shopName?: string) => void;
  clearWorkspaceId: () => void;
}

/**
 * Workspace store with persistence
 * SECURITY: No default workspaceId — must be explicitly set after auth
 */
export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      workspaceId: null,
      shopId: null,
      shopName: null,
      setWorkspaceId: (id) => set({ workspaceId: id }),
      setShopId: (id) => set({ shopId: id, shopName: null }),
      setWorkspaceAndShop: (workspaceId, shopId, shopName) => set({ workspaceId, shopId, shopName: shopName ?? null }),
      clearWorkspaceId: () => set({ workspaceId: null, shopId: null, shopName: null }),
    }),
    {
      name: 'pulse-workspace',
    }
  )
);

// M11: cross-tab sync. Zustand's persist writes to localStorage but does NOT
// listen for changes from other tabs. Without this, switching workspace in
// tab A leaves tab B showing stale data until manual reload — a stale shopId
// can cause a request to land on the wrong tenant before the user realises.
// The listener mirrors whatever the other tab wrote.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== 'pulse-workspace' || !e.newValue) return;
    try {
      const parsed = JSON.parse(e.newValue) as { state?: Partial<WorkspaceState> };
      if (parsed?.state) {
        useWorkspaceStore.setState({
          workspaceId: parsed.state.workspaceId ?? null,
          shopId: parsed.state.shopId ?? null,
          shopName: parsed.state.shopName ?? null,
        });
      }
    } catch {
      // bad JSON — ignore, we'll catch up on the next legit write
    }
  });
}

/**
 * Helper to get workspace ID with validation
 * SECURITY: Throws if workspace not selected — prevents accidental cross-tenant access
 */
export function requireWorkspaceId(): number {
  const state = useWorkspaceStore.getState();
  if (!state.workspaceId) {
    throw new Error('Workspace not selected. Please select a workspace first.');
  }
  return state.workspaceId;
}

/**
 * Helper to get shop ID (optional)
 */
export function getShopId(): number | null {
  return useWorkspaceStore.getState().shopId;
}
