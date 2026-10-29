import { AlertTriangle, RefreshCw } from 'lucide-react';

interface SlowLoadingWarningProps {
  onRetry?: () => void;
  message?: string;
}

/**
 * Warning banner shown when loading takes too long.
 */
export function SlowLoadingWarning({ 
  onRetry, 
  message = 'Загрузка занимает больше времени чем обычно...' 
}: SlowLoadingWarningProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
      <AlertTriangle className="h-5 w-5 shrink-0" />
      <span className="flex-1">{message}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          className="flex items-center gap-1.5 rounded-md bg-amber-100 px-3 py-1.5 font-medium hover:bg-amber-200 transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          Повторить
        </button>
      )}
    </div>
  );
}
