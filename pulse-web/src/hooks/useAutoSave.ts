/**
 * Auto-save hook for Visual Studio
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useWorkspaceStore } from '@/store/workspace';
import { apiFetch } from '@/lib/api';

interface AutoSaveOptions {
  /** Project ID (if exists) */
  projectId?: number | null;
  /** Project name */
  projectName: string;
  /** Function to get current canvas data */
  getCanvasData: () => object | null;
  /** Function to get thumbnail data URL */
  getThumbnail?: () => string | null;
  /** Auto-save interval in ms (default: 30000 = 30s) */
  interval?: number;
  /** Enable/disable auto-save */
  enabled?: boolean;
  /** Callback when save completes */
  onSaved?: (projectId: number) => void;
  /** Callback when save fails */
  onError?: (error: Error) => void;
}

interface AutoSaveState {
  isSaving: boolean;
  lastSaved: Date | null;
  hasUnsavedChanges: boolean;
  error: string | null;
}

export function useAutoSave({
  projectId,
  projectName,
  getCanvasData,
  getThumbnail,
  interval = 30000,
  enabled = true,
  onSaved,
  onError,
}: AutoSaveOptions) {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  
  const [state, setState] = useState<AutoSaveState>({
    isSaving: false,
    lastSaved: null,
    hasUnsavedChanges: false,
    error: null,
  });

  const projectIdRef = useRef(projectId);
  const lastDataRef = useRef<string | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Update ref when projectId changes
  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  /**
   * Save project
   */
  const save = useCallback(async (force: boolean = false) => {
    if (!workspaceId) return;
    if (state.isSaving && !force) return;

    const canvasData = getCanvasData();
    if (!canvasData) return;

    const dataString = JSON.stringify(canvasData);
    
    // Skip if data hasn't changed
    if (!force && dataString === lastDataRef.current) {
      setState((s) => ({ ...s, hasUnsavedChanges: false }));
      return;
    }

    setState((s) => ({ ...s, isSaving: true, error: null }));

    try {
      const body: any = {
        name: projectName,
        canvasData,
        status: 'saved',
      };

      // Add thumbnail if available
      if (getThumbnail) {
        const thumbnail = getThumbnail();
        if (thumbnail) {
          body.thumbnail = thumbnail;
        }
      }

      let result;
      
      if (projectIdRef.current) {
        // Update existing project
        result = await apiFetch(
          `/studio/projects/${projectIdRef.current}?workspaceId=${workspaceId}`,
          {
            method: 'PUT',
            body: JSON.stringify(body),
          }
        );
      } else {
        // Create new project
        result = await apiFetch(
          `/studio/projects?workspaceId=${workspaceId}`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );

        // Update project ID for future saves
        if (result.project?.projectId) {
          projectIdRef.current = result.project.projectId;
          onSaved?.(result.project.projectId);
        }
      }

      lastDataRef.current = dataString;
      
      setState((s) => ({
        ...s,
        isSaving: false,
        lastSaved: new Date(),
        hasUnsavedChanges: false,
      }));
    } catch (error: any) {
      setState((s) => ({
        ...s,
        isSaving: false,
        error: error.message || 'Ошибка сохранения',
      }));
      onError?.(error);
    }
  }, [workspaceId, projectName, getCanvasData, getThumbnail, state.isSaving, onSaved, onError]);

  /**
   * Mark as having unsaved changes (debounced save trigger)
   */
  const markDirty = useCallback(() => {
    setState((s) => ({ ...s, hasUnsavedChanges: true }));

    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Set new timeout for auto-save
    if (enabled) {
      saveTimeoutRef.current = setTimeout(() => {
        save();
      }, interval);
    }
  }, [enabled, interval, save]);

  /**
   * Auto-save on interval
   */
  useEffect(() => {
    if (!enabled || !state.hasUnsavedChanges) return;

    const timer = setInterval(() => {
      if (state.hasUnsavedChanges) {
        save();
      }
    }, interval);

    return () => clearInterval(timer);
  }, [enabled, interval, state.hasUnsavedChanges, save]);

  /**
   * Save before unload
   */
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (state.hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = 'У вас есть несохранённые изменения. Вы уверены, что хотите уйти?';
        return e.returnValue;
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [state.hasUnsavedChanges]);

  /**
   * Cleanup on unmount
   */
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  return {
    ...state,
    save,
    markDirty,
    forceSave: () => save(true),
  };
}

/**
 * Format last saved time for display
 */
export function formatLastSaved(date: Date | null): string {
  if (!date) return 'Не сохранено';

  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);

  if (seconds < 60) {
    return 'Только что';
  } else if (minutes < 60) {
    return `${minutes} мин. назад`;
  } else {
    return date.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  }
}
