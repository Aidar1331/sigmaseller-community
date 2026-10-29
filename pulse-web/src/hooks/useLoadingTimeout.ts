import { useState, useEffect } from 'react';

/**
 * Hook to detect slow loading states.
 * Shows warning after timeoutMs (default 10s) if still loading.
 */
export function useLoadingTimeout(
  isLoading: boolean,
  timeoutMs = 10000
): { showSlowWarning: boolean } {
  const [showSlowWarning, setShowSlowWarning] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setShowSlowWarning(false);
      return;
    }

    const timeout = setTimeout(() => {
      setShowSlowWarning(true);
    }, timeoutMs);

    return () => clearTimeout(timeout);
  }, [isLoading, timeoutMs]);

  return { showSlowWarning };
}
