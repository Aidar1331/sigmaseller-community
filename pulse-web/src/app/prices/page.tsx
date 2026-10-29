'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useWorkspaceStore } from '@/store/workspace';
import { apiFetch } from '@/lib/api';
import { useShopChange } from '@/hooks/useShopChange';
import { useActiveShop } from '@/hooks/useShopParam';
import { formatNumber, formatRub } from '@/lib/format';
import { cn } from '@/lib/cn';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/ToggleGroup';
import { RefreshCw, Tag, AlertTriangle, TrendingUp, TrendingDown, History, Percent, ShieldAlert } from 'lucide-react';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';

type GoodsItem = {
  nmID: number;
  vendorCode?: string;
  currencyIsoCode4217?: string;
  discount?: number;
  editableSizePrice?: boolean;
  sizes?: Array<{
    sizeID?: number;
    price?: number;
    discountedPrice?: number;
    techSizeName?: string;
  }>;
};

type QuarantineItem = {
  nmID: number;
  reason?: string;
  dateMove?: string;
};

type PriceHistoryItem = {
  nmID: number;
  dt: string;
  price?: number;
  discount?: number;
};

type TabType = 'goods' | 'quarantine' | 'history';

export default function PricesPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const setWorkspaceId = useWorkspaceStore((s) => s.setWorkspaceId);
  const { shopId } = useActiveShop();

  const [activeTab, setActiveTab] = useState<TabType>('goods');
  const [goods, setGoods] = useState<GoodsItem[]>([]);
  const [quarantine, setQuarantine] = useState<QuarantineItem[]>([]);
  const [priceHistory, setPriceHistory] = useState<PriceHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchNmId, setSearchNmId] = useState('');
  const [historyNmId, setHistoryNmId] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkDiscount, setBulkDiscount] = useState('');
  const [bulkApplying, setBulkApplying] = useState(false);

  const toggleSelect = (nmId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nmId)) next.delete(nmId);
      else next.add(nmId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === goods.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(goods.map((g) => g.nmID)));
    }
  };

  // Pagination
  const [offset, setOffset] = useState(0);
  const limit = 100;

  const fetchGoods = async () => {
    if (!workspaceId || workspaceId <= 0) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (searchNmId) params.set('filterNmID', searchNmId);
      if (shopId) params.set('shopId', String(shopId));
      const res = await apiFetch(`/prices/${workspaceId}/goods?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Ошибка загрузки');
      setGoods(json.data?.data?.listGoods || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchQuarantine = async () => {
    if (!workspaceId || workspaceId <= 0) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (shopId) params.set('shopId', String(shopId));
      const res = await apiFetch(`/prices/${workspaceId}/quarantine?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Ошибка загрузки');
      setQuarantine(json.data?.data?.quarantineGoods || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchPriceHistory = async () => {
    if (!workspaceId || !historyNmId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ nmID: historyNmId, limit: '50' });
      if (shopId) params.set('shopId', String(shopId));
      const res = await apiFetch(`/prices/${workspaceId}/history/price?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Ошибка загрузки');
      setPriceHistory(json.data?.data?.history || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const reloadCurrentTab = useCallback(() => {
    if (activeTab === 'goods') fetchGoods();
    else if (activeTab === 'quarantine') fetchQuarantine();
  }, [activeTab, shopId]);

  useEffect(() => {
    reloadCurrentTab();
  }, [workspaceId, activeTab, offset, shopId]);

  useShopChange(reloadCurrentTab);

  useEffect(() => {
    if (activeTab === 'history' && historyNmId) fetchPriceHistory();
  }, [historyNmId]);

  const handleSearch = () => {
    setOffset(0);
    if (activeTab === 'goods') fetchGoods();
  };

  const handleHistorySearch = () => {
    if (historyNmId) fetchPriceHistory();
  };

  const handleBulkDiscount = async () => {
    const pct = Number(bulkDiscount);
    if (!Number.isFinite(pct) || pct < 0 || pct > 95) {
      setError('Введите скидку в процентах от 0 до 95');
      return;
    }
    if (selectedIds.size === 0 || !workspaceId) return;
    if (!confirm(`Применить скидку ${pct}% к ${selectedIds.size} товарам?`)) return;
    setBulkApplying(true);
    setError(null);
    try {
      const payload = Array.from(selectedIds).map((nmID) => ({ nmID, discount: pct }));
      await apiFetch(`/prices/${workspaceId}/upload`, {
        method: 'POST',
        body: JSON.stringify({ data: payload }),
        headers: { 'Content-Type': 'application/json' },
      });
      setSelectedIds(new Set());
      setBulkDiscount('');
      // Refresh товары через 2 сек чтобы WB успел обработать задачу
      setTimeout(() => fetchGoods(), 2000);
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось применить скидку');
    } finally {
      setBulkApplying(false);
    }
  };

  return (
    <AppShell title="Ценообразование">
      <div className="space-y-4">
        {/* Tabs */}
        <div className="flex items-center gap-4">
          <ToggleGroup
            type="single"
            value={activeTab}
            onValueChange={(v) => v && setActiveTab(v as TabType)}
          >
            <ToggleGroupItem value="goods" className="gap-2">
              <Tag className="h-4 w-4" />
              Товары и цены
            </ToggleGroupItem>
            <ToggleGroupItem value="quarantine" className="gap-2">
              <ShieldAlert className="h-4 w-4" />
              Карантин
            </ToggleGroupItem>
            <ToggleGroupItem value="history" className="gap-2">
              <History className="h-4 w-4" />
              История цен
            </ToggleGroupItem>
          </ToggleGroup>

          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-label="Обновить"
              title="Обновить"
              onClick={() => {
                if (activeTab === 'goods') fetchGoods();
                else if (activeTab === 'quarantine') fetchQuarantine();
                else if (activeTab === 'history' && historyNmId) fetchPriceHistory();
              }}
              disabled={loading}
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
          </div>
        </div>

        {error && (
          <Card className="border-red-500/50 bg-red-500/10 p-4">
            <div className="flex items-center gap-2 text-red-400">
              <AlertTriangle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          </Card>
        )}

        {/* Goods Tab */}
        {activeTab === 'goods' && (
          <div className="space-y-4">
            <Card className="p-4">
              <div className="flex items-center gap-4">
                {workspaceId ? (
                  <div className="flex-1">
                    <ProductSearchInput
                      workspaceId={workspaceId}
                      value={searchNmId}
                      onChange={(v) => setSearchNmId(v)}
                      placeholder="Поиск по артикулу или названию товара..."
                    />
                  </div>
                ) : (
                  <input
                    type="text"
                    placeholder="Поиск по артикулу WB..."
                    value={searchNmId}
                    onChange={(e) => setSearchNmId(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    className="flex-1 rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30"
                  />
                )}
                <Button onClick={handleSearch} disabled={loading}>
                  Найти
                </Button>
              </div>
            </Card>

            {selectedIds.size > 0 && (
              <Card className="flex items-center gap-3 border-indigo-500/30 bg-indigo-500/5 p-3">
                <span className="text-sm font-medium text-indigo-400">
                  Выбрано: {selectedIds.size}
                </span>
                <Button size="sm" variant="outline" onClick={() => setSelectedIds(new Set())}>
                  Снять выделение
                </Button>
                <div className="flex items-center gap-1">
                  <Percent className="h-3.5 w-3.5 text-indigo-400" />
                  <input
                    type="number"
                    min={0}
                    max={95}
                    placeholder="%"
                    value={bulkDiscount}
                    onChange={(e) => setBulkDiscount(e.target.value)}
                    className="w-16 rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-indigo-500/40"
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={bulkApplying || !bulkDiscount}
                  onClick={handleBulkDiscount}
                >
                  {bulkApplying ? 'Применяю...' : 'Применить скидку'}
                </Button>
              </Card>
            )}

            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-[800px] w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--card-border)] bg-[var(--card-bg)]">
                      <th className="w-10 px-3 py-3 text-center">
                        <input
                          type="checkbox"
                          aria-label="Выбрать все строки"
                          checked={goods.length > 0 && selectedIds.size === goods.length}
                          onChange={toggleSelectAll}
                          className="rounded border-[var(--card-border)]"
                        />
                      </th>
                      <th className="px-4 py-3 text-left font-medium">Артикул WB</th>
                      <th className="px-4 py-3 text-left font-medium">Артикул продавца</th>
                      <th className="px-4 py-3 text-right font-medium">Скидка %</th>
                      <th className="px-4 py-3 text-right font-medium">Цена</th>
                      <th className="px-4 py-3 text-right font-medium">Цена со скидкой</th>
                      <th className="px-4 py-3 text-center font-medium">Размеры</th>
                    </tr>
                  </thead>
                  <tbody>
                    {goods.map((item) => {
                      const firstSize = item.sizes?.[0];
                      return (
                        <tr key={item.nmID} className={cn("border-b border-[var(--card-border)] hover:bg-[var(--card-bg)]/50", selectedIds.has(item.nmID) && "bg-indigo-500/5")}>
                          <td className="w-10 px-3 py-3 text-center">
                            <input
                              type="checkbox"
                              aria-label={`Выбрать ${item.vendorCode ?? item.nmID}`}
                              checked={selectedIds.has(item.nmID)}
                              onChange={() => toggleSelect(item.nmID)}
                              className="rounded border-[var(--card-border)]"
                            />
                          </td>
                          <td className="px-4 py-3 font-mono text-xs">{item.nmID}</td>
                          <td className="px-4 py-3">{item.vendorCode || '—'}</td>
                          <td className="px-4 py-3 text-right">
                            {item.discount != null ? (
                              <span className="inline-flex items-center gap-1 text-orange-400">
                                <Percent className="h-3 w-3" />
                                {item.discount}%
                              </span>
                            ) : '—'}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {firstSize?.price != null ? formatRub(firstSize.price * 100) : '—'}
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-green-400">
                            {firstSize?.discountedPrice != null ? formatRub(firstSize.discountedPrice * 100) : '—'}
                          </td>
                          <td className="px-4 py-3 text-center text-xs text-[var(--content-text-muted)]">
                            {item.sizes?.length || 0} шт
                          </td>
                        </tr>
                      );
                    })}
                    {goods.length === 0 && !loading && (
                      <tr>
                        <td colSpan={7} className="px-4 py-8 text-center text-[var(--content-text-muted)]">
                          Нет данных
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between border-t border-[var(--card-border)] px-4 py-3">
                <span className="text-sm text-[var(--content-text-muted)]">
                  Показано {goods.length} товаров
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - limit))}
                  >
                    Назад
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={goods.length < limit}
                    onClick={() => setOffset(offset + limit)}
                  >
                    Далее
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* Quarantine Tab */}
        {activeTab === 'quarantine' && (
          <Card className="overflow-hidden">
            <div className="border-b border-[var(--card-border)] bg-amber-500/10 px-4 py-3">
              <div className="flex items-center gap-2 text-amber-400">
                <ShieldAlert className="h-5 w-5" />
                <span className="font-medium">Товары на карантине</span>
                <span className="text-sm text-[var(--content-text-muted)]">
                  (цены заблокированы из-за резких изменений)
                </span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[800px] w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--card-border)] bg-[var(--card-bg)]">
                    <th className="px-4 py-3 text-left font-medium">Артикул WB</th>
                    <th className="px-4 py-3 text-left font-medium">Причина</th>
                    <th className="px-4 py-3 text-left font-medium">Дата</th>
                  </tr>
                </thead>
                <tbody>
                  {quarantine.map((item, idx) => (
                    <tr key={`${item.nmID}-${idx}`} className="border-b border-[var(--card-border)] hover:bg-[var(--card-bg)]/50">
                      <td className="px-4 py-3 font-mono text-xs">{item.nmID}</td>
                      <td className="px-4 py-3">{item.reason || '—'}</td>
                      <td className="px-4 py-3 text-[var(--content-text-muted)]">
                        {item.dateMove ? new Date(item.dateMove).toLocaleDateString('ru') : '—'}
                      </td>
                    </tr>
                  ))}
                  {quarantine.length === 0 && !loading && (
                    <tr>
                      <td colSpan={3} className="px-4 py-8 text-center text-green-400">
                        ✓ Нет товаров на карантине
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* History Tab */}
        {activeTab === 'history' && (
          <div className="space-y-4">
            <Card className="p-4">
              <div className="flex items-center gap-4">
                <input
                  type="text"
                  placeholder="Артикул WB для просмотра истории..."
                  value={historyNmId}
                  onChange={(e) => setHistoryNmId(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleHistorySearch()}
                  className="flex-1 rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30"
                />
                <Button onClick={handleHistorySearch} disabled={loading || !historyNmId}>
                  Показать историю
                </Button>
              </div>
            </Card>

            {priceHistory.length > 0 && (
              <Card className="overflow-hidden">
                <div className="border-b border-[var(--card-border)] px-4 py-3">
                  <span className="font-medium">История цен для артикула {historyNmId}</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-[800px] w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--card-border)] bg-[var(--card-bg)]">
                        <th className="px-4 py-3 text-left font-medium">Дата</th>
                        <th className="px-4 py-3 text-right font-medium">Цена</th>
                        <th className="px-4 py-3 text-right font-medium">Скидка %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {priceHistory.map((item, idx) => (
                        <tr key={idx} className="border-b border-[var(--card-border)] hover:bg-[var(--card-bg)]/50">
                          <td className="px-4 py-3">
                            {item.dt ? new Date(item.dt).toLocaleDateString('ru') : '—'}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {item.price != null ? formatRub(item.price * 100) : '—'}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {item.discount != null ? `${item.discount}%` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {historyNmId && priceHistory.length === 0 && !loading && (
              <Card className="p-8 text-center text-[var(--content-text-muted)]">
                Нет истории цен для этого товара
              </Card>
            )}
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="h-6 w-6 animate-spin text-indigo-400" />
          </div>
        )}
      </div>
    </AppShell>
  );
}
