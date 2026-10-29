'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useWorkspaceStore } from '@/store/workspace';

/**
 * Hook that calls `onShopChange()` whenever the active shopId or workspaceId changes.
 * Listens to both Zustand store changes AND the 'shop-changed' CustomEvent
 * dispatched by WorkspaceGuard.
 *
 * Usage:
 *   useShopChange(() => { fetchData(); });
 */
export function useShopChange(onShopChange: () => void) {
  const { workspaceId, shopId } = useWorkspaceStore();
  const prevRef = useRef<string | null>(null);
  const callbackRef = useRef(onShopChange);
  callbackRef.current = onShopChange;

  // Watch Zustand store changes
  useEffect(() => {
    const key = `${workspaceId}:${shopId}`;
    if (prevRef.current === null) {
      prevRef.current = key;
      return;
    }
    if (prevRef.current !== key) {
      prevRef.current = key;
      callbackRef.current();
    }
  }, [workspaceId, shopId]);

  // Also listen to CustomEvent from WorkspaceGuard
  useEffect(() => {
    const handler = () => callbackRef.current();
    window.addEventListener('shop-changed', handler);
    return () => window.removeEventListener('shop-changed', handler);
  }, []);
}
