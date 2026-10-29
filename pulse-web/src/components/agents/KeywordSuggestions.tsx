'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, Plus, RefreshCw, AlertTriangle, Check } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';

type KeywordCandidate = {
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
};

type Response = {
  summary: string;
  candidates: KeywordCandidate[];
};

type Props = {
  workspaceId: number | null;
  shopId: number | null;
  onAdded?: () => void;
};

export function KeywordSuggestions({ workspaceId, shopId, onAdded }: Props) {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const qs = shopId ? `?shopId=${shopId}` : '';
      const r = await apiFetch<Response>(`/agents/${workspaceId}/seo/keyword-suggestions${qs}`);
      setData(r);
      setSelected(new Set());
    } catch (err) {
      setError((err as Error)?.message ?? 'Не удалось загрузить');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, shopId]);

  useEffect(() => { load(); }, [load]);

  const toggle = (keyword: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(keyword)) next.delete(keyword);
      else next.add(keyword);
      return next;
    });
  };

  const toggleAll = () => {
    if (!data) return;
    if (selected.size === data.candidates.length) setSelected(new Set());
    else setSelected(new Set(data.candidates.map((c) => c.keyword)));
  };

  const handleAdd = async () => {
    if (!workspaceId || selected.size === 0 || !data) return;
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const chosen = data.candidates.filter((c) => selected.has(c.keyword));
      const payload = {
        shopId,
        keywords: chosen.map((c) => ({ keyword: c.keyword, nmIds: c.relatedNmIds.slice(0, 50) })),
      };
      const raw = await apiFetch<string | { added?: number; message?: string }>(`/agents/${workspaceId}/seo/keywords/add`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      setNotice(parsed.message ?? `Добавлено: ${parsed.added ?? 0}`);
      setSelected(new Set());
      await load();
      onAdded?.();
    } catch (err) {
      setError((err as Error)?.message ?? 'Ошибка добавления');
    } finally {
      setAdding(false);
    }
  };

  const candidates = data?.candidates ?? [];
  const allSelected = candidates.length > 0 && selected.size === candidates.length;

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-500" />
            Рекомендуемые слова для отслеживания
            {candidates.length > 0 && (
              <span className="text-xs font-normal text-gray-500">({candidates.length})</span>
            )}
          </h3>
          {data?.summary && <div className="text-xs text-gray-500 mt-0.5">{data.summary}</div>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="neutral" onClick={load} disabled={loading || adding}>
            <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} /> Обновить
          </Button>
          <Button onClick={handleAdd} disabled={selected.size === 0 || adding}>
            <Plus className="mr-2 h-4 w-4" />
            {adding ? 'Добавляю…' : `Добавить выбранные${selected.size ? ` (${selected.size})` : ''}`}
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 mb-2">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 text-sm text-green-700 mb-2">
          <Check className="h-4 w-4" /> {notice}
        </div>
      )}

      {candidates.length === 0 && !loading && (
        <div className="text-sm text-gray-500 py-6 text-center">
          Нет подходящих кандидатов. Убедитесь, что Jam-отчёт включён и search-queries sync прошёл.
        </div>
      )}

      {candidates.length > 0 && (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-[var(--content-muted)]">
                <th className="py-2 px-2 w-8">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Выбрать все" />
                </th>
                <th className="py-2 px-2">Запрос</th>
                <th className="py-2 px-2">Пример товара</th>
                <th className="py-2 px-2 text-right">Показы</th>
                <th className="py-2 px-2 text-right">Клики</th>
                <th className="py-2 px-2 text-right">Заказы</th>
                <th className="py-2 px-2 text-right">CTR %</th>
                <th className="py-2 px-2 text-right">Позиция</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => {
                const isSelected = selected.has(c.keyword);
                return (
                  <tr
                    key={c.keyword}
                    className={cn('border-b hover:bg-slate-50/50 cursor-pointer', isSelected && 'bg-violet-50/40')}
                    onClick={() => toggle(c.keyword)}
                  >
                    <td className="py-2 px-2">
                      <input type="checkbox" checked={isSelected} readOnly aria-label={`Выбрать ${c.keyword}`} />
                    </td>
                    <td className="py-2 px-2 font-medium text-gray-900">{c.keyword}</td>
                    <td className="py-2 px-2 text-xs text-gray-600 max-w-[260px] truncate" title={c.sampleTitle ?? ''}>
                      {c.sampleTitle ?? `${c.relatedNmIds.length} SKU`}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums">{c.views.toLocaleString('ru')}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{c.clicks}</td>
                    <td className="py-2 px-2 text-right tabular-nums font-semibold">
                      {c.orders > 0 ? <span className="text-green-700">{c.orders}</span> : '0'}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums">{c.ctrPct}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{c.avgPosition ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
