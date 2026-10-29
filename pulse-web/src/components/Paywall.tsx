'use client';
import type { ReactNode } from 'react';
export function Paywall({ children }: { workspaceId: number; feature?: string; children: ReactNode }) { return <>{children}</>; }
export function useSubscription(_workspaceId: number) {
  const status = { hasSubscription: true, status: 'free', expiresAt: null, isActive: true, daysLeft: 0 };
  return { status, loading: false, isActive: true, daysLeft: 0, expiresAt: null };
}
