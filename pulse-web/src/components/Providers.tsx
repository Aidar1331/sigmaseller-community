'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, useEffect, type ReactNode } from 'react';
import { useAuthStore } from '@/store/auth';
import { useWorkspaceStore } from '@/store/workspace';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * Sync workspaceId between auth store and workspace store
 * This ensures both stores have the same workspaceId
 */
function WorkspaceSyncer() {
  const authWorkspaceId = useAuthStore((s) => s.workspaceId);
  const setWorkspaceId = useWorkspaceStore((s) => s.setWorkspaceId);
  const workspaceStoreId = useWorkspaceStore((s) => s.workspaceId);

  useEffect(() => {
    // Sync from auth store to workspace store if they differ
    if (authWorkspaceId && authWorkspaceId !== workspaceStoreId) {
      setWorkspaceId(authWorkspaceId);
    }
  }, [authWorkspaceId, workspaceStoreId, setWorkspaceId]);

  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000, // 30s — avoid re-fetching on every tab switch
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <WorkspaceSyncer />
        {children}
      </ErrorBoundary>
    </QueryClientProvider>
  );
}
