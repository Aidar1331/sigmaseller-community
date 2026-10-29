import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useWorkspaceStore } from './workspace';

interface User {
  userId: number;
  email: string;
  name?: string;
}

interface AuthState {
  token: string | null;
  user: User | null;
  /**
   * @deprecated Use useWorkspaceStore().workspaceId instead.
   * Kept for backwards compatibility, synced from workspace store.
   */
  workspaceId: number | null;
  isAuthenticated: boolean;
  
  setAuth: (token: string, user: User, workspaceId: number) => void;
  logout: () => void;
  /**
   * @deprecated Use useWorkspaceStore().setWorkspaceId instead.
   */
  setWorkspaceId: (id: number) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      workspaceId: null,
      isAuthenticated: false,

      setAuth: (token, user, workspaceId) => {
        // SINGLE SOURCE OF TRUTH: Write to workspace store
        useWorkspaceStore.getState().setWorkspaceId(workspaceId);
        set({
          token,
          user,
          workspaceId, // Keep in sync for backwards compatibility
          isAuthenticated: true,
        });
      },

      logout: () => {
        // Clear workspace store too
        useWorkspaceStore.getState().clearWorkspaceId();
        set({
          token: null,
          user: null,
          workspaceId: null,
          isAuthenticated: false,
        });
      },

      /**
       * @deprecated Use useWorkspaceStore().setWorkspaceId instead.
       */
      setWorkspaceId: (id) => {
        // Forward to workspace store (single source of truth)
        useWorkspaceStore.getState().setWorkspaceId(id);
        set({ workspaceId: id });
      },
    }),
    {
      name: 'pulse-auth',
      partialize: (state) => ({
        // SECURITY: Don't persist token in localStorage — auth uses httpOnly cookies
        user: state.user,
        workspaceId: state.workspaceId,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);

// Helper to get workspace ID
// SECURITY: No fallback to 1 — if not set, throw to prevent cross-tenant access
export function getWorkspaceId(): number {
  // Read from workspace store (single source of truth)
  const workspaceId = useWorkspaceStore.getState().workspaceId;
  if (!workspaceId) {
    throw new Error('Workspace ID not set. Please select a workspace.');
  }
  return workspaceId;
}

// Helper to get current user ID
// SECURITY: No fallback — if not authenticated, throw
export function getUserId(): number {
  const state = useAuthStore.getState();
  if (!state.user?.userId) {
    throw new Error('User not authenticated');
  }
  return state.user.userId;
}

// Safe versions that return null instead of throwing
export function getWorkspaceIdOrNull(): number | null {
  // Read from workspace store (single source of truth)
  return useWorkspaceStore.getState().workspaceId;
}

export function getUserIdOrNull(): number | null {
  return useAuthStore.getState().user?.userId ?? null;
}
