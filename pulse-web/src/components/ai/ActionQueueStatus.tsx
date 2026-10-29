'use client';

/**
 * Compact progress strip for AI-agent actions that ran through the durable
 * Action Queue (ENABLE_ACTION_QUEUE backend feature, migration 0117).
 *
 * Shows live status for one or more actionIds: how many are still queued,
 * how many succeeded, how many failed. Polls `/agent-actions?ids=...` every
 * 2 seconds and stops once all rows reach a terminal state.
 *
 * Drop this under any assistant message that referenced actionIds:
 *   <ActionQueueStatus actionIds={[123, 124, 125]} />
 *
 * Renders nothing for empty input — safe to call unconditionally.
 */

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle, Loader2, Hourglass, X } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useWorkspaceStore } from '@/store/workspace';

interface ActionRow {
  actionId: number;
  status: string;
  actionType: string;
  retryCount: number;
  lastError: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  result: unknown;
  conversationId: number | null;
}

interface ActionsResponse {
  actions: ActionRow[];
}

const TERMINAL_STATUSES = new Set(['executed', 'failed:permanent', 'cancelled']);

interface Counts {
  total: number;
  executed: number;
  inFlight: number;   // queued | running | failed:retryable
  failed: number;     // failed:permanent
  cancelled: number;
}

function tallyStatuses(rows: ActionRow[]): Counts {
  let executed = 0, inFlight = 0, failed = 0, cancelled = 0;
  for (const r of rows) {
    if (r.status === 'executed') executed++;
    else if (r.status === 'failed:permanent') failed++;
    else if (r.status === 'cancelled') cancelled++;
    else inFlight++; // queued | running | failed:retryable
  }
  return { total: rows.length, executed, inFlight, failed, cancelled };
}

interface Props {
  actionIds: number[];
  className?: string;
}

export function ActionQueueStatus({ actionIds, className }: Props) {
  // Deduplicate + sort for stable cache key. Empty list → don't fire.
  const sortedIds = Array.from(new Set(actionIds)).sort((a, b) => a - b);
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const enabled = sortedIds.length > 0 && Boolean(workspaceId);

  const { data, isLoading, isError } = useQuery<ActionsResponse>({
    queryKey: ['agent-actions', workspaceId, sortedIds],
    queryFn: () => apiFetch<ActionsResponse>(`/agent-actions?workspaceId=${workspaceId}&ids=${sortedIds.join(',')}`),
    enabled,
    // Poll every 2s while at least one action is still in flight. Once all
    // are terminal, refetchInterval returns false and React Query stops.
    refetchInterval: (query) => {
      const rows = (query.state.data as ActionsResponse | undefined)?.actions ?? [];
      if (rows.length === 0) return 2000; // backend not yet seeing the rows; keep trying
      const allTerminal = rows.every((r) => TERMINAL_STATUSES.has(r.status));
      return allTerminal ? false : 2000;
    },
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  if (!enabled) return null;

  const rows = data?.actions ?? [];
  const counts = tallyStatuses(rows);
  const expectedTotal = sortedIds.length;

  // While the backend is still processing the very first poll (rows.length < expected),
  // show a friendly "registering" line rather than 0/N.
  const showRegistering = isLoading || rows.length < expectedTotal;

  return (
    <div
      className={cn(
        'mt-2 rounded-md border border-violet-100 bg-violet-50/50 px-3 py-2 text-sm',
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 flex-wrap">
        {showRegistering ? (
          <span className="flex items-center gap-1.5 text-gray-600">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Регистрирую команды в очереди ({rows.length}/{expectedTotal})…
          </span>
        ) : (
          <>
            <span className="text-gray-600 font-medium">
              Очередь команд:
            </span>
            {counts.executed > 0 && (
              <span className="flex items-center gap-1 text-emerald-600">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {counts.executed} готово
              </span>
            )}
            {counts.inFlight > 0 && (
              <span className="flex items-center gap-1 text-violet-600">
                <Hourglass className="w-3.5 h-3.5 animate-pulse" />
                {counts.inFlight} в работе
              </span>
            )}
            {counts.failed > 0 && (
              <span className="flex items-center gap-1 text-rose-600">
                <AlertTriangle className="w-3.5 h-3.5" />
                {counts.failed} ошибка
              </span>
            )}
            {counts.cancelled > 0 && (
              <span className="flex items-center gap-1 text-gray-500">
                <X className="w-3.5 h-3.5" />
                {counts.cancelled} отменено
              </span>
            )}
            <span className="text-gray-500 ml-auto text-xs">
              {counts.executed + counts.failed + counts.cancelled} / {counts.total}
            </span>
          </>
        )}
      </div>

      {/* Per-action error detail (only on permanent failures, dedup'd) */}
      {counts.failed > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-rose-700">
          {rows
            .filter((r) => r.status === 'failed:permanent' && r.lastError)
            .slice(0, 3)
            .map((r) => (
              <li key={r.actionId} className="truncate">
                #{r.actionId}: {r.lastError}
              </li>
            ))}
        </ul>
      )}

      {isError && (
        <div className="mt-1 text-xs text-rose-500">
          Не удалось получить статус команд. Повторная попытка…
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: extract actionIds from an assistant message body.
//
// The pilot relies on the tool result message embedding the id as
// `[actionId:N]`. AiChatMessage scans the rendered content with this helper
// and feeds the resulting ids into <ActionQueueStatus />. Once SSE-side
// emits a structured `action_queued` event, this regex parser can retire.
// ---------------------------------------------------------------------------

const ACTION_ID_RE = /\[actionId:(\d+)\]/g;

export function extractActionIds(content: string | null | undefined): number[] {
  if (!content) return [];
  const ids: number[] = [];
  // Use matchAll to gather all occurrences.
  for (const m of content.matchAll(ACTION_ID_RE)) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) ids.push(n);
  }
  return ids;
}
