'use client';

import { AppShell } from '@/components/AppShell';
import { PricingTabs } from '@/components/pricing/PricingTabs';

export default function PricingHistoryPage() {
  return (
    <AppShell>
      <div className="p-6 max-w-6xl mx-auto">
        <h1 className="text-2xl font-semibold mb-1">Цена</h1>
        <p className="text-sm text-gray-500 mb-6">
          Управление ценой: правила репрайса, A/B-тесты цены, история изменений.
        </p>
        <PricingTabs current="history" />

        <div className="p-8 border border-dashed border-gray-300 rounded text-center text-gray-500 text-sm">
          История всех изменений цены — следующая итерация.
          Будет лог из pricing_decisions: когда, артикул, было → стало, источник (Sigma/ручка), причина.
        </div>
      </div>
    </AppShell>
  );
}
