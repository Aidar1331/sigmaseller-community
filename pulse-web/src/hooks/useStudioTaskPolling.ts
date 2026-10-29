'use client';

/**
 * App-level polling активной Studio-задачи. Работает везде где смонтирован
 * AppShell → при переключении страниц polling не обрывается, пользователь
 * видит прогресс/результат даже если ушёл с /studio на /pulse.
 *
 * Паттерн из AI-чата: глобальный state в zustand, фоновый polling
 * отдельно от страницы-владельца UI.
 */

import { useEffect } from 'react';
import { useStudioTaskStore } from '@/store/studioTask';
import { useWorkspaceStore } from '@/store/workspace';
import { apiFetch } from '@/lib/api';

export function useStudioTaskPolling() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const activeTask = useStudioTaskStore((s) => s.activeTask);
  const setActiveTask = useStudioTaskStore((s) => s.setActiveTask);

  useEffect(() => {
    if (!activeTask || !workspaceId) return;
    if (activeTask.status === 'completed' || activeTask.status === 'failed') return;

    const intervalMs = activeTask.kind === 'video' ? 5000 : 2000;
    const interval = setInterval(async () => {
      try {
        const task = await apiFetch<{
          taskId: string;
          status: 'pending' | 'processing' | 'completed' | 'failed';
          progress?: number;
          output?: StudioTaskOutput;
          error?: string;
        }>(`/studio/ai/task/${activeTask.taskId}?workspaceId=${workspaceId}`);

        // Merge updated fields into activeTask, keeping kind/prompt/model/startedAt
        setActiveTask({
          ...activeTask,
          status: task.status,
          progress: task.progress,
          output: task.output,
          error: task.error,
        });

        if (task.status === 'completed') {
          // Notify: задача завершена
          try {
            if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
              new Notification('AI Студия — готово', {
                body: activeTask.prompt.slice(0, 80),
                icon: '/favicon.ico',
              });
            }
          } catch {}
        }
      } catch {
        // keep polling on transient errors
      }
    }, intervalMs);

    return () => clearInterval(interval);
  }, [activeTask, workspaceId, setActiveTask]);
}

interface StudioTaskOutput {
  images?: Array<{ url: string; assetId: number }>;
  video?: { url: string; assetId: number; seconds: number; size: string };
}
