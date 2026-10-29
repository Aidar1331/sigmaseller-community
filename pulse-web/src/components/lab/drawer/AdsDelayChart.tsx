'use client';

/**
 * AdsDelayChart — бар-чарт «эффект рекламы по дням».
 * Под капотом — lag cross-correlation, в UI — только видимый пик и подпись.
 */

import { useEffect, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Cell, Tooltip } from 'recharts';
import { apiFetch } from '@/lib/api';
import { Explainer } from './Explainer';

interface LagResp {
  ok: boolean;
  lag: {
    series: Array<{ lag: number; r: number; p: number; n: number }>;
    bestLag: number;
    bestR: number;
    bestP: number;
    leader: string;
  } | null;
  n: number;
  sparsity: string;
}

interface Props {
  workspaceId: number;
  shopId: number;
  nmId: number;
  from: string;
  to: string;
}

export function AdsDelayChart({ workspaceId, shopId, nmId, from, to }: Props) {
  const [data, setData] = useState<LagResp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    apiFetch<LagResp>(
      `/lab/${workspaceId}/lag?shopId=${shopId}&nmId=${nmId}&from=${from}&to=${to}&x=advSpendRub&y=ordersCount&maxLag=10`,
      { signal: ac.signal } as RequestInit,
    )
      .then(d => { if (!ac.signal.aborted) setData(d); })
      .catch(() => {})
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [workspaceId, shopId, nmId, from, to]);

  if (loading) return <div className="text-xs text-slate-500 italic">Ищем задержку эффекта рекламы…</div>;
  if (!data?.lag) return <div className="text-xs text-slate-500">Недостаточно данных по рекламе для анализа задержки.</div>;

  const points = data.lag.series
    .filter(s => Number.isFinite(s.r) && s.lag >= 0) // показываем только «реклама опережает» часть
    .map(s => ({ lag: s.lag, strength: Math.max(0, s.r) })); // только положительные «пики эффекта»

  if (points.length === 0) return <div className="text-xs text-slate-500">Нет положительного эффекта рекламы за период.</div>;

  const bestLag = data.lag.bestLag >= 0 ? data.lag.bestLag : null;
  const humanLine = bestLag != null && bestLag > 0
    ? `Пик эффекта рекламы — через ${bestLag} ${bestLag === 1 ? 'день' : bestLag < 5 ? 'дня' : 'дней'}`
    : bestLag === 0
      ? 'Эффект рекламы виден в тот же день'
      : 'Явного эффекта рекламы не обнаружено';

  const strong = bestLag != null && data.lag.bestR >= 0.3 && data.lag.bestP < 0.1;

  return (
    <div>
      <div className="text-xs font-medium text-slate-700 mb-1">Через сколько дней срабатывает реклама</div>
      <div className="h-[200px] w-full">
        <ResponsiveContainer>
          <BarChart data={points} margin={{ top: 8, right: 12, bottom: 24, left: 12 }}>
            <XAxis dataKey="lag" tick={{ fontSize: 10 }} label={{ value: 'Дней после рекламы', position: 'bottom', offset: 0, fontSize: 11 }} />
            <YAxis tick={{ fontSize: 10 }} hide />
            <Tooltip
              formatter={(v) => [(Number(v) * 100).toFixed(0) + '%', 'Сила']}
              labelFormatter={(lag) => `+${lag} дн.`}
            />
            <Bar dataKey="strength" radius={[4, 4, 0, 0]}>
              {points.map((p, idx) => (
                <Cell key={idx} fill={p.lag === bestLag && strong ? '#10b981' : '#94a3b8'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className={`mt-1 text-xs font-medium ${strong ? 'text-emerald-700' : 'text-slate-600'}`}>
        ⏱ {humanLine}
      </div>
      <Explainer
        read={
          <span>
            Каждый столбик — день после дня рекламы. Чем <b>выше столбик</b>, тем сильнее реклама,
            оплаченная в день 0, повлияла на заказы через N дней. <b>Зелёный столбик</b> — пик
            эффекта.
          </span>
        }
        use={
          strong ? (
            <ul className="list-disc list-inside space-y-0.5">
              <li>Эффект через {bestLag} {bestLag === 1 ? 'день' : bestLag! < 5 ? 'дня' : 'дней'} — планируйте акции и поставки с этим лагом: рекламу запускайте за {bestLag} {bestLag === 1 ? 'день' : 'дня'} до целевой даты.</li>
              <li>Не оценивайте окупаемость рекламы по тому же дню — реальная конверсия размазана.</li>
              <li>Если основной пик на лаге 0 — реклама работает «в моменте», можно дешевле тестировать ставки.</li>
            </ul>
          ) : (
            <ul className="list-disc list-inside space-y-0.5">
              <li>Связи нет — реклама либо не работает, либо данных недостаточно. Проверьте таргетинг и крупность бюджета.</li>
              <li>Урежьте спенд на 30% и сравните заказы — если падения нет, реклама бесполезна на этом товаре.</li>
            </ul>
          )
        }
      />
    </div>
  );
}
