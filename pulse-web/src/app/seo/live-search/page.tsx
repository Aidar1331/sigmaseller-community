'use client';

import { AppShell } from '@/components/AppShell';
import { LivePositionSearch } from '@/components/seo/LivePositionSearch';
import { CompetitorAnalysis } from '@/components/seo/CompetitorAnalysis';
import { useWorkspaceStore } from '@/store/workspace';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

export default function LiveSearchPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);

  if (!workspaceId) {
    return (
      <AppShell>
        <div className="p-8 text-center text-muted-foreground">
          Выберите магазин для поиска позиций
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Link 
            href="/seo"
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Живой поиск позиций</h1>
            <p className="text-muted-foreground">
              Поиск позиций товаров в реальном времени без сохранения в историю
            </p>
          </div>
        </div>

        {/* Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <LivePositionSearch workspaceId={workspaceId} />
          <CompetitorAnalysis workspaceId={workspaceId} />
        </div>

        {/* Help */}
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
          <h3 className="font-medium text-blue-800 dark:text-blue-300 mb-2">💡 Как использовать</h3>
          <ul className="text-sm text-blue-700 dark:text-blue-400 space-y-1">
            <li>• <strong>Поиск позиций</strong> — введите ключевое слово и артикулы товаров для проверки их позиций</li>
            <li>• <strong>Анализ конкурентов</strong> — узнайте CPM ставки рекламодателей по ключевому слову</li>
            <li>• Данные получаются в реальном времени и не сохраняются в историю</li>
            <li>• Для регулярного отслеживания используйте раздел "SEO Позиции"</li>
          </ul>
        </div>
      </div>
    </AppShell>
  );
}
