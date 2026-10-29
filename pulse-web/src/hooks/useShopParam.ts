'use client';

import { useMemo } from 'react';
import { useWorkspaceStore } from '@/store/workspace';

/**
 * Returns a ready-to-concatenate URL query suffix for the currently active
 * shopId from the workspace store. Empty string when no shop is selected
 * (multi-shop "all shops" mode — backend should treat as workspace-wide).
 *
 * Usage:
 *   const shopParam = useShopParam();
 *   apiFetch(`/finance/${ws}?from=${a}&to=${b}${shopParam}`)
 *
 * For URLSearchParams flows, use the explicit accessor instead:
 *   const { shopId } = useActiveShop();
 *   if (shopId) params.set('shopId', String(shopId));
 *
 * Audit 2026-05-24: 21 страница не передавала shopId → юзер с несколькими
 * магазинами видел смесь. Этот hook централизует паттерн.
 */
export function useShopParam(): string {
  const shopId = useWorkspaceStore((s) => s.shopId);
  return useMemo(() => (shopId ? `&shopId=${shopId}` : ''), [shopId]);
}

/**
 * Same as useShopParam but generates the FIRST URL param (with `?` instead
 * of `&`). Use when shopId is the only param.
 */
export function useShopQuery(): string {
  const shopId = useWorkspaceStore((s) => s.shopId);
  return useMemo(() => (shopId ? `?shopId=${shopId}` : ''), [shopId]);
}

/**
 * Explicit accessor — returns the active shopId or null. Use for URLSearchParams,
 * conditional UI, or when shopId needs to be in the request body.
 */
export function useActiveShop(): { shopId: number | null } {
  const shopId = useWorkspaceStore((s) => s.shopId);
  return { shopId: shopId ?? null };
}
