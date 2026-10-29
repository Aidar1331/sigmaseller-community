'use client';

import { useShopChange } from '@/hooks/useShopChange';
import { useShopParam, useActiveShop } from '@/hooks/useShopParam';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RefreshCw,
  Settings,
  Plus,
  Truck,
  Package,
  Calendar,
  User,
  ChevronRight,
  AlertTriangle,
  AlertCircle,
  CheckCircle,
  Clock,
  Download,
  Trash2,
  Edit2,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { useWorkspaceStore } from '@/store/workspace';
import { SupplyWizard } from './components/SupplyWizard';
import { SupplySlipDownload } from '@/components/supplies/SupplySlipDownload';

// Types
type Warehouse = {
  warehouseId: number;
  warehouseName: string;
  address: string | null;
  priority: number | null;
  salesCount14d?: number;
  ordersCount14d?: number;
  acceptanceCoefficient?: number;
  currentStock?: number;
};

type WarehouseRegion = {
  regionName: string;
  warehouses: Warehouse[];
  hasPriority: boolean;
};

type Driver = {
  driverId: number;
  firstName: string;
  lastName: string;
  carModel: string;
  carNumber: string;
  isDefault: boolean;
};

type Draft = {
  draftId: number;
  name: string;
  warehouseId: number | null;
  warehouseName: string | null;
  plannedDate: string | null;
  status: string;
  totalItems: number;
  totalQty: number;
  totalBoxes: number;
  createdAt: string;
  updatedAt: string;
};

type SupplyItem = {
  nmId: number;
  vendorCode: string | null;
  title: string | null;
  currentStock: number;
  inWay: number;
  avgDailySales: number;
  daysOfStock: number | null;
  needToSend: number;
  status: 'critical' | 'warning' | 'ok';
};

type CalculateResponse = {
  warehouseId: number;
  items: SupplyItem[];
  summary: { critical: number; warning: number; ok: number; total: number };
};

type DemandItem = {
  nmId: number;
  vendorCode: string | null;
  title: string | null;
  tags: string[] | null;
  regionDemand: number;
  avgDailySales: number;
  currentStock: number;
  inWay: number;
  daysOfStock: number;
  needToSend: number;
};

type WarehouseSummary = {
  warehouseId: number;
  warehouseName: string;
  warehouseRegion: string;
  isPriority: boolean;
  totalDemand: number;
  totalNeed: number;
  itemCount: number;
  items: DemandItem[];
};

type DemandPlanResponse = {
  salesPeriod: number;
  horizonDays: number;
  warehouseSummaries: WarehouseSummary[];
  consolidatedNeeds: (DemandItem & { totalDemand: number; totalNeed: number })[];
  unmappedRegions: string[];
  summary: { totalWarehouses: number; priorityWarehouses: number; totalProducts: number };
};

type BoxSettings = {
  defaultItemsPerBox: number;
  perProduct: { nmId: number; itemsPerBox: number }[];
};

// Status icons
const statusIcon = {
  critical: <AlertTriangle className="h-4 w-4 text-red-500" />,
  warning: <AlertCircle className="h-4 w-4 text-amber-500" />,
  ok: <CheckCircle className="h-4 w-4 text-emerald-500" />,
};

const statusBadge = {
  critical: 'danger' as const,
  warning: 'warning' as const,
  ok: 'success' as const,
};

export default function SuppliesV2Page() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopParam = useShopParam();
  const { shopId } = useActiveShop();

  // Tab state
  const [tab, setTab] = useState<'plan' | 'drafts' | 'active' | 'history' | 'settings'>('plan');
  const [showWizard, setShowWizard] = useState(false);

  // Warehouses & priorities
  const [warehouseRegions, setWarehouseRegions] = useState<WarehouseRegion[]>([]);
  const [expandedRegions, setExpandedRegions] = useState<Set<string>>(new Set());
  const [selectedWarehouse, setSelectedWarehouse] = useState<number | null>(null);

  // Flat list of all warehouses (for compatibility)
  const warehouses = useMemo(
    () => warehouseRegions.flatMap((r) => r.warehouses),
    [warehouseRegions]
  );

  // Settings
  const [boxSettings, setBoxSettings] = useState<BoxSettings>({ defaultItemsPerBox: 10, perProduct: [] });
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [showDriverForm, setShowDriverForm] = useState(false);
  const [newDriver, setNewDriver] = useState({ firstName: '', lastName: '', carModel: '', carNumber: '' });

  // Planning
  const [salesPeriod, setSalesPeriod] = useState(14);
  const [deliveryDays, setDeliveryDays] = useState(5);
  const [safetyDays, setSafetyDays] = useState(7);
  const [calcResult, setCalcResult] = useState<CalculateResponse | null>(null);
  const [selectedItems, setSelectedItems] = useState<Map<number, number>>(new Map());

  // Demand-based planning
  const [demandPlan, setDemandPlan] = useState<DemandPlanResponse | null>(null);
  
  // Acceptance options (coefficients)
  const [acceptanceOptions, setAcceptanceOptions] = useState<{
    result: Array<{
      barcode: string;
      warehouses?: Array<{
        warehouseId: number;
        warehouseName: string;
        coefficient: number;
        allowUnload: boolean;
        boxTypes: Array<{ boxTypeId: number; boxTypeName: string }>;
      }>;
      error?: { title: string; detail: string };
    }>;
  } | null>(null);
  const [acceptanceLoading, setAcceptanceLoading] = useState(false);
  
  // Transit tariffs
  const [transitTariffs, setTransitTariffs] = useState<Array<{
    transitWarehouseName: string;
    destinationWarehouseName: string;
    boxTariff: Array<{ from: number; to: number; value: number }> | null;
    palletTariff: number;
  }>>([]);
  const [transitLoading, setTransitLoading] = useState(false);
  const [selectedPlanWarehouse, setSelectedPlanWarehouse] = useState<number | null>(null);
  const [adjustedQuantities, setAdjustedQuantities] = useState<Map<number, number>>(new Map());
  const [plannedDate, setPlannedDate] = useState<string>('');
  // Map: warehouseId → nmId → quantity
  const [warehouseQuantities, setWarehouseQuantities] = useState<Map<number, Map<number, number>>>(new Map());
  // Map: nmId → itemsPerBox
  const [itemsPerBox, setItemsPerBox] = useState<Map<number, number>>(new Map());

  // Drafts
  const [drafts, setDrafts] = useState<Draft[]>([]);

  // WB Supplies History
  const [wbSupplies, setWbSupplies] = useState<Array<{
    id: number;
    wbSupplyId: number | null;
    wbPreorderId: number | null;
    statusId: number;
    warehouseName: string | null;
    quantity: number;
    acceptedQuantity: number | null;
    supplyDate: string | null;
    factDate: string | null;
    createdAt: string;
  }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [expandedSupplyId, setExpandedSupplyId] = useState<number | null>(null);
  const [supplyGoods, setSupplyGoods] = useState<Array<{
    barcode: string;
    vendorCode: string | null;
    nmId: number;
    quantity: number;
    acceptedQuantity: number | null;
  }>>([]);

  // Loading states
  const [loading, setLoading] = useState(false);
  const [calcLoading, setCalcLoading] = useState(false);
  const [demandLoading, setDemandLoading] = useState(false);

  // Load warehouses
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<{ regions: WarehouseRegion[] }>(`/supplies/${workspaceId}/warehouses${shopParam ? `?shopId=${shopId}` : ''}`)
      .then((r) => {
        setWarehouseRegions(r.regions ?? []);
        // Expand regions with priorities
        const expanded = new Set<string>(r.regions?.filter((reg) => reg.hasPriority).map((reg) => reg.regionName) ?? []);
        setExpandedRegions(expanded);
        // Select first priority warehouse
        const allWarehouses = r.regions?.flatMap((reg) => reg.warehouses) ?? [];
        const priority = allWarehouses.find((w) => w.priority === 1);
        if (priority) setSelectedWarehouse(priority.warehouseId);
      })
      .catch((e) => console.error('Failed to load warehouses:', e));
  }, [workspaceId, shopParam, shopId]);

  // Load box settings
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<BoxSettings>(`/supplies/${workspaceId}/box-settings${shopParam ? `?shopId=${shopId}` : ''}`)
      .then((r) => setBoxSettings(r))
      .catch((e) => console.warn('Failed to load box settings:', e));
  }, [workspaceId, shopParam, shopId]);

  // Load drivers
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<{ drivers: Driver[] }>(`/supplies/${workspaceId}/drivers${shopParam ? `?shopId=${shopId}` : ''}`)
      .then((r) => setDrivers(r.drivers ?? []))
      .catch((e) => console.error('Failed to load drivers:', e));
  }, [workspaceId, shopParam, shopId]);

  // Load drafts
  const loadDrafts = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const r = await apiFetch<{ drafts: Draft[] }>(`/supplies/${workspaceId}/drafts${shopParam ? `?shopId=${shopId}` : ''}`);
      setDrafts(r.drafts ?? []);
    } catch (e) { console.error('Failed to load drafts:', e); }
    setLoading(false);
  }, [workspaceId, shopParam, shopId]);

  useEffect(() => {
    loadDrafts();
  }, [loadDrafts]);

  // Load WB supplies history
  const loadHistory = useCallback(async () => {
    if (!workspaceId) return;
    setHistoryLoading(true);
    try {
      const r = await apiFetch<{ supplies: typeof wbSupplies }>(`/supplies/${workspaceId}/list${shopParam ? `?shopId=${shopId}` : ''}`);
      setWbSupplies(r.supplies ?? []);
    } catch (e) { console.error('Failed to load supply history:', e); }
    setHistoryLoading(false);
  }, [workspaceId, shopParam, shopId]);

  // Sync from WB
  const syncFromWb = useCallback(async () => {
    if (!workspaceId) return;
    setHistoryLoading(true);
    try {
      await apiFetch(`/supplies/${workspaceId}/wb/sync`, {
        method: 'POST',
        body: JSON.stringify({ statusIDs: [1, 2, 3, 4, 5, 6], ...(shopId ? { shopId } : {}) }),
        headers: { 'Content-Type': 'application/json' },
      });
      await loadHistory();
    } catch (e) { console.error('Failed to sync from WB:', e); }
    setHistoryLoading(false);
  }, [workspaceId, loadHistory, shopId]);
  useShopChange(loadHistory);

  // Re-fetch all data when shop changes (for pages using useState+apiFetch)
  useEffect(() => {
    const handler = () => {
      loadDrafts();
      loadHistory();
    };
    window.addEventListener('shop-changed', handler);
    return () => window.removeEventListener('shop-changed', handler);
  }, [loadDrafts, loadHistory]);

  // Auto-load history and auto-sync from WB on first visit if empty
  const historySynced = useRef(false);
  useEffect(() => {
    if (tab === 'history' || tab === 'active') {
      loadHistory().then(() => {
        // Auto-sync from WB on first visit if no supplies loaded yet
        if (!historySynced.current && wbSupplies.length === 0) {
          historySynced.current = true;
          syncFromWb();
        }
      });
    }
  }, [tab, loadHistory]);

  // Load supply goods when expanded
  const loadSupplyGoods = useCallback(async (supplyId: number, wbSupplyId: number | null, wbPreorderId: number | null) => {
    if (!workspaceId) return;
    setExpandedSupplyId(supplyId);
    setSupplyGoods([]);
    try {
      const id = wbSupplyId ?? wbPreorderId;
      if (!id) return;
      const isPreorder = !wbSupplyId;
      const r = await apiFetch<{ goods: typeof supplyGoods }>(`/supplies/${workspaceId}/list/${supplyId}/goods${shopParam ? `?shopId=${shopId}` : ''}`);
      setSupplyGoods(r.goods ?? []);
    } catch (e) { console.error('Failed to load supply goods:', e); }
  }, [workspaceId, shopParam, shopId]);

  // Calculate needs (old method - per warehouse)
  const calculate = useCallback(async () => {
    if (!workspaceId || !selectedWarehouse) return;
    setCalcLoading(true);
    try {
      const qs = new URLSearchParams({
        warehouseId: String(selectedWarehouse),
        salesPeriod: String(salesPeriod),
        deliveryDays: String(deliveryDays),
        safetyDays: String(safetyDays),
      });
      if (shopId) qs.set('shopId', String(shopId));
      const r = await apiFetch<CalculateResponse>(`/supplies/${workspaceId}/calculate?${qs}`);
      setCalcResult(r);
      // Auto-select critical and warning items
      const newSelected = new Map<number, number>();
      for (const item of r.items) {
        if (item.status !== 'ok' && item.needToSend > 0) {
          newSelected.set(item.nmId, item.needToSend);
        }
      }
      setSelectedItems(newSelected);
    } catch (e) { console.error('Failed to calculate needs:', e); }
    setCalcLoading(false);
  }, [workspaceId, selectedWarehouse, salesPeriod, deliveryDays, safetyDays, shopId]);

  // Load demand-based plan
  const loadDemandPlan = useCallback(async () => {
    if (!workspaceId) return;
    setDemandLoading(true);
    try {
      const qs = new URLSearchParams({
        salesPeriod: String(salesPeriod),
        deliveryDays: String(deliveryDays),
        safetyDays: String(safetyDays),
      });
      if (shopId) qs.set('shopId', String(shopId));
      const r = await apiFetch<DemandPlanResponse>(`/supplies/${workspaceId}/demand-plan?${qs}`);
      setDemandPlan(r);
      // Auto-select first warehouse with demand
      if (r.warehouseSummaries.length > 0) {
        const priority = r.warehouseSummaries.find((w) => w.isPriority) ?? r.warehouseSummaries[0];
        setSelectedPlanWarehouse(priority.warehouseId);
      }
      // Initialize warehouse quantities
      const whQty = new Map<number, Map<number, number>>();
      for (const wh of r.warehouseSummaries) {
        const itemQty = new Map<number, number>();
        for (const item of wh.items) {
          itemQty.set(item.nmId, item.needToSend);
        }
        whQty.set(wh.warehouseId, itemQty);
      }
      setWarehouseQuantities(whQty);
      // Initialize adjusted quantities from consolidated needs
      const adjusted = new Map<number, number>();
      for (const item of r.consolidatedNeeds) {
        if (item.totalNeed > 0) {
          adjusted.set(item.nmId, item.totalNeed);
        }
      }
      setAdjustedQuantities(adjusted);
    } catch (e) { console.error('Failed to load demand plan:', e); }
    setDemandLoading(false);
  }, [workspaceId, salesPeriod, deliveryDays, safetyDays, shopId]);

  // Create draft
  const createDraft = useCallback(async () => {
    if (!workspaceId || !selectedWarehouse || selectedItems.size === 0) return;
    const wh = warehouses.find((w) => w.warehouseId === selectedWarehouse);
    if (!wh) return;

    setLoading(true);
    try {
      await apiFetch(`/supplies/${workspaceId}/drafts`, {
        method: 'POST',
        body: JSON.stringify({
          warehouseId: selectedWarehouse,
          warehouseName: wh.warehouseName,
          items: Array.from(selectedItems.entries()).map(([nmId, quantity]) => ({ nmId, quantity })),
          ...(shopId ? { shopId } : {}),
        }),
      });
      await loadDrafts();
      setTab('drafts');
      setSelectedItems(new Map());
    } catch (e) { console.error('Failed to create draft:', e); }
    setLoading(false);
  }, [workspaceId, selectedWarehouse, warehouses, selectedItems, loadDrafts, shopId]);

  // Check acceptance options (coefficients)
  const checkAcceptance = useCallback(async (items: Array<{ barcode: string; quantity: number }>) => {
    if (!workspaceId || items.length === 0) return;
    setAcceptanceLoading(true);
    try {
      const result = await apiFetch<typeof acceptanceOptions>(`/supplies/${workspaceId}/wb/acceptance-options`, {
        method: 'POST',
        body: JSON.stringify({ items, ...(shopId ? { shopId } : {}) }),
      });
      setAcceptanceOptions(result);
    } catch (e) {
      console.error('Failed to check acceptance:', e);
    }
    setAcceptanceLoading(false);
  }, [workspaceId, shopId]);

  // Load transit tariffs
  const loadTransitTariffs = useCallback(async () => {
    if (!workspaceId) return;
    setTransitLoading(true);
    try {
      const result = await apiFetch<{ tariffs: typeof transitTariffs }>(`/supplies/${workspaceId}/wb/transit-tariffs${shopParam ? `?shopId=${shopId}` : ''}`);
      setTransitTariffs(result.tariffs ?? []);
    } catch (e) {
      console.error('Failed to load transit tariffs:', e);
    }
    setTransitLoading(false);
  }, [workspaceId, shopParam, shopId]);

  // Delete draft
  const deleteDraft = useCallback(async (draftId: number) => {
    if (!workspaceId) return;
    if (!confirm('Удалить черновик?')) return;
    try {
      await apiFetch(`/supplies/${workspaceId}/drafts/${draftId}${shopParam ? `?shopId=${shopId}` : ''}`, { method: 'DELETE' });
      await loadDrafts();
    } catch (e) { console.error('Failed to delete draft:', e); }
  }, [workspaceId, loadDrafts, shopParam, shopId]);

  // Save warehouse priorities
  const savePriorities = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      await apiFetch(`/supplies/${workspaceId}/warehouses/priorities`, {
        method: 'PUT',
        body: JSON.stringify({
          priorities: warehouses.map((w) => ({
            warehouseId: w.warehouseId,
            warehouseName: w.warehouseName,
            priority: w.priority,
          })),
          ...(shopId ? { shopId } : {}),
        }),
      });
      // Re-fetch to confirm save
      const res = await apiFetch<{ regions: typeof warehouseRegions }>(`/supplies/${workspaceId}/warehouses${shopParam ? `?shopId=${shopId}` : ''}`);
      if (res.regions) setWarehouseRegions(res.regions);
    } catch (e) {
      console.error('Failed to save priorities:', e);
      alert(`Ошибка сохранения приоритетов: ${e instanceof Error ? e.message : 'Неизвестная ошибка'}`);
    }
    setLoading(false);
  }, [workspaceId, warehouses, shopParam, shopId]);

  // Save box settings (debounced to avoid rapid API calls)
  const saveBoxSettingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveBoxSettings = useCallback((value: number) => {
    if (!workspaceId) return;
    if (saveBoxSettingsTimer.current) clearTimeout(saveBoxSettingsTimer.current);
    saveBoxSettingsTimer.current = setTimeout(async () => {
      try {
        await apiFetch(`/supplies/${workspaceId}/box-settings`, {
          method: 'PUT',
          body: JSON.stringify({ defaultItemsPerBox: value, ...(shopId ? { shopId } : {}) }),
        });
        setBoxSettings((prev) => ({ ...prev, defaultItemsPerBox: value }));
      } catch (e) { console.error('Failed to save box settings:', e); }
    }, 300);
  }, [workspaceId, shopId]);

  // Priority warehouses for selector
  const priorityWarehouses = useMemo(
    () => warehouses.filter((w) => w.priority !== null).sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)),
    [warehouses]
  );

  // Stats
  const draftCount = drafts.filter((d) => d.status === 'draft').length;
  const activeCount = drafts.filter((d) => ['ready', 'booking', 'submitted'].includes(d.status)).length;

  if (!workspaceId) {
    return (
      <AppShell title="Поставки">
        <div className="flex min-h-[300px] items-center justify-center p-6">
          <div className="text-sm text-[var(--content-muted)]">Выберите магазин для работы с поставками</div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Поставки">
      <div className="p-6 space-y-4">
        {/* Tabs */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--card-border)] pb-2">
          <button
            onClick={() => setTab('plan')}
            className={cn(
              'px-4 py-2 text-sm font-medium rounded-t-lg transition-colors',
              tab === 'plan' ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-500' : 'text-[var(--content-muted)] hover:text-[var(--content-text)]'
            )}
          >
            📊 Планирование
          </button>
          <button
            onClick={() => setTab('drafts')}
            className={cn(
              'px-4 py-2 text-sm font-medium rounded-t-lg transition-colors',
              tab === 'drafts' ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-500' : 'text-[var(--content-muted)] hover:text-[var(--content-text)]'
            )}
          >
            📝 Черновики {draftCount > 0 && <Badge variant="info" className="ml-1">{draftCount}</Badge>}
          </button>
          <button
            onClick={() => setTab('active')}
            className={cn(
              'px-4 py-2 text-sm font-medium rounded-t-lg transition-colors',
              tab === 'active' ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-500' : 'text-[var(--content-muted)] hover:text-[var(--content-text)]'
            )}
          >
            🚚 В работе {activeCount > 0 && <Badge variant="warning" className="ml-1">{activeCount}</Badge>}
          </button>
          <button
            onClick={() => setTab('history')}
            className={cn(
              'px-4 py-2 text-sm font-medium rounded-t-lg transition-colors',
              tab === 'history' ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-500' : 'text-[var(--content-muted)] hover:text-[var(--content-text)]'
            )}
          >
            📜 История
          </button>
          <div className="flex-1" />
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowWizard(true)}
            className="mr-2"
          >
            <Plus className="h-4 w-4 mr-1" />
            Новая поставка
          </Button>
          <button
            onClick={() => setTab('settings')}
            className={cn(
              'px-4 py-2 text-sm font-medium rounded-t-lg transition-colors flex items-center gap-1.5',
              tab === 'settings' ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-500' : 'text-[var(--content-muted)] hover:text-[var(--content-text)]'
            )}
          >
            <Settings className="h-4 w-4" />
            Настройки
          </button>
        </div>

        {/* PLANNING TAB */}
        {tab === 'plan' && (
          <div className="space-y-4">
            {/* Filters */}
            <Card className="p-4">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--content-muted)]">Период анализа</span>
                  <Select value={String(salesPeriod)} onValueChange={(v) => setSalesPeriod(Number(v))}>
                    <SelectTrigger className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[7, 14, 30, 60].map((d) => (
                        <SelectItem key={d} value={String(d)}>{d} дн</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--content-muted)]">Доставка</span>
                  <Input
                    type="number"
                    value={deliveryDays}
                    onChange={(e) => setDeliveryDays(Number(e.target.value))}
                    className="w-16 text-center"
                    min={1}
                    max={30}
                  />
                  <span className="text-xs text-[var(--content-muted)]">дн</span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--content-muted)]">Запас</span>
                  <Input
                    type="number"
                    value={safetyDays}
                    onChange={(e) => setSafetyDays(Number(e.target.value))}
                    className="w-16 text-center"
                    min={0}
                    max={60}
                  />
                  <span className="text-xs text-[var(--content-muted)]">дн</span>
                </div>

                <Button onClick={loadDemandPlan} loading={demandLoading}>
                  <RefreshCw className={cn('h-4 w-4', demandLoading && 'animate-spin')} />
                  Анализ спроса
                </Button>
              </div>

              {priorityWarehouses.length === 0 && (
                <div className="mt-3 text-sm text-amber-700 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  Настройте приоритетные склады во вкладке Настройки
                </div>
              )}
            </Card>

            {/* Demand Plan Results */}
            {demandPlan && (
              <>
                {/* Warehouse summary cards */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm font-semibold">Потребность по складам</div>
                    <div className="text-xs text-[var(--content-muted)]">
                      Склады с ⭐ — ваши приоритетные
                    </div>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    {demandPlan.warehouseSummaries.slice(0, 12).map((wh) => {
                      const userPriority = warehouses.find((w) => w.warehouseId === wh.warehouseId)?.priority;
                      return (
                        <Card
                          key={wh.warehouseId}
                          className={cn(
                            'p-3 cursor-pointer transition-all hover:shadow-md',
                            selectedPlanWarehouse === wh.warehouseId && 'ring-2 ring-indigo-500',
                            !userPriority && 'opacity-50'
                          )}
                          onClick={() => setSelectedPlanWarehouse(wh.warehouseId)}
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium truncate">{wh.warehouseName}</div>
                              <div className="text-xs text-[var(--content-muted)]">{wh.warehouseRegion}</div>
                            </div>
                            {userPriority && (
                              <span className="text-sm ml-1">
                                {userPriority === 1 ? '⭐' : userPriority === 2 ? '🥈' : userPriority === 3 ? '🥉' : `#${userPriority}`}
                              </span>
                            )}
                          </div>
                          <div className="mt-2 flex items-baseline gap-2">
                            <span className="text-lg font-bold">{formatNumber(wh.totalNeed)}</span>
                            <span className="text-xs text-[var(--content-muted)]">к отправке</span>
                          </div>
                          <div className="text-xs text-[var(--content-muted)]">
                            {wh.itemCount} товаров • {formatNumber(wh.totalDemand)} заказов
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                </div>

                {/* Selected warehouse details */}
                {selectedPlanWarehouse && (() => {
                  const wh = demandPlan.warehouseSummaries.find((w) => w.warehouseId === selectedPlanWarehouse);
                  if (!wh) return null;
                  const whQty = warehouseQuantities.get(wh.warehouseId) ?? new Map();
                  const totalToSend = Array.from(whQty.values()).reduce((a, b) => a + b, 0);
                  return (
                    <Card className="overflow-hidden p-0">
                      <div className="flex items-center justify-between border-b border-[var(--card-border)] px-4 py-3">
                        <div>
                          <div className="text-sm font-semibold">{wh.warehouseName}</div>
                          <div className="text-xs text-[var(--content-muted)]">
                            Спрос: {formatNumber(wh.totalDemand)} заказов • К отправке: {formatNumber(totalToSend)} шт
                          </div>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => {
                            const items = Array.from(whQty.entries())
                              .filter(([, qty]) => qty > 0)
                              .map(([nmId, quantity]) => ({ nmId, quantity }));
                            if (items.length === 0) return;
                            setLoading(true);
                            apiFetch(`/supplies/${workspaceId}/drafts`, {
                              method: 'POST',
                              body: JSON.stringify({
                                warehouseId: wh.warehouseId,
                                warehouseName: wh.warehouseName,
                                items,
                                ...(shopId ? { shopId } : {}),
                              }),
                            })
                              .then(() => {
                                loadDrafts();
                                setTab('drafts');
                              })
                              .finally(() => setLoading(false));
                          }}
                          disabled={totalToSend === 0}
                          loading={loading}
                        >
                          <Plus className="h-4 w-4" />
                          Черновик на {wh.warehouseName}
                        </Button>
                      </div>
                      <div className="overflow-x-auto max-h-[40vh]">
                        <table className="min-w-[800px] w-full text-sm">
                          <thead className="bg-slate-50 sticky top-0">
                            <tr className="text-[var(--content-muted)] text-xs">
                              <th className="px-4 py-2 text-left">Товар</th>
                              <th className="px-4 py-2 text-left">Теги</th>
                              <th className="px-4 py-2 text-right">Спрос</th>
                              <th className="px-4 py-2 text-right">Остаток</th>
                              <th className="px-4 py-2 text-right">В пути</th>
                              <th className="px-4 py-2 text-right">Дней запаса</th>
                              <th className="px-4 py-2 text-right">Шт в коробке</th>
                              <th className="px-4 py-2 text-right">К отправке (шт)</th>
                              <th className="px-4 py-2 text-right">Коробок</th>
                            </tr>
                          </thead>
                          <tbody>
                            {wh.items.map((item) => {
                              const qty = whQty.get(item.nmId) ?? item.needToSend;
                              const perBox = itemsPerBox.get(item.nmId) ?? boxSettings.defaultItemsPerBox;
                              const boxes = perBox > 0 ? Math.ceil(qty / perBox) : 0;
                              return (
                                <tr key={item.nmId} className="border-t border-[var(--table-border)] hover:bg-slate-50">
                                  <td className="px-4 py-2">
                                    <div className="font-medium">{item.vendorCode ?? item.nmId}</div>
                                    <div className="text-xs text-[var(--content-muted)] truncate max-w-[200px]">
                                      {item.title ?? `Артикул ${item.nmId}`}
                                    </div>
                                  </td>
                                  <td className="px-4 py-2">
                                    {item.tags?.map((tag) => (
                                      <span key={tag} className="inline-block text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded mr-1 mb-1">
                                        {tag}
                                      </span>
                                    ))}
                                  </td>
                                  <td className="px-4 py-2 text-right font-mono">{formatNumber(item.regionDemand)}</td>
                                  <td className="px-4 py-2 text-right font-mono">{formatNumber(item.currentStock)}</td>
                                  <td className="px-4 py-2 text-right font-mono text-blue-600">{item.inWay > 0 ? formatNumber(item.inWay) : '—'}</td>
                                  <td className={cn(
                                    'px-4 py-2 text-right font-mono',
                                    item.daysOfStock <= 7 ? 'text-red-600 font-bold' : item.daysOfStock <= 14 ? 'text-amber-700' : 'text-emerald-600'
                                  )}>
                                    {item.daysOfStock >= 999 ? '∞' : item.daysOfStock}
                                  </td>
                                  <td className="px-4 py-2 text-right">
                                    <Input
                                      type="number"
                                      value={perBox}
                                      onChange={(e) => {
                                        const next = new Map(itemsPerBox);
                                        next.set(item.nmId, Math.max(1, Number(e.target.value)));
                                        setItemsPerBox(next);
                                      }}
                                      className="w-16 text-right"
                                      min={1}
                                    />
                                  </td>
                                  <td className="px-4 py-2 text-right">
                                    <Input
                                      type="number"
                                      value={qty}
                                      onChange={(e) => {
                                        // Store raw value — rounding happens on blur only
                                        const rawQty = Math.max(0, Number(e.target.value) || 0);
                                        setWarehouseQuantities((prev) => {
                                          const next = new Map(prev);
                                          const whMap = new Map(next.get(wh.warehouseId) ?? new Map());
                                          whMap.set(item.nmId, rawQty);
                                          next.set(wh.warehouseId, whMap);
                                          return next;
                                        });
                                      }}
                                      onBlur={(e) => {
                                        // Re-round on blur in case of direct edit
                                        const rawQty = Math.max(0, Number(e.target.value));
                                        const roundedQty = perBox > 0 ? Math.ceil(rawQty / perBox) * perBox : rawQty;
                                        if (roundedQty !== rawQty) {
                                          setWarehouseQuantities((prev) => {
                                            const next = new Map(prev);
                                            const whMap = new Map(next.get(wh.warehouseId) ?? new Map());
                                            whMap.set(item.nmId, roundedQty);
                                            next.set(wh.warehouseId, whMap);
                                            return next;
                                          });
                                        }
                                      }}
                                      className="w-20 text-right"
                                      min={0}
                                    />
                                  </td>
                                  <td className="px-4 py-2 text-right font-mono text-[var(--content-muted)]">
                                    {boxes}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="border-t-2 border-[var(--card-border)] bg-slate-50 font-medium text-sm">
                              <td className="px-4 py-2" colSpan={2}>Итого по {wh.warehouseName}</td>
                              <td className="px-4 py-2 text-right font-mono">{formatNumber(wh.totalDemand)}</td>
                              <td className="px-4 py-2 text-right font-mono">{formatNumber(wh.items.reduce((s, i) => s + i.currentStock, 0))}</td>
                              <td className="px-4 py-2 text-right font-mono text-blue-600">{formatNumber(wh.items.reduce((s, i) => s + i.inWay, 0))}</td>
                              <td className="px-4 py-2 text-right">—</td>
                              <td className="px-4 py-2 text-right">—</td>
                              <td className="px-4 py-2 text-right font-mono font-bold text-indigo-600">{formatNumber(totalToSend)}</td>
                              <td className="px-4 py-2 text-right font-mono">
                                {(() => {
                                  const totalBoxes = wh.items.reduce((s, item) => {
                                    const qty = whQty.get(item.nmId) ?? item.needToSend;
                                    const perBox = itemsPerBox.get(item.nmId) ?? boxSettings.defaultItemsPerBox;
                                    return s + (perBox > 0 ? Math.ceil(qty / perBox) : 0);
                                  }, 0);
                                  return totalBoxes;
                                })()}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </Card>
                  );
                })()}

                {/* Consolidated plan */}
                <Card className="overflow-hidden p-0">
                  <div className="flex items-center justify-between border-b border-[var(--card-border)] px-4 py-3">
                    <div>
                      <div className="text-sm font-semibold">Итоговый план по товарам</div>
                      <div className="text-xs text-[var(--content-muted)]">
                        Консолидированная потребность для приоритетных складов
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        type="date"
                        value={plannedDate}
                        onChange={(e) => setPlannedDate(e.target.value)}
                        className="w-40"
                        placeholder="Плановая дата"
                      />
                      <Button
                        onClick={() => {
                          const items = Array.from(adjustedQuantities.entries())
                            .filter(([, qty]) => qty > 0)
                            .map(([nmId, quantity]) => ({ nmId, quantity }));
                          if (items.length === 0) return;
                          setLoading(true);
                          apiFetch(`/supplies/${workspaceId}/drafts`, {
                            method: 'POST',
                            body: JSON.stringify({
                              warehouseId: null,
                              warehouseName: 'Сводный план',
                              plannedDate: plannedDate || null,
                              items,
                              ...(shopId ? { shopId } : {}),
                            }),
                          })
                            .then(() => {
                              loadDrafts();
                              setTab('drafts');
                              setPlannedDate('');
                            })
                            .finally(() => setLoading(false));
                        }}
                        disabled={adjustedQuantities.size === 0}
                        loading={loading}
                      >
                        <Plus className="h-4 w-4" />
                        Создать черновик ({adjustedQuantities.size})
                      </Button>
                    </div>
                  </div>
                  
                  {/* Acceptance coefficients info */}
                  {selectedPlanWarehouse && (
                    <div className="mt-2 p-3 bg-slate-50 rounded-lg text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-[var(--content-muted)]">
                          Коэффициент приёмки на складе
                        </span>
                        {acceptanceOptions?.result?.[0]?.warehouses?.find(w => w.warehouseId === selectedPlanWarehouse) ? (
                          <span className="font-medium">
                            {(() => {
                              const wh = acceptanceOptions.result[0].warehouses?.find(w => w.warehouseId === selectedPlanWarehouse);
                              if (!wh) return '—';
                              if (wh.coefficient === -1) return <Badge variant="danger">Недоступно</Badge>;
                              if (wh.coefficient === 0) return <Badge variant="success">Бесплатно</Badge>;
                              return <Badge variant="warning">×{wh.coefficient}</Badge>;
                            })()}
                          </span>
                        ) : (
                          <span className="text-[var(--content-muted)]">—</span>
                        )}
                      </div>
                    </div>
                  )}
                  
                  <div className="overflow-x-auto max-h-[40vh]">
                    <table className="min-w-[800px] w-full text-sm">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr className="text-[var(--content-muted)] text-xs">
                          <th className="px-4 py-2 text-left">✓</th>
                          <th className="px-4 py-2 text-left">Товар</th>
                          <th className="px-4 py-2 text-right">Общий спрос</th>
                          <th className="px-4 py-2 text-right">Рекомендация</th>
                          <th className="px-4 py-2 text-right">Отправить</th>
                        </tr>
                      </thead>
                      <tbody>
                        {demandPlan.consolidatedNeeds.map((item) => {
                          const isSelected = adjustedQuantities.has(item.nmId);
                          const qty = adjustedQuantities.get(item.nmId) ?? item.totalNeed;
                          return (
                            <tr
                              key={item.nmId}
                              className={cn(
                                'border-t border-[var(--table-border)] transition-colors',
                                isSelected ? 'bg-indigo-50' : 'hover:bg-slate-50'
                              )}
                            >
                              <td className="px-4 py-2">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={(e) => {
                                    const next = new Map(adjustedQuantities);
                                    if (e.target.checked) {
                                      next.set(item.nmId, item.totalNeed);
                                    } else {
                                      next.delete(item.nmId);
                                    }
                                    setAdjustedQuantities(next);
                                  }}
                                  className="h-4 w-4 rounded border-gray-300"
                                />
                              </td>
                              <td className="px-4 py-2">
                                <div className="font-medium">{item.vendorCode ?? item.nmId}</div>
                                <div className="text-xs text-[var(--content-muted)] truncate max-w-[200px]">
                                  {item.title ?? `Артикул ${item.nmId}`}
                                </div>
                              </td>
                              <td className="px-4 py-2 text-right font-mono">{formatNumber(item.totalDemand)}</td>
                              <td className="px-4 py-2 text-right font-mono text-[var(--content-muted)]">
                                {formatNumber(item.totalNeed)}
                              </td>
                              <td className="px-4 py-2 text-right">
                                {isSelected ? (
                                  <Input
                                    type="number"
                                    value={qty}
                                    onChange={(e) => {
                                      const next = new Map(adjustedQuantities);
                                      next.set(item.nmId, Math.max(0, Number(e.target.value)));
                                      setAdjustedQuantities(next);
                                    }}
                                    className="w-20 text-right"
                                    min={0}
                                  />
                                ) : (
                                  <span className="font-mono text-[var(--content-muted)]">{formatNumber(item.totalNeed)}</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>

                {/* Unmapped regions warning */}
                {demandPlan.unmappedRegions.length > 0 && (
                  <Card className="p-4 border-amber-200 bg-amber-50">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 flex-shrink-0" />
                      <div>
                        <div className="text-sm font-medium text-amber-800">
                          ⚠️ Заказы из {demandPlan.unmappedRegions.length} регионов не учтены в расчёте
                        </div>
                        <div className="text-xs text-amber-700 mt-1">
                          Для этих регионов не настроена привязка к складам. Заказы из них не попали в потребность:
                        </div>
                        <div className="flex flex-wrap gap-1 mt-2">
                          {demandPlan.unmappedRegions.slice(0, 10).map((region) => (
                            <span key={region} className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                              {region}
                              <button
                                className="ml-1 text-amber-700 hover:text-amber-900 font-bold"
                                title={`Перейти в настройки и привязать регион "${region}" к складу`}
                                onClick={() => setTab('settings')}
                              >
                                +
                              </button>
                            </span>
                          ))}
                          {demandPlan.unmappedRegions.length > 10 && (
                            <span className="text-xs text-amber-700">+{demandPlan.unmappedRegions.length - 10} ещё</span>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-2"
                          onClick={() => setTab('settings')}
                        >
                          Настроить привязку регионов к складам
                        </Button>
                      </div>
                    </div>
                  </Card>
                )}
              </>
            )}

            {!demandPlan && (
              <Card className="p-8 text-center text-[var(--content-muted)]">
                <Package className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <div>Нажмите Анализ спроса для расчёта потребности</div>
                <div className="text-xs mt-1">Анализ учитывает заказы из всех регионов</div>
              </Card>
            )}
          </div>
        )}

        {/* DRAFTS TAB */}
        {tab === 'drafts' && (
          <div className="space-y-4">
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Черновики поставок</div>
                <Button variant="neutral" onClick={loadDrafts} loading={loading}>
                  <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                  Обновить
                </Button>
              </div>
            </Card>

            {drafts.filter((d) => d.status === 'draft').length === 0 ? (
              <Card className="p-8 text-center text-[var(--content-muted)]">
                <Package className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <div>Нет черновиков</div>
                <div className="text-xs mt-1">Создайте черновик на вкладке "Планирование"</div>
              </Card>
            ) : (
              <div className="grid gap-3">
                {drafts.filter((d) => d.status === 'draft').map((draft) => (
                  <Card key={draft.draftId} className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="h-12 w-12 rounded-lg bg-slate-100 flex items-center justify-center">
                          <Package className="h-6 w-6 text-slate-500" />
                        </div>
                        <div>
                          <div className="font-medium">{draft.name}</div>
                          <div className="text-xs text-[var(--content-muted)] flex items-center gap-2">
                            <Truck className="h-3 w-3" /> {draft.warehouseName ?? '—'}
                            <span>•</span>
                            {draft.totalItems} поз. / {formatNumber(draft.totalQty)} шт / {draft.totalBoxes} кор.
                            {draft.plannedDate && (
                              <>
                                <span>•</span>
                                <Calendar className="h-3 w-3" /> {new Date(draft.plannedDate).toLocaleDateString('ru-RU')}
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="neutral">Черновик</Badge>
                        <Button variant="neutral" size="sm" onClick={() => {
                          setTab('plan');
                          // Load draft items for editing
                          if (draft.draftId) {
                            apiFetch(`/supplies/${workspaceId}/drafts/${draft.draftId}/items${shopParam ? `?shopId=${shopId}` : ''}`)
                              .then((res: any) => {
                                // Items loaded — user can edit in plan tab
                              })
                              .catch((e: any) => console.warn('Failed to load draft items:', e));
                          }
                        }}>
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button 
                          variant="neutral" 
                          size="sm" 
                          title="Скачать CSV для загрузки в WB"
                          onClick={async () => {
                            try {
                              const response = await fetch(`/api/proxy/supplies/${workspaceId}/drafts/${draft.draftId}/export${shopParam ? `?shopId=${shopId}` : ''}`, {
                                credentials: 'include',
                              });
                              const blob = await response.blob();
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `supply-${draft.draftId}.csv`;
                              a.click();
                            } catch (err) {
                              console.error('Не удалось скачать CSV');
                            }
                          }}
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                        <Button variant="neutral" size="sm" onClick={() => deleteDraft(draft.draftId)}>
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                        <Button
                          size="sm"
                          disabled={loading}
                          onClick={async () => {
                            try {
                              setLoading(true);
                              const res = await apiFetch(`/supplies/${workspaceId}/drafts/${draft.draftId}/submit-to-wb${shopParam ? `?shopId=${shopId}` : ''}`, {
                                method: 'POST',
                              });
                              if (res.ok || res.preorderID) {
                                alert(`Поставка создана в WB${res.preorderID ? ` (ID: ${res.preorderID})` : ''}`);
                                await loadDrafts();
                              } else {
                                alert(`Ошибка: ${res.error ?? 'Неизвестная ошибка'}`);
                              }
                            } catch (e) {
                              alert(`Ошибка отправки в WB: ${e instanceof Error ? e.message : 'Неизвестная ошибка'}`);
                            } finally {
                              setLoading(false);
                            }
                          }}
                        >
                          {loading ? 'Отправка...' : 'Создать в WB'} <ChevronRight className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}

        {/* SETTINGS TAB */}
        {tab === 'settings' && (
          <div className="space-y-4">
            {/* Priority warehouses */}
            <Card className="p-4">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-sm font-semibold">Приоритетные склады</div>
                  <div className="text-xs text-[var(--content-muted)]">
                    Раскройте регион → выберите приоритет склада (1 = высший, 5 = низший). Склады без приоритета не участвуют в планировании.
                  </div>
                </div>
                <Button onClick={savePriorities} loading={loading}>
                  Сохранить
                </Button>
              </div>
              <div className="space-y-2">
                {warehouseRegions.length === 0 && (
                  <div className="text-center py-8">
                    <p className="text-sm text-[var(--content-muted)]">Нет данных о складах</p>
                    <p className="text-xs text-[var(--content-muted)] mt-1">Синхронизируйте данные с WB для отображения складов</p>
                    <Button className="mt-3" variant="neutral" onClick={async () => {
                      try {
                        await apiFetch(`/supplies/${workspaceId}/warehouses/sync${shopParam ? `?shopId=${shopId}` : ''}`, { method: 'POST' });
                        const res = await apiFetch<{ regions: typeof warehouseRegions }>(`/supplies/${workspaceId}/warehouses${shopParam ? `?shopId=${shopId}` : ''}`);
                        if (res.regions) setWarehouseRegions(res.regions);
                      } catch (e: any) { alert(e?.message ?? 'Ошибка синхронизации'); }
                    }}>Синхронизировать склады</Button>
                  </div>
                )}
                {warehouseRegions.map((region) => {
                  const isExpanded = expandedRegions.has(region.regionName);
                  const priorityCount = region.warehouses.filter((w) => w.priority !== null).length;
                  return (
                    <div key={region.regionName} className="border border-[var(--table-border)] rounded-lg overflow-hidden">
                      {/* Region header */}
                      <button
                        className="w-full px-4 py-3 flex items-center justify-between bg-[var(--surface-secondary)] hover:bg-[var(--surface-tertiary)] transition-colors"
                        onClick={() => {
                          setExpandedRegions((prev) => {
                            const next = new Set(prev);
                            if (next.has(region.regionName)) {
                              next.delete(region.regionName);
                            } else {
                              next.add(region.regionName);
                            }
                            return next;
                          });
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{region.regionName}</span>
                          <span className="text-xs text-[var(--content-muted)]">
                            ({region.warehouses.length} {region.warehouses.length === 1 ? 'склад' : 'складов'})
                          </span>
                          {priorityCount > 0 && (
                            <span className="text-xs bg-[var(--accent)] text-white px-2 py-0.5 rounded-full">
                              {priorityCount} выбрано
                            </span>
                          )}
                        </div>
                        <svg
                          className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      {/* Expanded warehouses */}
                      {isExpanded && (
                        <div className="divide-y divide-[var(--table-border)]">
                          {region.warehouses.map((wh) => (
                            <div
                              key={wh.warehouseId}
                              className="px-4 py-2 flex items-center justify-between hover:bg-[var(--surface-secondary)] transition-colors"
                            >
                              <div className="flex-1 min-w-0 mr-4">
                                <div className="text-sm font-medium">{wh.warehouseName}</div>
                                {wh.address && (
                                  <div className="text-xs text-[var(--content-muted)] truncate max-w-md">
                                    {wh.address}
                                  </div>
                                )}
                              </div>
                              {/* Acceptance coefficient */}
                              {wh.acceptanceCoefficient !== undefined && (
                                <div className="text-right mr-4 min-w-[80px]">
                                  <div className={cn(
                                    'text-sm font-medium tabular-nums',
                                    wh.acceptanceCoefficient < 2 ? 'text-green-700' :
                                    wh.acceptanceCoefficient < 5 ? 'text-yellow-700' : 'text-red-600'
                                  )}>
                                    x{wh.acceptanceCoefficient}
                                  </div>
                                  <div className="text-[10px] text-[var(--content-muted)]">коэфф.</div>
                                </div>
                              )}
                              {/* Current stock */}
                              {wh.currentStock !== undefined && wh.currentStock > 0 && (
                                <div className="text-right mr-4 min-w-[80px]">
                                  <div className="text-sm font-medium tabular-nums">{formatNumber(wh.currentStock)} шт</div>
                                  <div className="text-[10px] text-[var(--content-muted)]">остаток</div>
                                </div>
                              )}
                              {/* Sales stats (14 days) */}
                              <div className="text-right mr-4 min-w-[100px]">
                                {wh.salesCount14d !== undefined && wh.salesCount14d > 0 ? (
                                  <>
                                    <div className="text-sm font-medium tabular-nums">{formatNumber(wh.salesCount14d)} шт</div>
                                    <div className="text-xs text-[var(--content-muted)]">продаж за 14д</div>
                                  </>
                                ) : (
                                  <div className="text-xs text-[var(--content-muted)]">нет продаж</div>
                                )}
                              </div>
                              <Select
                                value={wh.priority !== null ? String(wh.priority) : '__none__'}
                                onValueChange={(v) => {
                                  setWarehouseRegions((prev) =>
                                    prev.map((r) =>
                                      r.regionName === region.regionName
                                        ? {
                                            ...r,
                                            warehouses: r.warehouses.map((w) =>
                                              w.warehouseId === wh.warehouseId
                                                ? { ...w, priority: v && v !== '__none__' ? Number(v) : null }
                                                : w
                                            ),
                                          }
                                        : r
                                    )
                                  );
                                }}
                              >
                                <SelectTrigger className="w-28">
                                  <SelectValue placeholder="—" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none__">—</SelectItem>
                                  <SelectItem value="1">⭐ 1</SelectItem>
                                  <SelectItem value="2">🥈 2</SelectItem>
                                  <SelectItem value="3">🥉 3</SelectItem>
                                  <SelectItem value="4">4</SelectItem>
                                  <SelectItem value="5">5</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* Transit tariffs */}
            <Card className="p-4">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-sm font-semibold">Транзитные направления</div>
                  <div className="text-xs text-[var(--content-muted)]">
                    Тарифы на перевозку товаров между складами WB
                  </div>
                </div>
                <Button variant="neutral" size="sm" onClick={loadTransitTariffs} loading={transitLoading}>
                  <RefreshCw className="h-4 w-4 mr-1" />
                  Загрузить
                </Button>
              </div>
              {transitTariffs.length > 0 && (
                <div className="overflow-x-auto max-h-[300px]">
                  <table className="min-w-[700px] w-full text-sm">
                    <thead className="sticky top-0 bg-white">
                      <tr className="border-b text-left text-[var(--content-muted)] text-xs">
                        <th className="py-2 px-3">Транзитный склад</th>
                        <th className="py-2 px-3">Склад назначения</th>
                        <th className="py-2 px-3 text-right">Паллета, ₽</th>
                        <th className="py-2 px-3 text-right">Короб, ₽/л</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transitTariffs.slice(0, 50).map((t, i) => (
                        <tr key={i} className="border-b hover:bg-slate-50">
                          <td className="py-2 px-3">{t.transitWarehouseName}</td>
                          <td className="py-2 px-3">{t.destinationWarehouseName}</td>
                          <td className="py-2 px-3 text-right tabular-nums">{formatNumber(t.palletTariff)}</td>
                          <td className="py-2 px-3 text-right tabular-nums">
                            {t.boxTariff?.[0]?.value ? formatNumber(t.boxTariff[0].value) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {transitTariffs.length > 50 && (
                    <div className="text-xs text-center py-2 text-[var(--content-muted)]">
                      Показано 50 из {transitTariffs.length}
                    </div>
                  )}
                </div>
              )}
            </Card>

            {/* Box settings */}
            <Card className="p-4">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-sm font-semibold">Настройки коробок</div>
                  <div className="text-xs text-[var(--content-muted)]">
                    Сколько товаров помещается в одну коробку
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm">По умолчанию:</span>
                <Input
                  type="number"
                  value={boxSettings.defaultItemsPerBox}
                  onChange={(e) => setBoxSettings((prev) => ({ ...prev, defaultItemsPerBox: Number(e.target.value) || 1 }))}
                  onBlur={(e) => saveBoxSettings(Number(e.target.value) || 1)}
                  className="w-24"
                  min={1}
                  max={1000}
                />
                <span className="text-sm text-[var(--content-muted)]">шт в коробке</span>
              </div>
            </Card>

            {/* Drivers */}
            <Card className="p-4">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-sm font-semibold">Водители</div>
                  <div className="text-xs text-[var(--content-muted)]">
                    Сохранённые данные для пропусков
                  </div>
                </div>
                <Button variant="neutral" size="sm" onClick={() => setShowDriverForm(!showDriverForm)}>
                  <Plus className="h-4 w-4" />
                  Добавить
                </Button>
              </div>
              {showDriverForm && (
                <div className="grid grid-cols-2 gap-2 mb-4 p-3 bg-slate-50 rounded-lg">
                  <Input placeholder="Имя" value={newDriver.firstName} onChange={(e) => setNewDriver({ ...newDriver, firstName: e.target.value })} />
                  <Input placeholder="Фамилия" value={newDriver.lastName} onChange={(e) => setNewDriver({ ...newDriver, lastName: e.target.value })} />
                  <Input placeholder="Модель авто" value={newDriver.carModel} onChange={(e) => setNewDriver({ ...newDriver, carModel: e.target.value })} />
                  <Input placeholder="Гос. номер" value={newDriver.carNumber} onChange={(e) => setNewDriver({ ...newDriver, carNumber: e.target.value })} />
                  <Button size="sm" className="col-span-2" disabled={!newDriver.firstName || !newDriver.lastName || !newDriver.carNumber} onClick={async () => {
                    try {
                      const res = await apiFetch(`/supplies/${workspaceId}/drivers`, {
                        method: 'POST',
                        body: JSON.stringify({ ...newDriver, ...(shopId ? { shopId } : {}) }),
                      });
                      setDrivers((prev) => [...prev, (res as any).driver]);
                      setNewDriver({ firstName: '', lastName: '', carModel: '', carNumber: '' });
                      setShowDriverForm(false);
                    } catch (e: any) {
                      alert(`Ошибка: ${e?.message ?? 'Не удалось добавить водителя'}`);
                    }
                  }}>Сохранить</Button>
                </div>
              )}
              {drivers.length === 0 ? (
                <div className="text-sm text-[var(--content-muted)] text-center py-4">
                  Нет сохранённых водителей
                </div>
              ) : (
                <div className="space-y-2">
                  {drivers.map((d) => (
                    <div key={d.driverId} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
                      <div className="flex items-center gap-3">
                        <User className="h-5 w-5 text-slate-400" />
                        <div>
                          <div className="font-medium text-sm">
                            {d.lastName} {d.firstName}
                            {d.isDefault && <Badge variant="info" className="ml-2">По умолчанию</Badge>}
                          </div>
                          <div className="text-xs text-[var(--content-muted)]">
                            {d.carModel} • {d.carNumber}
                          </div>
                        </div>
                      </div>
                      <Button variant="neutral" size="sm" onClick={async () => {
                        if (!confirm(`Удалить водителя ${d.lastName} ${d.firstName}?`)) return;
                        try {
                          await apiFetch(`/supplies/${workspaceId}/drivers/${d.driverId}${shopParam ? `?shopId=${shopId}` : ''}`, { method: 'DELETE' });
                          setDrivers((prev) => prev.filter((dr) => dr.driverId !== d.driverId));
                        } catch (e) { console.error('Failed to delete driver:', e); }
                      }}>
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        {/* Active & History tabs */}
        {(tab === 'active' || tab === 'history') && (
          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-semibold">{tab === 'active' ? 'Активные поставки' : 'История поставок'}</div>
              <Button variant="neutral" size="sm" onClick={syncFromWb} loading={historyLoading}>
                <RefreshCw className="h-4 w-4 mr-1" />
                Синхронизировать с WB
              </Button>
            </div>
            
            {historyLoading ? (
              <div className="text-center py-8 text-[var(--content-muted)]">Загрузка...</div>
            ) : wbSupplies.length === 0 ? (
              <div className="text-center py-8 text-[var(--content-muted)]">
                <Truck className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <div>Нет поставок</div>
                <div className="text-xs mt-1">Нажмите «Синхронизировать» для загрузки данных из WB</div>
              </div>
            ) : (
              <div className="overflow-auto">
                <table className="min-w-[700px] w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-[var(--content-muted)]">
                      <th className="py-2 px-3">ID</th>
                      <th className="py-2 px-3">Склад</th>
                      <th className="py-2 px-3">Статус</th>
                      <th className="py-2 px-3 text-right">Кол-во</th>
                      <th className="py-2 px-3 text-right">Принято</th>
                      <th className="py-2 px-3">Дата плановая</th>
                      <th className="py-2 px-3">Дата факт</th>
                      <th className="py-2 px-3 text-right">Документы</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wbSupplies
                      .filter(s => tab === 'active' ? [1,2,3,4].includes(s.statusId) : s.statusId === 5)
                      .map((supply) => {
                        const statusName = {
                          1: 'Не запланировано',
                          2: 'Запланировано',
                          3: 'Отгрузка разрешена',
                          4: 'Идёт приёмка',
                          5: 'Принято',
                          6: 'Отгружено',
                        }[supply.statusId] ?? `Статус ${supply.statusId}`;
                        const statusColor = {
                          1: 'bg-gray-100 text-gray-700',
                          2: 'bg-blue-100 text-blue-700',
                          3: 'bg-indigo-100 text-indigo-700',
                          4: 'bg-amber-100 text-amber-700',
                          5: 'bg-green-100 text-green-700',
                          6: 'bg-purple-100 text-purple-700',
                        }[supply.statusId] ?? 'bg-gray-100 text-gray-700';
                        
                        const isExpanded = expandedSupplyId === supply.id;
                        return (
                          <React.Fragment key={supply.id}>
                            <tr 
                              className="border-b hover:bg-slate-50 cursor-pointer"
                              onClick={() => {
                                if (isExpanded) {
                                  setExpandedSupplyId(null);
                                } else {
                                  loadSupplyGoods(supply.id, supply.wbSupplyId, supply.wbPreorderId);
                                }
                              }}
                            >
                              <td className="py-2 px-3 font-mono text-xs">
                                <div className="flex items-center gap-1">
                                  <ChevronRight className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')} />
                                  {supply.wbSupplyId ?? supply.wbPreorderId ?? supply.id}
                                </div>
                              </td>
                              <td className="py-2 px-3">{supply.warehouseName ?? '—'}</td>
                              <td className="py-2 px-3">
                                <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', statusColor)}>
                                  {statusName}
                                </span>
                              </td>
                              <td className="py-2 px-3 text-right tabular-nums">{formatNumber(supply.quantity)}</td>
                              <td className="py-2 px-3 text-right tabular-nums">{supply.acceptedQuantity ?? '—'}</td>
                              <td className="py-2 px-3 text-xs">{supply.supplyDate ?? '—'}</td>
                              <td className="py-2 px-3 text-xs">{supply.factDate ? new Date(supply.factDate).toLocaleDateString('ru-RU') : '—'}</td>
                              <td className="py-2 px-3 text-right" onClick={(e) => e.stopPropagation()}>
                                <SupplySlipDownload workspaceId={workspaceId!} supplyRowId={supply.id} />
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="bg-slate-50">
                                <td colSpan={8} className="p-3">
                                  <div className="text-xs font-medium mb-2">Товары в поставке:</div>
                                  {supplyGoods.length === 0 ? (
                                    <div className="text-xs text-[var(--content-muted)]">Загрузка...</div>
                                  ) : (
                                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 text-xs">
                                      {supplyGoods.slice(0, 12).map((g, i) => (
                                        <div key={i} className="flex items-center justify-between bg-white p-2 rounded border">
                                          <span className="truncate">{g.vendorCode ?? g.barcode}</span>
                                          <span className="tabular-nums font-medium ml-2">
                                            {g.acceptedQuantity ?? g.quantity} шт
                                          </span>
                                        </div>
                                      ))}
                                      {supplyGoods.length > 12 && (
                                        <div className="text-[var(--content-muted)] p-2">
                                          +{supplyGoods.length - 12} ещё
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>

      {/* Supply Wizard Modal */}
      {showWizard && workspaceId && (
        <SupplyWizard
          workspaceId={workspaceId}
          onClose={() => setShowWizard(false)}
          onSuccess={() => {
            setShowWizard(false);
            loadDrafts();
            setTab('drafts');
          }}
        />
      )}
    </AppShell>
  );
}
