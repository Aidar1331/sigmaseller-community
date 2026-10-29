'use client';

import { useState, useEffect, useCallback } from 'react';
import { Search, RefreshCw, Loader2, TrendingUp, Eye, ShoppingCart, Package } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ErrorBanner } from '@/components/ui/ErrorBanner';

type SearchReportItem = {
  nmId: number;
  vendorCode: string;
  brandName: string;
  productName: string;
  avgPosition: number;
  medianPosition: number;
  viewsCount: number;
  clicksCount: number;
  ctr: number;
  addToCartCount: number;
  ordersCount: number;
};

type ProductSearchText = {
  text: string;
  frequency: number;
  avgPosition: number;
  openCardCount: number;
  addToCartCount: number;
  ordersCount: number;
};

type Props = {
  workspaceId: number;
  dateFrom?: string;
  dateTo?: string;
};

export function SearchQueriesTable({ workspaceId, dateFrom, dateTo }: Props) {
  const [data, setData] = useState<SearchReportItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expandedNmId, setExpandedNmId] = useState<number | null>(null);
  const [searchTexts, setSearchTexts] = useState<ProductSearchText[]>([]);
  const [loadingTexts, setLoadingTexts] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      params.set('limit', '100');

      const res = await apiFetch(`/seo/${workspaceId}/search-queries?${params}`);
      if (res.error) {
        setError(res.error);
      } else {
        setData(res.data || []);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, dateFrom, dateTo]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const loadSearchTexts = async (nmId: number) => {
    if (expandedNmId === nmId) {
      setExpandedNmId(null);
      setSearchTexts([]);
      return;
    }

    setExpandedNmId(nmId);
    setLoadingTexts(true);
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);

      const res = await apiFetch(`/seo/${workspaceId}/search-queries/texts/${nmId}?${params}`);
      setSearchTexts(res.data || []);
    } catch (e: any) {
      setSearchTexts([]);
      setError(e?.message ?? 'Не удалось загрузить запросы по товару');
    } finally {
      setLoadingTexts(false);
    }
  };

  const filteredData = search
    ? data.filter(
        (item) =>
          item.productName.toLowerCase().includes(search.toLowerCase()) ||
          item.vendorCode.toLowerCase().includes(search.toLowerCase()) ||
          String(item.nmId).includes(search)
      )
    : data;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <ErrorBanner error={error} onRetry={loadData} onDismiss={() => setError(null)} />
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по товарам..."
              className="pl-9 w-64"
            />
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={loadData}>
          <RefreshCw className="h-4 w-4 mr-1" />
          Обновить
        </Button>
      </div>

      {/* Stats summary */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm">
            <Package className="h-4 w-4" />
            Товаров
          </div>
          <div className="text-2xl font-bold mt-1">{formatNumber(data.length)}</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm">
            <Eye className="h-4 w-4" />
            Показы
          </div>
          <div className="text-2xl font-bold mt-1">
            {formatNumber(data.reduce((sum, item) => sum + item.viewsCount, 0))}
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm">
            <ShoppingCart className="h-4 w-4" />
            В корзину
          </div>
          <div className="text-2xl font-bold mt-1">
            {formatNumber(data.reduce((sum, item) => sum + item.addToCartCount, 0))}
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm">
            <TrendingUp className="h-4 w-4" />
            Заказы
          </div>
          <div className="text-2xl font-bold mt-1">
            {formatNumber(data.reduce((sum, item) => sum + item.ordersCount, 0))}
          </div>
        </Card>
      </div>

      {/* Table */}
      {filteredData.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          {search ? 'Ничего не найдено' : 'Нет данных за выбранный период'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th className="py-3 px-2 text-left">Товар</th>
                <th className="py-3 px-2 text-right">Позиция</th>
                <th className="py-3 px-2 text-right">Показы</th>
                <th className="py-3 px-2 text-right">Клики</th>
                <th className="py-3 px-2 text-right">CTR</th>
                <th className="py-3 px-2 text-right">В корзину</th>
                <th className="py-3 px-2 text-right">Заказы</th>
              </tr>
            </thead>
            <tbody>
              {filteredData.map((item) => (
                <>
                  <tr
                    key={item.nmId}
                    onClick={() => loadSearchTexts(item.nmId)}
                    className={cn(
                      'border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer',
                      expandedNmId === item.nmId && 'bg-blue-50 dark:bg-blue-900/20'
                    )}
                  >
                    <td className="py-3 px-2">
                      <div className="font-medium truncate max-w-[300px]">
                        {item.productName}
                      </div>
                      <div className="text-xs text-gray-500">
                        {item.vendorCode} · #{item.nmId}
                      </div>
                    </td>
                    <td className="py-3 px-2 text-right">
                      <Badge
                        variant={item.avgPosition <= 10 ? 'success' : item.avgPosition <= 50 ? 'warning' : 'secondary'}
                      >
                        {item.avgPosition.toFixed(1)}
                      </Badge>
                    </td>
                    <td className="py-3 px-2 text-right text-gray-600 dark:text-gray-400">
                      {formatNumber(item.viewsCount)}
                    </td>
                    <td className="py-3 px-2 text-right text-gray-600 dark:text-gray-400">
                      {formatNumber(item.clicksCount)}
                    </td>
                    <td className="py-3 px-2 text-right">
                      <Badge
                        variant={item.ctr >= 5 ? 'success' : item.ctr >= 2 ? 'warning' : 'secondary'}
                      >
                        {item.ctr.toFixed(2)}%
                      </Badge>
                    </td>
                    <td className="py-3 px-2 text-right text-gray-600 dark:text-gray-400">
                      {formatNumber(item.addToCartCount)}
                    </td>
                    <td className="py-3 px-2 text-right font-medium">
                      {formatNumber(item.ordersCount)}
                    </td>
                  </tr>
                  {expandedNmId === item.nmId && (
                    <tr className="bg-gray-50 dark:bg-gray-800/30">
                      <td colSpan={7} className="py-4 px-4">
                        {loadingTexts ? (
                          <div className="flex items-center justify-center py-4">
                            <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
                          </div>
                        ) : searchTexts.length === 0 ? (
                          <div className="text-center py-4 text-gray-500">
                            Нет поисковых запросов
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                              Топ поисковых запросов:
                            </div>
                            <div className="grid gap-2">
                              {searchTexts.slice(0, 10).map((text, idx) => (
                                <div
                                  key={idx}
                                  className="flex items-center justify-between bg-white dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700"
                                >
                                  <div className="flex items-center gap-3">
                                    <span className="text-gray-500 text-xs w-5">
                                      {idx + 1}.
                                    </span>
                                    <span className="font-medium">{text.text}</span>
                                  </div>
                                  <div className="flex items-center gap-4 text-xs text-gray-500">
                                    <span>Частота: {formatNumber(text.frequency)}</span>
                                    <span>Позиция: {text.avgPosition.toFixed(1)}</span>
                                    <span>Заказы: {text.ordersCount}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
