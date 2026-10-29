'use client';

import { useState, useEffect } from 'react';
import { apiFetch } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Plus, Trash2, RefreshCw, TrendingUp, TrendingDown, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { ErrorBanner } from '@/components/ui/ErrorBanner';

interface Competitor {
  competitorId: number;
  nmId: number;
  name: string;
  isActive: boolean;
  createdAt: string;
  latestPosition?: {
    position: number | null;
    page: number | null;
    price: number | null;
    priceWithDiscount: number | null;
    discount: number | null;
    reviewCount: number | null;
    rating: number | null;
    isPromo: boolean;
    checkedAt: string;
  };
  keywords?: Array<{ keywordId: number; keyword: string }>;
}

interface CompetitorAnalysisProps {
  workspaceId: number;
}

export function CompetitorAnalysis({ workspaceId }: CompetitorAnalysisProps) {
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add form
  const [showAdd, setShowAdd] = useState(false);
  const [newNmId, setNewNmId] = useState('');
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  // Expanded competitor
  const [expanded, setExpanded] = useState<number | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const fetchCompetitors = async () => {
    try {
      setLoading(true);
      const data = await apiFetch<Competitor[]>(`/seo/${workspaceId}/competitors`);
      setCompetitors(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCompetitors();
  }, [workspaceId]);

  const handleAdd = async () => {
    if (!newNmId.trim() || !newName.trim()) return;

    setAdding(true);
    try {
      await apiFetch(`/seo/${workspaceId}/competitors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nmId: Number(newNmId), name: newName }),
      });
      setNewNmId('');
      setNewName('');
      setShowAdd(false);
      setError(null);
      fetchCompetitors();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось добавить конкурента');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (competitorId: number) => {
    if (!confirm('Удалить конкурента?')) return;

    try {
      await apiFetch(`/seo/${workspaceId}/competitors/${competitorId}`, {
        method: 'DELETE',
      });
      setError(null);
      fetchCompetitors();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось удалить конкурента');
    }
  };

  const handleExpand = async (competitorId: number) => {
    if (expanded === competitorId) {
      setExpanded(null);
      return;
    }

    setExpanded(competitorId);
    setHistoryLoading(true);

    try {
      const data = await apiFetch(`/seo/${workspaceId}/competitors/${competitorId}/positions?limit=30`);
      setHistory(data.positions || []);
    } catch (err: any) {
      setHistory([]);
      setError(err?.message ?? 'Не удалось загрузить историю конкурента');
    } finally {
      setHistoryLoading(false);
    }
  };

  if (loading) {
    return <div className="text-center py-8 text-muted-foreground">Загрузка...</div>;
  }

  return (
    <div className="space-y-4">
      {error && (
        <ErrorBanner error={error} onRetry={fetchCompetitors} onDismiss={() => setError(null)} />
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">👥 Мониторинг конкурентов</h3>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchCompetitors}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Обновить
          </Button>
          <Button size="sm" onClick={() => setShowAdd(!showAdd)}>
            <Plus className="h-4 w-4 mr-1" />
            Добавить
          </Button>
        </div>
      </div>

      {/* Add form */}
      {showAdd && (
        <Card className="p-4">
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="text-sm text-muted-foreground">Артикул WB</label>
              <Input
                type="text"
                inputMode="numeric"
                value={newNmId}
                onChange={(e) => setNewNmId(e.target.value.replace(/\D/g, ''))}
                placeholder="140884915"
                className="font-mono"
              />
              <div className="text-xs text-muted-foreground mt-1">
                Из URL карточки: wildberries.ru/catalog/<span className="font-mono text-indigo-600">140884915</span>/detail
              </div>
            </div>
            <div className="flex-1">
              <label className="text-sm text-muted-foreground">Название</label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Конкурент X"
              />
            </div>
            <Button onClick={handleAdd} disabled={adding}>
              {adding ? 'Добавляю...' : 'Добавить'}
            </Button>
          </div>
        </Card>
      )}

      {/* Competitors list */}
      {competitors.length === 0 ? (
        <Card className="p-8 text-center text-muted-foreground">
          Нет отслеживаемых конкурентов. Добавьте первого!
        </Card>
      ) : (
        <Card className="divide-y">
          {competitors.map((c) => (
            <div key={c.competitorId}>
              <div
                className="p-4 hover:bg-muted/50 cursor-pointer"
                onClick={() => handleExpand(c.competitorId)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="font-medium">{c.name}</div>
                      <div className="text-sm text-muted-foreground">
                        <NmIdLink
                          nmId={c.nmId}
                          className="text-blue-600 hover:underline inline-flex items-center gap-1"
                        >
                          {c.nmId}
                          <ExternalLink className="h-3 w-3" />
                        </NmIdLink>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {c.latestPosition && (
                      <>
                        {/* Position */}
                        <div className="text-center">
                          <div
                            className={cn(
                              'text-lg font-bold',
                              c.latestPosition.position && c.latestPosition.position <= 10
                                ? 'text-green-700'
                                : c.latestPosition.position && c.latestPosition.position <= 50
                                  ? 'text-yellow-700'
                                  : 'text-red-600'
                            )}
                          >
                            {c.latestPosition.position ?? '—'}
                          </div>
                          <div className="text-xs text-muted-foreground">позиция</div>
                        </div>

                        {/* Price */}
                        <div className="text-center">
                          <div className="text-lg font-bold">
                            {c.latestPosition.priceWithDiscount
                              ? formatNumber(c.latestPosition.priceWithDiscount) + '₽'
                              : '—'}
                          </div>
                          {c.latestPosition.discount && c.latestPosition.discount > 0 && (
                            <div className="text-xs text-green-700">-{c.latestPosition.discount}%</div>
                          )}
                        </div>

                        {/* Rating */}
                        <div className="text-center">
                          <div className="text-lg font-bold">
                            {c.latestPosition.rating ?? '—'}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {c.latestPosition.reviewCount ?? 0} отз.
                          </div>
                        </div>

                        {/* Promo badge */}
                        {c.latestPosition.isPromo && (
                          <span className="px-2 py-1 bg-orange-100 text-orange-700 text-xs rounded">
                            🔥 Реклама
                          </span>
                        )}
                      </>
                    )}

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(c.competitorId);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              </div>

              {/* Expanded history */}
              {expanded === c.competitorId && (
                <div className="p-4 bg-muted/30 border-t">
                  {historyLoading ? (
                    <div className="text-center text-muted-foreground">Загрузка истории...</div>
                  ) : history.length === 0 ? (
                    <div className="text-center text-muted-foreground">Нет данных истории</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="text-left p-2">Дата</th>
                            <th className="text-left p-2">Ключ</th>
                            <th className="text-right p-2">Позиция</th>
                            <th className="text-right p-2">Цена</th>
                            <th className="text-right p-2">Скидка</th>
                            <th className="text-right p-2">Рейтинг</th>
                            <th className="text-center p-2">Промо</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history.map((h, i) => (
                            <tr key={i} className="border-b">
                              <td className="p-2">{new Date(h.checkedAt).toLocaleString('ru')}</td>
                              <td className="p-2 truncate max-w-[150px]" title={h.keyword}>
                                {h.keyword || '—'}
                              </td>
                              <td className="p-2 text-right font-mono">
                                <span
                                  className={cn(
                                    'px-2 py-0.5 rounded',
                                    h.position <= 10
                                      ? 'bg-green-100 text-green-700'
                                      : h.position <= 50
                                        ? 'bg-yellow-100 text-yellow-700'
                                        : 'bg-red-100 text-red-700'
                                  )}
                                >
                                  {h.position ?? '—'}
                                </span>
                              </td>
                              <td className="p-2 text-right">
                                {h.priceWithDiscount ? formatNumber(h.priceWithDiscount) + '₽' : '—'}
                              </td>
                              <td className="p-2 text-right">
                                {h.discount ? `-${h.discount}%` : '—'}
                              </td>
                              <td className="p-2 text-right">{h.rating ?? '—'}</td>
                              <td className="p-2 text-center">{h.isPromo ? '🔥' : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      {/* Info */}
      <div className="text-sm text-muted-foreground">
        💡 Добавьте конкурентов и привяжите их к ключевым словам. При проверке позиций будут собраны:
        позиция, цена, скидка, рейтинг, отзывы, рекламный или нет.
      </div>
    </div>
  );
}
