'use client';

import { useState } from 'react';
import { TrendingUp, TrendingDown, Edit2, RotateCcw, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';

export type Cluster = {
  cluster: number;
  phrase: string;
  count: number;
  views?: number;
  clicks?: number;
  ctr?: number;
  orders?: number;
  sum?: number;
};

export type ClusterBid = {
  cluster: number;
  bid: number;
};

type ClusterTableProps = {
  clusters: Cluster[];
  bids: ClusterBid[];
  stats?: Array<{
    cluster: number;
    views: number;
    clicks: number;
    ctr: number;
    orders: number;
    sum: number;
    sumPrice: number;
  }>;
  onSetBids: (bids: ClusterBid[]) => Promise<void>;
  onResetBids: (clusters: number[]) => Promise<void>;
  loading?: boolean;
};

export function ClusterTable({
  clusters,
  bids,
  stats = [],
  onSetBids,
  onResetBids,
  loading,
}: ClusterTableProps) {
  const [editingBids, setEditingBids] = useState<Record<number, number>>({});
  const [selectedClusters, setSelectedClusters] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  // Merge clusters with bids and stats
  const bidMap = new Map(bids.map((b) => [b.cluster, b.bid]));
  const statsMap = new Map(stats.map((s) => [s.cluster, s]));

  const mergedData = clusters.map((c) => ({
    ...c,
    bid: bidMap.get(c.cluster) ?? 0,
    stats: statsMap.get(c.cluster),
  }));

  const handleBidChange = (cluster: number, value: string) => {
    const numValue = parseInt(value, 10);
    if (!isNaN(numValue) && numValue >= 0) {
      setEditingBids((prev) => ({ ...prev, [cluster]: numValue }));
    }
  };

  const handleSaveBids = async () => {
    const bidsToSave = Object.entries(editingBids).map(([cluster, bid]) => ({
      cluster: parseInt(cluster, 10),
      bid,
    }));
    if (bidsToSave.length === 0) return;

    setSaving(true);
    try {
      await onSetBids(bidsToSave);
      setEditingBids({});
    } finally {
      setSaving(false);
    }
  };

  const handleResetSelected = async () => {
    if (selectedClusters.size === 0) return;
    setSaving(true);
    try {
      await onResetBids(Array.from(selectedClusters));
      setSelectedClusters(new Set());
    } finally {
      setSaving(false);
    }
  };

  const toggleSelect = (cluster: number) => {
    setSelectedClusters((prev) => {
      const next = new Set(prev);
      if (next.has(cluster)) {
        next.delete(cluster);
      } else {
        next.add(cluster);
      }
      return next;
    });
  };

  const selectAll = () => {
    if (selectedClusters.size === clusters.length) {
      setSelectedClusters(new Set());
    } else {
      setSelectedClusters(new Set(clusters.map((c) => c.cluster)));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (clusters.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        Нет кластеров для этой кампании
      </div>
    );
  }

  const hasChanges = Object.keys(editingBids).length > 0;

  return (
    <div className="space-y-4">
      {/* Actions bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={selectedClusters.size === clusters.length && clusters.length > 0}
            onChange={selectAll}
            className="h-4 w-4 rounded border-gray-300"
          />
          <span className="text-sm text-gray-500">
            {selectedClusters.size > 0
              ? `Выбрано: ${selectedClusters.size}`
              : `Всего: ${clusters.length}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {selectedClusters.size > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleResetSelected}
              disabled={saving}
            >
              <RotateCcw className="h-4 w-4 mr-1" />
              Сбросить ставки
            </Button>
          )}
          {hasChanges && (
            <Button size="sm" onClick={handleSaveBids} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Edit2 className="h-4 w-4 mr-1" />
              )}
              Сохранить ({Object.keys(editingBids).length})
            </Button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700">
              <th className="py-3 px-2 text-left w-8"></th>
              <th className="py-3 px-2 text-left">Кластер</th>
              <th className="py-3 px-2 text-right">Показы</th>
              <th className="py-3 px-2 text-right">Клики</th>
              <th className="py-3 px-2 text-right">CTR</th>
              <th className="py-3 px-2 text-right">Заказы</th>
              <th className="py-3 px-2 text-right">Расход ₽</th>
              <th className="py-3 px-2 text-right w-32">Ставка ₽</th>
            </tr>
          </thead>
          <tbody>
            {mergedData.map((row) => {
              const editValue = editingBids[row.cluster];
              const currentBid = editValue !== undefined ? editValue : row.bid;
              const s = row.stats;
              const ctr = s?.ctr ?? (row.ctr ?? 0);
              const drr = s && s.sumPrice > 0 ? ((s.sum / s.sumPrice) * 100) : 0;

              return (
                <tr
                  key={row.cluster}
                  className={cn(
                    'border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50',
                    selectedClusters.has(row.cluster) && 'bg-blue-50 dark:bg-blue-900/20'
                  )}
                >
                  <td className="py-2 px-2">
                    <input
                      type="checkbox"
                      checked={selectedClusters.has(row.cluster)}
                      onChange={() => toggleSelect(row.cluster)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </td>
                  <td className="py-2 px-2">
                    <div className="font-medium">{row.phrase}</div>
                    <div className="text-xs text-gray-500">
                      #{row.cluster} · {row.count} запросов
                    </div>
                  </td>
                  <td className="py-2 px-2 text-right text-gray-600 dark:text-gray-400">
                    {formatNumber(s?.views ?? row.views ?? 0)}
                  </td>
                  <td className="py-2 px-2 text-right text-gray-600 dark:text-gray-400">
                    {formatNumber(s?.clicks ?? row.clicks ?? 0)}
                  </td>
                  <td className="py-2 px-2 text-right">
                    <Badge
                      variant={ctr >= 2 ? 'success' : ctr >= 1 ? 'warning' : 'secondary'}
                    >
                      {ctr.toFixed(2)}%
                    </Badge>
                  </td>
                  <td className="py-2 px-2 text-right">
                    {s?.orders ?? row.orders ?? 0}
                    {drr > 0 && (
                      <div className="text-xs text-gray-500">
                        ДРР: {drr.toFixed(1)}%
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-2 text-right text-gray-600 dark:text-gray-400">
                    {formatNumber(s?.sum ?? row.sum ?? 0)}
                  </td>
                  <td className="py-2 px-2 text-right">
                    <Input
                      type="number"
                      value={currentBid / 100} // convert from kopecks
                      onChange={(e) =>
                        handleBidChange(row.cluster, String(Math.round(parseFloat(e.target.value) * 100)))
                      }
                      className={cn(
                        'w-24 text-right',
                        editValue !== undefined && 'ring-2 ring-blue-500'
                      )}
                      min={0}
                      step={0.5}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
