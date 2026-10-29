'use client';

/**
 * Studio prompt history tab — список всех сохранённых генераций промптов по
 * workspace. Позволяет переиспользовать промпты без повторного вызова LLM.
 */

import { useState, useEffect } from 'react';
import { Loader2, Copy, Check, ExternalLink, Clock, Package, ChevronDown, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { NmIdLink } from '@/components/ui/NmIdLink';
import type { SuggestedPrompt } from './PromptSuggestionsPanel';

interface HistoryRow {
  id: number;
  nmId: number;
  createdAt: string;
  auditId: number | null;
  modelUsed: string;
  label: string | null;
  prompts: SuggestedPrompt[];
  productContext: { title: string; category: string; brand?: string; photosCount: number; hasAudit: boolean };
}

interface Props {
  workspaceId: number;
  onOpenInStudio: (prompt: SuggestedPrompt, nmId: number) => void;
  refreshKey?: number;
}

const KIND_EMOJI: Record<string, string> = {
  main_image: '🖼️', lifestyle: '🏡', infographic: '📊', scale: '📏',
  detail: '🔍', packaging: '📦', video_demo: '🎬',
  rewrite_title: '✏️', rewrite_description: '📝',
};

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));
  } catch { return iso; }
}

export function PromptHistoryTab({ workspaceId, onOpenInStudio, refreshKey }: Props) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      apiFetch<{ ok: boolean; rows: HistoryRow[] }>(`/studio/ai/suggest-prompts/history?workspaceId=${workspaceId}&limit=50`)
        .then((res) => { if (!cancelled) setRows(res.rows ?? []); })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Ошибка'); });
    };
    load();
    // Auto-refresh каждые 10 сек — новые записи из `/creative-audit` или чата
    // подтянутся без ручного рефреша страницы.
    const interval = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [workspaceId, refreshKey]);

  const toggle = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copy = async (key: string, text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 1500);
        return;
      }
    } catch (err) {
      console.warn('clipboard failed, fallback', err);
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 1500);
      } else {
        alert('Копирование не поддерживается. Выделите текст вручную.');
      }
    } catch (err) {
      console.error('copy failed', err);
    }
  };

  if (rows === null && !error) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
        Не удалось загрузить историю: {error}
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
        <Package className="mx-auto mb-3 h-10 w-10 opacity-30" />
        <div className="font-medium text-gray-700">Пока нет сохранённых генераций</div>
        <div className="mt-1">Когда вы попросите «Подсказать промпты» для товара, результаты сохранятся здесь.</div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-500 mb-3">
        Всего: {rows.length} записей. Клик по строке — раскрыть промпты.
      </div>
      {rows.map((row) => {
        const isOpen = expandedIds.has(row.id);
        return (
          <div key={row.id} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <button
              type="button"
              onClick={() => toggle(row.id)}
              className="flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                {isOpen ? <ChevronDown className="h-4 w-4 text-gray-500 flex-shrink-0" /> : <ChevronRight className="h-4 w-4 text-gray-500 flex-shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium text-gray-900 truncate">
                    <Package className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
                    <span className="font-mono text-xs text-gray-500 flex-shrink-0"><NmIdLink nmId={row.nmId} /></span>
                    <span className="truncate">{row.productContext.title || '—'}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-gray-500">
                    <Clock className="h-3 w-3" />
                    {formatDate(row.createdAt)}
                    <span>·</span>
                    <span>{row.prompts.length} промптов</span>
                    {row.auditId && <span className="rounded bg-indigo-100 px-1 py-px text-[10px] font-semibold text-indigo-700">аудит #{row.auditId}</span>}
                    {row.productContext.category && <span className="rounded bg-gray-100 px-1 py-px text-[10px] text-gray-600">{row.productContext.category}</span>}
                  </div>
                </div>
              </div>
            </button>

            {isOpen && (
              <div className="border-t border-gray-200 bg-gray-50/50 p-3 space-y-2">
                {row.prompts.map((p, i) => {
                  const key = `${row.id}:${i}`;
                  return (
                    <div key={i} className="rounded-md border border-gray-200 bg-white p-2.5">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm">{KIND_EMOJI[p.kind] ?? '🎨'}</span>
                          <span className="text-xs font-semibold text-gray-900 truncate">{p.title}</span>
                        </div>
                        <span className="text-[10px] font-mono text-gray-500 flex-shrink-0">{p.targetModel}</span>
                      </div>
                      <pre className="mb-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded bg-gray-50 p-1.5 text-[10px] leading-relaxed text-gray-700 border border-gray-100">
                        {p.promptText}
                      </pre>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => void copy(key, p.promptText)}
                          className="inline-flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-700 hover:bg-gray-50"
                        >
                          {copiedKey === key ? <Check className="h-2.5 w-2.5 text-green-700" /> : <Copy className="h-2.5 w-2.5" />}
                          {copiedKey === key ? 'Скопировано' : 'Копировать'}
                        </button>
                        <button
                          onClick={() => onOpenInStudio(p, row.nmId)}
                          className="inline-flex items-center gap-1 rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-indigo-700"
                        >
                          <ExternalLink className="h-2.5 w-2.5" />
                          В форму
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
