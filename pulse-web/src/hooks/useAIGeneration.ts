/**
 * Hook для AI операций в Visual Studio
 */

import { useState, useCallback, useRef } from 'react';
import { useWorkspaceStore } from '@/store/workspace';
import { apiFetch } from '@/lib/api';

export interface GenerateOptions {
  prompt: string;
  referenceImageUrl?: string;
  model?: 'gemini-flash' | 'gemini-pro';
  aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
  variants?: 1 | 2 | 4;
  temperature?: number;
  presetId?: number;
}

export interface RemoveBgOptions {
  imageUrl: string;
  model?: string;
  alphaMatting?: boolean;
}

export interface TaskResult {
  taskId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  results?: { url: string; assetId?: number }[];
  error?: string;
  creditsUsed: number;
}

const POLL_INTERVAL = 1500; // 1.5 seconds
const MAX_POLL_TIME = 120000; // 2 minutes

export function useAIGeneration() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Poll task status until complete
   */
  const pollTaskStatus = useCallback(async (taskId: string): Promise<TaskResult> => {
    const startTime = Date.now();
    
    while (Date.now() - startTime < MAX_POLL_TIME) {
      // Check if cancelled
      if (abortRef.current?.signal.aborted) {
        throw new Error('Operation cancelled');
      }

      const result = await apiFetch(`/studio/ai/task/${taskId}?workspaceId=${workspaceId}`);
      
      setProgress(result.progress || 0);
      
      if (result.status === 'completed') {
        return {
          taskId,
          status: 'completed',
          progress: 100,
          results: result.results?.images || [result.results],
          creditsUsed: result.creditsUsed || 0,
        };
      }
      
      if (result.status === 'failed') {
        throw new Error(result.error || 'Task failed');
      }
      
      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
    
    throw new Error('Operation timed out');
  }, [workspaceId]);

  /**
   * Remove background from image
   */
  const removeBackground = useCallback(async (options: RemoveBgOptions): Promise<TaskResult | null> => {
    if (!workspaceId) {
      setError('Workspace not selected');
      return null;
    }

    setIsLoading(true);
    setProgress(0);
    setError(null);
    abortRef.current = new AbortController();

    try {
      // Start task
      const response = await apiFetch(`/studio/ai/remove-background?workspaceId=${workspaceId}`, {
        method: 'POST',
        body: JSON.stringify(options),
      });

      if (response.error) {
        throw new Error(response.error);
      }

      setCurrentTaskId(response.taskId);
      setProgress(10);

      // Poll for result
      const result = await pollTaskStatus(response.taskId);
      
      return result;
    } catch (err: any) {
      const message = err.message || 'Failed to remove background';
      setError(message);
      return null;
    } finally {
      setIsLoading(false);
      setCurrentTaskId(null);
      abortRef.current = null;
    }
  }, [workspaceId, pollTaskStatus]);

  /**
   * Generate image with AI
   */
  const generate = useCallback(async (options: GenerateOptions): Promise<TaskResult | null> => {
    if (!workspaceId) {
      setError('Workspace not selected');
      return null;
    }

    setIsLoading(true);
    setProgress(0);
    setError(null);
    abortRef.current = new AbortController();

    try {
      // Start task
      const response = await apiFetch(`/studio/ai/generate?workspaceId=${workspaceId}`, {
        method: 'POST',
        body: JSON.stringify(options),
      });

      if (response.error) {
        throw new Error(response.error);
      }

      setCurrentTaskId(response.taskId);
      setProgress(10);

      // Poll for result
      const result = await pollTaskStatus(response.taskId);
      
      return result;
    } catch (err: any) {
      const message = err.message || 'Failed to generate image';
      setError(message);
      return null;
    } finally {
      setIsLoading(false);
      setCurrentTaskId(null);
      abortRef.current = null;
    }
  }, [workspaceId, pollTaskStatus]);

  /**
   * Cancel current operation
   */
  const cancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  /**
   * Get task status (one-shot, not polling)
   */
  const getTaskStatus = useCallback(async (taskId: string): Promise<TaskResult | null> => {
    if (!workspaceId) return null;

    try {
      const result = await apiFetch(`/studio/ai/task/${taskId}?workspaceId=${workspaceId}`);
      return {
        taskId,
        status: result.status,
        progress: result.progress || 0,
        results: result.results?.images || (result.results ? [result.results] : undefined),
        error: result.error,
        creditsUsed: result.creditsUsed || 0,
      };
    } catch {
      return null;
    }
  }, [workspaceId]);

  return {
    // State
    isLoading,
    progress,
    error,
    currentTaskId,
    
    // Actions
    removeBackground,
    generate,
    cancel,
    getTaskStatus,
    
    // Utils
    clearError: () => setError(null),
  };
}

/**
 * Стоимость операций в кредитах
 */
export const CREDIT_COSTS = {
  'remove_bg': 0,
  'generate:gemini-flash': 10,
  'generate:gemini-pro': 20,
  'upscale:2x': 5,
  'upscale:4x': 10,
} as const;

/**
 * Рассчитать стоимость генерации
 */
export function calculateCost(options: GenerateOptions): number {
  const model = options.model || 'gemini-flash';
  const variants = options.variants || 1;
  const costPerImage = model === 'gemini-pro' ? 20 : 10;
  return costPerImage * variants;
}
