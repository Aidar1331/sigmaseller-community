'use client';

/**
 * App-level polling активной Creative Audit задачи.
 *
 * Аналог `useStudioTaskPolling` (см. DECISIONS#94). Монтируется в AppShell —
 * polling работает поверх любой страницы. При переключении вкладок цикл
 * не обрывается, бекенд продолжает работу, мы видим финальный результат
 * как только пользователь вернётся на /creative-audit (или из шапки).
 *
 * До этого паттерна `runAudit` в page.tsx крутил собственный for-loop, и
 * unmount страницы → loop умирал → пользователь видел ложный таймаут.
 */

import { useEffect } from 'react';
import { useAuditTaskStore } from '@/store/auditTask';
import { useWorkspaceStore } from '@/store/workspace';
import { apiFetch } from '@/lib/api';

const POLL_MS = 3000;
// Остановить polling если задача висит >12 минут (типичный аудит 3-5 мин;
// 12 минут — безопасный потолок чтобы зомби-job не крутился бесконечно).
const HARD_TIMEOUT_MS = 12 * 60 * 1000;

interface JobStatus {
  status?: 'running' | 'done' | 'failed';
  stage?: string | null;
  error?: string | null;
  result?: unknown;
}

export function useAuditJobPolling() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const activeTask = useAuditTaskStore((s) => s.activeTask);
  const setActiveTask = useAuditTaskStore((s) => s.setActiveTask);

  useEffect(() => {
    if (!activeTask || !workspaceId) return;
    if (activeTask.status !== 'running') return;

    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;

      // Hard timeout safety net — если backend завис, мы не оставляем
      // вечно крутящийся job в localStorage.
      if (Date.now() - activeTask.startedAt > HARD_TIMEOUT_MS) {
        setActiveTask({
          ...activeTask,
          status: 'failed',
          error: 'Аудит не завершился за 12 минут — проверьте список истории',
        });
        return;
      }

      try {
        const res = await apiFetch<JobStatus>(
          `/creative-audit/${workspaceId}/jobs/${activeTask.jobId}`,
        );
        if (cancelled) return;

        if (res.status === 'done') {
          setActiveTask({
            ...activeTask,
            status: 'done',
            stage: res.stage ?? null,
            result: res.result,
          });
          // Browser notification — хорошо когда пользователь ушёл в другую вкладку.
          try {
            if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
              new Notification('Аудит карточки готов', {
                body: `Артикул ${activeTask.nmId}`,
                icon: '/favicon.ico',
              });
            }
          } catch {}
        } else if (res.status === 'failed') {
          setActiveTask({
            ...activeTask,
            status: 'failed',
            error: res.error ?? 'Аудит упал на сервере',
          });
        } else {
          // running — обновляем стадию для индикации прогресса.
          if (res.stage && res.stage !== activeTask.stage) {
            setActiveTask({ ...activeTask, stage: res.stage });
          }
        }
      } catch {
        // Транзиентная сетевая ошибка — продолжаем опрашивать,
        // backend держит задачу независимо.
      }
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeTask, workspaceId, setActiveTask]);
}
