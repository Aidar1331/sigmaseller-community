'use client';

import { formatNumber, formatRub } from '@/lib/format';
import type { Overview, PlanSummary } from '@/types/pulse';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';

function PlanFactRow({ label, fact, plan }: { label: string; fact: number; plan: number }) {
  const pct = plan > 0 ? Math.round((fact / plan) * 100) : null;
  const isRub = label.includes('₽');

  return (
    <Card className="p-3">
      <div className="text-xs text-[var(--content-muted)]">{label}</div>
      <div className="mt-1 flex items-baseline gap-2 text-sm text-[var(--content-text)]">
        <span>факт <span className="font-mono font-semibold">{isRub ? formatRub(fact) : formatNumber(fact)}</span></span>
        <span className="text-[var(--content-muted)]">/</span>
        <span>план <span className="font-mono">{isRub ? formatRub(plan) : formatNumber(plan)}</span></span>
        {pct != null && (
          <Badge variant={pct >= 100 ? 'success' : pct >= 80 ? 'warning' : 'danger'}>
            {pct}%
          </Badge>
        )}
      </div>
    </Card>
  );
}

export function PlanFactCards({
  planSummary,
  overview,
  tagId,
}: {
  planSummary: PlanSummary | null;
  overview: Overview | null;
  tagId: number | null;
}) {
  if (!planSummary || !overview) return null;

  return (
    <Card className="mt-6 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-[var(--content-text)]">План / факт</div>
          <div className="mt-1 text-[11px] text-[var(--content-muted)]">
            Период: {planSummary.start} → {planSummary.end}
            {tagId ? ` · tagId=${tagId}` : ''}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
        <PlanFactRow label="Заказы (шт)" fact={overview.kpis.ordersCount} plan={planSummary.ordersQty} />
        <PlanFactRow label="Продажи (шт)" fact={overview.kpis.salesCount} plan={planSummary.salesQty} />
        <PlanFactRow label="Продажи (₽)" fact={overview.kpis.salesRub} plan={planSummary.salesRub} />
      </div>
    </Card>
  );
}
