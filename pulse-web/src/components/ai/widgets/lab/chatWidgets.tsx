'use client';

/**
 * Обёртки drawer-компонентов Лаборатории для WIDGET_REGISTRY — так `subagent_lab`
 * может вернуть их inline в ответе AI-чата.
 *
 * Каждый wrapper ждёт в props поля {workspaceId, shopId, nmId, from, to}, а рендерит
 * тот же визуальный компонент что на странице /dynamics — один код, два места.
 */

import { MetricRelationsGrid } from '@/components/lab/drawer/MetricRelationsGrid';
import { PriceImpactChart } from '@/components/lab/drawer/PriceImpactChart';
import { AdsDelayChart } from '@/components/lab/drawer/AdsDelayChart';
import { PriceSensitivityCard } from '@/components/lab/drawer/PriceSensitivityCard';
import { ProductTimeline } from '@/components/lab/drawer/ProductTimeline';
import { SeoInsightsBlock } from '@/components/lab/drawer/SeoInsightsBlock';
import { BestComboCard } from '@/components/lab/drawer/BestComboCard';

type Required5 = Record<'workspaceId' | 'shopId' | 'nmId' | 'from' | 'to', unknown>;

function validate(props: Record<string, unknown>): (Required5 & { workspaceId: number; shopId: number; nmId: number; from: string; to: string }) | null {
  const ws = Number(props.workspaceId);
  const sh = Number(props.shopId);
  const nm = Number(props.nmId);
  const from = String(props.from ?? '');
  const to = String(props.to ?? '');
  if (!Number.isInteger(ws) || ws <= 0) return null;
  if (!Number.isInteger(sh) || sh <= 0) return null;
  if (!Number.isInteger(nm) || nm <= 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  return { workspaceId: ws, shopId: sh, nmId: nm, from, to };
}

function Fallback({ reason }: { reason: string }) {
  return <div className="text-xs text-slate-500 italic p-2">{reason}</div>;
}

export function LabMetricRelationsWidget(props: Record<string, unknown>) {
  const v = validate(props);
  if (!v) return <Fallback reason="Недостаточно параметров для матрицы связей." />;
  return <MetricRelationsGrid {...v} />;
}

export function LabPriceImpactWidget(props: Record<string, unknown>) {
  const v = validate(props);
  if (!v) return <Fallback reason="Недостаточно параметров для графика." />;
  return <PriceImpactChart {...v} />;
}

export function LabAdsDelayWidget(props: Record<string, unknown>) {
  const v = validate(props);
  if (!v) return <Fallback reason="Недостаточно параметров для анализа рекламы." />;
  return <AdsDelayChart {...v} />;
}

export function LabPriceSensitivityWidget(props: Record<string, unknown>) {
  const v = validate(props);
  if (!v) return <Fallback reason="Недостаточно параметров для оценки чувствительности." />;
  return <PriceSensitivityCard {...v} />;
}

export function LabProductTimelineWidget(props: Record<string, unknown>) {
  const v = validate(props);
  if (!v) return <Fallback reason="Недостаточно параметров для хронологии." />;
  return <ProductTimeline {...v} />;
}

export function LabSeoInsightsWidget(props: Record<string, unknown>) {
  const v = validate(props);
  if (!v) return <Fallback reason="Недостаточно параметров для SEO-блока." />;
  return <SeoInsightsBlock {...v} />;
}

export function LabBestComboWidget(props: Record<string, unknown>) {
  const v = validate(props);
  if (!v) return <Fallback reason="Недостаточно параметров для лучшей комбинации." />;
  return <BestComboCard {...v} />;
}
