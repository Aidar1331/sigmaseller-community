'use client';

import * as React from 'react';
import { Card } from '@/components/ui/Card';
import { AlertCircle } from 'lucide-react';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { CopyTableButton } from '@/components/ui/CopyTableButton';
import { ExportButton } from '@/components/ui/ExportButton';
import { csrfHeaders } from '@/lib/api';
import { InsightCard as LabInsightCard, type InsightPayload as LabInsightPayload } from '@/components/lab/InsightCard';
import {
  LabMetricRelationsWidget,
  LabPriceImpactWidget,
  LabAdsDelayWidget,
  LabPriceSensitivityWidget,
  LabProductTimelineWidget,
  LabSeoInsightsWidget,
  LabBestComboWidget,
} from '@/components/ai/widgets/lab/chatWidgets';

interface WidgetRendererProps {
  type: string;
  props: Record<string, unknown>;
}

/**
 * Widget registry and renderer.
 * Maps widget type to component.
 */
export function WidgetRenderer({ type, props }: WidgetRendererProps) {
  const Widget = WIDGET_REGISTRY[type];

  if (!Widget) {
    return (
      <Card className="p-4 bg-gray-50">
        <div className="flex items-center gap-2 text-gray-500">
          <AlertCircle className="w-4 h-4" />
          <span className="text-sm">Неизвестный виджет: {type}</span>
        </div>
        <pre className="mt-2 text-xs text-gray-500 overflow-auto">
          {JSON.stringify(props, null, 2)}
        </pre>
      </Card>
    );
  }

  return <Widget {...props} />;
}

// ── Widget Components ──────────────────────────────────────

/**
 * Funnel diagram widget.
 * Shows sales funnel stages.
 */
function FunnelDiagramWidget(props: Record<string, unknown>) {
  const stages = (props.stages as Array<{ name: string; value: number; pct: number }>) ?? [];
  const nmId = props.nmId as number | undefined;
  const title = (props.title as string) ?? 'Воронка продаж';

  return (
    <Card className="p-4">
      <h4 className="font-medium text-gray-900 mb-3">{title}</h4>
      {nmId && <p className="text-xs text-gray-500 mb-3">SKU: {nmId}</p>}
      <div className="space-y-2">
        {stages.map((stage, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="w-24 text-sm text-gray-600 truncate">{stage.name}</div>
            <div className="flex-1 h-6 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-violet-500 rounded-full transition-all"
                style={{ width: `${Math.min(100, stage.pct)}%` }}
              />
            </div>
            <div className="w-20 text-sm text-right">
              <span className="font-medium">{formatNumber(stage.value)}</span>
              <span className="text-gray-500 ml-1">({stage.pct}%)</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * Price slider widget.
 * Allows adjusting price with projections.
 */
function PriceSliderWidget(props: Record<string, unknown>) {
  const currentPrice = (props.currentPrice as number) ?? 0;
  const minPrice = (props.minPrice as number) ?? 0;
  const maxPrice = (props.maxPrice as number) ?? 0;
  const productName = (props.productName as string) ?? 'Товар';
  const projections = (props.projections as Array<{
    price: number;
    margin: number;
    orders: number;
    revenue: number;
  }>) ?? [];

  return (
    <Card className="p-4">
      <h4 className="font-medium text-gray-900 mb-1">Изменение цены</h4>
      <p className="text-sm text-gray-500 mb-4">{productName}</p>

      <div className="mb-4">
        <div className="flex justify-between text-sm text-gray-500 mb-1">
          <span>{formatCurrency(minPrice)}</span>
          <span className="font-medium text-violet-600">{formatCurrency(currentPrice)}</span>
          <span>{formatCurrency(maxPrice)}</span>
        </div>
        <input
          type="range"
          min={minPrice}
          max={maxPrice}
          defaultValue={currentPrice}
          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-violet-600"
        />
      </div>

      {projections.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-center text-sm">
          <div className="p-2 bg-gray-50 rounded-lg">
            <div className="text-gray-500">Маржа</div>
            <div className="font-medium">{projections[0]?.margin ?? 0}%</div>
          </div>
          <div className="p-2 bg-gray-50 rounded-lg">
            <div className="text-gray-500">Заказы</div>
            <div className="font-medium">{projections[0]?.orders ?? 0}</div>
          </div>
          <div className="p-2 bg-gray-50 rounded-lg">
            <div className="text-gray-500">Выручка</div>
            <div className="font-medium">{formatCurrency(projections[0]?.revenue ?? 0)}</div>
          </div>
          <div className="p-2 bg-gray-50 rounded-lg">
            <div className="text-gray-500">Цена</div>
            <div className="font-medium">{formatCurrency(projections[0]?.price ?? currentPrice)}</div>
          </div>
        </div>
      )}

      <p className="mt-4 text-xs text-gray-500 text-center">
        Переместите слайдер и нажмите "Подтвердить" для применения
      </p>
    </Card>
  );
}

/**
 * Insight card widget.
 * Shows a single insight with icon and action.
 */
function InsightCardWidget(props: Record<string, unknown>) {
  const title = (props.title as string) ?? 'Инсайт';
  const description = (props.description as string) ?? '';
  const severity = (props.severity as 'info' | 'warning' | 'critical') ?? 'info';
  const metric = (props.metric as string) ?? '';
  const value = (props.value as string | number) ?? '';
  const change = (props.change as number) ?? 0;

  const colors = {
    info: 'bg-blue-50 border-blue-200 text-blue-700',
    warning: 'bg-amber-50 border-amber-200 text-amber-700',
    critical: 'bg-red-50 border-red-200 text-red-700',
  };

  return (
    <Card className={`p-4 border-2 ${colors[severity]}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <h4 className="font-semibold mb-1">{title}</h4>
          <p className="text-sm opacity-80">{description}</p>
        </div>
        {value && (
          <div className="text-right">
            <div className="text-2xl font-bold">{value}</div>
            {change !== 0 && (
              <div className={`text-sm ${change > 0 ? 'text-green-700' : 'text-red-600'}`}>
                {change > 0 ? '+' : ''}{change}%
              </div>
            )}
            {metric && <div className="text-xs opacity-60">{metric}</div>}
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Metrics comparison widget.
 * Shows before/after or period comparison.
 */
function MetricsCompareWidget(props: Record<string, unknown>) {
  const title = (props.title as string) ?? 'Сравнение';
  const metrics = (props.metrics as Array<{
    name: string;
    current: number;
    previous: number;
    unit?: string;
  }>) ?? [];

  return (
    <Card className="p-4">
      <h4 className="font-medium text-gray-900 mb-3">{title}</h4>
      <div className="space-y-3">
        {metrics.map((m, i) => {
          const change = m.previous > 0 ? ((m.current - m.previous) / m.previous) * 100 : 0;
          const isPositive = change > 0;
          return (
            <div key={i} className="flex items-center justify-between">
              <span className="text-sm text-gray-600">{m.name}</span>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500 line-through">
                  {formatNumber(m.previous)}{m.unit ?? ''}
                </span>
                <span className="font-medium">
                  {formatNumber(m.current)}{m.unit ?? ''}
                </span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${isPositive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                  {isPositive ? '+' : ''}{change.toFixed(1)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * Alert list widget.
 * Shows list of issues/alerts with severity.
 */
function AlertListWidget(props: Record<string, unknown>) {
  const title = (props.title as string) ?? 'Внимание';
  const alerts = (props.alerts as Array<{
    text: string;
    severity: 'info' | 'warning' | 'critical';
    nmId?: number;
  }>) ?? [];

  const icons = {
    info: '💡',
    warning: '⚠️',
    critical: '🚨',
  };

  return (
    <Card className="p-4">
      <h4 className="font-medium text-gray-900 mb-3">{title}</h4>
      <div className="space-y-2">
        {alerts.map((alert, i) => (
          <div key={i} className="flex items-start gap-2 text-sm">
            <span>{icons[alert.severity]}</span>
            <div className="flex-1">
              <span className="text-gray-700">{alert.text}</span>
              {alert.nmId && (
                <span className="ml-2 text-xs text-gray-500">#<NmIdLink nmId={alert.nmId} /></span>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * Action buttons widget.
 * Shows quick action buttons.
 */
function ActionButtonsWidget(props: Record<string, unknown>) {
  const actions = (props.actions as Array<{
    label: string;
    action: string;
    text?: string;   // готовая фраза, которую мы пошлём от имени пользователя
    variant?: 'primary' | 'secondary' | 'danger';
  }>) ?? [];

  const variants = {
    primary: 'bg-violet-600 text-white hover:bg-violet-700',
    secondary: 'bg-gray-100 text-gray-700 hover:bg-gray-200',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  };

  const handleClick = (a: { label: string; action: string; text?: string }) => {
    // Либо готовый user-text, либо синтетическая команда "/action name".
    const text = a.text ?? a.label;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ai-chat-send', { detail: { text, action: a.action } }));
    }
  };

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {actions.map((a, i) => (
        <button
          key={i}
          onClick={() => handleClick(a)}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${variants[a.variant ?? 'secondary']}`}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Supply plan widget.
 * Shows prioritized supply plan with stock status per product.
 */
function SupplyPlanWidget(props: Record<string, unknown>) {
  const items = (props.items as Array<{
    name: string;
    nmId: number;
    priority: 'critical' | 'high' | 'low';
    neededQty: number;
    currentQty: number;
    targetDays: number;
    daysOfStock: number;
    avgDailySales: number;
  }>) ?? [];
  const totalNeeded = (props.totalNeeded as number) ?? 0;
  const targetDays = (props.targetDays as number) ?? 45;
  const warehouses = (props.warehouses as string[]) ?? [];
  const criticalCount = (props.criticalCount as number) ?? 0;
  const highCount = (props.highCount as number) ?? 0;

  const critical = items.filter(i => i.priority === 'critical');
  const high = items.filter(i => i.priority === 'high');
  const low = items.filter(i => i.priority === 'low');

  const priorityColors = {
    critical: { bg: 'bg-red-50', border: 'border-red-200', badge: 'bg-red-100 text-red-700', icon: '🔴' },
    high: { bg: 'bg-amber-50', border: 'border-amber-200', badge: 'bg-amber-100 text-amber-700', icon: '🟡' },
    low: { bg: 'bg-green-50', border: 'border-green-200', badge: 'bg-green-100 text-green-700', icon: '✅' },
  };

  function renderGroup(label: string, groupItems: typeof items, priority: 'critical' | 'high' | 'low') {
    if (groupItems.length === 0) return null;
    const c = priorityColors[priority];
    const supplyHeaders = ['Артикул', 'Товар', 'Остаток', 'Дней', 'Поставить'];
    const supplyRows = groupItems.map((item) => [
      String(item.nmId),
      item.name ?? '',
      `${item.currentQty} шт`,
      item.daysOfStock > 0 ? `${item.daysOfStock} дн` : '—',
      item.neededQty > 0 ? `${item.neededQty} шт` : '—',
    ]);
    return (
      <div className={`rounded-lg border ${c.border} ${c.bg} p-3 mb-3`}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span>{c.icon}</span>
            <span className="font-semibold text-sm text-gray-800">{label}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${c.badge}`}>{groupItems.length}</span>
          </div>
          <CopyTableButton headers={supplyHeaders} rows={supplyRows} />
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs">
              <th className="text-left py-1 font-medium">Артикул</th>
              <th className="text-left py-1 font-medium">Товар</th>
              <th className="text-right py-1 font-medium">Остаток</th>
              <th className="text-right py-1 font-medium">Дней</th>
              <th className="text-right py-1 font-medium">Поставить</th>
            </tr>
          </thead>
          <tbody>
            {groupItems.map((item) => (
              <tr key={item.nmId} className="border-t border-gray-200/50">
                <td className="py-1.5 text-gray-600 font-mono text-xs"><NmIdLink nmId={item.nmId} /></td>
                <td className="py-1.5 text-gray-800 max-w-[200px] truncate">{item.name}</td>
                <td className="py-1.5 text-right font-medium">{item.currentQty} шт</td>
                <td className="py-1.5 text-right">{item.daysOfStock > 0 ? `${item.daysOfStock} дн` : '—'}</td>
                <td className="py-1.5 text-right font-semibold">
                  {item.neededQty > 0 ? `${item.neededQty} шт` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-medium text-gray-900">План поставок на {targetDays} дней</h4>
        <span className="text-sm font-semibold text-violet-600">Итого: {totalNeeded} шт</span>
      </div>

      {renderGroup('Критично — нулевые остатки', critical, 'critical')}
      {renderGroup('Важно — заканчиваются', high, 'high')}
      {renderGroup('В норме', low, 'low')}

      {warehouses.length > 0 && (
        <div className="mt-3 text-xs text-gray-500">
          <span className="font-medium">Склады:</span> {warehouses.join(', ')}
        </div>
      )}

      <div className="mt-3 flex gap-4 text-xs text-gray-500">
        {criticalCount > 0 && <span>🔴 Критично: {criticalCount}</span>}
        {highCount > 0 && <span>🟡 Важно: {highCount}</span>}
        <span>📦 Всего: {items.length} товаров</span>
      </div>
    </Card>
  );
}

/**
 * ABC-analysis widget.
 * Renders the categorised product table (A/B/C) returned by show_abc_chart.
 * Without this entry agent users see a raw JSON dump instead of a chart.
 */
function AbcChartWidget(props: Record<string, unknown>) {
  const totalProducts = (props.totalProducts as number) ?? 0;
  const totalRevenueRub = (props.totalRevenueRub as number) ?? 0;
  const totals = (props.totals as { a: { count: number }; b: { count: number }; c: { count: number } }) ?? { a: { count: 0 }, b: { count: 0 }, c: { count: 0 } };
  const period = (props.period as { from?: string; to?: string } | undefined);
  const products = (props.products as Array<{
    nmId: number;
    name: string;
    revenueRub: number;
    orders: number;
    sales: number;
    sharePct: number;
    cumulativePct: number;
    category: 'A' | 'B' | 'C';
  }>) ?? [];

  const badgeColors = {
    A: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    B: 'bg-amber-100 text-amber-700 border-amber-200',
    C: 'bg-gray-100 text-gray-600 border-gray-200',
  };

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-medium text-gray-900">ABC-анализ ассортимента</h4>
        {period?.from && period?.to && (
          <span className="text-xs text-gray-500">{period.from} → {period.to}</span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 mb-4">
        <div className="p-3 bg-emerald-50 rounded-lg">
          <div className="text-xs text-emerald-600 font-medium">A · 80% выручки</div>
          <div className="text-2xl font-bold text-emerald-700">{totals.a.count}</div>
          <div className="text-xs text-gray-500">товаров</div>
        </div>
        <div className="p-3 bg-amber-50 rounded-lg">
          <div className="text-xs text-amber-700 font-medium">B · 15% выручки</div>
          <div className="text-2xl font-bold text-amber-700">{totals.b.count}</div>
          <div className="text-xs text-gray-500">товаров</div>
        </div>
        <div className="p-3 bg-gray-50 rounded-lg">
          <div className="text-xs text-gray-600 font-medium">C · 5% выручки</div>
          <div className="text-2xl font-bold text-gray-700">{totals.c.count}</div>
          <div className="text-xs text-gray-500">товаров</div>
        </div>
      </div>

      <div className="text-sm text-gray-500 mb-2">
        Всего {totalProducts} товаров · выручка {formatCurrency(totalRevenueRub)}
      </div>

      {products.length > 0 && (
        <div className="overflow-x-auto">
          <div className="flex justify-end mb-1">
            <CopyTableButton
              headers={['#', 'Артикул', 'Товар', 'Выручка', 'Доля %', 'ABC']}
              rows={products.map((p, i) => [
                String(i + 1),
                String(p.nmId),
                p.name ?? '',
                formatCurrency(p.revenueRub),
                String(p.sharePct),
                p.category,
              ])}
            />
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 text-xs border-b">
                <th className="text-left py-1.5 font-medium">#</th>
                <th className="text-left py-1.5 font-medium">Артикул</th>
                <th className="text-left py-1.5 font-medium">Товар</th>
                <th className="text-right py-1.5 font-medium">Выручка</th>
                <th className="text-right py-1.5 font-medium">Доля</th>
                <th className="text-center py-1.5 font-medium">ABC</th>
              </tr>
            </thead>
            <tbody>
              {products.slice(0, 20).map((p, i) => (
                <tr key={p.nmId} className="border-b border-gray-100 last:border-b-0">
                  <td className="py-1.5 text-gray-500 text-xs">{i + 1}</td>
                  <td className="py-1.5 font-mono text-xs text-gray-600"><NmIdLink nmId={p.nmId} /></td>
                  <td className="py-1.5 text-gray-800 max-w-[280px] truncate">{p.name}</td>
                  <td className="py-1.5 text-right font-medium">{formatCurrency(p.revenueRub)}</td>
                  <td className="py-1.5 text-right text-gray-500">{p.sharePct}%</td>
                  <td className="py-1.5 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded-full border text-xs font-semibold ${badgeColors[p.category]}`}>
                      {p.category}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {products.length > 20 && (
            <div className="mt-2 text-xs text-gray-500 text-center">+ ещё {products.length - 20} товаров</div>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * Seller report widget.
 * Dashboard-style snapshot for the show_seller_report tool.
 */
function SellerReportWidget(props: Record<string, unknown>) {
  const period = (props.period as string) ?? 'weekly';
  const dateTo = (props.dateTo as string) ?? '';
  const sales = (props.sales as { orders: number; sales: number; revenue: number; ordersRevenue: number }) ?? { orders: 0, sales: 0, revenue: 0, ordersRevenue: 0 };
  const finance = (props.finance as { payoutRub: number; commissionRub: number; logisticsRub: number; storageRub: number; penaltyRub: number }) ?? { payoutRub: 0, commissionRub: 0, logisticsRub: 0, storageRub: 0, penaltyRub: 0 };

  const periodLabels: Record<string, string> = { daily: 'день', weekly: '7 дней', monthly: '30 дней' };

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-medium text-gray-900">Отчёт продавца</h4>
        <span className="text-xs text-gray-500">{periodLabels[period] ?? period} {dateTo && `· ${dateTo}`}</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="p-3 bg-violet-50 rounded-lg">
          <div className="text-xs text-violet-600 font-medium">Заказы</div>
          <div className="text-xl font-bold text-violet-700">{sales.orders}</div>
        </div>
        <div className="p-3 bg-emerald-50 rounded-lg">
          <div className="text-xs text-emerald-600 font-medium">Продажи</div>
          <div className="text-xl font-bold text-emerald-700">{sales.sales}</div>
        </div>
        <div className="p-3 bg-sky-50 rounded-lg">
          <div className="text-xs text-sky-600 font-medium">Выручка</div>
          <div className="text-xl font-bold text-sky-700">{formatCurrency(sales.revenue / 100)}</div>
        </div>
        <div className="p-3 bg-amber-50 rounded-lg">
          <div className="text-xs text-amber-700 font-medium">К выплате</div>
          <div className="text-xl font-bold text-amber-700">{formatCurrency(finance.payoutRub)}</div>
        </div>
      </div>

      <div className="space-y-1 text-sm">
        <div className="flex justify-between"><span className="text-gray-500">Комиссия WB</span><span className="font-medium">{formatCurrency(finance.commissionRub)}</span></div>
        <div className="flex justify-between"><span className="text-gray-500">Логистика</span><span className="font-medium">{formatCurrency(finance.logisticsRub)}</span></div>
        <div className="flex justify-between"><span className="text-gray-500">Хранение</span><span className="font-medium">{formatCurrency(finance.storageRub)}</span></div>
        {finance.penaltyRub > 0 && (
          <div className="flex justify-between"><span className="text-red-500">Штрафы</span><span className="font-medium text-red-600">{formatCurrency(finance.penaltyRub)}</span></div>
        )}
      </div>
    </Card>
  );
}

/**
 * Supply calendar widget — acceptance coefficients per warehouse per date.
 * Without this registry entry users see a raw JSON dump when the agent
 * calls show_supply_calendar.
 */
function SupplyCalendarWidget(props: Record<string, unknown>) {
  const deliveryType = (props.deliveryType as string) ?? 'box';
  const warehouses = (props.warehouses as Array<{
    warehouseId: number;
    dates: Array<{ date: string; coefficient: number; slotsAvailable?: number }>;
  }>) ?? [];

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-medium text-gray-900">Календарь приёмки</h4>
        <span className="text-xs text-gray-500">тип: {deliveryType}</span>
      </div>

      {warehouses.length === 0 ? (
        <div className="text-sm text-gray-500">Нет доступных слотов</div>
      ) : (
        <div className="space-y-3">
          {warehouses.map((wh) => (
            <div key={wh.warehouseId} className="border rounded-md p-2">
              <div className="text-xs font-mono text-gray-500 mb-1">Склад #{wh.warehouseId}</div>
              {wh.dates.length === 0 ? (
                <div className="text-xs text-gray-500">нет свободных дат</div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {wh.dates.slice(0, 14).map((d) => {
                    const color = d.coefficient === 0
                      ? 'bg-emerald-100 text-emerald-700'
                      : d.coefficient <= 2
                        ? 'bg-sky-100 text-sky-700'
                        : d.coefficient <= 5
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-red-100 text-red-700';
                    return (
                      <div key={d.date} className={`px-2 py-1 rounded text-xs ${color}`}>
                        <div className="font-mono">{d.date.slice(5)}</div>
                        <div className="text-[10px] opacity-70">×{d.coefficient}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 text-[10px] text-gray-500">
        🟢 ×0 бесплатно · 🔵 до ×2 · 🟡 до ×5 · 🔴 выше
      </div>
    </Card>
  );
}

// ── Supply Wizard / Created widgets ────────────────────────

type WizardItem = {
  nmId: number;
  productTitle: string | null;
  currentStock: number;
  recommendedQty: number;
  urgency: 'critical' | 'high' | 'medium' | 'low';
  reason: string | null;
  barcode: string | null;
};
type WizardWarehouse = { id: number; name: string; region: string | null };

function SupplyWizardWidget(props: Record<string, unknown>) {
  const items = (props.items as WizardItem[]) ?? [];
  const warehouses = (props.warehouses as WizardWarehouse[]) ?? [];
  const shopId = props.shopId as number | null | undefined;

  // Локальный стейт виджета — выбор items/warehouse/type/qty
  const [selected, setSelected] = React.useState<Set<number>>(() => new Set(items.slice(0, 5).map((i) => i.nmId)));
  const [qtyMap, setQtyMap] = React.useState<Map<number, number>>(() => new Map(items.map((i) => [i.nmId, i.recommendedQty])));
  const [warehouseId, setWarehouseId] = React.useState<number | ''>(warehouses[0]?.id ?? '');
  const [deliveryType, setDeliveryType] = React.useState<'box' | 'mono_pallet' | 'super_safe'>('box');

  const toggle = (nmId: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(nmId)) next.delete(nmId);
      else next.add(nmId);
      return next;
    });

  const setQty = (nmId: number, v: number) =>
    setQtyMap((prev) => {
      const next = new Map(prev);
      next.set(nmId, Math.max(1, Math.floor(v)));
      return next;
    });

  const chosen = items.filter((i) => selected.has(i.nmId) && i.barcode);
  const totalQty = chosen.reduce((s, i) => s + (qtyMap.get(i.nmId) ?? i.recommendedQty), 0);
  const wh = warehouses.find((w) => w.id === warehouseId);
  const urgencyColor: Record<string, string> = {
    critical: 'text-red-600 bg-red-50',
    high: 'text-orange-700 bg-orange-50',
    medium: 'text-yellow-700 bg-yellow-50',
    low: 'text-gray-500 bg-gray-50',
  };

  const handleCreate = () => {
    if (chosen.length === 0 || !warehouseId || !wh) return;
    const goods = chosen.map((i) => ({ barcode: i.barcode!, quantity: qtyMap.get(i.nmId) ?? i.recommendedQty }));
    const text = [
      'Создай поставку:',
      `— Склад: ${wh.name} (id=${warehouseId})`,
      `— Тип: ${deliveryType}`,
      `— Товары (${chosen.length} SKU, ${totalQty} шт):`,
      ...chosen.map((i) => `  · ${i.barcode} × ${qtyMap.get(i.nmId) ?? i.recommendedQty} (${i.productTitle ?? i.nmId})`),
      `Shop: ${shopId ?? 'n/a'}`,
      'Параметры: ' + JSON.stringify({ warehouseID: warehouseId, deliveryType, goods, rationale: 'Создание из supply-wizard' }),
    ].join('\n');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ai-chat-send', { detail: { text } }));
    }
  };

  return (
    <Card className="p-4 border-violet-200 bg-violet-50/30">
      <div className="flex items-center gap-2 mb-2">
        <span>📦</span>
        <span className="font-semibold text-gray-900">Мастер поставки FBO</span>
        <span className="text-xs text-gray-500">({items.length} рекомендаций)</span>
      </div>

      {/* Товары */}
      <div className="bg-white rounded-lg border mb-3 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 text-left text-gray-500">
              <th className="py-1.5 px-2 w-8"></th>
              <th className="py-1.5 px-2">Товар</th>
              <th className="py-1.5 px-2">Срочность</th>
              <th className="py-1.5 px-2 text-right">Остаток</th>
              <th className="py-1.5 px-2 text-right">Поставить</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const isSel = selected.has(it.nmId);
              const hasBc = !!it.barcode;
              return (
                <tr key={it.nmId} className={`border-t ${isSel ? 'bg-violet-50/40' : ''} ${!hasBc ? 'opacity-50' : ''}`}>
                  <td className="py-1.5 px-2">
                    <input
                      type="checkbox"
                      checked={isSel}
                      disabled={!hasBc}
                      onChange={() => toggle(it.nmId)}
                      title={hasBc ? '' : 'Нет barcode — нельзя добавить'}
                    />
                  </td>
                  <td className="py-1.5 px-2">
                    <div className="font-medium text-gray-900 truncate max-w-[220px]" title={it.productTitle ?? ''}>
                      {it.productTitle ?? `#${it.nmId}`}
                    </div>
                    <div className="text-gray-500 text-[10px]">
                      nm {it.nmId}{it.barcode ? ` · ${it.barcode}` : ' · нет barcode'}
                    </div>
                  </td>
                  <td className="py-1.5 px-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${urgencyColor[it.urgency] ?? ''}`}>
                      {it.urgency}
                    </span>
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{it.currentStock}</td>
                  <td className="py-1.5 px-2 text-right">
                    <input
                      type="number"
                      min={1}
                      value={qtyMap.get(it.nmId) ?? it.recommendedQty}
                      onChange={(e) => setQty(it.nmId, Number(e.target.value))}
                      disabled={!isSel || !hasBc}
                      className="w-16 px-1.5 py-0.5 border rounded text-right tabular-nums disabled:bg-gray-100"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Склад + тип */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <label className="text-xs">
          <span className="block text-gray-700 mb-1 font-medium">Склад назначения</span>
          <select
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value ? Number(e.target.value) : '')}
            className="w-full px-2 py-1.5 border rounded bg-white"
          >
            {warehouses.length === 0 && <option value="">Нет доступных складов</option>}
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.name}{w.region ? ` (${w.region})` : ''}</option>
            ))}
          </select>
        </label>
        <div className="text-xs">
          <span className="block text-gray-700 mb-1 font-medium">Тип доставки</span>
          <div className="flex gap-3">
            {(['box', 'mono_pallet', 'super_safe'] as const).map((t) => (
              <label key={t} className="flex items-center gap-1">
                <input type="radio" checked={deliveryType === t} onChange={() => setDeliveryType(t)} />
                <span>{t === 'box' ? 'Короба' : t === 'mono_pallet' ? 'Монопаллета' : 'СуперСейф'}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Summary + button */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-gray-600">
          Выбрано: <b>{chosen.length} SKU</b> · <b>{totalQty} шт</b>
          {wh ? <> · <b>{wh.name}</b></> : null}
        </div>
        <button
          onClick={handleCreate}
          disabled={chosen.length === 0 || !warehouseId}
          className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          📦 Создать поставку →
        </button>
      </div>
      <div className="text-[10px] text-gray-500 mt-2">
        После клика агент подтвердит параметры и вызовет WB API. Вы получите preorderID и лист приёмки.
      </div>
    </Card>
  );
}

function SupplyCreatedWidget(props: Record<string, unknown>) {
  const workspaceId = props.workspaceId as number;
  const supplyRowId = props.supplyRowId as number;
  const preorderId = props.preorderId as number | null;
  const supplyId = props.supplyId as number | null;
  const warehouseName = props.warehouseName as string | null;
  const supplyDate = props.supplyDate as string | null;
  const itemsCount = props.itemsCount as number;
  const totalQty = props.totalQty as number;
  const items = (props.items as Array<{ nmId: number | null; barcode: string; quantity: number; vendorCode: string | null }>) ?? [];
  const lkUrl = props.lkUrl as string | null;

  const slipUrl = `/api/proxy/agents/${workspaceId}/supply-slip/${supplyRowId}/file`;

  const [slipStatus, setSlipStatus] = React.useState<'idle' | 'generating' | 'ready' | 'error'>('idle');

  const handleGenerate = async () => {
    setSlipStatus('generating');
    try {
      await fetch(`/api/proxy/agents/${workspaceId}/supply-slip/${supplyRowId}/generate`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...csrfHeaders() },
      });
      setSlipStatus('ready');
      window.open(slipUrl, '_blank');
    } catch {
      setSlipStatus('error');
    }
  };

  return (
    <Card className="p-4 border-green-200 bg-green-50/30">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-green-700">✅</span>
        <span className="font-semibold text-gray-900">Поставка создана</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs text-gray-700 mb-3">
        {supplyId !== null && <div><span className="text-gray-500">Supply ID:</span> <b>{supplyId}</b></div>}
        {preorderId !== null && <div><span className="text-gray-500">Preorder ID:</span> <b>{preorderId}</b></div>}
        {warehouseName && <div><span className="text-gray-500">Склад:</span> <b>{warehouseName}</b></div>}
        {supplyDate && <div><span className="text-gray-500">Дата:</span> <b>{supplyDate}</b></div>}
        <div><span className="text-gray-500">SKU:</span> <b>{itemsCount}</b></div>
        <div><span className="text-gray-500">Всего шт:</span> <b>{totalQty}</b></div>
      </div>

      {items.length > 0 && (
        <details className="mb-3">
          <summary className="cursor-pointer text-xs text-gray-600 hover:text-gray-900">Состав поставки ({items.length})</summary>
          <ul className="mt-2 text-[11px] text-gray-700 list-disc pl-4 max-h-40 overflow-y-auto">
            {items.map((it, i) => (
              <li key={i}>
                {it.barcode} × {it.quantity}
                {it.vendorCode ? ` (${it.vendorCode})` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={handleGenerate}
          disabled={slipStatus === 'generating'}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-60"
        >
          {slipStatus === 'generating' ? 'Генерация…' : '📄 Скачать лист приёмки'}
        </button>
        {slipStatus === 'ready' && (
          <a href={slipUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-violet-700 hover:underline">
            открыть ещё раз
          </a>
        )}
        {lkUrl && (
          <a
            href={lkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white border text-sm text-gray-700 hover:bg-gray-50"
          >
            🔗 Открыть в ЛК WB
          </a>
        )}
        {slipStatus === 'error' && (
          <span className="text-xs text-red-600">Ошибка генерации</span>
        )}
      </div>
    </Card>
  );
}

interface KeywordCandidate {
  keyword: string;
  score: number;
  views: number;
  clicks: number;
  orders: number;
  ctrPct: number;
  avgPosition: number | null;
  relatedNmIds: number[];
  sampleTitle: string | null;
  alreadyTracked: boolean;
  reason: string;
}

function KeywordSuggestionsWidget(props: Record<string, unknown>) {
  const candidates = (props.candidates as KeywordCandidate[]) ?? [];
  const workspaceId = props.workspaceId as number | undefined;
  const shopId = props.shopId as number | null | undefined;
  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(candidates.slice(0, Math.min(10, candidates.length)).map((c) => c.keyword)),
  );
  const [status, setStatus] = React.useState<'idle' | 'saving' | 'done' | 'error'>('idle');
  const [message, setMessage] = React.useState<string>('');

  const toggle = (kw: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(kw)) next.delete(kw);
      else next.add(kw);
      return next;
    });

  const handleAdd = async () => {
    if (!workspaceId || selected.size === 0) return;
    setStatus('saving');
    try {
      const body = {
        shopId: shopId ?? null,
        keywords: Array.from(selected).map((kw) => {
          const c = candidates.find((x) => x.keyword === kw);
          return { keyword: kw, nmIds: c?.relatedNmIds ?? [] };
        }),
      };
      const res = await fetch(`/api/agents/${workspaceId}/seo/keywords/add`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      setStatus('done');
      setMessage(`Добавлено: ${data.added ?? selected.size}${data.skipped ? `, пропущено ${data.skipped}` : ''}`);
    } catch (e) {
      setStatus('error');
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  if (candidates.length === 0) {
    return (
      <Card className="p-4">
        <div className="text-sm text-gray-600">Нет кандидатов на отслеживание.</div>
      </Card>
    );
  }

  return (
    <Card className="p-4 border-emerald-200 bg-emerald-50/30">
      <div className="flex items-center gap-2 mb-2">
        <span>🔍</span>
        <span className="font-semibold text-gray-900">Рекомендуемые слова для отслеживания</span>
        <span className="text-xs text-gray-500">({candidates.length} кандидатов)</span>
      </div>
      <div className="bg-white rounded-lg border mb-3 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 text-left text-gray-500">
              <th className="py-1.5 px-2 w-8"></th>
              <th className="py-1.5 px-2">Запрос</th>
              <th className="py-1.5 px-2 text-right">Показы</th>
              <th className="py-1.5 px-2 text-right">Клики</th>
              <th className="py-1.5 px-2 text-right">Заказы</th>
              <th className="py-1.5 px-2 text-right">Score</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => {
              const isSel = selected.has(c.keyword);
              return (
                <tr key={c.keyword} className={`border-t ${isSel ? 'bg-emerald-50/50' : ''}`}>
                  <td className="py-1.5 px-2">
                    <input
                      type="checkbox"
                      checked={isSel}
                      disabled={c.alreadyTracked}
                      onChange={() => toggle(c.keyword)}
                      title={c.alreadyTracked ? 'Уже отслеживается' : ''}
                    />
                  </td>
                  <td className="py-1.5 px-2">
                    <div className="font-medium text-gray-900">{c.keyword}</div>
                    <div className="text-gray-500 text-[10px]">{c.reason}</div>
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{c.views}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{c.clicks}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{c.orders}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{c.score}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={handleAdd}
          disabled={selected.size === 0 || status === 'saving' || status === 'done'}
          className="px-3 py-1.5 text-sm font-medium rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-gray-300"
        >
          {status === 'saving' ? 'Добавляем…' : `Добавить выбранные (${selected.size})`}
        </button>
        {status === 'done' && <span className="text-xs text-emerald-700">✓ {message}</span>}
        {status === 'error' && <span className="text-xs text-red-600">{message}</span>}
      </div>
    </Card>
  );
}

// ── Generic data_table ─────────────────────────────────────
//
// Универсальная таблица для любых аналитических выводов: сортировка по любой
// колонке, пагинация по 10, поиск, экспорт CSV. Типы колонок подсказывают
// как форматировать: nmId → ссылка на wildberries.ru, rub → руб., pct →
// проценты. Агент использует через tool `show_data_table`.

interface DataTableColumn {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'nmId' | 'rub' | 'pct' | 'date';
  width?: string;
}

function DataTableWidget(props: Record<string, unknown>) {
  const title = (props.title as string) ?? '';
  const subtitle = (props.subtitle as string) ?? '';
  const columns = ((props.columns as DataTableColumn[]) ?? []).filter((c) => c?.key && c?.label);
  const rowsAll = ((props.rows as Array<Record<string, unknown>>) ?? []);
  const pageSize = Number(props.pageSize ?? 10);

  const [search, setSearch] = React.useState('');
  const [sortKey, setSortKey] = React.useState<string | null>(null);
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('desc');
  const [page, setPage] = React.useState(0);

  // Поиск: все значения объекта → toLowerCase → includes
  const filtered = React.useMemo(() => {
    if (!search.trim()) return rowsAll;
    const q = search.toLowerCase();
    return rowsAll.filter((r) =>
      columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(q)),
    );
  }, [rowsAll, search, columns]);

  const sorted = React.useMemo(() => {
    if (!sortKey) return filtered;
    const col = columns.find((c) => c.key === sortKey);
    const isNum = col?.type === 'number' || col?.type === 'rub' || col?.type === 'pct' || col?.type === 'nmId';
    const arr = [...filtered];
    arr.sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      if (isNum) {
        const na = Number(va) || 0;
        const nb = Number(vb) || 0;
        return sortDir === 'asc' ? na - nb : nb - na;
      }
      const sa = String(va ?? '');
      const sb = String(vb ?? '');
      return sortDir === 'asc' ? sa.localeCompare(sb, 'ru') : sb.localeCompare(sa, 'ru');
    });
    return arr;
  }, [filtered, sortKey, sortDir, columns]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageRows = sorted.slice(page * pageSize, (page + 1) * pageSize);

  React.useEffect(() => {
    if (page >= totalPages) setPage(Math.max(0, totalPages - 1));
  }, [totalPages, page]);

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const renderCell = (row: Record<string, unknown>, col: DataTableColumn) => {
    const v = row[col.key];
    if (v == null || v === '') return <span className="text-gray-500">—</span>;
    if (col.type === 'nmId') {
      const id = String(v);
      return (
        <a
          href={`https://www.wildberries.ru/catalog/${id}/detail.aspx`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline font-mono"
        >
          {id}
        </a>
      );
    }
    if (col.type === 'rub') {
      const n = Number(v);
      if (!Number.isFinite(n)) return String(v);
      return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
    }
    if (col.type === 'pct') {
      const n = Number(v);
      if (!Number.isFinite(n)) return String(v);
      return `${n.toFixed(1)}%`;
    }
    if (col.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) return String(v);
      return n.toLocaleString('ru-RU');
    }
    return String(v);
  };


  return (
    <Card className="p-4">
      {(title || subtitle) && (
        <div className="mb-3">
          {title && <h4 className="font-semibold text-gray-900">{title}</h4>}
          {subtitle && <div className="text-xs text-gray-500 mt-0.5">{subtitle}</div>}
        </div>
      )}
      <div className="flex items-center gap-2 mb-2">
        <input
          type="text"
          placeholder="🔍 Поиск…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          className="flex-1 px-2 py-1 text-sm border rounded"
        />
        <span className="text-xs text-gray-500 tabular-nums">
          {sorted.length} из {rowsAll.length}
        </span>
        <ExportButton
          title={title || undefined}
          subtitle={subtitle || undefined}
          columns={columns}
          rows={sorted}
        />
      </div>
      <div className="overflow-x-auto bg-white rounded-lg border">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 text-left text-gray-500">
              {columns.map((c) => {
                const active = sortKey === c.key;
                return (
                  <th
                    key={c.key}
                    className="py-1.5 px-2 font-medium cursor-pointer hover:bg-gray-100 select-none whitespace-nowrap"
                    style={c.width ? { width: c.width } : undefined}
                    onClick={() => toggleSort(c.key)}
                  >
                    {c.label}
                    <span className="ml-1 text-gray-500">
                      {active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && (
              <tr><td colSpan={columns.length} className="py-4 px-2 text-center text-gray-500">Нет данных</td></tr>
            )}
            {pageRows.map((row, i) => (
              <tr key={i} className="border-t hover:bg-slate-50/50">
                {columns.map((c) => (
                  <td key={c.key} className="py-1.5 px-2 tabular-nums">
                    {renderCell(row, c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-2 text-xs">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-40"
          >← Назад</button>
          <span className="text-gray-600 tabular-nums">
            Стр. {page + 1} из {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-40"
          >Далее →</button>
        </div>
      )}
    </Card>
  );
}

// ── Widget Registry ────────────────────────────────────────

/**
 * Wrapper: рендерит карточку Лаборатории из payload, который отдаёт subagent_lab.
 * Без статистической терминологии — см. components/lab/InsightCard.
 */
function LabInsightCardWidget(props: Record<string, unknown>) {
  const payload = (props.insight ?? props) as LabInsightPayload;
  const nmId = typeof props.nmId === 'number' ? props.nmId : undefined;
  // Защита: если backend забудет обязательное поле — покажем мягкий плейсхолдер
  if (!payload || !payload.hypothesisText || !payload.category) {
    return (
      <Card className="p-4 bg-slate-50">
        <div className="text-xs text-slate-500">
          Карточка Лаборатории не готова — недостаточно данных.
        </div>
      </Card>
    );
  }
  return <LabInsightCard insight={payload} nmId={nmId} />;
}

const WIDGET_REGISTRY: Record<string, React.ComponentType<any>> = {
  funnel_diagram: FunnelDiagramWidget,
  price_slider: PriceSliderWidget,
  insight_card: InsightCardWidget,
  lab_insight: LabInsightCardWidget,
  lab_metric_relations: LabMetricRelationsWidget,
  lab_price_impact: LabPriceImpactWidget,
  lab_ads_delay: LabAdsDelayWidget,
  lab_price_sensitivity: LabPriceSensitivityWidget,
  lab_product_timeline: LabProductTimelineWidget,
  lab_seo_insights: LabSeoInsightsWidget,
  lab_best_combo: LabBestComboWidget,
  metrics_compare: MetricsCompareWidget,
  alert_list: AlertListWidget,
  action_buttons: ActionButtonsWidget,
  supply_plan: SupplyPlanWidget,
  supply_wizard: SupplyWizardWidget,
  supply_created: SupplyCreatedWidget,
  abc_chart: AbcChartWidget,
  seller_report: SellerReportWidget,
  supply_calendar: SupplyCalendarWidget,
  keyword_suggestions: KeywordSuggestionsWidget,
  data_table: DataTableWidget,
};

// ── Helpers ────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString('ru-RU');
}

function formatCurrency(n: number): string {
  return n.toLocaleString('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
}
