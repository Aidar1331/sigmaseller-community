'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorFallbackProps {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
}

export function ErrorFallback({ error, reset, title }: ErrorFallbackProps) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div className="w-14 h-14 rounded-2xl bg-red-100 flex items-center justify-center mb-4">
        <AlertTriangle className="h-7 w-7 text-red-600" />
      </div>
      <h2 className="text-lg font-semibold text-gray-900 mb-2">
        {title ?? 'Произошла ошибка'}
      </h2>
      <p className="text-sm text-gray-500 mb-6 max-w-md text-center">
        {error.message || 'Не удалось загрузить страницу. Попробуйте обновить.'}
      </p>
      <button
        onClick={reset}
        className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
      >
        <RefreshCw className="h-4 w-4" />
        Попробовать снова
      </button>
    </div>
  );
}
