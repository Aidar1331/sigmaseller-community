'use client';

import { AppShell } from '@/components/AppShell';
import { BidCalculator } from '@/components/bidder/BidCalculator';
import { useWorkspaceStore } from '@/store/workspace';
import { ArrowLeft, Calculator, TrendingUp } from 'lucide-react';
import Link from 'next/link';

export default function BidCalculatorPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);

  if (!workspaceId) {
    return (
      <AppShell>
        <div className="p-8 text-center text-muted-foreground">
          Выберите магазин для расчёта ставок
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
            href="/bidder"
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Calculator className="h-7 w-7" />
              Калькулятор ставок
            </h1>
            <p className="text-muted-foreground">
              Рассчитайте оптимальную ставку для достижения нужной позиции в рекламе
            </p>
          </div>
        </div>

        {/* Content */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <BidCalculator workspaceId={workspaceId} />
          
          {/* Tips Card */}
          <div className="space-y-4">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h3 className="font-semibold mb-4 flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-green-700" />
                Стратегии биддинга
              </h3>
              
              <div className="space-y-4 text-sm">
                <div>
                  <h4 className="font-medium mb-1">🎯 По позиции</h4>
                  <p className="text-gray-600 dark:text-gray-400">
                    Укажите целевую позицию — система рассчитает минимальную ставку для её достижения.
                    Учитываются текущие CPM конкурентов.
                  </p>
                </div>
                
                <div>
                  <h4 className="font-medium mb-1">📊 По DRR (Доля рекламных расходов)</h4>
                  <p className="text-gray-600 dark:text-gray-400">
                    Укажите целевой DRR — ставка будет корректироваться автоматически, 
                    чтобы держать рекламные расходы в заданных пределах.
                  </p>
                </div>
                
                <div>
                  <h4 className="font-medium mb-1">💰 Лимиты</h4>
                  <p className="text-gray-600 dark:text-gray-400">
                    Всегда устанавливайте минимальную и максимальную ставку. 
                    Это защитит от случайных перерасходов.
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
              <h3 className="font-medium text-yellow-800 dark:text-yellow-300 mb-2">⚠️ Важно</h3>
              <ul className="text-sm text-yellow-700 dark:text-yellow-400 space-y-1">
                <li>• Ставки конкурентов меняются постоянно</li>
                <li>• Рекомендации актуальны на момент расчёта</li>
                <li>• Для автоматизации используйте правила биддера</li>
                <li>• Учитывайте время суток — ставки меняются</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
