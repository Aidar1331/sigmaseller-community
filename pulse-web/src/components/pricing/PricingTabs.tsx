'use client';

import Link from 'next/link';

type Tab = 'rules' | 'ab' | 'history';

const TABS: Array<{ key: Tab; label: string; href: string }> = [
  { key: 'rules', label: 'Правила', href: '/pricing' },
  { key: 'ab', label: 'A/B-тест цены', href: '/pricing/ab' },
  { key: 'history', label: 'История', href: '/pricing/history' },
];

export function PricingTabs({ current }: { current: Tab }) {
  return (
    <div className="flex gap-2 border-b border-gray-200 mb-6">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            current === t.key
              ? 'border-indigo-600 text-indigo-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
