'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  CalendarDays,
  MessageSquare,
  CreditCard,
  Bot,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * BottomNav — нижняя мобильная навигация (5 ключевых разделов).
 *
 * - Видна на <md, скрыта на >=md (там работает sidebar).
 * - Active state по pathname (точное совпадение или startsWith + '/').
 * - Высота 56px + safe-area-inset-bottom (env() для notch / home indicator iOS).
 * - z-30 — ниже модалок (z-50), но выше контента.
 * - Touch targets ≥ 48×48 — кнопки растягиваются по высоте 56px и flex-1.
 */

type NavItem = { href: string; label: string; icon: LucideIcon };

const ITEMS: NavItem[] = [
  { href: '/pulse',    label: 'Пульс',    icon: Activity },
  { href: '/events',   label: 'События',  icon: CalendarDays },
  { href: '/feedback', label: 'Отзывы',   icon: MessageSquare },
  { href: '/finance',  label: 'Финансы',  icon: CreditCard },
  { href: '/ai',       label: 'Чат',      icon: Bot },
];

// Страницы где BottomNav перекрывает свой sticky-input (чат / редакторы) —
// на них навигация скрывается полностью, чтобы не блокировать ввод.
const HIDE_ON_PATHS: Array<string | RegExp> = [
  /^\/ai(\/|$)/,        // AI чат: имеет свой sticky input снизу
  /^\/chat(\/|$)/,      // Buyer chat
  /^\/studio\/editor/,  // Studio canvas
];

export function BottomNav() {
  const pathname = usePathname() || '/';

  // Hide on pages with their own fixed-bottom controls
  const shouldHide = HIDE_ON_PATHS.some((p) =>
    typeof p === 'string' ? pathname === p : p.test(pathname),
  );
  if (shouldHide) return null;

  return (
    <nav
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 md:hidden',
        'border-t border-gray-200 bg-white/95 backdrop-blur-lg',
        'pb-safe'
      )}
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      aria-label="Основная навигация"
    >
      <ul className="mx-auto flex h-14 max-w-screen-sm items-stretch">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const active =
            pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-full w-full flex-col items-center justify-center gap-0.5',
                  'transition-colors duration-150',
                  // touch target 48×56
                  'min-h-[48px]',
                  active
                    ? 'text-indigo-600'
                    : 'text-gray-500 active:text-gray-700'
                )}
              >
                <Icon
                  className={cn(
                    'h-5 w-5 transition-transform',
                    active && 'scale-110'
                  )}
                  aria-hidden="true"
                />
                <span
                  className={cn(
                    'text-[11px] font-medium leading-none',
                    active && 'font-semibold'
                  )}
                >
                  {item.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
