'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { useShopParam } from '@/hooks/useShopParam';
import { Sparkles, AlertTriangle, ThumbsUp, TrendingDown, Lightbulb, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/cn';

interface SummaryStats {
  totalReviews: number;
  totalQuestions: number;
  avgRating: number | null;
  ratingsByStar: Record<string, number>;
  negativeCount: number;
  answeredPct: number;
}

interface TopProblem {
  theme: string;
  count: number;
  severity: 'low' | 'medium' | 'high';
  examples: string[];
  recommendation: string;
}

interface SummaryResult {
  period: string;
  scope: string;
  stats: SummaryStats;
  topProblems: TopProblem[];
  topPraise: Array<{ theme: string; count: number }>;
  trend: string;
  actionableInsights: string[];
  cached?: boolean;
}

interface Props {
  workspaceId: number;
}

const PERIOD_OPTIONS = [30, 60, 90, 120] as const;

const SEVERITY_COLORS: Record<TopProblem['severity'], string> = {
  high: 'bg-red-50 border-red-200 text-red-900',
  medium: 'bg-orange-50 border-orange-200 text-orange-900',
  low: 'bg-yellow-50 border-yellow-200 text-yellow-900',
};

const SEVERITY_BADGES: Record<TopProblem['severity'], string> = {
  high: 'bg-red-600 text-white',
  medium: 'bg-orange-500 text-white',
  low: 'bg-yellow-500 text-white',
};

export function FeedbackSummaryPanel({ workspaceId }: Props) {
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SummaryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shopParam = useShopParam();

  const runSummary = async () => {
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { days };
      // Parse shopId from useShopParam (returns '&shopId=N' or '')
      const shopMatch = shopParam.match(/shopId=(\d+)/);
      if (shopMatch) body.shopId = Number(shopMatch[1]);

      const res = (await apiFetch(`/feedback/${workspaceId}/summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })) as SummaryResult | { error: string };

      if ('error' in res) {
        setError(res.error);
      } else {
        setResult(res);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось получить сводку');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="p-4 border-violet-200 bg-gradient-to-br from-violet-50/40 to-indigo-50/40">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-violet-600 flex items-center justify-center text-white">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <div className="text-sm font-semibold text-violet-900">AI-анализ всех отзывов</div>
            <div className="text-[11px] text-violet-700">Выявит повторяющиеся проблемы, темы и даст рекомендации</div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-xs text-gray-600">Период:</span>
        {PERIOD_OPTIONS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDays(d)}
            disabled={loading}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              days === d
                ? 'bg-violet-600 text-white'
                : 'bg-white text-violet-700 border border-violet-200 hover:bg-violet-100',
              loading && 'opacity-50 cursor-not-allowed',
            )}
          >
            {d} дней
          </button>
        ))}
        <Button
          variant="primary"
          size="sm"
          onClick={runSummary}
          disabled={loading}
          className="ml-auto"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              Анализ...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4 mr-1" />
              Сделать сводку
            </>
          )}
        </Button>
      </div>

      {error && (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-3 space-y-4">
          {/* Header with stats */}
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-sm font-medium text-gray-900">
                Сводка за {result.period} · {result.scope}
                {result.cached && <span className="ml-2 text-[11px] text-gray-500">(из кэша)</span>}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setResult(null)}
              className="p-1 rounded hover:bg-gray-100 text-gray-500"
              title="Скрыть"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <Stat label="Отзывов" value={result.stats.totalReviews} />
            <Stat label="Вопросов" value={result.stats.totalQuestions} />
            <Stat
              label="Средняя оценка"
              value={result.stats.avgRating != null ? `${result.stats.avgRating.toFixed(2)} ★` : '—'}
              tone={result.stats.avgRating != null && result.stats.avgRating < 4 ? 'red' : 'default'}
            />
            <Stat
              label="Негативных"
              value={result.stats.negativeCount}
              tone={result.stats.negativeCount > 0 ? 'red' : 'default'}
            />
            <Stat label="% ответов" value={`${result.stats.answeredPct}%`} />
          </div>

          {/* Top Problems */}
          {result.topProblems.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-red-600" />
                <h4 className="font-semibold text-sm text-gray-900">Повторяющиеся проблемы</h4>
              </div>
              <div className="space-y-2">
                {result.topProblems.map((p, i) => (
                  <div
                    key={i}
                    className={cn('rounded-lg border p-3', SEVERITY_COLORS[p.severity])}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="font-medium text-sm">{p.theme}</div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="neutral" size="sm">{p.count}</Badge>
                        <span className={cn('px-2 py-0.5 rounded text-[10px] font-bold uppercase', SEVERITY_BADGES[p.severity])}>
                          {p.severity}
                        </span>
                      </div>
                    </div>
                    {p.examples.length > 0 && (
                      <ul className="mt-1.5 text-xs space-y-0.5 list-disc list-inside opacity-80">
                        {p.examples.map((ex, j) => (
                          <li key={j}>«{ex}»</li>
                        ))}
                      </ul>
                    )}
                    {p.recommendation && (
                      <div className="mt-2 text-xs flex items-start gap-1.5 pt-2 border-t border-current border-opacity-20">
                        <Lightbulb className="w-3 h-3 mt-0.5 shrink-0" />
                        <span><b>Что сделать:</b> {p.recommendation}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top Praise */}
          {result.topPraise.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <ThumbsUp className="w-4 h-4 text-green-600" />
                <h4 className="font-semibold text-sm text-gray-900">Что чаще всего хвалят</h4>
              </div>
              <div className="flex flex-wrap gap-2">
                {result.topPraise.map((p, i) => (
                  <div key={i} className="inline-flex items-center gap-1.5 rounded-lg border border-green-200 bg-green-50 px-3 py-1 text-xs text-green-900">
                    <span className="font-medium">{p.theme}</span>
                    <Badge variant="neutral" size="sm">{p.count}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Trend */}
          {result.trend && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 flex items-start gap-2">
              <TrendingDown className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
              <div className="text-sm text-blue-900"><b>Тренд:</b> {result.trend}</div>
            </div>
          )}

          {/* Actionable insights */}
          {result.actionableInsights.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Lightbulb className="w-4 h-4 text-amber-600" />
                <h4 className="font-semibold text-sm text-gray-900">Конкретные шаги</h4>
              </div>
              <ol className="space-y-1.5 text-sm text-gray-800 list-decimal list-inside pl-1">
                {result.actionableInsights.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number | string;
  tone?: 'default' | 'red';
}) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-white px-3 py-2',
        tone === 'red' ? 'border-red-200 bg-red-50/50' : 'border-gray-200',
      )}
    >
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={cn('text-base font-semibold', tone === 'red' && 'text-red-700')}>
        {value}
      </div>
    </div>
  );
}
