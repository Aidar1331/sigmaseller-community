'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import { useShopChange } from '@/hooks/useShopChange';
import { useActiveShop } from '@/hooks/useShopParam';
import {
  Package, RefreshCw, Check, X, Clock, AlertTriangle, Filter,
  TrendingDown, Calendar, Search, ChevronDown, ChevronUp,
  Eye, MessageSquare
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatRub } from '@/lib/format';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';

type Return = {
  returnId: number;
  nmId: number;
  productTitle: string | null;
  brandName: string | null;
  photoUrl?: string | null;
  reason: string | null;
  comment: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'processing';
  createdAt: string;
  amount?: number;
  quantity?: number;
};

type Statistics = {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  totalAmount: number;
  byReason: Record<string, number>;
};

export default function ReturnsPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const { shopId } = useActiveShop();
  const [loading, setLoading] = useState(false);
  const [returns, setReturns] = useState<Return[]>([]);
  const [stats, setStats] = useState<Statistics | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterNmId, setFilterNmId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadReturns = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterStatus) params.set('status', filterStatus);
      if (filterNmId) params.set('nmId', filterNmId);
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      if (shopId) params.set('shopId', String(shopId));
      params.set('limit', '200');

      const [returnsRes, statsRes] = await Promise.all([
        apiFetch(`/returns/${workspaceId}?${params}`) as Promise<{ data: Return[]; total: number }>,
        apiFetch(`/returns/${workspaceId}/statistics?${params}`).catch(() => null) as Promise<Statistics | null>,
      ]);

      setReturns(returnsRes.data ?? []);
      setStats(statsRes ?? { total: 0, pending: 0, approved: 0, rejected: 0, totalAmount: 0, byReason: {} });
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось загрузить возвраты');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, filterStatus, filterNmId, dateFrom, dateTo, shopId]);

  const approveReturn = async (returnId: number) => {
    if (!workspaceId) return;
    setActionLoading(returnId);
    try {
      await apiFetch(`/returns/${workspaceId}/${returnId}/approve`, {
        method: 'PATCH',
        body: JSON.stringify({}),
      });
      await loadReturns();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось одобрить возврат');
    } finally {
      setActionLoading(null);
    }
  };

  const rejectReturn = async (returnId: number) => {
    if (!workspaceId || !rejectReason.trim()) {
      setError('Укажите причину отклонения');
      return;
    }
    setActionLoading(returnId);
    try {
      await apiFetch(`/returns/${workspaceId}/${returnId}/reject`, {
        method: 'PATCH',
        body: JSON.stringify({ reason: rejectReason.trim() }),
      });
      setRejectReason('');
      await loadReturns();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось отклонить возврат');
    } finally {
      setActionLoading(null);
    }
  };

  useEffect(() => {
    loadReturns();
  }, [loadReturns]);
  useShopChange(loadReturns);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="warning"><Clock className="h-3 w-3 mr-1" />Ожидает</Badge>;
      case 'approved':
        return <Badge variant="success"><Check className="h-3 w-3 mr-1" />Одобрен</Badge>;
      case 'rejected':
        return <Badge variant="danger"><X className="h-3 w-3 mr-1" />Отклонён</Badge>;
      case 'processing':
        return <Badge variant="info"><RefreshCw className="h-3 w-3 mr-1" />Обработка</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  if (workspaceId === null) {
    return (
      <AppShell title="Возвраты">
        <Card className="p-8 text-center text-gray-500">
          Выберите магазин для просмотра возвратов
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell title="Возвраты">
      <div className="space-y-4">
        <ErrorBanner error={error} onRetry={loadReturns} onDismiss={() => setError(null)} />

        {/* Statistics cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Card className="p-4">
              <div className="text-sm text-gray-500">Всего</div>
              <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
            </Card>
            <Card className="p-4">
              <div className="text-sm text-yellow-700">Ожидают</div>
              <div className="text-2xl font-bold text-yellow-700">{stats.pending}</div>
            </Card>
            <Card className="p-4">
              <div className="text-sm text-green-700">Одобрено</div>
              <div className="text-2xl font-bold text-green-700">{stats.approved}</div>
            </Card>
            <Card className="p-4">
              <div className="text-sm text-red-600">Отклонено</div>
              <div className="text-2xl font-bold text-red-600">{stats.rejected}</div>
            </Card>
            <Card className="p-4">
              <div className="text-sm text-gray-500">Сумма</div>
              <div className="text-2xl font-bold text-gray-900">
                {formatRub(stats.totalAmount ?? 0)} ₽
              </div>
            </Card>
          </div>
        )}

        {/* Reasons breakdown */}
        {stats?.byReason && Object.keys(stats.byReason).length > 0 && (
          <Card className="p-4">
            <div className="text-sm font-medium text-gray-700 mb-3">Причины возвратов</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(stats.byReason)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([reason, count]) => (
                  <Badge key={reason} variant="neutral" className="text-sm">
                    {reason}: {count}
                  </Badge>
                ))}
            </div>
          </Card>
        )}

        {/* Filters */}
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-gray-500" />
              <span className="text-sm text-gray-600">Фильтры:</span>
            </div>

            <select
              className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
            >
              <option value="">Все статусы</option>
              <option value="pending">Ожидают</option>
              <option value="approved">Одобренные</option>
              <option value="rejected">Отклонённые</option>
              <option value="processing">В обработке</option>
            </select>

            <div className="flex items-center gap-2 min-w-[200px]">
              <ProductSearchInput
                workspaceId={workspaceId}
                value={filterNmId}
                onChange={setFilterNmId}
                single
                compact
                placeholder="Товар"
              />
            </div>

            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-gray-500" />
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-36"
              />
              <span className="text-gray-500">—</span>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-36"
              />
            </div>

            <Button variant="neutral" size="sm" onClick={loadReturns} loading={loading}>
              <RefreshCw className="h-4 w-4" />
              Обновить
            </Button>
          </div>
        </Card>

        {/* Returns list */}
        <div className="space-y-3">
          {loading ? (
            <Card className="p-8 text-center text-gray-500">Загрузка...</Card>
          ) : returns.length === 0 ? (
            <Card className="p-8 text-center text-gray-500">
              <Package className="h-12 w-12 mx-auto mb-3 text-gray-300" />
              <p>Нет возвратов за выбранный период</p>
            </Card>
          ) : (
            returns.map((ret) => (
              <Card key={ret.returnId} className="overflow-hidden">
                <div
                  className="p-4 cursor-pointer hover:bg-gray-50 transition-colors"
                  onClick={() => setExpandedId(expandedId === ret.returnId ? null : ret.returnId)}
                >
                  <div className="flex items-start gap-4">
                    {/* Product image */}
                    {ret.photoUrl ? (
                      <img
                        src={ret.photoUrl}
                        alt=""
                        className="w-16 h-16 rounded-lg object-cover"
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-lg bg-gray-100 flex items-center justify-center">
                        <Package className="h-6 w-6 text-gray-500" />
                      </div>
                    )}

                    {/* Product info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-medium text-gray-900 truncate">
                            {ret.productTitle || 'Без названия'}
                          </div>
                          <div className="text-sm text-gray-500">
                            {ret.brandName && <span>{ret.brandName} · </span>}
                            <span className="text-gray-500">#<NmIdLink nmId={ret.nmId} /></span>
                          </div>
                        </div>
                        {getStatusBadge(ret.status)}
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-gray-600">
                        {ret.reason && (
                          <div className="flex items-center gap-1">
                            <AlertTriangle className="h-4 w-4 text-yellow-500" />
                            {ret.reason}
                          </div>
                        )}
                        {ret.amount != null && (
                          <div className="font-medium">
                            {formatRub(ret.amount)} ₽
                          </div>
                        )}
                        {ret.quantity != null && ret.quantity > 1 && (
                          <Badge variant="secondary">{ret.quantity} шт.</Badge>
                        )}
                        <div className="text-gray-500">
                          {new Date(ret.createdAt).toLocaleDateString('ru-RU')}
                        </div>
                      </div>
                    </div>

                    {/* Expand icon */}
                    <div className="text-gray-500">
                      {expandedId === ret.returnId ? (
                        <ChevronUp className="h-5 w-5" />
                      ) : (
                        <ChevronDown className="h-5 w-5" />
                      )}
                    </div>
                  </div>
                </div>

                {/* Expanded content */}
                {expandedId === ret.returnId && (
                  <div className="px-4 pb-4 border-t border-gray-100 pt-4 space-y-4">
                    {/* Comment */}
                    {ret.comment && (
                      <div className="bg-gray-50 rounded-lg p-3">
                        <div className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-1">
                          <MessageSquare className="h-4 w-4" />
                          Комментарий покупателя
                        </div>
                        <p className="text-sm text-gray-600">{ret.comment}</p>
                      </div>
                    )}

                    {/* Actions for pending returns */}
                    {ret.status === 'pending' && (
                      <div className="space-y-3">
                        <div className="flex gap-2">
                          <Button
                            variant="success"
                            size="sm"
                            onClick={() => approveReturn(ret.returnId)}
                            loading={actionLoading === ret.returnId}
                          >
                            <Check className="h-4 w-4" />
                            Одобрить возврат
                          </Button>
                        </div>

                        <div className="flex gap-2">
                          <Input
                            placeholder="Причина отклонения..."
                            value={expandedId === ret.returnId ? rejectReason : ''}
                            onChange={(e) => setRejectReason(e.target.value)}
                            className="flex-1"
                          />
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => rejectReturn(ret.returnId)}
                            loading={actionLoading === ret.returnId}
                            disabled={!rejectReason.trim()}
                          >
                            <X className="h-4 w-4" />
                            Отклонить
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            ))
          )}
        </div>

        {/* Pagination info */}
        {returns.length > 0 && (
          <div className="text-sm text-gray-500 text-center">
            Показано {returns.length} возвратов
          </div>
        )}
      </div>
    </AppShell>
  );
}
