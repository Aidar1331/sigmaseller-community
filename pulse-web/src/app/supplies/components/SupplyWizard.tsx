'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  X, ChevronLeft, ChevronRight, Package, Warehouse, Calendar,
  Box, Check, Loader2, AlertTriangle, Search, Plus, Minus, Truck
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';

// Types
type Product = {
  nmId: number;
  vendorCode: string | null;
  title: string | null;
  barcode: string | null;
  currentStock: number;
  avgDailySales: number;
  daysOfStock: number | null;
  recommended: number;
};

type WarehouseOption = {
  warehouseId: number;
  warehouseName: string;
  region: string | null;
  coefficient: number;
  canBox: boolean;
  canMonopallet: boolean;
  acceptsAll: boolean;
  priority: number | null;
};

type DateSlot = {
  date: string;
  coefficient: number;
  slotsAvailable: boolean;
};

type SelectedProduct = {
  nmId: number;
  vendorCode: string | null;
  title: string | null;
  barcode: string | null;
  quantity: number;
};

type Props = {
  workspaceId: number;
  onClose: () => void;
  onSuccess: () => void;
  draftId?: number; // If editing existing draft
};

type Step = 'products' | 'quantities' | 'warehouse' | 'date' | 'confirm';

const STEPS: { key: Step; label: string; icon: typeof Package }[] = [
  { key: 'products', label: 'Товары', icon: Package },
  { key: 'quantities', label: 'Количество', icon: Box },
  { key: 'warehouse', label: 'Склад', icon: Warehouse },
  { key: 'date', label: 'Дата', icon: Calendar },
  { key: 'confirm', label: 'Подтверждение', icon: Check },
];

export function SupplyWizard({ workspaceId, onClose, onSuccess, draftId }: Props) {
  const [step, setStep] = useState<Step>('products');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Step 1: Products
  const [availableProducts, setAvailableProducts] = useState<Product[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<SelectedProduct[]>([]);
  const [productSearch, setProductSearch] = useState('');

  // Step 3: Warehouse
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [selectedWarehouse, setSelectedWarehouse] = useState<WarehouseOption | null>(null);

  // Step 4: Date
  const [dateSlots, setDateSlots] = useState<DateSlot[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // Step 5: Options
  const [deliveryType, setDeliveryType] = useState<'box' | 'mono_pallet'>('box');
  const [supplyName, setSupplyName] = useState('');

  // Load recommended products
  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: Product[] }>(
        `/supplies/${workspaceId}/recommended?salesPeriod=14`
      );
      setAvailableProducts(res.items || []);
    } catch (e: any) {
      setError(e?.message || 'Ошибка загрузки товаров');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  // Load warehouses with acceptance options
  const loadWarehouses = useCallback(async () => {
    if (selectedProducts.length === 0) return;

    setLoading(true);
    try {
      // Get acceptance options for selected products
      const items = selectedProducts.map(p => ({
        barcode: p.barcode || String(p.nmId),
        quantity: p.quantity,
      }));

      const res = await apiFetch<{ warehouses: WarehouseOption[]; debug?: { hint?: string; errorBarcodes?: { barcode: string; error: string }[] } }>(
        `/supplies/${workspaceId}/wb/best-warehouses`,
        {
          method: 'POST',
          body: JSON.stringify({ items }),
        }
      );
      setWarehouses(res.warehouses || []);
      if (res.warehouses?.length === 0 && res.debug?.hint) {
        setError(res.debug.hint);
      }
    } catch (e: any) {
      setError(e?.message || 'Ошибка загрузки складов');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, selectedProducts]);

  // Load date slots for warehouse
  const loadDateSlots = useCallback(async () => {
    if (!selectedWarehouse) return;

    setLoading(true);
    try {
      const res = await apiFetch<{ dates: DateSlot[] }>(
        `/supplies/${workspaceId}/wb/dates/${selectedWarehouse.warehouseId}?deliveryType=${deliveryType}`
      );
      setDateSlots(res.dates || []);
    } catch (e: any) {
      setError(e?.message || 'Ошибка загрузки дат');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, selectedWarehouse, deliveryType]);

  // Initial load
  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  // Load warehouses when moving to that step
  useEffect(() => {
    if (step === 'warehouse') {
      loadWarehouses();
    }
  }, [step, loadWarehouses]);

  // Load dates when warehouse selected
  useEffect(() => {
    if (step === 'date' && selectedWarehouse) {
      loadDateSlots();
    }
  }, [step, selectedWarehouse, loadDateSlots]);

  // Toggle product selection
  const toggleProduct = (product: Product) => {
    const exists = selectedProducts.find(p => p.nmId === product.nmId);
    if (exists) {
      setSelectedProducts(prev => prev.filter(p => p.nmId !== product.nmId));
    } else {
      setSelectedProducts(prev => [...prev, {
        nmId: product.nmId,
        vendorCode: product.vendorCode,
        title: product.title,
        barcode: product.barcode,
        quantity: product.recommended || 10,
      }]);
    }
  };

  // Update quantity
  const updateQuantity = (nmId: number, quantity: number) => {
    setSelectedProducts(prev =>
      prev.map(p => p.nmId === nmId ? { ...p, quantity: Math.max(1, quantity) } : p)
    );
  };

  // Submit to WB
  const submitToWB = async () => {
    if (!selectedWarehouse || !selectedDate) return;

    setSubmitting(true);
    setError(null);

    try {
      // First create a draft
      const draftRes = await apiFetch<{ draftId: number }>(
        `/supplies/${workspaceId}/drafts`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: supplyName || `Поставка ${new Date().toLocaleDateString('ru-RU')}`,
            warehouseId: selectedWarehouse.warehouseId,
            warehouseName: selectedWarehouse.warehouseName,
            items: selectedProducts.map(p => ({
              nmId: p.nmId,
              quantity: p.quantity,
            })),
          }),
        }
      );

      // Then submit to WB
      const result = await apiFetch<{ ok: boolean; supplyID?: number; error?: string }>(
        `/supplies/${workspaceId}/drafts/${draftRes.draftId}/submit-to-wb`,
        {
          method: 'POST',
          body: JSON.stringify({
            date: selectedDate,
            deliveryType,
          }),
        }
      );

      if (!result.ok) {
        throw new Error(result.error || 'Ошибка создания поставки');
      }

      onSuccess();
    } catch (e: any) {
      setError(e?.message || 'Ошибка создания поставки');
    } finally {
      setSubmitting(false);
    }
  };

  // Navigation
  const canGoNext = () => {
    switch (step) {
      case 'products': return selectedProducts.length > 0;
      case 'quantities': return selectedProducts.every(p => p.quantity > 0);
      case 'warehouse': return selectedWarehouse !== null;
      case 'date': return selectedDate !== null;
      case 'confirm': return true;
    }
  };

  const goNext = () => {
    const idx = STEPS.findIndex(s => s.key === step);
    if (idx < STEPS.length - 1) {
      setStep(STEPS[idx + 1].key);
    }
  };

  const goBack = () => {
    const idx = STEPS.findIndex(s => s.key === step);
    if (idx > 0) {
      setStep(STEPS[idx - 1].key);
    }
  };

  // Filter products by search
  const filteredProducts = availableProducts.filter(p =>
    !productSearch ||
    p.vendorCode?.toLowerCase().includes(productSearch.toLowerCase()) ||
    p.title?.toLowerCase().includes(productSearch.toLowerCase()) ||
    String(p.nmId).includes(productSearch)
  );

  const currentStepIndex = STEPS.findIndex(s => s.key === step);
  const totalQty = selectedProducts.reduce((sum, p) => sum + p.quantity, 0);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <Card className="w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-3">
            <Truck className="h-5 w-5 text-primary" />
            <h2 className="font-semibold text-lg">Новая поставка</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Progress */}
        <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/30">
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex items-center">
              <div
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
                  i === currentStepIndex
                    ? 'bg-primary text-primary-foreground'
                    : i < currentStepIndex
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {i < currentStepIndex ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <s.icon className="h-4 w-4" />
                )}
                <span className="hidden sm:inline">{s.label}</span>
              </div>
              {i < STEPS.length - 1 && (
                <ChevronRight className="h-4 w-4 mx-1 text-muted-foreground" />
              )}
            </div>
          ))}
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            {error}
            <button onClick={() => setError(null)} className="ml-auto hover:underline">
              Закрыть
            </button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* Step 1: Products */}
          {step === 'products' && !loading && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 text-muted-foreground" />
                <Input
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  placeholder="Поиск по артикулу или названию..."
                  className="flex-1"
                />
              </div>

              <div className="text-sm text-muted-foreground">
                Выбрано: {selectedProducts.length} товаров
              </div>

              <div className="grid gap-2 max-h-[400px] overflow-auto">
                {filteredProducts.map(product => {
                  const isSelected = selectedProducts.some(p => p.nmId === product.nmId);
                  const isCritical = product.daysOfStock !== null && product.daysOfStock < 7;
                  const isWarning = product.daysOfStock !== null && product.daysOfStock < 14;

                  return (
                    <div
                      key={product.nmId}
                      onClick={() => toggleProduct(product)}
                      className={cn(
                        'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                        isSelected
                          ? 'bg-primary/10 border-primary'
                          : 'hover:bg-muted/50 border-transparent'
                      )}
                    >
                      <div className={cn(
                        'w-5 h-5 rounded border-2 flex items-center justify-center',
                        isSelected ? 'bg-primary border-primary' : 'border-muted-foreground'
                      )}>
                        {isSelected && <Check className="h-3 w-3 text-primary-foreground" />}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">
                          {product.vendorCode || product.nmId}
                        </div>
                        <div className="text-sm text-muted-foreground truncate">
                          {product.title}
                        </div>
                      </div>

                      <div className="text-right text-sm">
                        <div className="font-medium">
                          Остаток: {product.currentStock}
                        </div>
                        <div className={cn(
                          'text-xs',
                          isCritical ? 'text-red-500' : isWarning ? 'text-amber-500' : 'text-muted-foreground'
                        )}>
                          {product.daysOfStock != null
                            ? `${product.daysOfStock} дн.`
                            : 'Нет продаж'}
                        </div>
                      </div>

                      {isCritical && (
                        <Badge className="bg-red-100 text-red-700">Критично</Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 2: Quantities */}
          {step === 'quantities' && !loading && (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground">
                Укажите количество для каждого товара. Всего: {totalQty} шт.
              </div>

              <div className="space-y-2">
                {selectedProducts.map(product => (
                  <div
                    key={product.nmId}
                    className="flex items-center gap-4 p-3 rounded-lg border"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{product.vendorCode || product.nmId}</div>
                      <div className="text-sm text-muted-foreground truncate">{product.title}</div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => updateQuantity(product.nmId, product.quantity - 10)}
                      >
                        <Minus className="h-4 w-4" />
                      </Button>
                      <Input
                        type="number"
                        value={product.quantity}
                        onChange={(e) => updateQuantity(product.nmId, parseInt(e.target.value) || 0)}
                        className="w-20 text-center"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => updateQuantity(product.nmId, product.quantity + 10)}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 3: Warehouse */}
          {step === 'warehouse' && !loading && (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground">
                Выберите склад для поставки
              </div>

              <div className="grid gap-2 max-h-[400px] overflow-auto">
                {warehouses.map(wh => (
                  <div
                    key={wh.warehouseId}
                    onClick={() => setSelectedWarehouse(wh)}
                    className={cn(
                      'flex items-center gap-4 p-4 rounded-lg border cursor-pointer transition-colors',
                      selectedWarehouse?.warehouseId === wh.warehouseId
                        ? 'bg-primary/10 border-primary'
                        : 'hover:bg-muted/50'
                    )}
                  >
                    <div className={cn(
                      'w-5 h-5 rounded-full border-2 flex items-center justify-center',
                      selectedWarehouse?.warehouseId === wh.warehouseId
                        ? 'bg-primary border-primary'
                        : 'border-muted-foreground'
                    )}>
                      {selectedWarehouse?.warehouseId === wh.warehouseId && (
                        <Check className="h-3 w-3 text-primary-foreground" />
                      )}
                    </div>

                    <div className="flex-1">
                      <div className="font-medium">{wh.warehouseName}</div>
                      <div className="text-sm text-muted-foreground">{wh.region}</div>
                    </div>

                    <div className="text-right">
                      <div className={cn(
                        'font-medium',
                        wh.coefficient === 0 ? 'text-green-500' : 'text-amber-500'
                      )}>
                        {wh.coefficient === 0 ? 'Бесплатно' : `+${wh.coefficient}%`}
                      </div>
                      {wh.priority && (
                        <Badge className="mt-1">⭐ Приоритет {wh.priority}</Badge>
                      )}
                    </div>

                    {!wh.acceptsAll && (
                      <Badge className="bg-amber-100 text-amber-700">Не все товары</Badge>
                    )}
                  </div>
                ))}

                {warehouses.length === 0 && (
                  <div className="text-center py-8 space-y-2">
                    <div className="text-muted-foreground">
                      Нет доступных складов WB для выбранных товаров
                    </div>
                    {error ? (
                      <div className="text-xs text-red-500">{error}</div>
                    ) : (
                      <div className="text-xs text-muted-foreground/70">
                        WB временно не принимает эти товары или баркоды неактивны.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 4: Date */}
          {step === 'date' && !loading && (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <span className="text-sm">Тип упаковки:</span>
                <div className="flex gap-2">
                  <Button
                    variant={deliveryType === 'box' ? 'primary' : 'neutral'}
                    size="sm"
                    onClick={() => setDeliveryType('box')}
                  >
                    Короба
                  </Button>
                  <Button
                    variant={deliveryType === 'mono_pallet' ? 'primary' : 'neutral'}
                    size="sm"
                    onClick={() => setDeliveryType('mono_pallet')}
                  >
                    Монопаллета
                  </Button>
                </div>
              </div>

              <div className="text-sm text-muted-foreground">
                Выберите дату поставки на {selectedWarehouse?.warehouseName}
              </div>

              <div className="grid grid-cols-7 gap-2">
                {dateSlots.map(slot => {
                  const date = new Date(slot.date);
                  const dayName = date.toLocaleDateString('ru-RU', { weekday: 'short' });
                  const dayNum = date.getDate();
                  const month = date.toLocaleDateString('ru-RU', { month: 'short' });
                  const isAvailable = slot.slotsAvailable;
                  const isSelected = selectedDate === slot.date;

                  return (
                    <button
                      key={slot.date}
                      onClick={() => isAvailable && setSelectedDate(slot.date)}
                      disabled={!isAvailable}
                      className={cn(
                        'p-3 rounded-lg text-center transition-colors',
                        isSelected
                          ? 'bg-primary text-primary-foreground'
                          : isAvailable
                          ? 'bg-muted hover:bg-muted/80'
                          : 'bg-muted/30 text-muted-foreground cursor-not-allowed'
                      )}
                    >
                      <div className="text-xs uppercase">{dayName}</div>
                      <div className="text-lg font-bold">{dayNum}</div>
                      <div className="text-xs">{month}</div>
                      {slot.coefficient > 0 && (
                        <div className="text-xs mt-1 text-amber-500">+{slot.coefficient}%</div>
                      )}
                      {!isAvailable && (
                        <div className="text-xs mt-1">❌</div>
                      )}
                    </button>
                  );
                })}
              </div>

              {dateSlots.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  Нет доступных дат. Попробуйте другой склад.
                </div>
              )}
            </div>
          )}

          {/* Step 5: Confirm */}
          {step === 'confirm' && !loading && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium mb-2">Название поставки</label>
                <Input
                  value={supplyName}
                  onChange={(e) => setSupplyName(e.target.value)}
                  placeholder={`Поставка ${new Date().toLocaleDateString('ru-RU')}`}
                />
              </div>

              <div className="space-y-4">
                <h3 className="font-medium">Проверьте данные поставки</h3>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Card className="p-4">
                    <div className="text-sm text-muted-foreground">Товары</div>
                    <div className="text-xl font-bold">{selectedProducts.length} позиций</div>
                    <div className="text-sm">{totalQty} шт. всего</div>
                  </Card>

                  <Card className="p-4">
                    <div className="text-sm text-muted-foreground">Склад</div>
                    <div className="text-xl font-bold">{selectedWarehouse?.warehouseName}</div>
                    <div className="text-sm">{selectedWarehouse?.region}</div>
                  </Card>

                  <Card className="p-4">
                    <div className="text-sm text-muted-foreground">Дата</div>
                    <div className="text-xl font-bold">
                      {selectedDate && new Date(selectedDate).toLocaleDateString('ru-RU', {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric'
                      })}
                    </div>
                  </Card>

                  <Card className="p-4">
                    <div className="text-sm text-muted-foreground">Упаковка</div>
                    <div className="text-xl font-bold">
                      {deliveryType === 'box' ? 'Короба' : 'Монопаллета'}
                    </div>
                  </Card>
                </div>

                <Card className="p-4">
                  <div className="text-sm text-muted-foreground mb-2">Товары в поставке</div>
                  <div className="space-y-1 max-h-[200px] overflow-auto">
                    {selectedProducts.map(p => (
                      <div key={p.nmId} className="flex justify-between text-sm">
                        <span>{p.vendorCode || p.nmId}</span>
                        <span className="font-medium">{p.quantity} шт.</span>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t">
          <Button
            variant="ghost"
            onClick={step === 'products' ? onClose : goBack}
            disabled={submitting}
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            {step === 'products' ? 'Отмена' : 'Назад'}
          </Button>

          {step === 'confirm' ? (
            <Button
              variant="primary"
              onClick={submitToWB}
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Создание...
                </>
              ) : (
                <>
                  <Truck className="h-4 w-4 mr-2" />
                  Создать в WB
                </>
              )}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={goNext}
              disabled={!canGoNext()}
            >
              Далее
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
