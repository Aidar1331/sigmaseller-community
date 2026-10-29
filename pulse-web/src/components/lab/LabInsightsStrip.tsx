/**
 * LabInsightsStrip — главный компонент Лаборатории на странице /dynamics.
 *
 * Поведение:
 *   - Автоматически подгружается после выбора товара (nmId + shopId).
 *   - Показывает period-advice баннер + до 3-х карточек (critical → growth → false_alarm).
 *   - Без кликов пользователя: «выбрал товар → получил инсайты».
 *   - Никакой статистической терминологии в DOM.
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { apiFetch } from '@/lib/api';
import { InsightCard, type InsightPayload } from './InsightCard';
import { PeriodAdviceBanner } from './PeriodAdviceBanner';
import { NoSignalEmpty } from './NoSignalEmpty';
import { LabDeepDrawer } from './LabDeepDrawer';

interface PeriodAdvice {
  n: number;
  badge: 'green' | 'yellow' | 'red';
  message: string;
  recommendations: string[];
}

interface InsightsResponse {
  ok: boolean;
  workspaceId: number;
  critical: InsightPayload[];
  growthPoints: InsightPayload[];
  falseAlarms: InsightPayload[];
  totalPairsEvaluated: number;
}

interface Props {
  workspaceId: number;
  shopId: number;
  nmId: number;
  from: string; // YYYY-MM-DD
  to: string;
}

export function LabInsightsStrip({ workspaceId, shopId, nmId, from, to }: Props) {
  const router = useRouter();
  const [advice, setAdvice] = useState<PeriodAdvice | null>(null);
  const [insights, setInsights] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const aborter = useRef<AbortController | null>(null);

  // Стабильный ключ для кэша / ре-фетча
  const key = `${workspaceId}:${shopId}:${nmId}:${from}:${to}`;

  useEffect(() => {
    if (!workspaceId || !shopId || !nmId) return;
    aborter.current?.abort();
    const ac = new AbortController();
    aborter.current = ac;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [adv, ins] = await Promise.all([
          apiFetch<{ ok: boolean } & PeriodAdvice>(
            `/lab/${workspaceId}/period-advice?from=${from}&to=${to}`,
            { signal: ac.signal } as RequestInit,
          ),
          apiFetch<InsightsResponse>(
            `/lab/${workspaceId}/insights?shopId=${shopId}&nmId=${nmId}&from=${from}&to=${to}`,
            { signal: ac.signal } as RequestInit,
          ),
        ]);
        if (ac.signal.aborted) return;
        setAdvice(adv as PeriodAdvice);
        setInsights(ins);
      } catch (err: unknown) {
        if (ac.signal.aborted) return;
        const msg = err instanceof Error ? err.message : 'Неизвестная ошибка';
        setError(msg);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();

    return () => ac.abort();
  }, [key, workspaceId, shopId, nmId, from, to]);

  // Топ-3 карточки: critical → growth → false_alarm
  const cards = useMemo(() => {
    if (!insights) return [];
    const merged = [
      ...insights.critical.map((i) => ({ ...i, _cat: 'critical' as const })),
      ...insights.growthPoints.map((i) => ({ ...i, _cat: 'growth_point' as const })),
      ...insights.falseAlarms.map((i) => ({ ...i, _cat: 'false_alarm' as const })),
    ];
    // Fingerprint для скрытия: hypothesisId + nmId
    return merged
      .filter((i) => !hidden.has(`${i.hypothesisId}:${nmId}`))
      .slice(0, 3);
  }, [insights, hidden, nmId]);

  if (!workspaceId || !shopId || !nmId) return null;

  // Период очень короткий — показываем мягкий баннер, не фетчим
  if (advice?.badge === 'red' && (advice.n ?? 0) < 14) {
    return (
      <Card className="p-4 mt-4">
        <Header />
        <div className="mt-3">
          <NoSignalEmpty reason="short_period" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-4 mt-4">
      <Header />

      <div className="mt-3">
        <PeriodAdviceBanner advice={advice} loading={loading && !advice} />
      </div>

      {error && (
        <div className="mt-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">
          Не удалось загрузить инсайты: {error}
        </div>
      )}

      {loading && !insights && (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          {[0, 1, 2].map((k) => (
            <div key={k} className="animate-pulse bg-slate-100 rounded-md h-[240px]" />
          ))}
        </div>
      )}

      {insights && cards.length === 0 && (
        <div className="mt-4">
          <NoSignalEmpty
            reason={insights.totalPairsEvaluated === 0 ? 'sparse' : 'no_signal'}
          />
        </div>
      )}

      {cards.length > 0 && (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          {cards.map((c) => (
            <InsightCard
              key={`${c.hypothesisId}:${c._cat}`}
              insight={c}
              nmId={nmId}
              onAskAi={(prompt) => {
                const params = new URLSearchParams({
                  prefill: prompt,
                  shopId: String(shopId),
                  nmId: String(nmId),
                });
                router.push(`/ai?${params.toString()}`);
              }}
              onDismiss={() =>
                setHidden((prev) => {
                  const next = new Set(prev);
                  next.add(`${c.hypothesisId}:${nmId}`);
                  return next;
                })
              }
            />
          ))}
        </div>
      )}

      {insights && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="text-xs font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-md px-3 py-1.5 transition"
          >
            🧠 Объяснить данные глубже
          </button>
        </div>
      )}

      <LabDeepDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        workspaceId={workspaceId}
        shopId={shopId}
        nmId={nmId}
        from={from}
        to={to}
      />
    </Card>
  );
}

function Header() {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="text-sm font-semibold text-[var(--content-text)]">
          Что это значит для вашего товара
        </div>
        <div className="text-[11px] text-slate-500 mt-0.5">
          Лаборатория разбирает зависимости и даёт рекомендации
        </div>
      </div>
    </div>
  );
}
