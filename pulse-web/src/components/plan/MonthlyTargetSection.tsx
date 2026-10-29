'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/ToggleGroup';
import { apiFetch } from '@/lib/api';

interface DailyRow {
  date: string;
  day: number;
  planRevenueKop: number;
  factRevenueKop: number;
  planImpressions: number;
  factImpressions: number;
  planOrdersQty: number;
  factOrdersQty: number;
  planAdSpendKop: number;
  factAdSpendKop: number;
  factClicks: number;
  factDrr: number | null;
}

interface MonthlyResp {
  target: {
    marketRevenueRub: number | null;
    targetSharePct: string | null;
    planRevenueRub: number;
    planAdSpendRub: number | null;
    planImpressions: number | null;
    planOrdersQty: number | null;
    comment: string | null;
  } | null;
  params: { month: string; daysInMonth: number; daysWithFact: number; remainingDays: number; today: string };
  daily: DailyRow[];
  summary: {
    factTotalRevenueKop: number;
    factTotalAdSpendKop: number;
    factTotalOrders: number;
    factTotalClicks?: number;
    factTotalDrr?: number | null;
    runRateKop: number;
    accumPlanKop: number;
    accumFactKop: number;
    pctOfPlan: number;
    forecastKop: number;
    dailyNeededKop: number;
    drrPct: number;
  };
}

function rub(kop: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(kop / 100)) + ' ₽';
}

function pct(v: number): string {
  return (v * 100).toFixed(1) + '%';
}

interface Props {
  workspaceId: number | null;
  shopId?: number;
  month: string; // YYYY-MM
}

export function MonthlyTargetSection({ workspaceId, shopId, month }: Props) {
  const [data, setData] = useState<MonthlyResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [numberFormat, setNumberFormat] = useState<'full' | 'short'>('short');

  // Динамический форматтер для чисел: учитывает выбранный режим
  const fmtRubByMode = (kop: number) => numberFormat === 'short' ? rubShort(kop) : rub(kop);
  const fmtNumByMode = (n: number) => numberFormat === 'short' && n >= 1000
    ? (n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'М' : (n / 1000).toFixed(1) + 'k')
    : n.toLocaleString('ru-RU');

  // Локальные input-значения (рубли, проценты в %)
  const [marketRev, setMarketRev] = useState('');
  const [shareInput, setShareInput] = useState('');
  const [planRev, setPlanRev] = useState('');
  const [planAd, setPlanAd] = useState('');
  const [planImp, setPlanImp] = useState('');
  const [planOrd, setPlanOrd] = useState('');

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ workspaceId: String(workspaceId), month });
      if (shopId) params.set('shopId', String(shopId));
      const resp = await apiFetch<MonthlyResp>(`/plans/monthly?${params}`);
      setData(resp);
      const t = resp.target;
      setMarketRev(t?.marketRevenueRub ? String(t.marketRevenueRub) : '');
      setShareInput(t?.targetSharePct ? (Number(t.targetSharePct) * 100).toFixed(2) : '');
      setPlanRev(t?.planRevenueRub ? String(t.planRevenueRub) : '');
      setPlanAd(t?.planAdSpendRub ? String(t.planAdSpendRub) : '');
      setPlanImp(t?.planImpressions ? String(t.planImpressions) : '');
      setPlanOrd(t?.planOrdersQty ? String(t.planOrdersQty) : '');
    } catch (e) {
      console.error('load monthly', e);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, shopId, month]);

  useEffect(() => { load(); }, [load]);

  const recalcPlan = () => {
    const m = Number(marketRev) || 0;
    const s = (Number(shareInput) || 0) / 100;
    if (m > 0 && s > 0) {
      setPlanRev(String(Math.round(m * s)));
    }
  };

  const save = async () => {
    if (!workspaceId) return;
    setSaving(true);
    try {
      await apiFetch('/plans/monthly', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          shopId: shopId ?? 0,
          month,
          marketRevenueRub: marketRev ? Number(marketRev) : null,
          targetSharePct: shareInput ? Number(shareInput) / 100 : null,
          planRevenueRub: Number(planRev) || 0,
          planAdSpendRub: planAd ? Number(planAd) : null,
          planImpressions: planImp ? Number(planImp) : null,
          planOrdersQty: planOrd ? Number(planOrd) : null,
        }),
      });
      await load();
    } catch (e) {
      console.error('save monthly', e);
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) {
    return <Card><CardContent className="p-6 text-sm text-gray-500">Загрузка…</CardContent></Card>;
  }
  if (!data) return null;

  const { summary, params } = data;
  const planTotalKop = Number(planRev) * 100;

  return (
    <Card>
      <CardContent className="p-5 space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Месячный шаблон</h2>
          <p className="text-xs text-gray-500 mt-1">Параметры — заполняешь ты. Факт — автоматом из RNP-метрик.</p>
        </div>

        {/* Параметры месяца */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <ParamInput label="Выручка по рынку, ₽" value={marketRev} onChange={setMarketRev} />
          <ParamInput label="Целевая доля, %" value={shareInput} onChange={setShareInput} step="0.01" />
          <ParamInput label="План выручки, ₽" value={planRev} onChange={setPlanRev} highlight />
          <ParamInput label="План рекламы, ₽" value={planAd} onChange={setPlanAd} />
          <ParamInput label="План кликов" value={planImp} onChange={setPlanImp} />
          <ParamInput label="План заказов" value={planOrd} onChange={setPlanOrd} />
        </div>

        {/* Сверка: средний чек план vs факт */}
        {(() => {
          const planRevN = Number(planRev) || 0;
          const planOrdN = Number(planOrd) || 0;
          const planAvg = planRevN > 0 && planOrdN > 0 ? Math.round(planRevN / planOrdN) : 0;
          const factRevRub = summary.factTotalRevenueKop / 100;
          const factOrd = summary.factTotalOrders;
          const factAvg = factRevRub > 0 && factOrd > 0 ? Math.round(factRevRub / factOrd) : 0;
          const deviation = planAvg > 0 && factAvg > 0 ? ((factAvg - planAvg) / planAvg) * 100 : null;
          if (planAvg === 0 && factAvg === 0) return null;
          return (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 px-3 py-2 flex items-center gap-4 flex-wrap text-xs">
              <span className="font-medium text-indigo-800">Средний чек:</span>
              {planAvg > 0 && (
                <span className="text-gray-600">План: <strong className="text-gray-900">{planAvg.toLocaleString('ru-RU')} ₽</strong></span>
              )}
              {factAvg > 0 && (
                <span className="text-gray-600">Факт: <strong className="text-gray-900">{factAvg.toLocaleString('ru-RU')} ₽</strong></span>
              )}
              {deviation !== null && (
                <span className={deviation >= 0 ? 'text-emerald-700' : 'text-red-600'}>
                  {deviation >= 0 ? '+' : ''}{deviation.toFixed(1)}% к плану
                </span>
              )}
              <span className="text-gray-400">· Чтобы синхронизировать План выручки и Заказов — нажми «↻ Рассчитать заказы»</span>
              {planRevN > 0 && planAvg > 0 && (
                <Button
                  size="xs"
                  variant="neutral"
                  onClick={() => {
                    // Берём текущий средний чек из факта (или из плана если факта нет),
                    // делим план выручки на него = новый план заказов
                    const useAvg = factAvg > 0 ? factAvg : planAvg;
                    setPlanOrd(String(Math.round(planRevN / useAvg)));
                  }}
                  title="План заказов = План выручки / Средний чек (факт или план)"
                >
                  ↻ Рассчитать заказы
                </Button>
              )}
            </div>
          );
        })()}
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="xs" variant="neutral" onClick={recalcPlan} title="План = Выручка по рынку × Целевая доля">
            ↻ Рассчитать план
          </Button>
          <Button size="xs" variant="primary" onClick={save} loading={saving}>
            Сохранить параметры
          </Button>
          <ToggleGroup type="single" value={numberFormat} onValueChange={(v) => v && setNumberFormat(v as 'full' | 'short')}>
            <ToggleGroupItem value="full">Полный</ToggleGroupItem>
            <ToggleGroupItem value="short">Кратко</ToggleGroupItem>
          </ToggleGroup>
          <span className="text-xs text-gray-500">
            Дней в месяце: {params.daysInMonth} · с фактом: {params.daysWithFact} · осталось: {params.remainingDays}
          </span>
        </div>

        {/* Сводка */}
        {(() => {
          // Расчёт «до конца недели» (по понедельникам — началу недели).
          // План недели = план/день × 7. Факт недели = сумма факта за дни этой недели (пн..сегодня).
          // Если в выбранном месяце «неделя» уползает за границы — клампим внутрь данных месяца.
          const todayStr = params.today;
          const todayDate = new Date(todayStr + 'T00:00:00Z');
          const dow = (todayDate.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
          const monday = new Date(todayDate); monday.setUTCDate(todayDate.getUTCDate() - dow);
          const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6);
          const mondayStr = monday.toISOString().slice(0, 10);
          const sundayStr = sunday.toISOString().slice(0, 10);

          const planPerDayKop = data.daily[0]?.planRevenueKop ?? 0;
          const planWeekKop = planPerDayKop * 7;
          const weekRows = data.daily.filter((d) => d.date >= mondayStr && d.date <= sundayStr);
          const weekFactKop = weekRows.reduce((s, d) => s + (d.date <= todayStr ? d.factRevenueKop : 0), 0);
          // Дни оставшиеся в неделе после сегодня (но не больше дней до конца месяца).
          const lastMonthDate = data.daily[data.daily.length - 1]?.date ?? sundayStr;
          const remainingEndStr = sundayStr < lastMonthDate ? sundayStr : lastMonthDate;
          const remainingEnd = new Date(remainingEndStr + 'T00:00:00Z');
          const remainingDaysWeek = Math.max(0, Math.round((remainingEnd.getTime() - todayDate.getTime()) / 86400000));
          const planRemainingWeekKop = planPerDayKop * remainingDaysWeek + planPerDayKop; // +сегодня уже посчитан в weekFact, считаем всю неделю
          const weekNeedKop = Math.max(0, planWeekKop - weekFactKop);
          const weekNeedPerDayKop = remainingDaysWeek > 0 ? Math.round(weekNeedKop / remainingDaysWeek) : 0;

          const RU_MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
          const sundayLabel = `${sunday.getUTCDate()} ${RU_MONTHS[sunday.getUTCMonth()]}`;

          // Цвет для «нужно/день неделя»: если требуемая нагрузка превышает дневной план более чем на 20% — красный, иначе нейтрально.
          const weekColor: 'red' | 'amber' | undefined = planPerDayKop > 0
            ? (weekNeedPerDayKop > planPerDayKop * 1.2 ? 'red' : weekNeedPerDayKop > planPerDayKop ? 'amber' : undefined)
            : undefined;

          const weekHint = remainingDaysWeek > 0
            ? `вс ${sundayLabel} · осталось ${remainingDaysWeek} ${plural(remainingDaysWeek, 'день', 'дня', 'дней')} · накопл. ${rubShort(weekFactKop)} из ${rubShort(planWeekKop)}`
            : `неделя закрыта · факт ${rubShort(weekFactKop)} из ${rubShort(planWeekKop)}`;

          return (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 pt-3 border-t border-gray-100">
              <Metric label="Факт, ₽" value={rub(summary.factTotalRevenueKop)} />
              <Metric label="План, ₽" value={rub(planTotalKop)} />
              <Metric label="% выполнения" value={pct(summary.pctOfPlan)} color={summary.pctOfPlan >= 1 ? 'emerald' : summary.pctOfPlan >= 0.8 ? 'amber' : 'red'} />
              <Metric label="Run Rate (прогноз)" value={rub(summary.runRateKop)} />
              <Metric label="Нужно ₽/день (месяц)" value={rub(summary.dailyNeededKop)} />
              <Metric label="Нужно ₽/день (неделя)" value={remainingDaysWeek > 0 ? rub(weekNeedPerDayKop) : '—'} color={weekColor} hint={weekHint} />
              <Metric label="ДРР, %" value={pct(summary.drrPct)} />
            </div>
          );
        })()}

        {/* Дневной грид */}
        <div className="overflow-x-auto pt-3 border-t border-gray-100">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="bg-gray-50 text-gray-600 sticky top-0">
                <th className="px-2 py-1.5 text-left font-medium">Метрика</th>
                {data.daily.map((d) => (
                  <th key={d.date} className={'px-1 py-1.5 text-center font-medium ' + (d.date === params.today ? 'bg-violet-100 text-violet-700' : '')}>
                    {d.day}
                  </th>
                ))}
                <th className="px-2 py-1.5 text-right font-medium bg-gray-100">Σ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              <Row label="Выручка: План, ₽" cells={data.daily.map((d) => fmtRubByMode(d.planRevenueKop))} total={fmtRubByMode(planTotalKop)} />
              <Row label="Выручка: Факт, ₽" cells={data.daily.map((d) => d.factRevenueKop > 0 ? factCell(fmtRubByMode(d.factRevenueKop), d.factRevenueKop, d.planRevenueKop, true) : '—')} total={factCell(fmtRubByMode(summary.factTotalRevenueKop), summary.factTotalRevenueKop, summary.accumPlanKop, true)} bold />
              <Row label="Реклама: План, ₽" cells={data.daily.map((d) => d.planAdSpendKop ? fmtRubByMode(d.planAdSpendKop) : '—')} total={fmtRubByMode((Number(planAd) || 0) * 100)} muted />
              <Row label="Реклама: Факт, ₽" cells={data.daily.map((d) => d.factAdSpendKop > 0 ? factCell(fmtRubByMode(d.factAdSpendKop), d.factAdSpendKop, d.planAdSpendKop, false) : '—')} total={fmtRubByMode(summary.factTotalAdSpendKop)} />
              <Row label="Клики: План" cells={data.daily.map((d) => d.planImpressions ? fmtNumByMode(d.planImpressions) : '—')} total={fmtNumByMode(Number(planImp) || 0)} muted />
              <Row label="Клики: Факт" cells={data.daily.map((d) => d.factImpressions > 0 ? factCell(fmtNumByMode(d.factImpressions), d.factImpressions, d.planImpressions, true) : '—')} total={fmtNumByMode(data.daily.reduce((s, d) => s + d.factImpressions, 0))} />
              <Row label="Заказы: План, шт" cells={data.daily.map((d) => d.planOrdersQty ? fmtNumByMode(d.planOrdersQty) : '—')} total={fmtNumByMode(Number(planOrd) || 0)} muted />
              <Row label="Заказы: Факт, шт" cells={data.daily.map((d) => d.factOrdersQty > 0 ? factCell(fmtNumByMode(d.factOrdersQty), d.factOrdersQty, d.planOrdersQty, true) : '—')} total={fmtNumByMode(summary.factTotalOrders)} />
              <Row label="ДРР: Факт, %" cells={data.daily.map((d) => d.factDrr != null ? d.factDrr.toFixed(1) + '%' : '—')} total={summary.factTotalDrr != null ? summary.factTotalDrr.toFixed(1) + '%' : '—'} bold />
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function rubShort(kop: number): string {
  if (!kop) return '—';
  const rub = Math.round(kop / 100);
  if (rub >= 1_000_000) return (rub / 1_000_000).toFixed(1) + 'М';
  if (rub >= 1_000) return (rub / 1_000).toFixed(1) + 'k';
  return String(rub);
}

function ParamInput({ label, value, onChange, step, highlight }: { label: string; value: string; onChange: (v: string) => void; step?: string; highlight?: boolean }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <Input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={'text-sm h-9 ' + (highlight ? 'bg-violet-50 border-violet-200 font-medium' : '')}
      />
    </div>
  );
}

function Metric({ label, value, color, hint }: { label: string; value: string; color?: 'emerald' | 'amber' | 'red'; hint?: string }) {
  const colorClass = color === 'emerald' ? 'text-emerald-600' : color === 'amber' ? 'text-amber-700' : color === 'red' ? 'text-red-600' : 'text-gray-900';
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-base font-semibold ${colorClass}`}>{value}</div>
      {hint ? <div className="text-[10px] text-gray-400 mt-0.5 leading-tight">{hint}</div> : null}
    </div>
  );
}

function Row({ label, cells, total, bold, muted }: { label: string; cells: ReactNode[]; total: ReactNode; bold?: boolean; muted?: boolean }) {
  return (
    <tr className={muted ? 'text-gray-400' : ''}>
      <td className={'px-2 py-1.5 text-left whitespace-nowrap ' + (bold ? 'font-medium text-gray-900' : 'text-gray-600')}>{label}</td>
      {cells.map((c, i) => (
        <td key={i} className="px-1 py-1.5 text-center tabular-nums">{c}</td>
      ))}
      <td className={'px-2 py-1.5 text-right bg-gray-50 tabular-nums ' + (bold ? 'font-semibold text-gray-900' : '')}>{total}</td>
    </tr>
  );
}

// Ячейка факта с двухстрочкой: значение + Δ% от плана.
// higherBetter=true для выручки/кликов/заказов; higherBetter=false для рекламы (перерасход = плохо).
function factCell(text: string, factVal: number, planVal: number, higherBetter: boolean): ReactNode {
  if (!planVal || planVal <= 0) return text;
  const devPct = ((factVal - planVal) / planVal) * 100;
  const sign = higherBetter ? 1 : -1;
  // ±2% считаем «попали»: серый, чтоб не пестрило.
  let color = 'text-gray-400';
  if (Math.abs(devPct) >= 2) color = devPct * sign >= 0 ? 'text-emerald-600' : 'text-red-500';
  const devStr = `${devPct > 0 ? '+' : ''}${devPct.toFixed(0)}%`;
  return (
    <div className="leading-tight">
      <div>{text}</div>
      <div className={`text-[10px] ${color}`}>{devStr}</div>
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
