'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  X, RefreshCw, Package, Key, BarChart3, Wallet, Play, Pause, Square,
  Loader2, Plus, Minus, Trash2, Save, ChevronLeft, Edit2, Check, AlertTriangle,
  TrendingUp, TrendingDown, Eye, MousePointer, ShoppingCart, Target, DollarSign
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatNumber, formatRub } from '@/lib/format';

// Types
type CampaignProduct = {
  nmId: number;
  vendorCode: string | null;
  title: string | null;
  photoUrl: string | null;
  bid: number; // kopecks
  minBid: number | null; // kopecks
  views: number;
  clicks: number;
  orders: number;
  spend: number; // rubles
  ctr: number;
  drr: number;
};

type CampaignKeyword = {
  phrase: string;
  views: number;
  clicks: number;
  ctr: number;
  orders: number;
  spend: number;
  isExcluded: boolean;
};

type CampaignStats = {
  totals: {
    views: number;
    clicks: number;
    orders: number;
    spend: number;
    revenue: number;
    ctr: number;
    cpc: number;
    drr: number;
    cr: number;
  };
  days: Array<{
    date: string;
    views: number;
    clicks: number;
    orders: number;
    spend: number;
    revenue: number;
    ctr: number;
    cpc: number;
    drr: number;
  }>;
  byProduct: CampaignProduct[];
};

type CampaignFinance = {
  balance: number; // рекламный баланс
  dailyLimit: number;
  todaySpend: number;
  weekSpend: number;
  monthSpend: number;
  monthRevenue: number;
  monthDrr: number;
  profitEstimate: number; // выручка - расход (грубая оценка)
};

type Campaign = {
  campaignId: number;
  name: string;
  status: number;
  paymentType: string;
  dailyBudget: number;
  nmIds: number[];
};

type Props = {
  workspaceId: number;
  campaign: Campaign;
  onClose: () => void;
  onUpdate: () => void;
};

type TabType = 'products' | 'keywords' | 'stats' | 'finance';

const statusLabels: Record<number, { label: string; color: string }> = {
  9: { label: 'Активна', color: 'bg-green-100 text-green-700' },
  11: { label: 'На паузе', color: 'bg-amber-100 text-amber-700' },
  4: { label: 'Готова', color: 'bg-blue-100 text-blue-700' },
  7: { label: 'Завершена', color: 'bg-gray-100 text-gray-600' },
};

export function CampaignDetail({ workspaceId, campaign, onClose, onUpdate }: Props) {
  const [activeTab, setActiveTab] = useState<TabType>('products');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Products state
  const [products, setProducts] = useState<CampaignProduct[]>([]);
  const [editingBid, setEditingBid] = useState<number | null>(null);
  const [bidValue, setBidValue] = useState<string>('');
  const [bulkBidMode, setBulkBidMode] = useState(false);
  const [bulkBidValue, setBulkBidValue] = useState('');
  const [bulkBidType, setBulkBidType] = useState<'set' | 'increase' | 'decrease'>('set');

  // Keywords state
  const [keywords, setKeywords] = useState<CampaignKeyword[]>([]);
  const [excludedPhrases, setExcludedPhrases] = useState<string[]>([]);
  const [newMinusPhrase, setNewMinusPhrase] = useState('');
  const [bulkMinusPhrases, setBulkMinusPhrases] = useState('');
  const [showBulkMinus, setShowBulkMinus] = useState(false);

  // Stats state
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [statsPeriod, setStatsPeriod] = useState<'7d' | '14d' | '30d'>('14d');

  // Finance state
  const [finance, setFinance] = useState<CampaignFinance | null>(null);
  const [newDailyLimit, setNewDailyLimit] = useState('');
  const [editingLimit, setEditingLimit] = useState(false);

  // Fetch products
  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ products: CampaignProduct[] }>(
        `/bidder/${workspaceId}/campaigns/${campaign.campaignId}/products`
      );
      setProducts(res.products || []);
    } catch (e: any) {
      setError(e?.message || 'Ошибка загрузки товаров');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, campaign.campaignId]);

  // Fetch keywords
  const fetchKeywords = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ keywords: CampaignKeyword[]; excluded: string[] }>(
        `/bidder/${workspaceId}/campaigns/${campaign.campaignId}/keywords`
      );
      setKeywords(res.keywords || []);
      setExcludedPhrases(res.excluded || []);
    } catch (e: any) {
      setError(e?.message || 'Ошибка загрузки ключевых слов');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, campaign.campaignId]);

  // Fetch stats
  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const days = statsPeriod === '7d' ? 7 : statsPeriod === '14d' ? 14 : 30;
      const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      const res = await apiFetch<CampaignStats>(
        `/bidder/${workspaceId}/campaigns/${campaign.campaignId}/stats?from=${from}&to=${to}`
      );
      setStats(res);
    } catch (e: any) {
      setError(e?.message || 'Ошибка загрузки статистики');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, campaign.campaignId, statsPeriod]);

  // Fetch finance
  const fetchFinance = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<CampaignFinance>(
        `/bidder/${workspaceId}/campaigns/${campaign.campaignId}/finance`
      );
      setFinance(res);
      setNewDailyLimit(String(res.dailyLimit || ''));
    } catch (e: any) {
      setError(e?.message || 'Ошибка загрузки финансов');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, campaign.campaignId]);

  // Load data on tab change
  useEffect(() => {
    setError(null);
    if (activeTab === 'products' && products.length === 0) {
      fetchProducts();
    } else if (activeTab === 'keywords' && keywords.length === 0) {
      fetchKeywords();
    } else if (activeTab === 'stats' && !stats) {
      fetchStats();
    } else if (activeTab === 'finance' && !finance) {
      fetchFinance();
    }
  }, [activeTab]);

  // Refetch stats on period change
  useEffect(() => {
    if (activeTab === 'stats') {
      fetchStats();
    }
  }, [statsPeriod]);

  // Save single bid
  const saveBid = async (nmId: number, bidKopecks: number) => {
    setSaving(true);
    try {
      await apiFetch(`/bidder/${workspaceId}/campaigns/${campaign.campaignId}/bids`, {
        method: 'PATCH',
        body: JSON.stringify({
          bids: [{ nmId, bid: bidKopecks, placement: 'combined' }]
        }),
      });
      setEditingBid(null);
      await fetchProducts();
    } catch (e: any) {
      setError(e?.message || 'Ошибка сохранения ставки');
    } finally {
      setSaving(false);
    }
  };

  // Save bulk bids
  const saveBulkBids = async () => {
    const value = parseFloat(bulkBidValue);
    if (!value || value <= 0) return;

    setSaving(true);
    try {
      const bids = products.map(p => {
        let newBid = p.bid;
        if (bulkBidType === 'set') {
          newBid = Math.round(value * 100);
        } else if (bulkBidType === 'increase') {
          newBid = p.bid + Math.round(value * 100);
        } else if (bulkBidType === 'decrease') {
          newBid = Math.max(50, p.bid - Math.round(value * 100));
        }
        return { nmId: p.nmId, bid: newBid, placement: 'combined' };
      });

      await apiFetch(`/bidder/${workspaceId}/campaigns/${campaign.campaignId}/bids`, {
        method: 'PATCH',
        body: JSON.stringify({ bids }),
      });
      setBulkBidMode(false);
      setBulkBidValue('');
      await fetchProducts();
    } catch (e: any) {
      setError(e?.message || 'Ошибка сохранения ставок');
    } finally {
      setSaving(false);
    }
  };

  // Add minus phrase
  const addMinusPhrase = async (phrase: string) => {
    if (!phrase.trim()) return;
    setSaving(true);
    try {
      const newExcluded = [...excludedPhrases, phrase.trim().toLowerCase()];
      await apiFetch(`/bidder/${workspaceId}/campaigns/${campaign.campaignId}/minus-phrases`, {
        method: 'POST',
        body: JSON.stringify({ phrases: newExcluded }),
      });
      setExcludedPhrases(newExcluded);
      setNewMinusPhrase('');
      // Remove from keywords
      setKeywords(kw => kw.map(k => 
        k.phrase.toLowerCase() === phrase.trim().toLowerCase() 
          ? { ...k, isExcluded: true } 
          : k
      ));
    } catch (e: any) {
      setError(e?.message || 'Ошибка добавления минус-фразы');
    } finally {
      setSaving(false);
    }
  };

  // Add bulk minus phrases
  const addBulkMinusPhrases = async () => {
    const phrases = bulkMinusPhrases.split('\n').map(p => p.trim().toLowerCase()).filter(Boolean);
    if (phrases.length === 0) return;

    setSaving(true);
    try {
      const newExcluded = [...new Set([...excludedPhrases, ...phrases])];
      await apiFetch(`/bidder/${workspaceId}/campaigns/${campaign.campaignId}/minus-phrases`, {
        method: 'POST',
        body: JSON.stringify({ phrases: newExcluded }),
      });
      setExcludedPhrases(newExcluded);
      setBulkMinusPhrases('');
      setShowBulkMinus(false);
    } catch (e: any) {
      setError(e?.message || 'Ошибка добавления минус-фраз');
    } finally {
      setSaving(false);
    }
  };

  // Remove minus phrase
  const removeMinusPhrase = async (phrase: string) => {
    setSaving(true);
    try {
      const newExcluded = excludedPhrases.filter(p => p !== phrase);
      await apiFetch(`/bidder/${workspaceId}/campaigns/${campaign.campaignId}/minus-phrases`, {
        method: 'POST',
        body: JSON.stringify({ phrases: newExcluded }),
      });
      setExcludedPhrases(newExcluded);
    } catch (e: any) {
      setError(e?.message || 'Ошибка удаления минус-фразы');
    } finally {
      setSaving(false);
    }
  };

  // Save daily limit
  const saveDailyLimit = async () => {
    const value = parseInt(newDailyLimit, 10);
    if (!value || value < 0) return;

    setSaving(true);
    try {
      await apiFetch(`/bidder/${workspaceId}/campaigns/${campaign.campaignId}/budget`, {
        method: 'PATCH',
        body: JSON.stringify({ dailyLimit: value }),
      });
      setEditingLimit(false);
      await fetchFinance();
    } catch (e: any) {
      setError(e?.message || 'Ошибка сохранения лимита');
    } finally {
      setSaving(false);
    }
  };

  const statusConfig = statusLabels[campaign.status] || { label: 'Неизвестно', color: 'bg-gray-100 text-gray-600' };

  const tabs: { key: TabType; label: string; icon: typeof Package }[] = [
    { key: 'products', label: 'Товары', icon: Package },
    { key: 'keywords', label: 'Ключевые слова', icon: Key },
    { key: 'stats', label: 'Статистика', icon: BarChart3 },
    { key: 'finance', label: 'Финансы', icon: Wallet },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <Card className="w-full max-w-5xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onClose}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div>
              <h2 className="font-semibold text-lg">{campaign.name || `Кампания #${campaign.campaignId}`}</h2>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>ID: {campaign.campaignId}</span>
                <span>·</span>
                <Badge className={statusConfig.color}>{statusConfig.label}</Badge>
              </div>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Tabs */}
        <div className="flex border-b px-4">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex items-center gap-2 px-4 py-3 border-b-2 transition-colors text-sm font-medium',
                activeTab === tab.key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Error banner */}
        {error && (
          <div className="px-4 py-2 bg-red-50 text-red-700 text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            {error}
            <button onClick={() => setError(null)} className="ml-auto hover:underline">Закрыть</button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* Products Tab */}
          {activeTab === 'products' && !loading && (
            <div>
              {/* Bulk actions */}
              <div className="flex items-center gap-2 mb-4">
                <Button
                  variant={bulkBidMode ? 'primary' : 'neutral'}
                  size="sm"
                  onClick={() => setBulkBidMode(!bulkBidMode)}
                >
                  Массовое изменение ставок
                </Button>
                <Button variant="neutral" size="sm" onClick={fetchProducts}>
                  <RefreshCw className="h-4 w-4 mr-1" />
                  Обновить
                </Button>
              </div>

              {bulkBidMode && (
                <div className="mb-4 p-3 bg-muted/30 rounded-lg flex items-center gap-3">
                  <select
                    value={bulkBidType}
                    onChange={(e) => setBulkBidType(e.target.value as any)}
                    className="rounded border px-2 py-1 text-sm"
                  >
                    <option value="set">Установить</option>
                    <option value="increase">Увеличить на</option>
                    <option value="decrease">Уменьшить на</option>
                  </select>
                  <Input
                    type="number"
                    value={bulkBidValue}
                    onChange={(e) => setBulkBidValue(e.target.value)}
                    placeholder="Сумма в ₽"
                    className="w-32"
                  />
                  <span className="text-sm text-muted-foreground">₽ для всех товаров</span>
                  <Button variant="primary" size="sm" onClick={saveBulkBids} disabled={saving}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Применить'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setBulkBidMode(false)}>
                    Отмена
                  </Button>
                </div>
              )}

              {/* Products table */}
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/50 border-b">
                      <th className="py-2 px-3 text-left font-medium">Товар</th>
                      <th className="py-2 px-3 text-right font-medium">Ставка</th>
                      <th className="py-2 px-3 text-right font-medium">Мин.</th>
                      <th className="py-2 px-3 text-right font-medium">Показы</th>
                      <th className="py-2 px-3 text-right font-medium">Клики</th>
                      <th className="py-2 px-3 text-right font-medium">CTR</th>
                      <th className="py-2 px-3 text-right font-medium">Заказы</th>
                      <th className="py-2 px-3 text-right font-medium">Расход</th>
                      <th className="py-2 px-3 text-right font-medium">ДРР</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {products.map(product => (
                      <tr key={product.nmId} className="hover:bg-muted/30">
                        <td className="py-2 px-3">
                          <div className="flex items-center gap-2">
                            {product.photoUrl && (
                              <img src={product.photoUrl} alt="" className="w-8 h-8 rounded object-cover" />
                            )}
                            <div>
                              <div className="font-medium"><NmIdLink nmId={product.nmId}>{product.vendorCode || product.nmId}</NmIdLink></div>
                              <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                                {product.title}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="py-2 px-3 text-right">
                          {editingBid === product.nmId ? (
                            <div className="flex items-center justify-end gap-1">
                              <Input
                                type="number"
                                value={bidValue}
                                onChange={(e) => setBidValue(e.target.value)}
                                className="w-20 text-right"
                                autoFocus
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => saveBid(product.nmId, Math.round(parseFloat(bidValue) * 100))}
                                disabled={saving}
                              >
                                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setEditingBid(null)}>
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                          ) : (
                            <button
                              className="font-mono hover:bg-muted px-2 py-0.5 rounded"
                              onClick={() => {
                                setEditingBid(product.nmId);
                                setBidValue(String(product.bid / 100));
                              }}
                            >
                              {(product.bid / 100).toFixed(0)} ₽
                              <Edit2 className="h-3 w-3 inline ml-1 opacity-50" />
                            </button>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right text-muted-foreground">
                          {product.minBid ? `${(product.minBid / 100).toFixed(0)} ₽` : '—'}
                        </td>
                        <td className="py-2 px-3 text-right">{formatNumber(product.views)}</td>
                        <td className="py-2 px-3 text-right">{formatNumber(product.clicks)}</td>
                        <td className="py-2 px-3 text-right">{product.ctr.toFixed(2)}%</td>
                        <td className="py-2 px-3 text-right">{product.orders}</td>
                        <td className="py-2 px-3 text-right">{product.spend.toFixed(0)} ₽</td>
                        <td className={cn(
                          'py-2 px-3 text-right font-medium',
                          product.drr > 30 ? 'text-red-500' : product.drr > 15 ? 'text-amber-500' : 'text-green-500'
                        )}>
                          {product.drr > 0 ? `${product.drr.toFixed(1)}%` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {products.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  Нет товаров в кампании
                </div>
              )}
            </div>
          )}

          {/* Keywords Tab */}
          {activeTab === 'keywords' && !loading && (
            <div className="space-y-6">
              {/* Add minus phrase */}
              <div>
                <h3 className="font-medium mb-2 flex items-center gap-2">
                  <Minus className="h-4 w-4 text-red-500" />
                  Добавить минус-фразу
                </h3>
                <div className="flex gap-2">
                  <Input
                    value={newMinusPhrase}
                    onChange={(e) => setNewMinusPhrase(e.target.value)}
                    placeholder="Введите фразу для исключения..."
                    className="flex-1"
                    onKeyDown={(e) => e.key === 'Enter' && addMinusPhrase(newMinusPhrase)}
                  />
                  <Button variant="primary" onClick={() => addMinusPhrase(newMinusPhrase)} disabled={saving}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  </Button>
                  <Button variant="neutral" onClick={() => setShowBulkMinus(!showBulkMinus)}>
                    Массово
                  </Button>
                </div>
                {showBulkMinus && (
                  <div className="mt-2 p-3 bg-muted/30 rounded-lg">
                    <textarea
                      value={bulkMinusPhrases}
                      onChange={(e) => setBulkMinusPhrases(e.target.value)}
                      placeholder="Каждая фраза с новой строки..."
                      className="w-full h-24 rounded border px-3 py-2 text-sm"
                    />
                    <div className="flex justify-end gap-2 mt-2">
                      <Button variant="ghost" size="sm" onClick={() => setShowBulkMinus(false)}>
                        Отмена
                      </Button>
                      <Button variant="primary" size="sm" onClick={addBulkMinusPhrases} disabled={saving}>
                        Добавить все
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {/* Current minus phrases */}
              <div>
                <h3 className="font-medium mb-2">Минус-фразы ({excludedPhrases.length})</h3>
                <div className="flex flex-wrap gap-2">
                  {excludedPhrases.map((phrase, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-red-100 text-red-700 text-xs"
                    >
                      {phrase}
                      <button
                        onClick={() => removeMinusPhrase(phrase)}
                        className="hover:bg-red-200 rounded-full p-0.5"
                        disabled={saving}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  {excludedPhrases.length === 0 && (
                    <span className="text-muted-foreground text-sm">Нет минус-фраз</span>
                  )}
                </div>
              </div>

              {/* Active keywords */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-medium">Поисковые запросы</h3>
                  <Button variant="neutral" size="sm" onClick={fetchKeywords}>
                    <RefreshCw className="h-4 w-4 mr-1" />
                    Обновить
                  </Button>
                </div>
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/50 border-b">
                        <th className="py-2 px-3 text-left font-medium">Фраза</th>
                        <th className="py-2 px-3 text-right font-medium">Показы</th>
                        <th className="py-2 px-3 text-right font-medium">Клики</th>
                        <th className="py-2 px-3 text-right font-medium">CTR</th>
                        <th className="py-2 px-3 text-right font-medium">Заказы</th>
                        <th className="py-2 px-3 text-right font-medium">Расход</th>
                        <th className="py-2 px-3 text-center font-medium">Действие</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {keywords.filter(k => !k.isExcluded).map((kw, i) => (
                        <tr key={i} className="hover:bg-muted/30">
                          <td className="py-2 px-3 font-medium">{kw.phrase}</td>
                          <td className="py-2 px-3 text-right">{formatNumber(kw.views)}</td>
                          <td className="py-2 px-3 text-right">{formatNumber(kw.clicks)}</td>
                          <td className="py-2 px-3 text-right">{kw.ctr.toFixed(2)}%</td>
                          <td className="py-2 px-3 text-right">{kw.orders}</td>
                          <td className="py-2 px-3 text-right">{kw.spend.toFixed(0)} ₽</td>
                          <td className="py-2 px-3 text-center">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => addMinusPhrase(kw.phrase)}
                              disabled={saving}
                              title="Добавить в минус-фразы"
                            >
                              <Minus className="h-4 w-4 text-red-500" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {keywords.filter(k => !k.isExcluded).length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    Нет данных по ключевым словам
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Stats Tab */}
          {activeTab === 'stats' && !loading && stats && (
            <div className="space-y-6">
              {/* Period selector */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Период:</span>
                {(['7d', '14d', '30d'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => setStatsPeriod(p)}
                    className={cn(
                      'px-3 py-1 rounded text-sm font-medium',
                      statsPeriod === p
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted hover:bg-muted/80'
                    )}
                  >
                    {p === '7d' ? '7 дней' : p === '14d' ? '14 дней' : '30 дней'}
                  </button>
                ))}
              </div>

              {/* Totals — null-safe (B2 fix 2026-05-07: backend may return
                  stats without `totals` when WB API rate-limited; previously
                  caused «Cannot read properties of undefined (reading 'views')». */}
              {stats.totals ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                  <StatCard icon={Eye} label="Показы" value={formatNumber(stats.totals.views ?? 0)} color="text-blue-500" />
                  <StatCard icon={MousePointer} label="Клики" value={formatNumber(stats.totals.clicks ?? 0)} sub={`CTR: ${(stats.totals.ctr ?? 0).toFixed(2)}%`} color="text-purple-500" />
                  <StatCard icon={ShoppingCart} label="Заказы" value={formatNumber(stats.totals.orders ?? 0)} sub={`CR: ${(stats.totals.cr ?? 0).toFixed(2)}%`} color="text-green-500" />
                  <StatCard icon={DollarSign} label="Расход" value={`${(stats.totals.spend ?? 0).toFixed(0)} ₽`} sub={`CPC: ${(stats.totals.cpc ?? 0).toFixed(0)} ₽`} color="text-red-500" />
                  <StatCard icon={Target} label="ДРР" value={`${(stats.totals.drr ?? 0).toFixed(1)}%`} sub={`Выручка: ${formatNumber(Math.round(stats.totals.revenue ?? 0))} ₽`} color={(stats.totals.drr ?? 0) > 30 ? 'text-red-500' : 'text-green-500'} />
                </div>
              ) : (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-6 text-center text-sm text-amber-800">
                  Статистика временно недоступна. Возможно, превышен лимит WB API — повторите через минуту.
                </div>
              )}

              {/* By product */}
              {stats.byProduct && stats.byProduct.length > 0 && (
                <div>
                  <h3 className="font-medium mb-2">По товарам</h3>
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/50 border-b">
                          <th className="py-2 px-3 text-left font-medium">Товар</th>
                          <th className="py-2 px-3 text-right font-medium">Показы</th>
                          <th className="py-2 px-3 text-right font-medium">Клики</th>
                          <th className="py-2 px-3 text-right font-medium">CTR</th>
                          <th className="py-2 px-3 text-right font-medium">Заказы</th>
                          <th className="py-2 px-3 text-right font-medium">Расход</th>
                          <th className="py-2 px-3 text-right font-medium">ДРР</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {stats.byProduct.map(p => (
                          <tr key={p.nmId} className="hover:bg-muted/30">
                            <td className="py-2 px-3">
                              <NmIdLink nmId={p.nmId} className="font-medium text-blue-600 hover:underline">{p.vendorCode || p.nmId}</NmIdLink>
                            </td>
                            <td className="py-2 px-3 text-right">{formatNumber(p.views)}</td>
                            <td className="py-2 px-3 text-right">{formatNumber(p.clicks)}</td>
                            <td className="py-2 px-3 text-right">{p.ctr.toFixed(2)}%</td>
                            <td className="py-2 px-3 text-right">{p.orders}</td>
                            <td className="py-2 px-3 text-right">{p.spend.toFixed(0)} ₽</td>
                            <td className={cn('py-2 px-3 text-right font-medium', p.drr > 30 ? 'text-red-500' : 'text-green-500')}>
                              {p.drr > 0 ? `${p.drr.toFixed(1)}%` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Daily stats */}
              {stats.days && stats.days.length > 0 && (
                <div>
                  <h3 className="font-medium mb-2">По дням</h3>
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/50 border-b">
                          <th className="py-2 px-3 text-left font-medium">Дата</th>
                          <th className="py-2 px-3 text-right font-medium">Показы</th>
                          <th className="py-2 px-3 text-right font-medium">Клики</th>
                          <th className="py-2 px-3 text-right font-medium">CTR</th>
                          <th className="py-2 px-3 text-right font-medium">Заказы</th>
                          <th className="py-2 px-3 text-right font-medium">Расход</th>
                          <th className="py-2 px-3 text-right font-medium">Выручка</th>
                          <th className="py-2 px-3 text-right font-medium">ДРР</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {stats.days.map(day => (
                          <tr key={day.date} className="hover:bg-muted/30">
                            <td className="py-2 px-3 font-medium">
                              {new Date(day.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                            </td>
                            <td className="py-2 px-3 text-right">{formatNumber(day.views)}</td>
                            <td className="py-2 px-3 text-right">{formatNumber(day.clicks)}</td>
                            <td className="py-2 px-3 text-right">{day.ctr.toFixed(2)}%</td>
                            <td className="py-2 px-3 text-right">{day.orders}</td>
                            <td className="py-2 px-3 text-right">{day.spend.toFixed(0)} ₽</td>
                            <td className="py-2 px-3 text-right">{day.revenue > 0 ? `${formatNumber(Math.round(day.revenue))} ₽` : '—'}</td>
                            <td className={cn('py-2 px-3 text-right font-medium', day.drr > 30 ? 'text-red-500' : 'text-green-500')}>
                              {day.drr > 0 ? `${day.drr.toFixed(1)}%` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Finance Tab */}
          {activeTab === 'finance' && !loading && finance && (
            <div className="space-y-6">
              {/* Balance */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <Card className="p-4">
                  <div className="text-sm text-muted-foreground mb-1">Баланс рекл. кабинета</div>
                  <div className="text-2xl font-bold">{formatNumber(finance.balance)} ₽</div>
                </Card>
                <Card className="p-4">
                  <div className="text-sm text-muted-foreground mb-1">Дневной лимит</div>
                  {editingLimit ? (
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        value={newDailyLimit}
                        onChange={(e) => setNewDailyLimit(e.target.value)}
                        className="w-24"
                      />
                      <Button variant="ghost" size="sm" onClick={saveDailyLimit} disabled={saving}>
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditingLimit(false)}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <button
                      className="text-2xl font-bold hover:bg-muted px-2 py-0.5 rounded flex items-center gap-2"
                      onClick={() => setEditingLimit(true)}
                    >
                      {finance.dailyLimit} ₽
                      <Edit2 className="h-4 w-4 opacity-50" />
                    </button>
                  )}
                </Card>
                <Card className="p-4">
                  <div className="text-sm text-muted-foreground mb-1">Сегодня потрачено</div>
                  <div className="text-2xl font-bold text-red-500">−{formatNumber(finance.todaySpend)} ₽</div>
                </Card>
                <Card className="p-4">
                  <div className="text-sm text-muted-foreground mb-1">ДРР за месяц</div>
                  <div className={cn('text-2xl font-bold', finance.monthDrr > 30 ? 'text-red-500' : 'text-green-500')}>
                    {finance.monthDrr.toFixed(1)}%
                  </div>
                </Card>
              </div>

              {/* Monthly summary */}
              <Card className="p-4">
                <h3 className="font-medium mb-4">За последний месяц</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <div className="text-sm text-muted-foreground">Расход на рекламу</div>
                    <div className="text-xl font-semibold text-red-500">−{formatNumber(finance.monthSpend)} ₽</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground">Выручка с рекламы</div>
                    <div className="text-xl font-semibold text-green-500">+{formatNumber(finance.monthRevenue)} ₽</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground">Прибыль (оценка 25% маржи)</div>
                    <div className={cn('text-xl font-semibold', finance.profitEstimate > 0 ? 'text-green-500' : 'text-red-500')}>
                      {finance.profitEstimate > 0 ? '+' : ''}{formatNumber(finance.profitEstimate)} ₽
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground">ДРР</div>
                    <div className={cn('text-xl font-semibold', finance.monthDrr > 30 ? 'text-red-500' : 'text-green-500')}>
                      {finance.monthDrr.toFixed(1)}%
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

// Stat card component
function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: any;
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-muted/30 rounded-lg p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
        <Icon className={cn('h-3.5 w-3.5', color)} />
        {label}
      </div>
      <div className="text-xl font-bold">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}
