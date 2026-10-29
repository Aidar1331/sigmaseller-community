'use client';

/**
 * PriceSensitivityCard — градиент «низкая · умеренная · высокая» +
 * человеческая фраза про реакцию заказов на изменение цены.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

interface Resp {
  ok: boolean;
  bucket: 'none' | 'low' | 'moderate' | 'high' | 'paradox' | 'insufficient';
  humanText: string;
  status: string;
}

interface Props {
  workspaceId: number;
  shopId: number;
  nmId: number;
  from: string;
  to: string;
}

const BUCKETS: Array<{ key: Resp['bucket']; label: string }> = [
  { key: 'none', label: 'Нет реакции' },
  { key: 'low', label: 'Низкая' },
  { key: 'moderate', label: 'Умеренная' },
  { key: 'high', label: 'Высокая' },
];

export function PriceSensitivityCard({ workspaceId, shopId, nmId, from, to }: Props) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    apiFetch<Resp>(
      `/lab/${workspaceId}/price-sensitivity?shopId=${shopId}&nmId=${nmId}&from=${from}&to=${to}`,
      { signal: ac.signal } as RequestInit,
    )
      .then(d => { if (!ac.signal.aborted) setData(d); })
      .catch(() => {})
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [workspaceId, shopId, nmId, from, to]);

  if (loading) return <div className="text-xs text-slate-500 italic">Оцениваем чувствительность к цене…</div>;
  if (!data) return null;
  if (data.bucket === 'insufficient') {
    return <div className="text-xs text-slate-500">{data.humanText || 'Недостаточно вариации цены для оценки.'}</div>;
  }
  if (data.bucket === 'paradox') {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
        <div className="text-xs font-medium text-amber-900 mb-1">Необычный паттерн</div>
        <div className="text-xs text-amber-800">
          {data.humanText}. Возможно эффект премиального позиционирования или совпадение с внешним всплеском спроса.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="text-xs font-medium text-slate-700 mb-1">Ценовая чувствительность товара</div>
      <div className="flex items-stretch rounded-md overflow-hidden border border-slate-200">
        {BUCKETS.map(b => {
          const active = b.key === data.bucket;
          return (
            <div
              key={b.key}
              className={`flex-1 text-center text-[11px] py-2 ${active
                ? 'bg-gradient-to-r from-emerald-400 to-emerald-600 text-white font-semibold'
                : 'bg-slate-50 text-slate-500'
                }`}
              title={b.label}
            >
              {b.label}
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-xs text-indigo-700 font-medium">💡 {data.humanText}</div>
    </div>
  );
}
