'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Building2, ChevronDown, Check, Store } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspaceStore } from '@/store/workspace';
import { apiFetch } from '@/lib/api';
import { useSyncStatus } from '@/hooks/useSyncStatus';

interface Workspace {
  workspaceId: number;
  name: string;
  role: string;
}

interface Shop {
  shopId: number;
  workspaceId: number;
  platform: string;
  name: string;
  isActive: boolean;
}

interface WorkspaceGuardProps {
  children: React.ReactNode;
}

/**
 * WorkspaceGuard - ensures workspace is selected before rendering children
 * Shows workspace selector if none selected
 */
export function WorkspaceGuard({ children }: WorkspaceGuardProps) {
  const { workspaceId, setWorkspaceId } = useWorkspaceStore();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadWorkspaces() {
      try {
        const res = await apiFetch('/auth/me') as { 
          user: { userId: number; email: string };
          workspaces: Workspace[];
          defaultWorkspace: Workspace | null;
        };
        
        setWorkspaces(res.workspaces ?? []);
        
        // Auto-select if only one workspace or none selected
        if (!workspaceId && res.workspaces?.length > 0) {
          const defaultWs = res.defaultWorkspace ?? res.workspaces[0];
          if (defaultWs) {
            setWorkspaceId(defaultWs.workspaceId);
          }
        }
      } catch (e: any) {
        setError(e?.message ?? 'Failed to load workspaces');
      } finally {
        setLoading(false);
      }
    }

    loadWorkspaces();
  }, [workspaceId, setWorkspaceId]);

  if (loading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <div className="text-center">
          <p className="text-red-500">{error}</p>
          <Link href="/auth/login" className="mt-2 text-sm text-indigo-500 hover:underline">
            Войти
          </Link>
        </div>
      </div>
    );
  }

  if (workspaces.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <div className="text-center">
          <Building2 className="mx-auto mb-4 h-12 w-12 text-neutral-400" />
          <h3 className="text-lg font-medium">Нет доступных кабинетов</h3>
          <p className="mt-2 text-sm text-neutral-500">
            Обратитесь к администратору для получения доступа
          </p>
        </div>
      </div>
    );
  }

  // IMPORTANT: Block rendering until workspaceId is set
  // This prevents race conditions where children make API calls with workspaceId=null
  if (!workspaceId) {
    // If we have workspaces but no selection yet, auto-select is in progress
    // Show loading instead of selector to prevent flash
    if (workspaces.length > 0) {
      return (
        <div className="flex min-h-[200px] items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        </div>
      );
    }
    // No workspaces available — show selector/empty state below
  }

  // Workspace selected — render children
  if (workspaceId && workspaces.some(w => w.workspaceId === workspaceId)) {
    return <>{children}</>;
  }

  // No workspace selected — show selector
  return (
    <div className="flex min-h-[300px] items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-6 shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
        <div className="mb-6 text-center">
          <Building2 className="mx-auto mb-3 h-10 w-10 text-indigo-500" />
          <h2 className="text-lg font-semibold">Выберите кабинет</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Для продолжения работы выберите рабочий кабинет
          </p>
        </div>

        <div className="space-y-2">
          {workspaces.map((ws) => (
            <button
              key={ws.workspaceId}
              onClick={() => setWorkspaceId(ws.workspaceId)}
              className="flex w-full items-center justify-between rounded-lg border border-neutral-200 p-4 text-left transition-all hover:border-indigo-300 hover:bg-indigo-50 dark:border-neutral-800 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/30"
            >
              <div>
                <div className="font-medium">{ws.name || `Кабинет #${ws.workspaceId}`}</div>
                <div className="text-xs text-neutral-500 capitalize">{ws.role}</div>
              </div>
              <ChevronDown className="h-4 w-4 -rotate-90 text-neutral-400" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * WorkspaceSelector - dropdown to switch workspaces (for header/sidebar)
 */
export function WorkspaceSelector() {
  const { workspaceId, setWorkspaceId } = useWorkspaceStore();
  const queryClient = useQueryClient();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    apiFetch('/auth/me')
      .then((res: any) => setWorkspaces(res.workspaces ?? []))
      .catch(() => {});
  }, []);

  const current = workspaces.find(w => w.workspaceId === workspaceId);

  if (workspaces.length <= 1) {
    return null; // No selector needed for single workspace
  }

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
      >
        <Building2 className="h-4 w-4 text-neutral-500" />
        <span className="max-w-[120px] truncate">
          {current?.name || `Кабинет #${workspaceId}`}
        </span>
        <ChevronDown className={`h-4 w-4 text-neutral-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 min-w-[200px] rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
            {workspaces.map((ws) => (
              <button
                key={ws.workspaceId}
                onClick={() => {
                  setWorkspaceId(ws.workspaceId);
                  setIsOpen(false);
                  queryClient.cancelQueries({ predicate: (q) => q.queryKey[0] !== 'syncStatus' });
                  queryClient.resetQueries({ predicate: (q) => q.queryKey[0] !== 'syncStatus' });
                  window.dispatchEvent(new CustomEvent('shop-changed', { detail: { workspaceId: ws.workspaceId } }));
                }}
                className="flex w-full items-center justify-between px-4 py-2 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900"
              >
                <span>{ws.name || `Кабинет #${ws.workspaceId}`}</span>
                {ws.workspaceId === workspaceId && (
                  <Check className="h-4 w-4 text-indigo-500" />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Владелец',
  manager: 'Менеджер',
  supervisor: 'Супервайзер',
  viewer: 'Просмотр',
  observer: 'Наблюдатель',
};

const PLATFORM_ICONS: Record<string, string> = {
  wb: '🟣',
  ozon: '🔵',
  yandex_market: '🟡',
};

function SyncStatusDot({ workspaceId, shopId }: { workspaceId: number; shopId?: number }) {
  const { data: sync } = useSyncStatus(workspaceId);

  if (!sync) return <span className="text-[10px] text-gray-500">...</span>;

  const run = sync.run;

  // Syncing — only show "Загрузка..." for the shop that is actually being synced
  const isRunActive = run?.stage && !run.stage.includes('done') && !run.stage.includes('failed') && !run.stage.includes('timeout') && !run.error;
  const isThisShopSyncing = isRunActive && (!run?.shopId || !shopId || run.shopId === shopId);
  if (isThisShopSyncing) {
    return (
      <span className="flex items-center gap-1 text-[10px] text-blue-600">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
        Загрузка...
      </span>
    );
  }

  // Error — only show for recent failures (< 5 min), otherwise fall through to time display
  const runAge = run?.updatedAt ? Date.now() - new Date(run.updatedAt).getTime() : Infinity;
  if (run?.error && runAge < 5 * 60 * 1000) {
    // F-011: hover-tooltip with the actual error text so users know what failed
    // instead of staring at a bare "Ошибка". Truncated to 200 chars to avoid
    // gigantic title attributes from stack traces.
    return (
      <span
        title={String(run.error).slice(0, 200)}
        className="text-[10px] text-red-500 cursor-help"
      >
        Ошибка
      </span>
    );
  }
  if (run?.stage && (run.stage.includes('failed') || run.stage.includes('timeout')) && runAge < 5 * 60 * 1000) {
    return (
      <span
        title={`Stage: ${run.stage}`}
        className="text-[10px] text-orange-500 cursor-help"
      >
        Ошибка синхр.
      </span>
    );
  }

  // Has data - show last updated time
  if (run?.updatedAt) {
    const updated = new Date(run.updatedAt);
    const now = new Date();
    const diffMs = now.getTime() - updated.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMin / 60);

    let timeStr: string;
    if (diffMin < 1) {
      timeStr = 'только что';
    } else if (diffMin < 60) {
      timeStr = `${diffMin} мин назад`;
    } else if (diffHours < 24) {
      timeStr = updated.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } else if (diffHours < 48) {
      timeStr = `Вчера ${updated.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      timeStr = updated.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    }

    return <span className="text-[10px] text-gray-500">{timeStr}</span>;
  }

  // No data
  return <span className="text-[10px] text-gray-500">Нет данных</span>;
}

/**
 * SidebarShopSelector — shop switcher for sidebar (replaces workspace selector)
 */
export function SidebarWorkspaceSelector() {
  const { workspaceId, shopId, setWorkspaceAndShop } = useWorkspaceStore();
  const [shops, setShops] = useState<Shop[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const queryClient = useQueryClient();
  
  // Wait for Zustand store to hydrate from localStorage
  useEffect(() => {
    setHydrated(true);
  }, []);

  // Load all shops for all user's workspaces
  const loadShops = useCallback(async () => {
    try {
      setLoading(true);
      // First get user's workspaces
      const meRes = await apiFetch('/auth/me') as { workspaces: Workspace[]; defaultWorkspace?: Workspace };
      const workspaces = meRes.workspaces ?? [];
      
      // IMPORTANT: Always set workspaceId even if no shops exist
      // This allows pages to render empty states instead of infinite loading
      const currentWorkspaceId = useWorkspaceStore.getState().workspaceId;
      if (!currentWorkspaceId && workspaces.length > 0) {
        const defaultWs = meRes.defaultWorkspace ?? workspaces[0];
        // Set workspace without shop - pages will show "connect shop" prompts
        useWorkspaceStore.getState().setWorkspaceId(defaultWs.workspaceId);
      }
      
      // Load shops for all workspaces IN PARALLEL (avoid sequential requests).
      // skipShopId: the active shop belongs to ONE workspace; passing it when listing
      // shops of a different workspace triggers the shopId-validation middleware (403).
      const shopResults = await Promise.allSettled(
        workspaces.map(async (ws) => {
          const shopsRes = await apiFetch(`/shops/${ws.workspaceId}`, { skipShopId: true }) as { rows: Shop[] };
          return (shopsRes.rows ?? []).map(s => ({ ...s, workspaceId: ws.workspaceId }));
        })
      );
      
      const allShops: Shop[] = [];
      shopResults.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          allShops.push(...result.value);
        } else {
          console.error(`Failed to load shops for workspace ${workspaces[idx].workspaceId}:`, result.reason);
        }
      });
      
      setShops(allShops);
      
      // Get current shopId from store (may have been restored from localStorage)
      const currentShopId = useWorkspaceStore.getState().shopId;
      
      // Auto-select first shop ONLY if no shop selected or current shop doesn't exist
      if (allShops.length > 0 && (!currentShopId || !allShops.some(s => s.shopId === currentShopId))) {
        const activeShop = allShops.find(s => s.isActive) ?? allShops[0];
        setWorkspaceAndShop(activeShop.workspaceId, activeShop.shopId, activeShop.name);
      }
    } catch (e) {
      console.error('Failed to load shops:', e);
    } finally {
      setLoading(false);
    }
  }, [setWorkspaceAndShop]);

  useEffect(() => {
    // Wait for store hydration before loading shops
    if (hydrated) {
      loadShops();
    }
  }, [hydrated, loadShops]);

  // Listen for shop updates
  useEffect(() => {
    const handler = () => loadShops();
    window.addEventListener('shops-updated', handler);
    return () => window.removeEventListener('shops-updated', handler);
  }, [loadShops]);

  // Handle shop switch
  const handleSwitchShop = (shop: Shop) => {
    if (shop.shopId === shopId) {
      setIsOpen(false);
      return;
    }
    // 1. Update store first (synchronous)
    setWorkspaceAndShop(shop.workspaceId, shop.shopId, shop.name);
    setIsOpen(false);
    // 2. Cancel in-flight queries and reset cache completely
    //    resetQueries() clears cache + triggers refetch for active queries
    queryClient.cancelQueries({ predicate: (q) => q.queryKey[0] !== 'syncStatus' });
    queryClient.resetQueries({ predicate: (q) => q.queryKey[0] !== 'syncStatus' });
    // 3. Notify pages using useState+apiFetch (not react-query) to re-fetch
    window.dispatchEvent(new CustomEvent('shop-changed', { detail: { shopId: shop.shopId, workspaceId: shop.workspaceId } }));
  };

  const currentShop = shops.find(s => s.shopId === shopId);
  const hasMultiple = shops.length > 1;

  if (loading) {
    return (
      <div className="px-1 py-1">
        <span className="text-xs text-gray-500">Загрузка...</span>
      </div>
    );
  }

  if (shops.length === 0) {
    return (
      <Link
        href="/shops"
        className="mt-1.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-gray-500 transition-colors hover:bg-gray-100"
      >
        <Store className="h-3.5 w-3.5" />
        <span>Подключить магазин</span>
      </Link>
    );
  }

  return (
    <div className="relative mt-1.5">
      <button
        type="button"
        onClick={() => hasMultiple && setIsOpen(!isOpen)}
        className={`
          flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors
          ${hasMultiple ? 'hover:bg-gray-100 cursor-pointer' : 'cursor-default'}
          ${isOpen ? 'bg-gray-100' : ''}
        `}
      >
        <Store className="h-3.5 w-3.5 shrink-0 text-gray-500" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-gray-700">
            {currentShop?.name ?? 'Выберите магазин'}
          </div>
          {currentShop && <SyncStatusDot workspaceId={currentShop.workspaceId} shopId={currentShop.shopId} />}
        </div>
        {hasMultiple && (
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        )}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-xl">
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Магазины
            </div>
            {shops.map((shop) => {
              const isActive = shop.shopId === shopId;
              const platformIcon = PLATFORM_ICONS[shop.platform] ?? '📦';
              return (
                <button
                  key={shop.shopId}
                  onClick={() => handleSwitchShop(shop)}
                  className={`
                    flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors
                    ${isActive ? 'bg-indigo-50' : 'hover:bg-gray-50'}
                  `}
                >
                  <div className={`
                    flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm
                    ${isActive
                      ? 'bg-indigo-100'
                      : 'bg-gray-100'
                    }
                  `}>
                    {platformIcon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className={`truncate text-sm ${isActive ? 'font-semibold text-indigo-700' : 'font-medium text-gray-700'}`}>
                      {shop.name}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-500 uppercase">
                        {shop.platform === 'wb' ? 'Wildberries' : shop.platform === 'ozon' ? 'Ozon' : shop.platform}
                      </span>
                      <span className="text-gray-300">·</span>
                      <SyncStatusDot workspaceId={shop.workspaceId} shopId={shop.shopId} />
                    </div>
                  </div>
                  {isActive && (
                    <Check className="h-4 w-4 shrink-0 text-indigo-500" />
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Hook to get current workspace ID with redirect to selector if not set
 */
export function useRequiredWorkspaceId(): number {
  const { workspaceId } = useWorkspaceStore();
  
  if (!workspaceId) {
    throw new Error('Workspace not selected');
  }
  
  return workspaceId;
}
