'use client';

import { AlertTriangle, RefreshCw, X } from 'lucide-react';

interface ErrorBannerProps {
  error: string | null;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
}

/**
 * Error banner component for displaying API/loading errors
 * Shows retry button if onRetry is provided
 */
export function ErrorBanner({ error, onRetry, onDismiss, className = '' }: ErrorBannerProps) {
  if (!error) return null;

  return (
    <div className={`rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/50 ${className}`}>
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-500" />
        <div className="flex-1">
          <p className="text-sm font-medium text-red-800 dark:text-red-200">
            Ошибка
          </p>
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-2 flex items-center gap-1.5 text-sm font-medium text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
            >
              <RefreshCw className="h-4 w-4" />
              Повторить
            </button>
          )}
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-red-500 hover:text-red-700 dark:hover:text-red-300"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Inline error message (smaller, for forms)
 */
export function ErrorMessage({ message }: { message: string | null }) {
  if (!message) return null;
  
  return (
    <p className="mt-1 text-sm text-red-600 dark:text-red-400">
      {message}
    </p>
  );
}

/**
 * Toast-style error (positioned fixed)
 */
export function ErrorToast({ error, onDismiss }: { error: string | null; onDismiss: () => void }) {
  if (!error) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm animate-in fade-in slide-in-from-bottom-2">
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 shadow-lg dark:border-red-900 dark:bg-red-950">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 flex-shrink-0 text-red-500" />
          <p className="flex-1 text-sm text-red-700 dark:text-red-300">{error}</p>
          <button onClick={onDismiss} className="text-red-500 hover:text-red-700">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
