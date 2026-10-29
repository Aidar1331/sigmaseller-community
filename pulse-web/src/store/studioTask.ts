/**
 * Global store для активной задачи Studio-генерации.
 * Живёт выше уровня страницы → при переключении /studio ↔ /pulse ↔ любая
 * другая вкладка задача не теряется, polling продолжается в AppShell.
 *
 * Паттерн идентичен `useAiChatStore` (стриминг чата тоже глобальный через
 * zustand, а не локальный в /ai/page.tsx).
 */

import { create } from 'zustand';

export interface StudioTask {
  taskId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number;
  output?: {
    images?: Array<{ url: string; assetId: number }>;
    video?: { url: string; assetId: number; seconds: number; size: string };
  };
  error?: string;
  kind: 'image' | 'video';
  prompt: string;
  model: string;
  startedAt: number;
}

interface StudioTaskState {
  activeTask: StudioTask | null;
  setActiveTask: (task: StudioTask | null) => void;
  clearActiveTask: () => void;
}

const STORAGE_KEY = 'pulse:studio:active-task';

function loadFromStorage(): StudioTask | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StudioTask;
    // Если задача завершена или брошена больше часа назад — чистим
    if (parsed.status === 'completed' || parsed.status === 'failed') return null;
    if (Date.now() - parsed.startedAt > 60 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveToStorage(task: StudioTask | null) {
  if (typeof window === 'undefined') return;
  try {
    if (!task) window.localStorage.removeItem(STORAGE_KEY);
    else if (task.status === 'pending' || task.status === 'processing') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(task));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {}
}

export const useStudioTaskStore = create<StudioTaskState>((set) => ({
  activeTask: loadFromStorage(),
  setActiveTask: (task) => {
    saveToStorage(task);
    set({ activeTask: task });
  },
  clearActiveTask: () => {
    saveToStorage(null);
    set({ activeTask: null });
  },
}));
