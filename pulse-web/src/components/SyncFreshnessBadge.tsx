'use client';

/**
 * Inline badge showing per-stream sync freshness for the currently
 * selected workspace + shop. Designed for page headers on Pulse /
 * Finance / SEO / Cashflow so users see "обновлено 3 мин назад" at a
 * glance. Polls /wb/:ws/shops/:shop/sync-status once a minute via
 * useShopSyncStatus.
 *
 * Colour key:
 *   fresh  — within SLA (green)
 *   stale  — past SLA but < 2×SLA (amber)
 *   broken — never succeeded, > 2×SLA, or token expired (red)
 */

import { useMemo } from 'react';
import { useWorkspaceStore } from '@/store/workspace';
import { useShopSyncStatus, pickStage, type SlaStatus } from '@/hooks/useShopSyncStatus';

const STATUS_STYLES: Record<SlaStatus, { dot: string; text: string; border: string }> = {
  fresh:  { dot: 'bg-emerald-500', text: 'text-emerald-700', border: 'border-emerald-200' },
  stale:  { dot: 'bg-amber-500',   text: 'text-amber-700',   border: 'border-amber-200'   },
  broken: { dot: 'bg-red-500',     text: 'text-red-700',     border: 'border-red-200'     },
};

interface Props {
  /** Stream name fragment, e.g. 'orders-sales', 'finance', 'funnel'. */
  stage: string;
  /** Optional override label; defaults to `stage`. */
  label?: string;
  className?: string;
}

function formatAge(minutes: number | null): string {
  if (minutes == null) return 'никогда';
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  return `${d} дн назад`;
}

export function SyncFreshnessBadge({ stage, label, className }: Props) {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopId = useWorkspaceStore((s) => s.shopId);
  const { data, isLoading } = useShopSyncStatus(workspaceId, shopId);

  const matched = useMemo(() => pickStage(data?.stages, stage), [data, stage]);

  // No data yet (first load or no shop selected) — render a neutral
  // placeholder rather than flashing red.
  if (!workspaceId || !shopId || (isLoading && !matched)) {
    return (
      <span
        className={
          'inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-2.5 py-0.5 text-xs text-gray-500 ' +
          (className ?? '')
        }
        title="Загрузка статуса синхронизации"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-gray-300" />
        <span>{label ?? stage}: …</span>
      </span>
    );
  }

  // Shop has no row in the VIEW for this stream — either never synced
  // or the stream name doesn't match any real stage. Show neutral
  // "нет данных" so we don't alarm users about streams that aren't
  // expected to run (e.g. SEO on a fresh workspace).
  if (!matched) {
    return (
      <span
        className={
          'inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-2.5 py-0.5 text-xs text-gray-500 ' +
          (className ?? '')
        }
        title={`Данные по синхронизации "${stage}" ещё не собраны`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-gray-300" />
        <span>{label ?? stage}: нет данных</span>
      </span>
    );
  }

  const s = STATUS_STYLES[matched.slaStatus];
  const age = formatAge(matched.ageMinutes);
  const tooltipLines = [
    matched.slaStatus === 'broken' && matched.lastTokenExpiredAt
      ? '⚠️ Токен WB истёк — обновите ключ магазина'
      : null,
    `Обновлено: ${age}`,
    matched.lastErrorMessage ? `Ошибка: ${matched.lastErrorMessage}` : null,
    `SLA: ${matched.slaMinutes} мин`,
  ].filter(Boolean).join('\n');

  return (
    <span
      className={
        `inline-flex items-center gap-1.5 rounded-full border ${s.border} bg-white px-2.5 py-0.5 text-xs ${s.text} ` +
        (className ?? '')
      }
      title={tooltipLines}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      <span>{label ?? stage}: {age}</span>
    </span>
  );
}
