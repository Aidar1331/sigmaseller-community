'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { apiFetch } from '@/lib/api';
import { useShopParam } from '@/hooks/useShopParam';
import { cn } from '@/lib/cn';

interface CategoriesResponse {
  period: string;
  total: number;
  categorized: number;
  uncategorizedHint: string | null;
  byCategory: Record<string, number>;
  bySentiment: Record<string, number>;
}

interface Props {
  workspaceId: number;
}

const CATEGORY_META: Record<
  string,
  { label: string; emoji: string; color: string; bgClass: string; barClass: string }
> = {
  quality: { label: 'Качество', emoji: '🔧', color: '#dc2626', bgClass: 'bg-red-50', barClass: 'bg-red-500' },
  delivery: { label: 'Доставка', emoji: '🚚', color: '#ea580c', bgClass: 'bg-orange-50', barClass: 'bg-orange-500' },
  packaging: { label: 'Упаковка', emoji: '📦', color: '#ca8a04', bgClass: 'bg-yellow-50', barClass: 'bg-yellow-500' },
  mismatch: { label: 'Несоответствие', emoji: '❓', color: '#9333ea', bgClass: 'bg-purple-50', barClass: 'bg-purple-500' },
  service: { label: 'Сервис', emoji: '💬', color: '#2563eb', bgClass: 'bg-blue-50', barClass: 'bg-blue-500' },
  praise: { label: 'Похвала', emoji: '👍', color: '#16a34a', bgClass: 'bg-green-50', barClass: 'bg-green-500' },
  other: { label: 'Другое', emoji: '·', color: '#6b7280', bgClass: 'bg-gray-50', barClass: 'bg-gray-400' },
};

const SENTIMENT_META: Record<string, { label: string; emoji: string; barClass: string }> = {
  negative: { label: 'Негативные', emoji: '😞', barClass: 'bg-red-500' },
  neutral: { label: 'Нейтральные', emoji: '😐', barClass: 'bg-gray-400' },
  positive: { label: 'Позитивные', emoji: '😊', barClass: 'bg-green-500' },
};

const PERIODS = [30, 60, 90, 120] as const;
const CATEGORY_ORDER = ['quality', 'delivery', 'packaging', 'mismatch', 'service', 'other', 'praise'];

export function FeedbackCategoriesDashboard({ workspaceId }: Props) {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<CategoriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const shopParam = useShopParam();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = (await apiFetch(
          `/feedback/${workspaceId}/categories?days=${days}${shopParam}`,
        )) as CategoriesResponse;
        if (!cancelled) setData(res);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Не удалось загрузить');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [workspaceId, days, shopParam]);

  const maxCount = data ? Math.max(1, ...Object.values(data.byCategory)) : 1;
  const maxSentiment = data ? Math.max(1, ...Object.values(data.bySentiment)) : 1;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-semibold text-gray-900">Распределение по темам</div>
          <div className="text-[11px] text-gray-500">
            {data ? `${data.categorized} из ${data.total} отзывов классифицированы AI` : ' '}
          </div>
        </div>
        <div className="flex gap-1.5">
          {PERIODS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={cn(
                'px-2.5 py-1 rounded text-xs font-medium transition-colors',
                days === d
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200',
              )}
            >
              {d}д
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="text-sm text-gray-500 py-4 text-center">Загрузка…</div>}
      {error && <div className="text-sm text-red-600 py-2">{error}</div>}

      {!loading && !error && data && data.categorized === 0 && (
        <div className="text-sm text-gray-500 py-4 text-center">
          За {data.period} нет классифицированных отзывов.
          {data.uncategorizedHint && (
            <div className="text-xs mt-1 text-gray-400">{data.uncategorizedHint}</div>
          )}
        </div>
      )}

      {!loading && !error && data && data.categorized > 0 && (
        <div className="space-y-3">
          {/* Category bars */}
          <div className="space-y-1.5">
            {CATEGORY_ORDER.map((cat) => {
              const count = data.byCategory[cat] ?? 0;
              if (count === 0) return null;
              const meta = CATEGORY_META[cat] ?? CATEGORY_META.other;
              const pct = (count / maxCount) * 100;
              return (
                <div key={cat} className="flex items-center gap-2">
                  <div className="w-32 text-xs text-gray-700 flex items-center gap-1 shrink-0">
                    <span>{meta.emoji}</span>
                    <span>{meta.label}</span>
                  </div>
                  <div className="flex-1 h-5 rounded bg-gray-100 overflow-hidden relative">
                    <div
                      className={cn('h-full transition-all', meta.barClass)}
                      style={{ width: `${pct}%` }}
                    />
                    <div className="absolute inset-0 flex items-center px-2 text-xs font-semibold text-gray-800 mix-blend-difference">
                      {count} ({Math.round((count / data.categorized) * 100)}%)
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Sentiment split */}
          {Object.keys(data.bySentiment).length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">Настроение</div>
              <div className="flex gap-1.5">
                {(['negative', 'neutral', 'positive'] as const).map((s) => {
                  const count = data.bySentiment[s] ?? 0;
                  if (count === 0) return null;
                  const meta = SENTIMENT_META[s];
                  const sentTotal = Object.values(data.bySentiment).reduce((a, b) => a + b, 0);
                  const pct = sentTotal > 0 ? Math.round((count / sentTotal) * 100) : 0;
                  return (
                    <div
                      key={s}
                      className="flex-1 rounded-lg border border-gray-200 p-2 bg-white"
                    >
                      <div className="text-xs text-gray-600 flex items-center gap-1">
                        <span>{meta.emoji}</span>
                        <span>{meta.label}</span>
                      </div>
                      <div className="text-lg font-semibold mt-0.5">
                        {count} <span className="text-xs text-gray-500">({pct}%)</span>
                      </div>
                      <div className="h-1 mt-1 rounded bg-gray-100 overflow-hidden">
                        <div className={cn('h-full', meta.barClass)} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {data.uncategorizedHint && (
            <div className="text-[11px] text-gray-500 italic">{data.uncategorizedHint}</div>
          )}
        </div>
      )}
    </Card>
  );
}
