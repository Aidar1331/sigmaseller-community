'use client';

import { useAuthStore } from '@/store/auth';
import { AppShell } from './AppShell';
import { Wrench } from 'lucide-react';

/**
 * Прячет страницу от не-владельца. Сейчас используется для /seo и /bidder —
 * эти инструменты есть в коде, но требуют либо Jam-подписку WB (SEO), либо
 * глубокой ручной настройки (биддер), и для обычного пользователя сейчас
 * не дают value. Показываем экран «в разработке» вместо пустых экранов.
 *
 * Владелец (user_id=1) видит страницу как раньше, чтобы продолжать тестировать.
 */
export function OwnerOnlyGate({ children, title, etaNote }: { children: React.ReactNode; title: string; etaNote?: string }) {
  const currentUserId = useAuthStore((s) => s.user?.userId);
  if (currentUserId === 1) return <>{children}</>;

  return (
    <AppShell title={title}>
      <div className="mx-auto mt-12 max-w-lg rounded-2xl border border-gray-200 bg-white p-10 text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
          <Wrench className="h-7 w-7" />
        </div>
        <h2 className="mb-3 text-xl font-semibold text-gray-900">{title} — в работе</h2>
        <p className="mb-2 text-sm leading-relaxed text-gray-600">
          Эта вкладка ещё допиливается. Сейчас она доступна только в режиме внутреннего тестирования.
        </p>
        {etaNote && (
          <p className="text-xs leading-relaxed text-gray-500">{etaNote}</p>
        )}
      </div>
    </AppShell>
  );
}
