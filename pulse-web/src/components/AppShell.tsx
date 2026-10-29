'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  BookOpen,
  Bot,
  Box,
  Calculator,
  CreditCard,
  FileText,
  Layers,
  LayoutGrid,
  MessageSquare,
  Palette,
  PieChart,
  Rocket,
  Settings,
  Shield,
  Sparkles,
  Lightbulb,
  Percent,
  Tag,
  Target,
  TestTube,
  Truck,
  TrendingUp,
  Users,
  Wallet,
  Zap,
  ChevronRight,
  ChevronDown,
  Coins,
  DollarSign,
  Menu,
  X,
  LogOut,
  type LucideIcon,
} from 'lucide-react';
import { SidebarWorkspaceSelector } from './WorkspaceGuard';
import { useWorkspaceStore } from '@/store/workspace';
import { useAuthStore } from '@/store/auth';
import { useStudioTaskStore } from '@/store/studioTask';
import { useStudioTaskPolling } from '@/hooks/useStudioTaskPolling';
import { useAuditJobPolling } from '@/hooks/useAuditJobPolling';
import { apiFetch } from '@/lib/api';
import { SyncProgressBanner } from '@/components/SyncProgressBanner';
import { DataFreshnessBar } from '@/components/DataFreshnessBar';
import { BottomNav } from '@/components/ui/BottomNav';

type MenuItem = { href: string; label: string; icon: LucideIcon; ownerOnly?: boolean };
type NavGroup = { title: string; items: MenuItem[] };

// ownerOnly=true — фича в работе, в меню видна только владельцу аккаунта.
// SEO требует Jam-подписки WB (у большинства пользователей пуст), биддер
// требует ручной настройки правил и сам по себе не plug-and-play.
// Показываем их только админу (user_id=1) до полноценной готовности.
const NAV_GROUPS: NavGroup[] = [
  {
    title: 'AI инструменты',
    items: [
      { href: '/ai',             label: 'AI Ассистент',     icon: Bot },
      { href: '/creative-audit', label: 'Аудит карточки',   icon: Palette },
      { href: '/studio',         label: 'AI Студия',        icon: Sparkles },
      { href: '/feedback',       label: 'Отзывы и вопросы', icon: MessageSquare },
    ],
  },
  {
    title: 'Помощники',
    items: [
      { href: '/task-monitor', label: 'Мониторинг',  icon: Shield },
      { href: '/documents',    label: 'База знаний', icon: BookOpen },
      { href: '/events',       label: 'Канбан',      icon: LayoutGrid },
      { href: '/tags',         label: 'Теги',        icon: Tag },
    ],
  },
  {
    title: 'Аналитика',
    items: [
      { href: '/pulse',                label: 'Рука на пульсе',   icon: Activity },
      { href: '/dynamics',             label: 'Лаборатория',      icon: TrendingUp },
      { href: '/analytics/abc',        label: 'ABC-анализ',       icon: PieChart },
      { href: '/analytics/warehouses', label: 'Склады и регионы', icon: Layers },
      // { href: '/insights',             label: 'Инсайты',          icon: Lightbulb }, // скрыто 2026-05-25 по запросу оператора
    ],
  },
  {
    title: 'Продвижение',
    items: [
      { href: '/seo',        label: 'SEO позиции',   icon: Target, ownerOnly: true },
      // Биддер скрыт из сайдбара 2026-05-31 по запросу оператора — авто-управление
      // рекламой ещё не готово (симуляция выдаёт мизерную разницу, юзеру
      // непонятно что произойдёт). Страница `/bidder` и API остаются за
      // owner-gate в middleware для дальнейшей доработки.
      // { href: '/bidder',     label: 'Рекл. биддер',  icon: Zap,    ownerOnly: true },
      { href: '/pricing',    label: 'Цена',          icon: DollarSign },
      { href: '/ab-photo',   label: 'A/B тест фото', icon: TestTube },
      // Промо-акции скрыты по запросу оператора 2026-05-25 — раздел показывает
      // "Скоро" для непринципиальных WB-акций и больше путает, чем помогает.
      // Страница и API остаются, просто убрана из сайдбара.
      // { href: '/promotions', label: 'Акции',          icon: Percent },
    ],
  },
  {
    title: 'Поставки',
    items: [
      { href: '/supplies', label: 'FBW отгрузки', icon: Truck },
      { href: '/fbs',      label: 'FBS отгрузки', icon: Box },
    ],
  },
  {
    title: 'Финансы',
    items: [
      { href: '/plan',           label: 'Факт / План',    icon: FileText },
      { href: '/cashflow',       label: 'ДДС',            icon: Wallet },
      { href: '/finance',        label: 'Финансы',        icon: CreditCard },
      { href: '/unit-economics', label: 'Юнит-экономика', icon: Calculator },
      { href: '/cogs',           label: 'Себестоимость',  icon: Calculator },
    ],
  },
];

// Flat lookup for page title / active icon in header.
const ALL_MAIN_ITEMS: MenuItem[] = NAV_GROUPS.flatMap((g) => g.items);

const SETTINGS: MenuItem[] = [
  { href: '/settings/team', label: 'Команда', icon: Users },
  // { href: '/settings/agent', label: 'AI-агент', icon: Bot }, // Hidden 2026-05-25 by request
  // { href: '/access', label: 'Доступ', icon: Users }, // Deprecated: use /settings/team
  { href: '/settings/ai', label: 'Настройки ИИ', icon: CreditCard },
  { href: '/connections', label: 'Подключения ИИ', icon: CreditCard },
  { href: '/assistant', label: 'Чат с магазином', icon: CreditCard },
  { href: '/shops', label: 'Магазины', icon: Box },
];

function NavSection({
  title,
  items,
  pathname,
  unansweredCount,
  collapsed,
  onToggle,
  onItemClick,
}: {
  title: string;
  items: MenuItem[];
  pathname: string;
  unansweredCount: number;
  collapsed: boolean;
  onToggle: () => void;
  onItemClick?: () => void;
}) {
  // If the active route lives inside this section, force-expand it on every
  // render — collapsing the active group would hide the user's current page.
  const containsActive = items.some((it) => pathname === it.href || pathname.startsWith(it.href + '/'));
  const effectivelyCollapsed = collapsed && !containsActive;

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={onToggle}
        className="group flex w-full items-center justify-between rounded-md px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors"
      >
        <span>{title}</span>
        <ChevronDown
          className={`h-3 w-3 transition-transform duration-200 ${effectivelyCollapsed ? '-rotate-90' : ''}`}
        />
      </button>
      {!effectivelyCollapsed && (
        <div className="mt-1 flex flex-col gap-1">
          {items.map((item) => (
            <NavItem
              key={item.href}
              item={item}
              active={pathname === item.href || pathname.startsWith(item.href + '/')}
              badge={item.href === '/feedback' ? unansweredCount : undefined}
              onClick={onItemClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NavItem({ item, active, badge, onClick }: { item: MenuItem; active: boolean; badge?: number; onClick?: () => void }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={`
        group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium
        transition-all duration-200 ease-out
        ${active
          ? 'bg-indigo-50 text-indigo-700'
          : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
        }
      `}
    >
      {/* Active indicator */}
      {active && (
        <div className="absolute -left-1 top-1/2 h-8 w-1 -translate-y-1/2 rounded-full bg-gradient-to-b from-indigo-500 to-indigo-600" />
      )}
      
      <div className={`
        relative flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-200
        ${active 
          ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200' 
          : 'bg-gray-100 text-gray-500 group-hover:bg-gray-200 group-hover:text-gray-700'
        }
      `}>
        <Icon className="h-4 w-4" />
        {badge != null && badge > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </div>
      
      <span className="flex-1">{item.label}</span>
      
      {active && (
        <ChevronRight className="h-4 w-4 text-indigo-400" />
      )}
    </Link>
  );
}

export function AppShell({ title, children, fullHeight }: { title?: string; children: React.ReactNode; fullHeight?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopId = useWorkspaceStore((s) => s.shopId);
  const logout = useAuthStore((s) => s.logout);
  const currentUserId = useAuthStore((s) => s.user?.userId);
  const isOwner = currentUserId === 1; // владелец (оператор) видит ownerOnly-фичи в работе

  // Фильтр: для не-владельца убираем ownerOnly-пункты, не показываем пустые группы.
  const visibleNavGroups = useMemo<NavGroup[]>(() => {
    if (isOwner) return NAV_GROUPS;
    return NAV_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((it) => !it.ownerOnly),
    })).filter((g) => g.items.length > 0);
  }, [isOwner]);

  const handleLogout = () => {
    logout();
    router.push('/auth/login');
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [unansweredCount, setUnansweredCount] = useState(0);
  const [aiBalance, setAiBalance] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Global Studio-task polling — при переключении страниц задача генерации
  // не теряется, прогресс обновляется из любой вкладки.
  useStudioTaskPolling();
  // Тот же паттерн для Creative Audit карточки — задача длится 3-5 мин,
  // user часто переключается на /pulse / /dynamics пока ждёт.
  useAuditJobPolling();
  const studioTask = useStudioTaskStore((s) => s.activeTask);
  const clearStudioTask = useStudioTaskStore((s) => s.clearActiveTask);

  // Sidebar section collapse state — persisted in localStorage so the
  // user's preference survives page reloads. Default: all expanded.
  const COLLAPSE_KEY = 'pulse:nav:collapsed';
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSE_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr)) setCollapsedGroups(new Set(arr));
      }
    } catch {}
  }, []);
  const toggleGroup = (title: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      try { window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(next))); } catch {}
      return next;
    });
  };

  // Load AI balance (shown in header next to «Онлайн»)
  useEffect(() => {
    if (!workspaceId) return;
    let mounted = true;
    const loadBalance = async () => {
      try {
        const res = await apiFetch<{ balanceRub: number }>(`/ai/${workspaceId}/balance`);
        if (mounted) setAiBalance(res.balanceRub);
      } catch {
        // silent — баланс не критичен для работы
      }
    };
    loadBalance();
    const interval = setInterval(loadBalance, 60 * 1000); // refresh every 1 min
    return () => { mounted = false; clearInterval(interval); };
  }, [workspaceId]);

  // Load unanswered feedback count
  useEffect(() => {
    if (!workspaceId) return;
    let mounted = true;
    const loadCount = async () => {
      try {
        const res = await apiFetch(`/feedback/${workspaceId}/unanswered`) as { total: number };
        if (mounted) setUnansweredCount(res.total ?? 0);
      } catch (e) {
        console.error('Failed to load unanswered count:', e);
      }
    };
    loadCount();
    // Refresh every 5 minutes
    const interval = setInterval(loadCount, 5 * 60 * 1000);
    return () => { mounted = false; clearInterval(interval); };
  }, [workspaceId, shopId]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!settingsOpen) return;
      const el = menuRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setSettingsOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [settingsOpen]);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  const pageTitle = useMemo(() => {
    if (title) return title;
    return ALL_MAIN_ITEMS.find((x) => x.href === pathname)?.label ?? 'Sigma Seller';
  }, [pathname, title]);

  const currentIcon = useMemo(() => {
    const item = ALL_MAIN_ITEMS.find((x) => x.href === pathname);
    return item?.icon ?? Activity;
  }, [pathname]);

  const CurrentIcon = currentIcon;

  return (
    <div className={`${fullHeight ? 'h-screen overflow-hidden' : 'min-h-screen'} bg-[var(--bg-base)]`}>
      <div className={`flex ${fullHeight ? 'h-full' : ''}`}>
        {/* Sidebar — Desktop */}
        <aside className="hidden w-[280px] shrink-0 flex-col border-r border-gray-200 bg-white md:flex">
          {/* Logo + Workspace Selector */}
          <div className="border-b border-gray-100 px-5 py-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-200">
                <span className="text-white text-2xl font-bold leading-none" style={{ fontFamily: 'serif' }}>Σ</span>
              </div>
              <h1 className="text-lg font-bold tracking-tight text-gray-900">Sigma Seller</h1>
            </div>
            <SidebarWorkspaceSelector />
          </div>

          {/* Navigation */}
          <nav className="flex-1 overflow-y-auto p-4">
            {visibleNavGroups.map((group) => (
              <NavSection
                key={group.title}
                title={group.title}
                items={group.items}
                pathname={pathname}
                unansweredCount={unansweredCount}
                collapsed={collapsedGroups.has(group.title)}
                onToggle={() => toggleGroup(group.title)}
              />
            ))}
          </nav>

          {/* Settings button */}
          <div className="border-t border-gray-100 p-4">
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setSettingsOpen((v) => !v)}
                className={`
                  flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium
                  transition-all duration-200
                  ${settingsOpen 
                    ? 'bg-gray-100 text-gray-900' 
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                  }
                `}
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100">
                  <Settings className="h-4 w-4 text-gray-500" />
                </div>
                <span className="flex-1 text-left">Настройки</span>
                <ChevronRight className={`h-4 w-4 text-gray-500 transition-transform duration-200 ${settingsOpen ? 'rotate-90' : ''}`} />
              </button>

              {/* Settings dropdown */}
              {settingsOpen && (
                <div className="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
                  <div className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Настройки
                  </div>
                  <div className="flex flex-col p-2">
                    {SETTINGS.map((it) => {
                      const Icon = it.icon;
                      const active = pathname === it.href;
                      return (
                        <Link
                          key={it.href}
                          href={it.href}
                          onClick={() => setSettingsOpen(false)}
                          className={`
                            flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-150
                            ${active 
                              ? 'bg-indigo-50 text-indigo-700' 
                              : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                            }
                          `}
                        >
                          <Icon className="h-4 w-4" />
                          {it.label}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* Mobile menu overlay */}
        {mobileMenuOpen && (
          <div 
            className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm md:hidden"
            onClick={() => setMobileMenuOpen(false)}
          />
        )}

        {/* Mobile menu */}
        <aside className={`
          fixed inset-y-0 left-0 z-50 flex w-[280px] transform flex-col bg-white shadow-2xl
          transition-transform duration-300 ease-out md:hidden
          ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}
        `}>
          <div className="border-b border-gray-100 px-5 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600">
                  <span className="text-white text-2xl font-bold leading-none" style={{ fontFamily: 'serif' }}>Σ</span>
                </div>
                <h1 className="text-lg font-bold text-gray-900">Sigma Seller</h1>
              </div>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <SidebarWorkspaceSelector />
          </div>
          <nav className="flex-1 overflow-y-auto p-4">
            {NAV_GROUPS.map((group) => (
              <NavSection
                key={group.title}
                title={group.title}
                items={group.items}
                pathname={pathname}
                unansweredCount={unansweredCount}
                collapsed={collapsedGroups.has(group.title)}
                onToggle={() => toggleGroup(group.title)}
                onItemClick={() => setMobileMenuOpen(false)}
              />
            ))}

            {/* Settings section — flat list on mobile (desktop hides this
                under a footer popover, but on a drawer it's friendlier to
                inline it). Mirrors SETTINGS array so links stay in sync. */}
            <div className="mt-4 pt-4 border-t border-gray-100">
              <div className="px-3 mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-2">
                <Settings className="h-3.5 w-3.5" />
                Настройки
              </div>
              <div className="flex flex-col gap-0.5">
                {SETTINGS.map((it) => {
                  const Icon = it.icon;
                  const active = pathname === it.href;
                  return (
                    <Link
                      key={it.href}
                      href={it.href}
                      onClick={() => setMobileMenuOpen(false)}
                      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                        active
                          ? 'bg-indigo-50 text-indigo-700'
                          : 'text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      <Icon className="h-4 w-4 text-gray-500" />
                      {it.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          </nav>
        </aside>

        {/* Main content */}
        <main className={`min-w-0 flex-1 ${fullHeight ? 'flex flex-col overflow-hidden' : ''}`}>
          {/* Header */}
          <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/80 backdrop-blur-lg">
            <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-4 lg:px-6">
              {/* Left: Mobile menu + Title */}
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setMobileMenuOpen(true)}
                  className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 md:hidden"
                >
                  <Menu className="h-5 w-5" />
                </button>
                
                <div className="flex items-center gap-3">
                  <div className="hidden h-9 w-9 items-center justify-center rounded-xl bg-indigo-50 sm:flex">
                    <CurrentIcon className="h-4 w-4 text-indigo-600" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-gray-900">{pageTitle}</h2>
                  </div>
                </div>
              </div>

              {/* Right: Status + Balance + Logout */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5">
                  <div className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="text-xs font-medium text-emerald-700">Онлайн</span>
                </div>

                {/* Активная Studio-генерация — индикатор виден на всех страницах */}
                {studioTask && (studioTask.status === 'pending' || studioTask.status === 'processing') && (
                  <Link
                    href="/studio"
                    className="hidden sm:flex items-center gap-1.5 rounded-full bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 transition-colors"
                    title={`AI Студия: ${studioTask.prompt.slice(0, 80)}`}
                  >
                    <span className="h-2 w-2 rounded-full bg-violet-500 animate-pulse" />
                    <span>
                      AI Студия:{' '}
                      {studioTask.status === 'pending' ? 'в очереди' : `${studioTask.progress ?? 0}%`}
                    </span>
                  </Link>
                )}
                {studioTask && studioTask.status === 'completed' && (
                  <Link
                    href="/studio"
                    onClick={clearStudioTask}
                    className="hidden sm:flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100 transition-colors"
                    title="Генерация завершена — кликни чтобы открыть"
                  >
                    ✅ Готово
                  </Link>
                )}
                {studioTask && studioTask.status === 'failed' && (
                  <Link
                    href="/studio"
                    onClick={clearStudioTask}
                    className="hidden sm:flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors"
                    title={studioTask.error || 'Ошибка'}
                  >
                    ❌ Ошибка
                  </Link>
                )}
                <Link href="/settings/ai" className="text-xs text-indigo-600">Мои ключи ИИ</Link>
                <button
                  onClick={handleLogout}
                  className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
                  title="Выйти"
                >
                  <LogOut className="h-4 w-4" />
                  <span className="hidden sm:inline">Выйти</span>
                </button>
              </div>
            </div>
          </header>

          {/* Sync progress banner */}
          {!fullHeight && <SyncProgressBanner />}
          {!fullHeight && <DataFreshnessBar />}

          {/* Page content
              На mobile добавляем pb-20 чтобы контент не прятался под BottomNav (56px + safe-area). */}
          <div
            className={
              fullHeight
                ? 'flex-1 min-h-0'
                : 'mx-auto max-w-[1400px] px-4 py-6 pb-24 md:pb-6 lg:px-6'
            }
          >
            {workspaceId ? children : (
              <div className="flex min-h-[300px] flex-col items-center justify-center gap-4 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-50">
                  <Box className="h-8 w-8 text-indigo-500" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Выберите рабочее пространство</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    Используйте селектор в боковом меню для выбора магазина
                  </p>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Mobile bottom navigation — видна только на <md. Desktop пользуется sidebar. */}
      <BottomNav />
    </div>
  );
}
