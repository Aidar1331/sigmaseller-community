'use client';

import { useState, useEffect, useRef } from 'react';
import { useWorkspaceStore } from '@/store/workspace';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import { Loader2, CheckCircle2, Clock, X } from 'lucide-react';

const STAGES = [
  { key: 'cards', label: 'Карточки' },
  { key: 'orders-sales', label: 'Заказы' },
  { key: 'finance', label: 'Финансы' },
  { key: 'funnel', label: 'Воронка' },
  { key: 'stocks', label: 'Остатки' },
];

const STAGE_TIMES_SEC: Record<string, number> = {
  cards: 20,
  'orders-sales': 120,
  'adv-spend': 60,
  finance: 120,
  funnel: 180,
  stocks: 30,
};

function estimateRemaining(currentStage: string | undefined): string {
  if (!currentStage) return '';
  const stages = Object.keys(STAGE_TIMES_SEC);
  const idx = stages.findIndex(s => currentStage.includes(s));
  if (idx < 0) return '';
  let remaining = (STAGE_TIMES_SEC[stages[idx]] ?? 0) / 2;
  for (let i = idx + 1; i < stages.length; i++) {
    remaining += STAGE_TIMES_SEC[stages[i]] ?? 0;
  }
  const mins = Math.ceil(remaining / 60);
  if (mins <= 1) return 'менее минуты';
  return `~${mins} мин`;
}

function stageIndex(stage: string | undefined): number {
  if (!stage) return -1;
  const s = stage.replace('initial-sync:', '');
  if (s === 'done') return STAGES.length;
  return STAGES.findIndex((st) => s.includes(st.key));
}

/** Check if the run is an initial-sync (not a manual refresh or incremental sync) */
function isInitialSyncRun(run: any): boolean {
  if (!run?.stage) return false;
  // Initial sync stages start with "initial-sync:" prefix
  return run.stage.startsWith('initial-sync:') || run.stage === 'done';
}

export function SyncProgressBanner() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const { data: sync } = useSyncStatus(workspaceId ?? 0);
  const [dismissed, setDismissed] = useState(false);
  const sawRunningRef = useRef(false);

  const run = sync?.run;

  // Only show this banner for initial-sync runs, not manual refreshes
  const isInitialSync = isInitialSyncRun(run);
  const hasActiveInitialSync = sync?.activeSyncJobs?.some(
    (j: any) => j.name === 'initial-full-sync'
  );

  const isDone = isInitialSync && (!!run?.stage?.includes('done') || run?.status === 'completed');
  const isError = !!run?.error || run?.status === 'failed';
  const isRunning = hasActiveInitialSync || (isInitialSync && !isDone && !isError && run?.status === 'running');

  if (isRunning) sawRunningRef.current = true;

  const currentIdx = stageIndex(run?.stage);
  const progress = Math.max(0, Math.min(100, ((currentIdx + 1) / STAGES.length) * 100));

  useEffect(() => {
    if (progress >= 100 || isDone) {
      const t = setTimeout(() => setDismissed(true), 30_000);
      return () => clearTimeout(t);
    }
    setDismissed(false);
  }, [progress, isDone]);

  if (!workspaceId) return null;
  if (dismissed) return null;

  // Only show for active initial-sync
  if (hasActiveInitialSync) {
    // Always show if initial-sync job is active in pg-boss
  } else if (!run || !isInitialSync) {
    return null;
  } else {
    if (!run.stage) return null;
    const updatedAgo = run.updatedAt ? Date.now() - new Date(run.updatedAt).getTime() : Infinity;
    if (!isRunning && !isDone) return null;
    if (isDone && !sawRunningRef.current) return null;
    if (isDone && updatedAgo > 45_000) return null;
  }

  return (
    <div className="border-b border-blue-200 bg-blue-50 px-4 py-3">
      <div className="mx-auto flex max-w-[1400px] items-center gap-4">
        {isRunning ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-600" />
        ) : (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-green-700" />
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="font-medium text-blue-900">
              {isDone ? 'Данные магазина загружены' : 'Загрузка данных магазина...'}
            </span>
            <span className="text-xs text-blue-600">
              {Math.round(progress)}%{' '}
              {isRunning && (
                <span className="text-blue-400">· Осталось {estimateRemaining(run?.stage)}</span>
              )}
            </span>
          </div>
          <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-blue-200">
            <div
              className="h-full rounded-full bg-blue-600 transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex gap-3">
            {STAGES.map((st, i) => {
              const done = i < currentIdx;
              const active = i === currentIdx;
              return (
                <div key={st.key} className="flex items-center gap-1 text-xs">
                  {done ? (
                    <CheckCircle2 className="h-3 w-3 text-blue-600" />
                  ) : active ? (
                    <Loader2 className="h-3 w-3 animate-spin text-blue-600" />
                  ) : (
                    <Clock className="h-3 w-3 text-blue-300" />
                  )}
                  <span className={done ? 'text-blue-700' : active ? 'font-medium text-blue-900' : 'text-blue-400'}>
                    {st.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded p-1 text-blue-400 hover:bg-blue-100 hover:text-blue-600"
          aria-label="Закрыть"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
