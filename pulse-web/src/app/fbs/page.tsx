'use client';

import { useShopChange } from '@/hooks/useShopChange';

import { useWorkspaceStore } from '@/store/workspace';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/ToggleGroup';
import { Switch } from '@/components/ui/Switch';
import { Badge } from '@/components/ui/Badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { RefreshCw, Play, Trash2, Plus, Package, Calendar, Download, Printer, CheckCircle, XCircle, Key } from 'lucide-react';
import { PassesTab } from '@/components/fbs/PassesTab';

interface Shop {
  shopId: number;
  platform: string;
  name: string;
  isActive: boolean;
}

interface ScheduleRow {
  scheduleId: number;
  workspaceId: number;
  shopId: number | null;
  daysOfWeek: number[];
  sendTime: string;
  timezone: string;
  telegramChatId?: string | null;
  telegramEnabled?: boolean;
  isActive: boolean;
  lastRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
  shopName?: string | null;
  platform?: string | null;
}

interface RunRow {
  runId: string;
  scheduleId: number | null;
  shopId: number | null;
  status: string;
  errorText?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
}

interface DocRow {
  docId: number;
  runId: string;
  fileName?: string | null;
  mime?: string | null;
  sizeBytes?: number | null;
  downloadUrl?: string | null;
}

interface WbOrder {
  id: number;
  createdAt: string;
  nmId: number;
  article: string;
  skus: string[];
  price: number;
  deliveryType: string;
  warehouseId: number;
}

const DAY_LABELS: Record<number, string> = { 1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт', 6: 'Сб', 7: 'Вс' };

function formatDays(days: number[]): string {
  const sorted = [...days].sort();
  if (sorted.length === 7) return 'Ежедневно';
  if (sorted.join(',') === '1,2,3,4,5') return 'Будни';
  if (sorted.join(',') === '6,7') return 'Выходные';
  return sorted.map((d) => DAY_LABELS[d] || String(d)).join(', ');
}

function platformLabel(p?: string | null) {
  if (!p) return '—';
  if (p === 'wb') return 'WB';
  if (p === 'ozon') return 'Ozon';
  if (p === 'yandex_market') return 'ЯМ';
  return p;
}

function statusVariant(status: string) {
  if (status === 'success') return 'success';
  if (status === 'running') return 'info';
  if (status === 'queued') return 'warning';
  return 'danger';
}

function formatPrice(kopecks: number): string {
  return (kopecks / 100).toLocaleString('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
}

export default function FbsPage() {
  const storeWorkspaceId = useWorkspaceStore((s) => s.workspaceId);
  const workspaceId = storeWorkspaceId ?? 0;

  const [activeTab, setActiveTab] = useState<'orders' | 'schedules' | 'history'>('orders');

  // Shops
  const [shops, setShops] = useState<Shop[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Schedules
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [docsByRun, setDocsByRun] = useState<Record<string, DocRow[]>>({});
  const [docsLoading, setDocsLoading] = useState<Record<string, boolean>>({});

  const [shopPick, setShopPick] = useState<string>('all');
  const [daysPick, setDaysPick] = useState<string[]>(['1', '2', '3', '4', '5']);
  const [sendTime, setSendTime] = useState('09:00');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [runShopPick, setRunShopPick] = useState<string>('all');

  // Orders (WB)
  const [orders, setOrders] = useState<WbOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [selectedOrders, setSelectedOrders] = useState<Set<number>>(new Set());
  const [stickersLoading, setStickersLoading] = useState(false);

  const loadShops = useCallback(async () => {
    if (!workspaceId || workspaceId <= 0) return;
    try {
      const res = await apiFetch(`/shops/${workspaceId}?platform=all`);
      setShops(res.rows ?? []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, [workspaceId]);

  const loadSchedulesAndRuns = useCallback(async () => {
    if (!workspaceId || workspaceId <= 0) return;
    setLoading(true);
    setError(null);
    try {
      const [schedulesRes, runsRes] = await Promise.all([
        apiFetch(`/fbs/${workspaceId}/schedules`),
        apiFetch(`/fbs/${workspaceId}/runs`),
      ]);
      setSchedules(schedulesRes.rows ?? []);
      setRuns(runsRes.rows ?? []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const loadOrders = useCallback(async () => {
    if (!workspaceId || workspaceId <= 0) return;
    setOrdersLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/fbs/${workspaceId}/orders/new`);
      setOrders(res.orders ?? []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setOrdersLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadShops();
  }, [loadShops]);
  useShopChange(loadShops);

  useEffect(() => {
    if (activeTab === 'orders') {
      loadOrders();
    } else if (activeTab === 'schedules' || activeTab === 'history') {
      loadSchedulesAndRuns();
    }
  }, [activeTab, loadOrders, loadSchedulesAndRuns]);

  const activeShops = useMemo(() => shops.filter((s) => s.isActive), [shops]);
  const wbShops = useMemo(() => activeShops.filter((s) => s.platform === 'wb'), [activeShops]);

  // Schedule actions
  async function createSchedule() {
    setError(null);
    try {
      const days = daysPick.map((d) => Number(d)).filter(Boolean);
      if (!days.length) {
        setError('Выберите хотя бы один день');
        return;
      }
      if (!sendTime) {
        setError('Укажите время отправки');
        return;
      }
      await apiFetch(`/fbs/${workspaceId}/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopId: shopPick === 'all' ? undefined : Number(shopPick),
          daysOfWeek: days,
          sendTime,
          telegramChatId: telegramChatId.trim() || undefined,
          telegramEnabled,
        }),
      });
      await loadSchedulesAndRuns();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  async function toggleSchedule(id: number, isActive: boolean) {
    try {
      await apiFetch(`/fbs/${workspaceId}/schedules/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !isActive }),
      });
      setSchedules((prev) => prev.map((s) => (s.scheduleId === id ? { ...s, isActive: !isActive } : s)));
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  async function deleteSchedule(id: number) {
    try {
      await apiFetch(`/fbs/${workspaceId}/schedules/${id}`, { method: 'DELETE' });
      setSchedules((prev) => prev.filter((s) => s.scheduleId !== id));
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  async function runNow(shopId?: number, scheduleId?: number) {
    try {
      await apiFetch(`/fbs/${workspaceId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId, scheduleId, telegramChatId: telegramChatId.trim() || undefined }),
      });
      await loadSchedulesAndRuns();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  async function loadDocs(runId: string) {
    if (docsByRun[runId]) return;
    setDocsLoading((prev) => ({ ...prev, [runId]: true }));
    try {
      const res = await apiFetch(`/fbs/${workspaceId}/runs/${runId}/documents`);
      setDocsByRun((prev) => ({ ...prev, [runId]: res.rows ?? [] }));
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setDocsLoading((prev) => ({ ...prev, [runId]: false }));
    }
  }

  // Order actions
  function toggleOrderSelection(orderId: number) {
    setSelectedOrders((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) {
        next.delete(orderId);
      } else {
        next.add(orderId);
      }
      return next;
    });
  }

  function selectAllOrders() {
    if (selectedOrders.size === orders.length) {
      setSelectedOrders(new Set());
    } else {
      setSelectedOrders(new Set(orders.map((o) => o.id)));
    }
  }

  async function downloadStickers() {
    if (selectedOrders.size === 0) return;
    setStickersLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/fbs/${workspaceId}/orders/stickers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderIds: Array.from(selectedOrders),
          type: 'pdf',
        }),
      });

      // Download stickers as PDF
      for (const sticker of res.stickers ?? []) {
        const blob = new Blob([Uint8Array.from(atob(sticker.file), (c) => c.charCodeAt(0))], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sticker-${sticker.orderId}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setStickersLoading(false);
    }
  }

  async function confirmSelectedOrders() {
    if (selectedOrders.size === 0) return;
    setError(null);
    const errors: string[] = [];

    for (const orderId of selectedOrders) {
      try {
        await apiFetch(`/fbs/${workspaceId}/orders/${orderId}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
      } catch (e: any) {
        errors.push(`Заказ ${orderId}: ${e?.message ?? e}`);
      }
    }

    if (errors.length > 0) {
      setError(errors.join('; '));
    }

    setSelectedOrders(new Set());
    await loadOrders();
  }

  if (!workspaceId || workspaceId <= 0) {
    return (
      <AppShell title="FBS‑отгрузки">
        <div className="flex min-h-[300px] items-center justify-center p-6">
          <div className="text-sm text-[var(--content-muted)]">Выберите магазин для работы с FBS-отгрузками</div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="FBS‑отгрузки">
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="text-sm text-[var(--content-muted)]">Управление FBS-заказами, расписаниями и документами.</div>
          <Button variant="neutral" onClick={() => (activeTab === 'orders' ? loadOrders() : loadSchedulesAndRuns())} disabled={loading || ordersLoading}>
            <RefreshCw className={cn('mr-2 h-4 w-4', (loading || ordersLoading) && 'animate-spin')} />
            Обновить
          </Button>
        </div>

        {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
          <TabsList>
            <TabsTrigger value="orders">
              <Package className="mr-2 h-4 w-4" />
              Заказы WB
              {orders.length > 0 && (
                <Badge variant="info" className="ml-2">{orders.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="schedules">
              <Calendar className="mr-2 h-4 w-4" />
              Расписания
            </TabsTrigger>
            <TabsTrigger value="history">
              История
            </TabsTrigger>
            <TabsTrigger value="passes">
              Пропуска
            </TabsTrigger>
            <TabsTrigger value="shops">
              Магазины
            </TabsTrigger>
          </TabsList>

          {/* Orders Tab */}
          <TabsContent value="orders" className="mt-6 space-y-4">
            {wbShops.length === 0 ? (
              <Card>
                <div className="p-8 text-center">
                  <Package className="mx-auto h-12 w-12 text-slate-300" />
                  <div className="mt-3 text-sm font-medium text-[var(--content-text)]">Нет подключённых магазинов WB</div>
                  <div className="mt-1 text-xs text-[var(--content-muted)]">Добавьте магазин Wildberries в разделе «Магазины»</div>
                  <Button className="mt-4" onClick={() => window.location.href = '/shops'}>
                    <Plus className="mr-2 h-4 w-4" />
                    Подключить магазин
                  </Button>
                </div>
              </Card>
            ) : orders.length === 0 ? (
              <Card>
                <div className="p-8 text-center">
                  <CheckCircle className="mx-auto h-12 w-12 text-emerald-400" />
                  <div className="mt-3 text-sm font-medium text-[var(--content-text)]">Новых заказов нет</div>
                  <div className="mt-1 text-xs text-[var(--content-muted)]">Все заказы собраны или ожидают поступления</div>
                </div>
              </Card>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Button variant="neutral" size="sm" onClick={selectAllOrders}>
                      {selectedOrders.size === orders.length ? 'Снять выделение' : 'Выбрать все'}
                    </Button>
                    {selectedOrders.size > 0 && (
                      <span className="text-sm text-[var(--content-muted)]">
                        Выбрано: {selectedOrders.size}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="neutral"
                      size="sm"
                      onClick={downloadStickers}
                      disabled={selectedOrders.size === 0 || stickersLoading}
                      loading={stickersLoading}
                    >
                      <Printer className="mr-2 h-4 w-4" />
                      Печать этикеток
                    </Button>
                    <Button
                      size="sm"
                      onClick={confirmSelectedOrders}
                      disabled={selectedOrders.size === 0}
                    >
                      <CheckCircle className="mr-2 h-4 w-4" />
                      Подтвердить сборку
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  {orders.map((order) => (
                    <Card
                      key={order.id}
                      className={cn(
                        'cursor-pointer transition-colors',
                        selectedOrders.has(order.id) && 'ring-2 ring-indigo-500 bg-indigo-50/50'
                      )}
                      onClick={() => toggleOrderSelection(order.id)}
                    >
                      <div className="flex items-center gap-4 p-4">
                        <input
                          type="checkbox"
                          checked={selectedOrders.has(order.id)}
                          onChange={() => toggleOrderSelection(order.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-[var(--content-text)]">
                              #{order.id}
                            </span>
                            <Badge variant="info" size="sm">{order.deliveryType.toUpperCase()}</Badge>
                          </div>
                          <div className="mt-1 text-xs text-[var(--content-muted)]">
                            Артикул: {order.article} · nmId: {order.nmId} · ШК: {order.skus.join(', ')}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-medium text-[var(--content-text)]">
                            {formatPrice(order.price)}
                          </div>
                          <div className="text-xs text-[var(--content-muted)]">
                            {new Date(order.createdAt).toLocaleString('ru-RU')}
                          </div>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              </>
            )}
          </TabsContent>

          {/* Schedules Tab */}
          <TabsContent value="schedules" className="mt-6 space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card>
                <div className="p-5 space-y-4">
                  <div className="text-sm font-semibold text-[var(--content-text)]">Новое расписание</div>

                  <div>
                    <div className="text-xs font-medium text-[var(--content-muted)] mb-1.5">Магазин</div>
                    <Select value={shopPick} onValueChange={setShopPick}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Все магазины</SelectItem>
                        {activeShops.map((s) => (
                          <SelectItem key={s.shopId} value={String(s.shopId)}>
                            {platformLabel(s.platform)} · {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <div className="text-xs font-medium text-[var(--content-muted)] mb-1.5">Время отправки</div>
                    <Input type="time" value={sendTime} onChange={(e) => setSendTime(e.target.value)} />
                  </div>

                  <div>
                    <div className="text-xs font-medium text-[var(--content-muted)] mb-1.5">Telegram для документов</div>
                    <Input placeholder="chat_id (например 123456789)" value={telegramChatId} onChange={(e) => setTelegramChatId(e.target.value)} />
                    <div className="mt-2">
                      <Switch label="Отправлять документы" checked={telegramEnabled} onCheckedChange={setTelegramEnabled} />
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-medium text-[var(--content-muted)] mb-1.5">Дни недели</div>
                    <ToggleGroup type="multiple" value={daysPick} onValueChange={setDaysPick}>
                      {Object.entries(DAY_LABELS).map(([day, label]) => (
                        <ToggleGroupItem key={day} value={day}>{label}</ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    <div className="mt-2 flex gap-2">
                      <Button variant="neutral" size="sm" onClick={() => setDaysPick(['1','2','3','4','5'])}>Будни</Button>
                      <Button variant="neutral" size="sm" onClick={() => setDaysPick(['6','7'])}>Выходные</Button>
                      <Button variant="neutral" size="sm" onClick={() => setDaysPick(['1','2','3','4','5','6','7'])}>Ежедневно</Button>
                    </div>
                  </div>

                  <Button onClick={createSchedule}>
                    <Plus className="mr-2 h-4 w-4" />
                    Добавить расписание
                  </Button>
                </div>
              </Card>

              <Card>
                <div className="p-5 space-y-4">
                  <div className="text-sm font-semibold text-[var(--content-text)]">Ручной запуск</div>

                  <div>
                    <div className="text-xs font-medium text-[var(--content-muted)] mb-1.5">Магазин</div>
                    <Select value={runShopPick} onValueChange={setRunShopPick}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Все магазины</SelectItem>
                        {activeShops.map((s) => (
                          <SelectItem key={s.shopId} value={String(s.shopId)}>
                            {platformLabel(s.platform)} · {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <div className="text-xs font-medium text-[var(--content-muted)] mb-1.5">Telegram (разовый запуск)</div>
                    <Input placeholder="chat_id (если нужно отправить документы)" value={telegramChatId} onChange={(e) => setTelegramChatId(e.target.value)} />
                  </div>

                  <Button onClick={() => runNow(runShopPick === 'all' ? undefined : Number(runShopPick))}>
                    <Play className="mr-2 h-4 w-4" />
                    Запустить сейчас
                  </Button>
                </div>
              </Card>
            </div>

            <Card>
              <div className="p-5 space-y-4">
                <div className="text-sm font-semibold text-[var(--content-text)]">Активные расписания</div>
                {schedules.length === 0 ? (
                  <div className="text-sm text-[var(--content-muted)]">Расписаний пока нет.</div>
                ) : (
                  <div className="space-y-3">
                    {schedules.map((s) => (
                      <div key={s.scheduleId} className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--card-border)] px-3 py-2">
                        <div>
                          <div className="text-sm font-medium text-[var(--content-text)]">
                            {s.sendTime} · {formatDays(s.daysOfWeek || [])}
                          </div>
                          <div className="text-xs text-[var(--content-muted)]">
                            {s.shopName ? `${platformLabel(s.platform)} · ${s.shopName}` : 'Все магазины'}
                            {s.telegramEnabled ? ` · TG: ${s.telegramChatId || '—'}` : ''}
                            {s.lastRunAt ? ` · последний запуск ${new Date(s.lastRunAt).toLocaleString('ru-RU')}` : ''}
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <Switch checked={s.isActive} onCheckedChange={() => toggleSchedule(s.scheduleId, s.isActive)} label={s.isActive ? 'Активно' : 'Пауза'} />
                          <Button variant="neutral" size="sm" onClick={() => runNow(undefined, s.scheduleId)}>
                            <Play className="mr-2 h-4 w-4" />
                            Запустить
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => deleteSchedule(s.scheduleId)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </TabsContent>

          {/* History Tab */}
          <TabsContent value="history" className="mt-6">
            <Card>
              <div className="p-5 space-y-4">
                <div className="text-sm font-semibold text-[var(--content-text)]">История запусков</div>
                {runs.length === 0 ? (
                  <div className="text-sm text-[var(--content-muted)]">Запусков пока нет.</div>
                ) : (
                  <div className="space-y-2">
                    {runs.map((r) => (
                      <div key={r.runId} className="rounded-[var(--radius-md)] border border-[var(--card-border)] px-3 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium text-[var(--content-text)]">{r.runId.slice(0, 8)}</div>
                            <div className="text-xs text-[var(--content-muted)]">
                              {new Date(r.createdAt).toLocaleString('ru-RU')} {r.errorText ? `· ${r.errorText}` : ''}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button variant="neutral" size="sm" onClick={() => loadDocs(r.runId)} loading={docsLoading[r.runId]}>
                              <Download className="mr-2 h-4 w-4" />
                              Документы
                            </Button>
                            <Badge variant={statusVariant(r.status) as any}>{r.status}</Badge>
                          </div>
                        </div>

                        {docsByRun[r.runId] && (
                          <div className="mt-3 border-t border-[var(--card-border)] pt-3 space-y-2">
                            {docsByRun[r.runId].length === 0 ? (
                              <div className="text-xs text-[var(--content-muted)]">Документы не найдены.</div>
                            ) : (
                              docsByRun[r.runId].map((d) => (
                                <div key={d.docId} className="flex items-center justify-between gap-3">
                                  <div className="text-xs text-[var(--content-muted)]">
                                    {d.fileName || `Документ ${d.docId}`}
                                  </div>
                                  <a
                                    href={`/api/proxy${d.downloadUrl}`}
                                    className="text-xs text-indigo-600 hover:underline"
                                  >
                                    Скачать
                                  </a>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </TabsContent>

          {/* Passes Tab */}
          <TabsContent value="passes" className="mt-6">
            <PassesTab workspaceId={workspaceId} />
          </TabsContent>

          {/* Shops / Marketplaces Tab */}
          <TabsContent value="shops" className="mt-6 space-y-4">
            <Card className="p-5">
              <h3 className="font-semibold mb-3">Подключённые магазины</h3>
              {wbShops.length === 0 ? (
                <div className="text-sm text-[var(--content-muted)]">Нет подключённых магазинов</div>
              ) : (
                <div className="space-y-3">
                  {wbShops.map((shop: any) => (
                    <div key={shop.shopId ?? shop.id} className="flex items-center justify-between p-3 rounded-lg border border-[var(--card-border)]">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400 font-bold text-sm">
                          WB
                        </div>
                        <div>
                          <div className="font-medium text-sm">{shop.name || `Магазин #${shop.shopId ?? shop.id}`}</div>
                          <div className="text-xs text-[var(--content-muted)]">
                            Wildberries • {shop.deliveryType === 'fbs' ? 'FBS' : shop.deliveryType === 'dbs' ? 'DBS' : 'FBO+FBS'}
                          </div>
                        </div>
                      </div>
                      <Badge variant={shop.isActive !== false ? 'success' : 'neutral'}>
                        {shop.isActive !== false ? 'Активен' : 'Отключён'}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-4 pt-4 border-t border-[var(--card-border)]">
                <h4 className="text-sm font-medium mb-2">Добавить маркетплейс</h4>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Button variant="outline" className="justify-start" onClick={() => window.location.href = '/shops'}>
                    <span className="font-bold text-indigo-400 mr-2">WB</span> Wildberries
                  </Button>
                </div>
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}
