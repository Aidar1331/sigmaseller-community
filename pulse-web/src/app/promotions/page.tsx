'use client';

import { useShopChange } from '@/hooks/useShopChange';
import { useShopParam, useActiveShop } from '@/hooks/useShopParam';

import { useEffect, useState } from 'react';
import { useWorkspaceStore } from '@/store/workspace';
import { apiFetch } from '@/lib/api';
import { formatRub } from '@/lib/format';
import { cn } from '@/lib/cn';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { Button } from '@/components/ui/Button';
import {
  RefreshCw,
  Calendar,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Plus,
  Minus
} from 'lucide-react';

const promoTypeLabels: Record<string, string> = {
  regular: 'Обычная',
  auto: 'Автоакция',
  exclusive: 'Эксклюзивная',
};

type Promotion = {
  id: number;
  name: string;
  type?: string;
  startDateTime?: string;
  endDateTime?: string;
  description?: string;
  advantages?: string[];
  inAction?: boolean;
  inPromoActionLeftovers?: number;
  inPromoActionTotal?: number;
  inPromoActionLeftoversPc?: string;
  participationPercentage?: number;
  status?: string;
};

type PromotionProduct = {
  nmId: number;
  vendorCode?: string;
  subjectName?: string;
  brand?: string;
  actionPrice?: number;
  currPrice?: number;
  inAction?: boolean;
  cogsKopecks?: number;
};

type PromotionConditions = {
  startDateTime?: string;
  endDateTime?: string;
  minDiscountPct?: number;
  maxDiscountPct?: number;
  freeDelivery?: boolean;
  bonusRubles?: number;
  conditions?: string[];
};

type ViewMode = 'list' | 'detail';

export default function PromotionsPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopParam = useShopParam();
  const { shopId } = useActiveShop();

  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [selectedPromotion, setSelectedPromotion] = useState<Promotion | null>(null);
  const [products, setProducts] = useState<PromotionProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [showAll, setShowAll] = useState(false);
  const [addingAll, setAddingAll] = useState(false);
  const [actionNmId, setActionNmId] = useState<number | null>(null);

  const fetchPromotions = async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (showAll) params.set('allPromo', 'true');
      if (shopId) params.set('shopId', String(shopId));
      const data = await apiFetch(`/analytics/${workspaceId}/promotions?${params.toString()}`);
      // Backend returns { ok: false, error: '...' } when WB API fails (still 200)
      if (data.ok === false && data.error) {
        setError(data.error);
      }
      setPromotions(data.data?.promotions || []);
    } catch (e: any) {
      const msg = e.message || '';
      // Friendly message for WB API errors
      if (msg.includes('WB GET') || msg.includes('WB POST')) {
        setError('Не удалось загрузить акции с WB. Возможно, API-ключ не имеет доступа к календарю акций.');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchPromotionProducts = async (promotionId: number) => {
    if (!workspaceId) return;
    setLoadingProducts(true);
    setError(null);
    try {
      const data = await apiFetch(`/analytics/${workspaceId}/promotions/${promotionId}/products${shopParam ? `?shopId=${shopId}` : ''}`);
      if (data.ok === false && data.error) {
        setError(data.error);
      }
      setProducts(data.data?.products || []);
    } catch (e: any) {
      const msg = e.message || '';
      if (msg.includes('WB GET') || msg.includes('400') || msg.includes('Invalid query')) {
        setError('Не удалось загрузить товары акции. WB API вернул ошибку. Возможно, акция уже завершена или у API-ключа нет доступа.');
      } else {
        setError(msg);
      }
    } finally {
      setLoadingProducts(false);
    }
  };

  const handleSelectPromotion = async (promo: Promotion) => {
    setSelectedPromotion(promo);
    setViewMode('detail');
    await fetchPromotionProducts(promo.id);
  };

  const handleBack = () => {
    setViewMode('list');
    setSelectedPromotion(null);
    setProducts([]);
  };

  const addProductToPromotion = async (nmId: number) => {
    if (!workspaceId || !selectedPromotion || actionNmId) return;
    setActionNmId(nmId);
    try {
      await apiFetch(`/analytics/${workspaceId}/promotions/${selectedPromotion.id}/products`, {
        method: 'POST',
        body: JSON.stringify({ nmIds: [nmId], ...(shopId ? { shopId } : {}) }),
      });
      await fetchPromotionProducts(selectedPromotion.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionNmId(null);
    }
  };

  const addAllProductsToPromotion = async () => {
    if (!workspaceId || !selectedPromotion) return;
    const notInAction = products.filter((p) => !p.inAction);
    if (notInAction.length === 0) return;
    setAddingAll(true);
    try {
      await apiFetch(`/analytics/${workspaceId}/promotions/${selectedPromotion.id}/products`, {
        method: 'POST',
        body: JSON.stringify({ nmIds: notInAction.map((p) => p.nmId), ...(shopId ? { shopId } : {}) }),
      });
      await fetchPromotionProducts(selectedPromotion.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setAddingAll(false);
    }
  };

  const calcMarginPct = (product: PromotionProduct): string | null => {
    const price = product.actionPrice ?? product.currPrice;
    const cogs = product.cogsKopecks ? product.cogsKopecks / 100 : null;
    if (!price || !cogs) return null;
    const margin = ((price - cogs) / price) * 100;
    return margin.toFixed(1);
  };

  const calcDiscountPct = (product: PromotionProduct): string | null => {
    if (!product.currPrice || !product.actionPrice) return null;
    const discount = ((product.currPrice - product.actionPrice) / product.currPrice) * 100;
    return discount.toFixed(0);
  };

  const removeProductFromPromotion = async (nmId: number) => {
    if (!workspaceId || !selectedPromotion || actionNmId) return;
    setActionNmId(nmId);
    try {
      await apiFetch(`/analytics/${workspaceId}/promotions/${selectedPromotion.id}/products`, {
        method: 'DELETE',
        body: JSON.stringify({ nmIds: [nmId], ...(shopId ? { shopId } : {}) }),
      });
      await fetchPromotionProducts(selectedPromotion.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionNmId(null);
    }
  };

  useEffect(() => {
    fetchPromotions();
  }, [workspaceId, showAll, shopId]);
  useShopChange(fetchPromotions);

  const getStatusBadge = (promo: Promotion) => {
    const now = new Date();
    const start = promo.startDateTime ? new Date(promo.startDateTime) : null;
    const end = promo.endDateTime ? new Date(promo.endDateTime) : null;

    if (end && now > end) {
      return <span className="inline-flex items-center gap-1 rounded-full bg-gray-500/20 px-2 py-0.5 text-xs text-gray-500">Завершена</span>;
    }
    if (start && now < start) {
      return <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/20 px-2 py-0.5 text-xs text-blue-400"><Clock className="h-3 w-3" />Скоро</span>;
    }
    return <span className="inline-flex items-center gap-1 rounded-full bg-green-500/20 px-2 py-0.5 text-xs text-green-400"><CheckCircle2 className="h-3 w-3" />Активна</span>;
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('ru', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  if (!workspaceId) {
    return (
      <AppShell title="Акции WB">
        <div className="flex items-center justify-center py-20 text-[var(--content-text-muted)]">
          Выберите магазин для просмотра акций
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Акции WB">
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center gap-4">
          {viewMode === 'detail' && (
            <Button variant="outline" size="sm" onClick={handleBack}>
              ← Назад к списку
            </Button>
          )}

          {viewMode === 'list' && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                  className="rounded border-[var(--card-border)]"
                />
                Показать все (включая завершённые)
              </label>
            </>
          )}

          <div className="ml-auto">
            <Button
              size="sm"
              variant="outline"
              onClick={fetchPromotions}
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

        {/* List View */}
        {viewMode === 'list' && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {promotions.map((promo) => (
              <Card
                key={promo.id}
                className="cursor-pointer p-4 transition-colors hover:bg-[var(--card-bg)]/80"
                onClick={() => handleSelectPromotion(promo)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="font-medium">{promo.name}</h3>
                    <p className="mt-1 text-sm text-[var(--content-text-muted)]">
                      {promoTypeLabels[promo.type ?? ''] ?? promo.type ?? 'Акция'}
                    </p>
                  </div>
                  {getStatusBadge(promo)}
                </div>

                <div className="mt-4 flex items-center gap-4 text-sm">
                  <div className="flex items-center gap-1 text-[var(--content-text-muted)]">
                    <Calendar className="h-4 w-4" />
                    <span>{formatDate(promo.startDateTime)}</span>
                  </div>
                  <span className="text-[var(--content-text-muted)]">→</span>
                  <span className="text-[var(--content-text-muted)]">{formatDate(promo.endDateTime)}</span>
                </div>

                {promo.participationPercentage != null && (
                  <div className="mt-3 flex items-center gap-2">
                    <div className="flex-1 rounded-full bg-[var(--card-border)] h-2">
                      <div
                        className="h-2 rounded-full bg-indigo-500"
                        style={{ width: `${Math.min(100, promo.participationPercentage)}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium">{promo.participationPercentage}%</span>
                  </div>
                )}

                <div className="mt-3 flex items-center justify-between text-sm">
                  <span className="text-[var(--content-text-muted)]">
                    Товаров: {promo.inPromoActionTotal ?? '—'}
                  </span>
                  <ChevronRight className="h-4 w-4 text-[var(--content-text-muted)]" />
                </div>
              </Card>
            ))}

            {promotions.length === 0 && !loading && (
              <Card className="col-span-full p-8 text-center text-[var(--content-text-muted)]">
                <Calendar className="mx-auto h-12 w-12 opacity-50" />
                <p className="mt-2">Нет доступных акций</p>
              </Card>
            )}
          </div>
        )}

        {/* Detail View */}
        {viewMode === 'detail' && selectedPromotion && (
          <div className="space-y-4">
            <Card className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h2 className="text-lg font-semibold">{selectedPromotion.name}</h2>
                  <p className="text-sm text-[var(--content-text-muted)]">
                    {formatDate(selectedPromotion.startDateTime)} — {formatDate(selectedPromotion.endDateTime)}
                  </p>
                  {selectedPromotion.type && (
                    <p className="mt-1 text-sm text-[var(--content-text-muted)]">
                      Тип: {promoTypeLabels[selectedPromotion.type ?? ''] ?? selectedPromotion.type}
                    </p>
                  )}
                  {selectedPromotion.description && (
                    <p className="mt-2 text-sm">{selectedPromotion.description}</p>
                  )}
                  {selectedPromotion.advantages && selectedPromotion.advantages.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selectedPromotion.advantages.map((adv, i) => (
                        <span key={i} className="inline-flex items-center rounded-full bg-indigo-500/10 px-2 py-0.5 text-xs text-indigo-400">
                          {adv}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2">
                  {getStatusBadge(selectedPromotion)}
                  {selectedPromotion.participationPercentage != null && (
                    <span className="text-sm font-medium">Участие: {selectedPromotion.participationPercentage}%</span>
                  )}
                  {selectedPromotion.inAction && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-500/20 px-2 py-0.5 text-xs text-green-400">
                      <CheckCircle2 className="h-3 w-3" />
                      Участвует
                    </span>
                  )}
                </div>
              </div>
            </Card>

            {/* Условия акции */}
            {(selectedPromotion.description || selectedPromotion.advantages) && (
              <Card className="p-4">
                <h3 className="text-sm font-semibold mb-2">📋 Условия акции</h3>
                {selectedPromotion.description && (
                  <p className="text-sm text-[var(--content-text-muted)] mb-2">{selectedPromotion.description}</p>
                )}
                {selectedPromotion.advantages && selectedPromotion.advantages.length > 0 && (
                  <div className="space-y-1">
                    {selectedPromotion.advantages.map((adv, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-400 shrink-0" />
                        <span>{adv}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}

            {/* Сводка по товарам */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Card className="p-3 text-center">
                <div className="text-2xl font-bold">{products.length}</div>
                <div className="text-xs text-[var(--content-text-muted)]">Товаров</div>
              </Card>
              <Card className="p-3 text-center">
                <div className="text-2xl font-bold text-green-400">
                  {products.filter((p) => p.inAction).length}
                </div>
                <div className="text-xs text-[var(--content-text-muted)]">Участвуют</div>
              </Card>
              <Card className="p-3 text-center">
                <div className="text-2xl font-bold text-amber-400">
                  {products.filter((p) => !p.inAction).length}
                </div>
                <div className="text-xs text-[var(--content-text-muted)]">Не добавлены</div>
              </Card>
              <Card className="p-3 text-center">
                <div className="text-2xl font-bold">
                  {(() => {
                    const discounts = products.map((p) => calcDiscountPct(p)).filter(Boolean);
                    if (discounts.length === 0) return '—';
                    const avg = discounts.reduce((sum, d) => sum + parseFloat(d!), 0) / discounts.length;
                    return `${avg.toFixed(0)}%`;
                  })()}
                </div>
                <div className="text-xs text-[var(--content-text-muted)]">Ср. скидка</div>
              </Card>
            </div>

            <Card className="overflow-hidden">
              <div className="border-b border-[var(--card-border)] px-4 py-3 flex items-center justify-between">
                <div>
                  <span className="font-medium">Товары, подходящие для акции</span>
                  <span className="ml-2 text-sm text-[var(--content-text-muted)]">
                    ({products.length} шт)
                  </span>
                </div>
                {products.some((p) => !p.inAction) && (
                  <Button
                    size="sm"
                    onClick={addAllProductsToPromotion}
                    disabled={addingAll}
                  >
                    {addingAll ? (
                      <RefreshCw className="h-3 w-3 animate-spin" />
                    ) : (
                      <Plus className="h-3 w-3" />
                    )}
                    Добавить все ({products.filter((p) => !p.inAction).length})
                  </Button>
                )}
              </div>

              {loadingProducts ? (
                <div className="flex items-center justify-center py-8">
                  <RefreshCw className="h-6 w-6 animate-spin text-indigo-400" />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--card-border)] bg-[var(--card-bg)]">
                        <th className="px-4 py-3 text-left font-medium">Артикул WB</th>
                        <th className="px-4 py-3 text-left font-medium">Артикул продавца</th>
                        <th className="px-4 py-3 text-left font-medium">Категория</th>
                        <th className="px-4 py-3 text-right font-medium">Текущая цена</th>
                        <th className="px-4 py-3 text-right font-medium">Цена акции</th>
                        <th className="px-4 py-3 text-right font-medium">Скидка</th>
                        <th className="px-4 py-3 text-right font-medium">Маржа</th>
                        <th className="px-4 py-3 text-center font-medium">Статус</th>
                        <th className="px-4 py-3 text-center font-medium">Действие</th>
                      </tr>
                    </thead>
                    <tbody>
                      {products.map((product) => (
                        <tr key={product.nmId} className="border-b border-[var(--card-border)] hover:bg-[var(--card-bg)]/50">
                          <td className="px-4 py-3 font-mono text-xs"><NmIdLink nmId={product.nmId} /></td>
                          <td className="px-4 py-3">{product.vendorCode || '—'}</td>
                          <td className="px-4 py-3 text-[var(--content-text-muted)]">{product.subjectName || '—'}</td>
                          <td className="px-4 py-3 text-right">
                            {product.currPrice != null ? formatRub(product.currPrice * 100) : '—'}
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-green-400">
                            {product.actionPrice != null ? formatRub(product.actionPrice * 100) : '—'}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {(() => {
                              const d = calcDiscountPct(product);
                              if (!d) return '—';
                              return <span className="text-amber-400">−{d}%</span>;
                            })()}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {(() => {
                              const m = calcMarginPct(product);
                              if (!m) return <span className="text-[var(--content-text-muted)] text-xs">нет с/с</span>;
                              const val = parseFloat(m);
                              return (
                                <span className={val < 10 ? 'text-red-400 font-medium' : val < 25 ? 'text-amber-400' : 'text-green-400'}>
                                  {m}%
                                </span>
                              );
                            })()}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {product.inAction ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-green-500/20 px-2 py-0.5 text-xs text-green-400">
                                <CheckCircle2 className="h-3 w-3" />
                                В акции
                              </span>
                            ) : (
                              <span className="text-[var(--content-text-muted)]">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {product.inAction ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-red-400 hover:bg-red-500/10"
                                onClick={() => removeProductFromPromotion(product.nmId)}
                              >
                                <Minus className="h-3 w-3" />
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-green-400 hover:bg-green-500/10"
                                onClick={() => addProductToPromotion(product.nmId)}
                              >
                                <Plus className="h-3 w-3" />
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                      {products.length === 0 && (
                        <tr>
                          <td colSpan={9} className="px-4 py-8 text-center text-[var(--content-text-muted)]">
                            Нет подходящих товаров
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        )}

        {loading && viewMode === 'list' && (
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="h-6 w-6 animate-spin text-indigo-400" />
          </div>
        )}
      </div>
    </AppShell>
  );
}
