'use client';

import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { AlertTriangle } from 'lucide-react';

export function AlertsReportSummary({
  alertsReport,
  onRunAlerts,
  loading,
}: {
  alertsReport: any;
  onRunAlerts: () => void;
  loading: boolean;
}) {
  if (!alertsReport) return null;

  return (
    <Card className="mt-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-50 text-red-500">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-medium text-[var(--content-text)]">
              Алерты за {alertsReport.date}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--content-muted)]">
              <span>всего: <span className="font-mono font-medium">{String(alertsReport.total ?? 0)}</span></span>
              <Badge variant="danger">critical: {String(alertsReport.bySeverity?.critical ?? 0)}</Badge>
              <Badge variant="warning">warn: {String(alertsReport.bySeverity?.warn ?? 0)}</Badge>
            </div>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onRunAlerts}
          loading={loading}
        >
          Пересчитать
        </Button>
      </div>
    </Card>
  );
}
