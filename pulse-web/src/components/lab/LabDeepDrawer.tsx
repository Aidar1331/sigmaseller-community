'use client';

/**
 * LabDeepDrawer — правый оверлей «Объяснить данные глубже».
 * Содержит 6 секций: матрица связей, влияние цены, задержка рекламы,
 * чувствительность, хронология, SEO.
 */

import { useEffect } from 'react';
import { MetricRelationsGrid } from './drawer/MetricRelationsGrid';
import { PriceImpactChart } from './drawer/PriceImpactChart';
import { AdsDelayChart } from './drawer/AdsDelayChart';
import { PriceSensitivityCard } from './drawer/PriceSensitivityCard';
import { ProductTimeline } from './drawer/ProductTimeline';
import { SeoInsightsBlock } from './drawer/SeoInsightsBlock';
import { BestComboCard } from './drawer/BestComboCard';

interface Props {
  open: boolean;
  onClose: () => void;
  workspaceId: number;
  shopId: number;
  nmId: number;
  from: string;
  to: string;
}

export function LabDeepDrawer({ open, onClose, workspaceId, shopId, nmId, from, to }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (open) {
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute top-0 right-0 bottom-0 w-full max-w-3xl bg-white shadow-2xl overflow-y-auto">
        <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
          <div>
            <div className="text-base font-semibold text-slate-800">Объяснение данных по товару</div>
            <div className="text-[11px] text-slate-500">Артикул {nmId} · Период {from} — {to}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-800 w-8 h-8 rounded flex items-center justify-center text-xl"
          >
            ×
          </button>
        </div>

        <div className="p-4 space-y-6">
          <section>
            <h3 className="text-sm font-semibold text-slate-800 mb-2">Как связаны метрики товара</h3>
            <MetricRelationsGrid workspaceId={workspaceId} shopId={shopId} nmId={nmId} from={from} to={to} />
          </section>

          <section>
            <BestComboCard workspaceId={workspaceId} shopId={shopId} nmId={nmId} from={from} to={to} />
          </section>

          <section>
            <PriceImpactChart workspaceId={workspaceId} shopId={shopId} nmId={nmId} from={from} to={to} />
          </section>

          <section>
            <PriceSensitivityCard workspaceId={workspaceId} shopId={shopId} nmId={nmId} from={from} to={to} />
          </section>

          <section>
            <AdsDelayChart workspaceId={workspaceId} shopId={shopId} nmId={nmId} from={from} to={to} />
          </section>

          <section>
            <ProductTimeline workspaceId={workspaceId} shopId={shopId} nmId={nmId} from={from} to={to} />
          </section>

          <section>
            <h3 className="text-sm font-semibold text-slate-800 mb-2">Поисковые позиции и конкуренты</h3>
            <SeoInsightsBlock workspaceId={workspaceId} shopId={shopId} nmId={nmId} from={from} to={to} />
          </section>
        </div>
      </div>
    </div>
  );
}
