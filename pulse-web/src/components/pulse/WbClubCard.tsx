'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { formatRub, formatPct } from '@/lib/format';
import { Crown, TrendingUp, Users, ShoppingBag } from 'lucide-react';
import { cn } from '@/lib/cn';

type WbClubStats = {
  totalOrders: number;
  wbClubOrders: number;
  wbClubPercent: number;
  totalRevenue: number;
  wbClubRevenue: number;
  wbClubRevenuePercent: number;
  avgOrderValue: number;
  wbClubAvgOrderValue: number;
};

interface WbClubCardProps {
  workspaceId: number;
  dateFrom: string;
  dateTo: string;
}

export function WbClubCard({ workspaceId, dateFrom, dateTo }: WbClubCardProps) {
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<WbClubStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!workspaceId || !dateFrom || !dateTo) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/analytics/${workspaceId}/wb-club`, {
        method: 'POST',
        body: JSON.stringify({ dateFrom, dateTo }),
      }) as { ok: boolean; totals?: WbClubStats; error?: string };

      if (res.ok && res.totals) {
        setStats(res.totals);
      } else {
        setError(res.error || 'Нет данных');
      }
    } catch (e: any) {
      setError(e?.message ?? 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, dateFrom, dateTo]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Hide card completely when loading, error, or no data
  if (loading || error || !stats) {
    return null;
  }

  return (
    <Card className="overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-white">
            <Crown className="h-5 w-5" />
            <span className="font-semibold">WB Club</span>
          </div>
          <Badge className="bg-white/20 text-white border-0">
            {formatPct(stats.wbClubPercent)}% заказов
          </Badge>
        </div>
      </div>

      {/* Stats */}
      <div className="p-4">
        <div className="grid grid-cols-2 gap-4">
          {/* Orders */}
          <div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
              <ShoppingBag className="h-3.5 w-3.5" />
              Заказы WB Club
            </div>
            <div className="text-xl font-bold text-gray-900">
              {stats.wbClubOrders.toLocaleString('ru-RU')}
            </div>
            <div className="text-xs text-gray-500">
              из {stats.totalOrders.toLocaleString('ru-RU')} всего
            </div>
          </div>

          {/* Revenue */}
          <div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
              <TrendingUp className="h-3.5 w-3.5" />
              Выручка WB Club
            </div>
            <div className="text-xl font-bold text-gray-900">
              {formatRub(stats.wbClubRevenue)}
            </div>
            <div className="text-xs text-gray-500">
              {formatPct(stats.wbClubRevenuePercent)}% от общей
            </div>
          </div>

          {/* Avg Order */}
          <div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
              <Users className="h-3.5 w-3.5" />
              Средний чек
            </div>
            <div className="text-lg font-semibold text-gray-900">
              {formatRub(stats.wbClubAvgOrderValue)}
            </div>
            <div className={cn(
              'text-xs',
              stats.wbClubAvgOrderValue > stats.avgOrderValue ? 'text-green-700' : 'text-gray-500'
            )}>
              {stats.wbClubAvgOrderValue > stats.avgOrderValue ? '↑ ' : ''}
              Обычный: {formatRub(stats.avgOrderValue)}
            </div>
          </div>

          {/* Premium Indicator */}
          <div className="flex items-center justify-center">
            <div className={cn(
              'text-center px-4 py-2 rounded-xl',
              stats.wbClubPercent > 30 ? 'bg-amber-50' : 'bg-gray-50'
            )}>
              <div className={cn(
                'text-2xl font-bold',
                stats.wbClubPercent > 30 ? 'text-amber-700' : 'text-gray-600'
              )}>
                {formatPct(stats.wbClubPercent)}%
              </div>
              <div className="text-xs text-gray-500">доля клуба</div>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
