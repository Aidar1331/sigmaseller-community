'use client';

/**
 * SeoInsightsBlock — карточки SEO-гипотез (позиции↔показы/заказы).
 * Рендерится только если insights содержит SEO-инсайты.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { InsightCard, type InsightPayload } from '../InsightCard';

interface Resp {
  ok: boolean;
  critical: InsightPayload[];
  growthPoints: InsightPayload[];
  falseAlarms: InsightPayload[];
}

interface Props {
  workspaceId: number;
  shopId: number;
  nmId: number;
  from: string;
  to: string;
}

const SEO_IDS = new Set([
  'seo_position_views',
  'seo_position_orders',
  'seo_coverage_views',
  'seo_competitor_pressure',
]);

export function SeoInsightsBlock({ workspaceId, shopId, nmId, from, to }: Props) {
  const [seo, setSeo] = useState<InsightPayload[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    apiFetch<Resp>(
      `/lab/${workspaceId}/insights?shopId=${shopId}&nmId=${nmId}&from=${from}&to=${to}&metrics=positionBest,positionMean,keywordsInTop10,viewCount,ordersCount`,
      { signal: ac.signal } as RequestInit,
    )
      .then(d => {
        if (ac.signal.aborted) return;
        const all = [...d.critical, ...d.growthPoints, ...d.falseAlarms];
        setSeo(all.filter(i => SEO_IDS.has(i.hypothesisId)));
      })
      .catch(() => {})
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [workspaceId, shopId, nmId, from, to]);

  if (loading) return <div className="text-xs text-slate-500 italic">Смотрим SEO-связи…</div>;
  if (seo.length === 0) {
    return <div className="text-xs text-slate-500">По этому товару нет отслеживаемых поисковых ключей или данных недостаточно.</div>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {seo.slice(0, 4).map(i => (
        <InsightCard key={i.hypothesisId} insight={i} nmId={nmId} />
      ))}
    </div>
  );
}
