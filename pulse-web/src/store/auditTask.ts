/**
 * Global store для активной задачи Creative Audit.
 *
 * Аналог `studioTask.ts` — паттерн сессии 28 (DECISIONS#94): живёт выше
 * страницы, polling делается в AppShell, при переключении вкладок задача
 * не теряется. Backend `creative_audit_jobs` крутится независимо;
 * стор нужен только чтобы фронт не потерял jobId при unmount.
 *
 * Жёстко отделён от `creativeAudit.ts` (тот хранит РЕЗУЛЬТАТ аудита, этот —
 * статус активной задачи).
 */

import { create } from 'zustand';

export interface AuditTask {
  jobId: number;
  nmId: number;
  status: 'running' | 'done' | 'failed';
  stage?: string | null;
  error?: string | null;
  result?: unknown; // JSON ответа /jobs/:id, парсится на странице
  startedAt: number;
}

interface AuditTaskState {
  activeTask: AuditTask | null;
  setActiveTask: (task: AuditTask | null) => void;
  clearActiveTask: () => void;
}

const STORAGE_KEY = 'pulse:audit:active-job';

function loadFromStorage(): AuditTask | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuditTask;
    if (parsed.status === 'done' || parsed.status === 'failed') return null;
    // 30 минут — больше типичного аудита (3-5 мин), но защищает от зависшей записи.
    if (Date.now() - parsed.startedAt > 30 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveToStorage(task: AuditTask | null) {
  if (typeof window === 'undefined') return;
  try {
    if (!task) window.localStorage.removeItem(STORAGE_KEY);
    else if (task.status === 'running') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(task));
    } else {
      // Завершённую — не держим.
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {}
}

export const useAuditTaskStore = create<AuditTaskState>((set) => ({
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
