'use client';

import * as React from 'react';
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { apiFetch } from '@/lib/api';
import { Sparkles, Download, TrendingUp, TrendingDown, Minus, Package } from 'lucide-react';

interface SuggestRow {
  nmId: number;
  title: string;
  vendorCode: string;
  photo: string | null;
  avg30dQty: number;
  avg7dQty: number;
  trendPct: number;
  fboQty: number;
  fbsQty: number;
  totalStockQty: number;
  avgPriceRub: number;
  planQty: number;
  planRevenueRub: number;
  stockLimited: boolean;
}

interface SuggestResp {
  month: string;
  daysInMonth: number;
  summary: {
    skuCount: number;
    totalPlanQty: number;
    totalPlanRub: number;
    avgPriceRub: number;
  };
  rows: SuggestRow[];
}

interface Props {
  workspaceId: number | null;
  shopId?: number;
  month: string;
}

export function AutoSuggestSection({ workspaceId, shopId, month }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SuggestResp | null>(null);
  const [sortBy, setSortBy] = useState<'revenue' | 'qty' | 'trend' | 'stock'>('revenue');

  const run = async () => {
    if (!workspaceId) return;
    setLoading(true);
    setOpen(true);
    try {
      const params = new URLSearchParams({ workspaceId: String(workspaceId), month });
      if (shopId) params.set('shopId', String(shopId));
      const res = await apiFetch<SuggestResp>(`/plans/auto-suggest?${params}`);
      setData(res);
    } catch (e) {
      console.error('autosuggest', e);
    } finally {
      setLoading(false);
    }
  };

  // Auto-reload когда пользователь сохранил распределение в MonthlyTargetSection
  React.useEffect(() => {
    const handler = () => {
      if (open && workspaceId) run();
    };
    window.addEventListener('plan-distribution-saved', handler);
    return () => window.removeEventListener('plan-distribution-saved', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId, shopId, month]);

  const sorted = data ? [...data.rows].sort((a, b) => {
    if (sortBy === 'qty') return b.planQty - a.planQty;
    if (sortBy === 'trend') return b.trendPct - a.trendPct;
    if (sortBy === 'stock') return b.totalStockQty - a.totalStockQty;
    return b.planRevenueRub - a.planRevenueRub;
  }) : [];

  const downloadCsv = () => {
    if (!data) return;
    const h = 'nmId;vendorCode;title;avg30d;avg7d;trend%;FBO;FBS;avgPrice;planQty;planRevenue';
    const lines = data.rows.map(r =>
      [r.nmId, r.vendorCode, `"${r.title.replace(/"/g, '""')}"`, r.avg30dQty, r.avg7dQty, r.trendPct, r.fboQty, r.fbsQty, r.avgPriceRub, r.planQty, r.planRevenueRub].join(';')
    );
    const blob = new Blob(['﻿' + [h, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `plan_autosuggest_${data.month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              План по артикулам
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              План шт — сохранённое распределение по SKU (из кнопки «Распределить план по SKU»). Редактируй вручную в колонке «План шт».
            </p>
          </div>
          <div className="flex items-center gap-2">
            {data && (
              <Button variant="neutral" size="sm" onClick={downloadCsv}>
                <Download className="h-3.5 w-3.5 mr-1" /> CSV
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={run} loading={loading}>
              <Sparkles className="h-3.5 w-3.5 mr-1" /> {data ? 'Пересчитать' : 'Рассчитать'}
            </Button>
          </div>
        </div>

        {open && data && (
          <>
            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="SKU в расчёте" value={data.summary.skuCount} />
              <Stat label="План по объёму" value={`${data.summary.totalPlanQty} шт`} />
              <Stat label="План по выручке" value={`${data.summary.totalPlanRub.toLocaleString('ru-RU')} ₽`} highlight />
              <Stat label="Средний чек" value={`${data.summary.avgPriceRub.toLocaleString('ru-RU')} ₽`} />
            </div>

            {/* Sort tabs */}
            <div className="flex gap-2 text-xs">
              <span className="text-gray-500 self-center">Сорт.:</span>
              {[
                { k: 'revenue' as const, l: 'По выручке' },
                { k: 'qty' as const, l: 'По кол-ву' },
                { k: 'trend' as const, l: 'По тренду' },
                { k: 'stock' as const, l: 'По остатку' },
              ].map((o) => (
                <button
                  key={o.k}
                  onClick={() => setSortBy(o.k)}
                  className={'px-2 py-1 rounded ' + (sortBy === o.k ? 'bg-violet-100 text-violet-700 font-medium' : 'text-gray-500 hover:bg-gray-100')}
                >
                  {o.l}
                </button>
              ))}
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50">
                  <tr className="text-gray-600">
                    <th className="px-2 py-2 text-left font-medium">Артикул / Название</th>
                    <th className="px-2 py-2 text-right font-medium">avg 30д</th>
                    <th className="px-2 py-2 text-right font-medium">avg 7д</th>
                    <th className="px-2 py-2 text-right font-medium">Тренд</th>
                    <th className="px-2 py-2 text-right font-medium">FBO</th>
                    <th className="px-2 py-2 text-right font-medium">FBS</th>
                    <th className="px-2 py-2 text-right font-medium">Цена</th>
                    <th className="px-2 py-2 text-right font-medium bg-violet-50">План шт</th>
                    <th className="px-2 py-2 text-right font-medium bg-violet-50">План ₽</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sorted.slice(0, 100).map((r) => (
                    <tr key={r.nmId} className={r.stockLimited ? 'bg-amber-50/40' : ''}>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-2">
                          {r.photo ? (
                            <img src={r.photo} alt="" className="w-8 h-8 object-cover rounded" />
                          ) : (
                            <div className="w-8 h-8 bg-gray-100 rounded flex items-center justify-center">
                              <Package className="h-4 w-4 text-gray-400" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="font-mono text-[10px] text-gray-500"><NmIdLink nmId={r.nmId} /></div>
                            <div className="truncate max-w-[280px] text-gray-700">{r.title}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.avg30dQty}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.avg7dQty}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        <TrendBadge pct={r.trendPct} />
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.fboQty}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.fbsQty}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.avgPriceRub}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium bg-violet-50/40">{r.planQty}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium bg-violet-50/40">
                        {r.planRevenueRub.toLocaleString('ru-RU')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.rows.length > 100 && (
                <div className="text-xs text-gray-500 mt-2 px-2">
                  Показано первые 100 из {data.rows.length} SKU. Полный список — в CSV.
                </div>
              )}
            </div>

            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              ⚠️ Жёлтые строки — план зарезан остатками (товара не хватит на трендовый прогноз). Нужна поставка.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className={highlight ? 'rounded-md bg-violet-50 border border-violet-200 p-3' : 'rounded-md border border-gray-200 p-3'}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={'mt-0.5 text-base font-semibold ' + (highlight ? 'text-violet-700' : 'text-gray-900')}>
        {value}
      </div>
    </div>
  );
}

function TrendBadge({ pct }: { pct: number }) {
  if (pct >= 10) return <span className="inline-flex items-center gap-0.5 text-emerald-700"><TrendingUp className="h-3 w-3" />+{pct}%</span>;
  if (pct <= -10) return <span className="inline-flex items-center gap-0.5 text-red-600"><TrendingDown className="h-3 w-3" />{pct}%</span>;
  return <span className="inline-flex items-center gap-0.5 text-gray-500"><Minus className="h-3 w-3" />{pct}%</span>;
}
