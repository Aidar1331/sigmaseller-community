'use client';

import { useEffect, useState } from 'react';

/**
 * SSR-safe media query hook. Возвращает false при первом рендере, чтобы
 * совпасть с серверным результатом, потом — реальное значение matchMedia.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener?.('change', update);
    return () => mql.removeEventListener?.('change', update);
  }, [query]);

  return matches;
}

/** True при ширине < 640px (Tailwind sm). */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 639px)');
}
