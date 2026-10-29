'use client';

import { AlertTriangle, ExternalLink } from 'lucide-react';

interface JamPaywallProps {
  /** Feature name to display */
  feature?: string;
  /** Custom message */
  message?: string;
  /** Show compact version */
  compact?: boolean;
}

/**
 * Jam Paywall Banner
 * 
 * Shown when WB API returns 402 (requires Jam subscription)
 * Links to WB monetization page where users can purchase Jam
 */
export function JamPaywall({ feature, message, compact = false }: JamPaywallProps) {
  const jamUrl = 'https://seller.wildberries.ru/monetization/jam';
  
  const defaultMessage = feature
    ? `Для функции «${feature}» требуется подписка «Джем» на Wildberries`
    : 'Для этой функции требуется подписка «Джем» на Wildberries';

  if (compact) {
    return (
      <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-4 w-4 flex-shrink-0" />
        <span>{message || defaultMessage}</span>
        <a
          href={jamUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200 underline"
        >
          Подключить
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/30">
      <div className="flex gap-3">
        <AlertTriangle className="h-5 w-5 flex-shrink-0 text-amber-500 dark:text-amber-400" />
        <div className="flex-1">
          <h3 className="text-sm font-medium text-amber-800 dark:text-amber-300">
            Требуется подписка «Джем»
          </h3>
          <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
            {message || defaultMessage}
          </p>
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-500">
            Подписка «Джем» от Wildberries открывает доступ к расширенной аналитике, 
            включая историю воронки продаж за год, детальные поисковые отчёты и многое другое.
          </p>
          <div className="mt-3">
            <a
              href={jamUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600"
            >
              Подключить «Джем»
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Hook to check if error is Jam-related
 */
export function isJamError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  
  const err = error as Record<string, unknown>;
  
  // Check for our API error format
  if (err.error === 'WB_JAM_REQUIRED') return true;
  if (err.error === 'jam_required') return true;
  if (err.statusCode === 402 || err.status === 402) return true;
  
  // Check for message patterns
  if (typeof err.message === 'string') {
    const msg = err.message.toLowerCase();
    if (msg.includes('джем') || msg.includes('jam') || msg.includes('402') || msg.includes('jam subscription')) {
      return true;
    }
  }
  
  // Check detail field from WB API
  if (typeof err.detail === 'string' && err.detail.includes('Jam subscription')) {
    return true;
  }
  
  return false;
}

export default JamPaywall;
