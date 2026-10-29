'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';
import {
  Zap, ChevronRight, ChevronLeft, Check, Rocket,
  Target, Search, Grid, Sparkles, X, AlertCircle
} from 'lucide-react';
import { cn } from '@/lib/cn';

type CampaignType = {
  value: string;
  label: string;
  description: string;
};

interface CreateCampaignWizardProps {
  workspaceId: number;
  onClose: () => void;
  onSuccess: (advertId: number) => void;
}

export function CreateCampaignWizard({ workspaceId, onClose, onSuccess }: CreateCampaignWizardProps) {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1: Campaign type
  const [types, setTypes] = useState<CampaignType[]>([]);
  const [selectedType, setSelectedType] = useState<string>('auto');

  // Step 2: Basic info
  const [name, setName] = useState('');
  const [dailyBudget, setDailyBudget] = useState<number | ''>('');

  // Step 3: Products
  const [nmIds, setNmIds] = useState('');

  // Step 4: Advanced (optional)
  const [cpm, setCpm] = useState<number | ''>('');

  useEffect(() => {
    const loadTypes = async () => {
      try {
        const res = await apiFetch(`/bidder/${workspaceId}/campaigns/types`) as { types: CampaignType[] };
        setTypes(res.types ?? []);
      } catch (e) {
        setTypes([
          { value: 'auto', label: 'Автоматическая', description: 'WB сам выбирает места показа' },
          { value: 'auction', label: 'Аукцион', description: 'Показы в поиске и каталоге по ставке' },
          { value: 'search', label: 'Поиск', description: 'Только в результатах поиска' },
          { value: 'catalog', label: 'Каталог', description: 'Только в каталоге категорий' },
        ]);
      }
    };
    loadTypes();
  }, [workspaceId]);

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'auto': return Sparkles;
      case 'auction': return Zap;
      case 'search': return Search;
      case 'catalog': return Grid;
      default: return Target;
    }
  };

  const canProceed = () => {
    switch (step) {
      case 1: return !!selectedType;
      case 2: return name.trim().length > 0;
      case 3: return nmIds.trim().length > 0;
      case 4: return true;
      default: return false;
    }
  };

  const handleCreate = async () => {
    setLoading(true);
    setError(null);

    const nmIdArray = nmIds.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));

    if (nmIdArray.length === 0) {
      setError('Укажите хотя бы один артикул товара');
      setLoading(false);
      return;
    }

    try {
      const res = await apiFetch(`/bidder/${workspaceId}/campaigns/create`, {
        method: 'POST',
        body: JSON.stringify({
          type: selectedType,
          name: name.trim(),
          dailyBudget: dailyBudget || undefined,
          nmIds: nmIdArray,
          cpm: cpm || undefined,
        }),
      }) as { ok: boolean; advertId?: number; error?: string };

      if (res.ok && res.advertId) {
        onSuccess(res.advertId);
      } else {
        setError(res.error || 'Не удалось создать кампанию');
      }
    } catch (e: any) {
      setError(e?.message ?? 'Ошибка при создании кампании');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
              <Rocket className="h-5 w-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Новая кампания</h2>
              <p className="text-sm text-gray-500">Шаг {step} из 4</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100">
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {/* Progress */}
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
          <div className="flex gap-2">
            {[1, 2, 3, 4].map((s) => (
              <div
                key={s}
                className={cn(
                  'flex-1 h-2 rounded-full transition-colors',
                  s <= step ? 'bg-indigo-500' : 'bg-gray-200'
                )}
              />
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-red-500" />
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}

          {/* Step 1: Type selection */}
          {step === 1 && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900">Выберите тип кампании</h3>
              <div className="grid grid-cols-2 gap-3">
                {types.map((type) => {
                  const Icon = getTypeIcon(type.value);
                  return (
                    <button
                      key={type.value}
                      onClick={() => setSelectedType(type.value)}
                      className={cn(
                        'p-4 rounded-xl border-2 text-left transition-all',
                        selectedType === type.value
                          ? 'border-indigo-500 bg-indigo-50'
                          : 'border-gray-200 hover:border-gray-300'
                      )}
                    >
                      <div className={cn(
                        'h-10 w-10 rounded-lg flex items-center justify-center mb-3',
                        selectedType === type.value ? 'bg-indigo-500 text-white' : 'bg-gray-100 text-gray-600'
                      )}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="font-medium text-gray-900">{type.label}</div>
                      <div className="text-sm text-gray-500 mt-1">{type.description}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 2: Basic info */}
          {step === 2 && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900">Основные настройки</h3>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Название кампании *
                </label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Моя новая кампания"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Дневной бюджет (₽)
                </label>
                <Input
                  type="number"
                  value={dailyBudget}
                  onChange={(e) => setDailyBudget(e.target.value ? Number(e.target.value) : '')}
                  placeholder="1000"
                />
                <p className="text-xs text-gray-500 mt-1">Оставьте пустым для неограниченного бюджета</p>
              </div>
            </div>
          )}

          {/* Step 3: Products */}
          {step === 3 && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900">Товары для рекламы</h3>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Артикулы WB (nmId) *
                </label>
                <ProductSearchInput
                  workspaceId={workspaceId}
                  value={nmIds}
                  onChange={setNmIds}
                  placeholder="Выберите товары..."
                />
                <p className="text-xs text-gray-500 mt-1">
                  Или введите артикулы через запятую: 123456, 789012
                </p>
              </div>
            </div>
          )}

          {/* Step 4: Advanced */}
          {step === 4 && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900">Дополнительные настройки</h3>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Начальная ставка CPM (₽)
                </label>
                <Input
                  type="number"
                  value={cpm}
                  onChange={(e) => setCpm(e.target.value ? Number(e.target.value) : '')}
                  placeholder="125"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Минимальная ставка — 125 ₽. Оставьте пустым для автоставки.
                </p>
              </div>

              {/* Summary */}
              <div className="mt-6 p-4 rounded-lg bg-gray-50">
                <h4 className="font-medium text-gray-900 mb-3">Сводка</h4>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Тип:</dt>
                    <dd className="font-medium">{types.find(t => t.value === selectedType)?.label}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Название:</dt>
                    <dd className="font-medium">{name}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Бюджет:</dt>
                    <dd className="font-medium">{dailyBudget ? `${dailyBudget} ₽/день` : 'Не ограничен'}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Товаров:</dt>
                    <dd className="font-medium">{nmIds.split(',').filter(s => s.trim()).length}</dd>
                  </div>
                </dl>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-gray-200 bg-gray-50">
          <Button
            variant="neutral"
            onClick={() => step > 1 ? setStep(step - 1) : onClose()}
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            {step > 1 ? 'Назад' : 'Отмена'}
          </Button>

          {step < 4 ? (
            <Button
              variant="primary"
              onClick={() => setStep(step + 1)}
              disabled={!canProceed()}
            >
              Далее
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={handleCreate}
              loading={loading}
              disabled={!canProceed()}
            >
              <Rocket className="h-4 w-4 mr-1" />
              Создать кампанию
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
