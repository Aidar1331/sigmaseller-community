/**
 * InsightCard — одна карточка инсайта из Лаборатории.
 *
 * UX-принципы (см. plan §6):
 *   - никаких r / p / q / lag / HC1 на экране
 *   - только человеческие фразы: категория, суть, что значит, связь, надёжность, что делать
 *   - три категории цветом: точка роста (зелёный), требует внимания (красный), под вопросом (амбра)
 */

'use client';

import { Card } from '@/components/ui/Card';
import {
  categoryMeta,
  cleanTemplate,
  metricLabel,
} from './i18n';

// Полезный тип — payload, который приходит от /lab/:ws/insights
export interface PairExamplesUI {
  medianX: number;
  medianY: number;
  iqrX?: { p25: number; p75: number };
  iqrY?: { p25: number; p75: number };
  bestByY: { date: string; x: number; y: number } | null;
  worstByY: { date: string; x: number; y: number } | null;
  topYBucket?: { avgX: number; avgY: number; n: number } | null;
  bottomYBucket?: { avgX: number; avgY: number; n: number } | null;
}
export interface InsightPayload {
  hypothesisId: string;
  category: 'critical' | 'growth_point' | 'false_alarm';
  hypothesisText: string;
  hypothesisCategory: string;
  bucket: string;
  r: number;
  p: number;
  n: number;
  method: 'pearson' | 'spearman' | 'kendall';
  interpretation: string;
  decision: string;
  noiseRisk: string;
  flags: string[];
  confidence: 'green' | 'yellow' | 'red';
  bestLag: number | null;
  metrics?: [string, string];
  examples?: PairExamplesUI | null;
  concreteCallout?: string | null;
}

interface Props {
  insight: InsightPayload;
  nmId?: number;
  /** @deprecated — кнопка «Спросить AI» убрана по запросу. Оставлено для совместимости. */
  onAskAi?: (prompt: string) => void;
  onDismiss?: () => void;
}

function ruDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}`;
}

const METRIC_UNIT: Record<string, 'rub' | 'pct' | 'count' | 'rank' | 'days'> = {
  ordersCount: 'count', salesCount: 'count', viewCount: 'count', openCardCount: 'count',
  addToCartCount: 'count', buyoutCount: 'count', cancelCount: 'count', stockQty: 'count',
  finishedPriceRub: 'rub', listPriceRub: 'rub', salesRub: 'rub', ordersRub: 'rub', forPayRub: 'rub',
  advSpendRub: 'rub', commissionRub: 'rub', logisticsRub: 'rub', storageRub: 'rub', penaltyRub: 'rub',
  marginRub: 'rub',
  ctrPercent: 'pct', crPercent: 'pct', drrPercent: 'pct', sppPct: 'pct', sellerDiscountPct: 'pct',
  marginPct: 'pct',
  positionBest: 'rank', positionMean: 'rank',
  daysOfStock: 'days',
};

function fmtMetricUI(key: string, v: number): string {
  if (!Number.isFinite(v)) return '—';
  const unit = METRIC_UNIT[key] ?? 'count';
  switch (unit) {
    case 'rub':   return Math.round(v).toLocaleString('ru-RU') + '₽';
    case 'pct':   return v.toFixed(1) + '%';
    case 'rank':  return '#' + Math.round(v);
    case 'days':  return v.toFixed(0) + ' дн';
    default:      return Math.round(v).toLocaleString('ru-RU');
  }
}

export function InsightCard({ insight, nmId, onDismiss }: Props) {
  const meta = categoryMeta(insight.category);

  const metricsLine = insight.metrics
    ? `${metricLabel(insight.metrics[0])} ↔ ${metricLabel(insight.metrics[1])}`
    : undefined;

  const interp = cleanTemplate(insight.interpretation);
  const decision = cleanTemplate(insight.decision);
  const noise = cleanTemplate(insight.noiseRisk);

  void nmId;

  return (
    <Card className={`p-4 border-2 ${meta.border} bg-white flex flex-col gap-3 min-h-[260px]`}>
      {/* Header: category + hypothesisCategory badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-lg leading-none">{meta.emoji}</span>
          <span className="text-sm font-semibold text-[var(--content-text)]">{meta.label}</span>
        </div>
        <span className="text-[10px] uppercase tracking-wide font-medium text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">
          {insight.hypothesisCategory}
        </span>
      </div>

      {/* Metrics line + суть */}
      {metricsLine && (
        <div className="text-[11px] font-medium text-slate-500">{metricsLine}</div>
      )}
      <div className="text-sm font-medium text-[var(--content-text)] leading-snug">
        {insight.hypothesisText}
      </div>

      {/* Конкретный итог с цифрами товара (от backend insightEngine) */}
      {insight.concreteCallout && (
        <div className="text-xs font-semibold text-slate-900 bg-amber-50 border border-amber-200 rounded p-2 leading-snug">
          📌 {insight.concreteCallout}
        </div>
      )}

      {/* Что это значит */}
      {interp && (
        <div className="text-xs text-slate-700 leading-relaxed">
          {interp}
        </div>
      )}

      {/* Сила и надёжность скрыты с лицевой карточки — они не несут полезной
          для селлера информации и засоряли блок (фидбек 2026-06-08). Сила
          связи косвенно отражена цветом меты-эмодзи и border-цветом, а полные
          числа r/p/sparsity видны в drawer-е «Объяснить глубже». */}

      {/* «На вашем товаре» — два дня с реальными цифрами */}
      {insight.examples?.bestByY && insight.examples?.worstByY && insight.metrics && (
        <div className="text-[11px] text-slate-700 bg-slate-50 border border-slate-200 rounded p-2 leading-snug">
          <div className="font-semibold text-slate-800 mb-0.5">На вашем товаре</div>
          <div>
            <span className="text-emerald-700">Лучший день</span> {ruDate(insight.examples.bestByY.date)}: {fmtMetricUI(insight.metrics[0], insight.examples.bestByY.x)} → {fmtMetricUI(insight.metrics[1], insight.examples.bestByY.y)}
          </div>
          <div>
            <span className="text-rose-700">Слабее</span> {ruDate(insight.examples.worstByY.date)}: {fmtMetricUI(insight.metrics[0], insight.examples.worstByY.x)} → {fmtMetricUI(insight.metrics[1], insight.examples.worstByY.y)}
          </div>
        </div>
      )}

      {/* Рекомендация */}
      {decision && (
        <div className="text-xs text-slate-800 bg-slate-50 rounded p-2 border border-slate-200">
          <span className="font-semibold">💡 Рекомендуем:</span> {decision}
        </div>
      )}

      {/* Риск — только для false_alarm */}
      {insight.category === 'false_alarm' && noise && (
        <div className="text-[11px] text-amber-800 leading-snug">
          <span className="font-semibold">⚠ Почему под вопросом:</span> {noise}
        </div>
      )}

      {/* Actions */}
      {onDismiss && (
        <div className="mt-auto flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onDismiss}
            className="text-[11px] font-medium text-slate-500 hover:text-slate-700 px-2 py-1"
          >
            Скрыть
          </button>
        </div>
      )}
    </Card>
  );
}
