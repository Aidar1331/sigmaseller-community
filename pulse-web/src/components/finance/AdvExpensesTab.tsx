'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/Card';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { apiFetch } from '@/lib/api';
import { FinanceStat } from './FinanceStat';

interface DailyRow {
  date: string;
  shopId: number | null;
  totalKop: number;
  balanceKop: number;
  accountKop: number;
  bonusKop: number;
  cashbackKop: number;
  rows: number;
  adverts: number;
}

interface CampaignRow {
  advertId: number;
  campName: string | null;
  advertType: number;
  advertStatus: number;
  totalKop: number;
  rows: number;
  days: number;
}

interface NmRow {
  nmId: number;
  vendorCode: string;
  title: string;
  photo: string | null;
  spendKop: number;
}

interface Resp {
  start: string;
  end: string;
  totals: {
    totalKop: number;
    balanceKop: number;
    accountKop: number;
    bonusKop: number;
    cashbackKop: number;
    rows: number;
    days: number;
    campaigns: number;
  };
  daily: DailyRow[];
  byCampaign: CampaignRow[];
  byNm: NmRow[];
}

function rub(kop: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(kop / 100));
}

function fmtDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

const STATUS_LABEL: Record<number, string> = {
  [-1]: 'Удалена',
  4: 'Готова',
  7: 'Завершена',
  8: 'Отменена',
  9: 'Активна',
  11: 'На паузе',
};

const TYPE_LABEL: Record<number, string> = {
  4: 'Каталог',
  5: 'Карточка',
  6: 'Поиск',
  7: 'Реком.',
  8: 'Авто',
  9: 'Аукцион',
};

interface Props {
  workspaceId: number | null;
  shopId?: number;
  start: string;
  end: string;
}

export function AdvExpensesTab({ workspaceId, shopId, start, end }: Props) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'days' | 'campaigns' | 'nms'>('days');

  const load = async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const p = new URLSearchParams({ start, end });
      if (shopId) p.set('shopId', String(shopId));
      const r = await apiFetch<Resp>(`/finance/${workspaceId}/adv-expenses?${p}`);
      setData(r);
    } catch (e) {
      console.error('adv-expenses', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [workspaceId, shopId, start, end]);

  const t = data?.totals;

  const campaignsSorted = useMemo(() => {
    return [...(data?.byCampaign ?? [])].sort((a, b) => b.totalKop - a.totalKop);
  }, [data]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-lg font-semibold">Расходы на рекламу</div>
              <div className="text-xs text-gray-500 mt-0.5">
                Источник — «История затрат» из ЛК ВБ (полные списания с баланса, счёта, бонусов, кэшбэка)
              </div>
            </div>
            {loading && <div className="text-sm text-gray-500">Загрузка…</div>}
          </div>

          {t && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                <FinanceStat label="Всего реклама" value={-t.totalKop / 100} red />
                <FinanceStat label="С баланса (взаимозачёт)" value={-t.balanceKop / 100} red />
                <FinanceStat label="Со счёта (ручное пополнение)" value={-t.accountKop / 100} red />
                <FinanceStat label="Бонусы" value={-t.bonusKop / 100} red />
                <FinanceStat label="Кэшбэк" value={-t.cashbackKop / 100} red />
                <FinanceStat label="Кампаний" value={t.campaigns} raw />
              </div>
              <details className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded p-2 mt-3">
                <summary className="cursor-pointer font-medium">Как считаются цифры</summary>
                <div className="mt-2 space-y-1">
                  <p>Фактические списания за продвижение из ЛК ВБ — те же цифры, что в xlsx «История затрат».</p>
                  <p><strong>С баланса</strong> = взаимозачёт ВБ (попадает в «Прочие удержания» финотчёта). <strong>Со счёта</strong> = ручное пополнение. <strong>Бонусы/Кэшбэк</strong> — внутренние средства ВБ.</p>
                </div>
              </details>
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <button
          onClick={() => setTab('days')}
          className={`px-3 py-1.5 rounded-md text-sm font-medium ${
            tab === 'days' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'
          }`}
        >
          По дням
        </button>
        <button
          onClick={() => setTab('campaigns')}
          className={`px-3 py-1.5 rounded-md text-sm font-medium ${
            tab === 'campaigns' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'
          }`}
        >
          По кампаниям
        </button>
        <button
          onClick={() => setTab('nms')}
          className={`px-3 py-1.5 rounded-md text-sm font-medium ${
            tab === 'nms' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'
          }`}
        >
          По артикулам
        </button>
      </div>

      <Card>
        <CardContent className="p-0">
          {tab === 'days' && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-2">Дата</th>
                    <th className="px-4 py-2 text-right">Всего</th>
                    <th className="px-4 py-2 text-right">Баланс</th>
                    <th className="px-4 py-2 text-right">Счёт</th>
                    <th className="px-4 py-2 text-right">Бонусы</th>
                    <th className="px-4 py-2 text-right">Кэшбэк</th>
                    <th className="px-4 py-2 text-right">Кампаний</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.daily ?? []).map((r) => (
                    <tr key={`${r.date}-${r.shopId}`} className="border-t border-gray-50">
                      <td className="px-4 py-2 font-medium">{fmtDate(r.date)}</td>
                      <td className="px-4 py-2 text-right font-semibold">{rub(r.totalKop)} ₽</td>
                      <td className="px-4 py-2 text-right text-gray-600">{rub(r.balanceKop)} ₽</td>
                      <td className="px-4 py-2 text-right text-gray-600">{rub(r.accountKop)} ₽</td>
                      <td className="px-4 py-2 text-right text-gray-600">{rub(r.bonusKop)} ₽</td>
                      <td className="px-4 py-2 text-right text-gray-600">{rub(r.cashbackKop)} ₽</td>
                      <td className="px-4 py-2 text-right text-gray-500">{r.adverts}</td>
                    </tr>
                  ))}
                  {(data?.daily ?? []).length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                        Нет данных за выбранный период
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'campaigns' && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-2">Кампания</th>
                    <th className="px-4 py-2">Тип</th>
                    <th className="px-4 py-2">Статус</th>
                    <th className="px-4 py-2 text-right">Расход</th>
                    <th className="px-4 py-2 text-right">Дней</th>
                    <th className="px-4 py-2 text-right">ID</th>
                  </tr>
                </thead>
                <tbody>
                  {campaignsSorted.map((c) => (
                    <tr key={c.advertId} className="border-t border-gray-50">
                      <td className="px-4 py-2">
                        <div className="font-medium truncate max-w-xs" title={c.campName ?? ''}>
                          {c.campName ?? '—'}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-gray-600">{TYPE_LABEL[c.advertType] ?? c.advertType}</td>
                      <td className="px-4 py-2 text-gray-600">{STATUS_LABEL[c.advertStatus] ?? c.advertStatus}</td>
                      <td className="px-4 py-2 text-right font-semibold">{rub(c.totalKop)} ₽</td>
                      <td className="px-4 py-2 text-right text-gray-500">{c.days}</td>
                      <td className="px-4 py-2 text-right text-gray-400 text-xs">{c.advertId}</td>
                    </tr>
                  ))}
                  {campaignsSorted.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                        Нет кампаний с расходом за период
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'nms' && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-2">Артикул</th>
                    <th className="px-4 py-2">Название</th>
                    <th className="px-4 py-2 text-right">Расход на рекламу</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.byNm ?? []).map((r) => (
                    <tr key={r.nmId} className="border-t border-gray-50">
                      <td className="px-4 py-2 tabular-nums"><NmIdLink nmId={r.nmId} /></td>
                      <td className="px-4 py-2 truncate max-w-md" title={r.title}>{r.title || r.vendorCode || '—'}</td>
                      <td className="px-4 py-2 text-right font-semibold">{rub(r.spendKop)} ₽</td>
                    </tr>
                  ))}
                  {(data?.byNm ?? []).length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-4 py-8 text-center text-gray-400">
                        Нет данных
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div className="px-4 py-2 text-[11px] text-gray-400 border-t border-gray-50">
                Значения по артикулам отмасштабированы под итог из «История затрат» ВБ. Доли распределены по показам и кликам в рекламном кабинете.
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
