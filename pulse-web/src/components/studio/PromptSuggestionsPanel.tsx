'use client';

/**
 * Shared panel showing AI-generated prompts for a product.
 * Used both on /creative-audit (with auditId) and on /studio (without audit).
 *
 * Two tabs:
 *  - «Сохранённые» — previous generations from DB (no LLM call)
 *  - «Новая генерация» — fresh call to /studio/ai/suggest-prompts
 *
 * If история пуста — сразу открывается «Новая генерация» + автогенерация.
 * Если есть — открывается «Сохранённые», генерация запускается по клику.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { X, Copy, Check, Sparkles, Loader2, AlertCircle, ExternalLink, Clock, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';

export interface SuggestedPrompt {
  kind: string;
  title: string;
  reasoning: string;
  promptText: string;
  targetModel: string;
  dimensions?: string;
  aspectRatio?: '1:1' | '3:4' | '16:9';
  estimatedCostRub?: number;
  referenceImageUrl?: string;
}

interface ProductContext {
  title: string;
  category: string;
  brand?: string;
  photosCount: number;
  hasAudit: boolean;
}

interface HistoryRow {
  id: number;
  createdAt: string;
  auditId: number | null;
  modelUsed: string;
  label: string | null;
  prompts: SuggestedPrompt[];
  productContext: ProductContext;
}

interface Props {
  nmId: number;
  auditId?: number;
  workspaceId: number;
  onClose: () => void;
  onOpenInStudio?: (prompt: SuggestedPrompt) => void;
  /** Вызывается когда свежая генерация сохранена в БД — для refresh "История промптов". */
  onGenerated?: () => void;
  embedded?: boolean;
}

type Tab = 'history' | 'new';

const KIND_LABEL: Record<string, string> = {
  main_image: 'Главное фото',
  lifestyle: 'Lifestyle',
  infographic: 'Инфографика',
  scale: 'Масштаб',
  detail: 'Деталь / макро',
  packaging: 'Упаковка',
  video_demo: 'Видео-демо',
  rewrite_title: 'Новый заголовок',
  rewrite_description: 'Новое описание',
};

const KIND_EMOJI: Record<string, string> = {
  main_image: '🖼️',
  lifestyle: '🏡',
  infographic: '📊',
  scale: '📏',
  detail: '🔍',
  packaging: '📦',
  video_demo: '🎬',
  rewrite_title: '✏️',
  rewrite_description: '📝',
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).format(d);
  } catch { return iso; }
}

export function PromptSuggestionsPanel({ nmId, auditId, workspaceId, onClose, onOpenInStudio, onGenerated, embedded = false }: Props) {
  // shopId is needed in the body so the saved row carries the active shop.
  // Without it backend stores shop_id=NULL and history fetches (which inject
  // ?shopId=N via apiFetch) filter the row out — so «История промптов» looks
  // empty even though the generation succeeded.
  const shopId = useWorkspaceStore((s) => s.shopId);
  // Auto-close modal when user navigates away (sidebar click, etc).
  // Без этого `fixed inset-0` backdrop перехватывает клик и навигация не срабатывает —
  // user кликает один раз впустую, панель закрывается, потом надо кликнуть ещё.
  const pathname = usePathname();
  const initialPathRef = useRef(pathname);
  useEffect(() => {
    if (embedded) return;
    if (pathname !== initialPathRef.current) onClose();
  }, [pathname, embedded, onClose]);

  const [tab, setTab] = useState<Tab>('history');
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [selectedHistoryId, setSelectedHistoryId] = useState<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<SuggestedPrompt[]>([]);
  const [ctx, setCtx] = useState<ProductContext | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const inflightKeyRef = useRef<string | null>(null);
  const autoRanRef = useRef(false);

  // Без вкладок: на mount сразу стартуем генерацию (backend дедупит по 5 мин).
  // Результат автоматически сохраняется в таблицу `studio_prompt_suggestions` —
  // виден в главной вкладке «История промптов» на уровне Studio.
  useEffect(() => {
    setHistoryLoading(false);
    setHistory([]);
  }, [workspaceId, nmId]);

  const generateFresh = useCallback(async (forceFresh = false) => {
    const key = `${workspaceId}:${nmId}:${auditId ?? 'none'}${forceFresh ? ':force' : ''}`;
    if (inflightKeyRef.current === key) return;
    inflightKeyRef.current = key;

    setLoading(true);
    setError(null);
    setElapsedSec(0);
    const startedAt = Date.now();
    const timerId = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    try {
      const res = (await apiFetch(`/studio/ai/suggest-prompts?workspaceId=${workspaceId}`, {
        method: 'POST',
        body: JSON.stringify({ nmId, auditId, count: 8, forceFresh, ...(shopId ? { shopId } : {}) }),
      })) as { ok: boolean; prompts: SuggestedPrompt[]; productContext: ProductContext; error?: string };

      if (!res.ok) throw new Error(res.error ?? 'Ошибка генерации промптов');
      setPrompts(res.prompts ?? []);
      setCtx(res.productContext ?? null);
      // Уведомляем родителя — он триггерит refetch главной вкладки «История промптов».
      onGenerated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      window.clearInterval(timerId);
      setLoading(false);
      inflightKeyRef.current = null;
    }
  }, [nmId, auditId, workspaceId, shopId, onGenerated]);

  // Auto-run fresh generation when history load completes and it's empty.
  useEffect(() => {
    if (!historyLoading && history !== null && history.length === 0 && !autoRanRef.current) {
      autoRanRef.current = true;
      void generateFresh();
    }
  }, [historyLoading, history, generateFresh]);

  const copyPrompt = async (idx: number, text: string) => {
    // Primary: modern Clipboard API (требует secure context — localhost / https)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopiedIdx(idx);
        setTimeout(() => setCopiedIdx(null), 1500);
        return;
      }
    } catch (err) {
      console.warn('clipboard.writeText failed, trying execCommand fallback', err);
    }
    // Fallback для старых / insecure контекстов: временный textarea + execCommand
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
        setCopiedIdx(idx);
        setTimeout(() => setCopiedIdx(null), 1500);
      } else {
        alert('Копирование не поддерживается браузером. Выделите текст вручную.');
      }
    } catch (err) {
      console.error('copy failed entirely', err);
      alert('Не удалось скопировать. Выделите текст вручную.');
    }
  };

  const openInStudio = (p: SuggestedPrompt) => {
    if (onOpenInStudio) {
      onOpenInStudio(p);
      return;
    }
    const params = new URLSearchParams();
    params.set('prompt', p.promptText);
    params.set('nmId', String(nmId));
    params.set('model', p.targetModel);
    params.set('kind', p.kind.startsWith('video_') ? 'video' : 'image');
    if (auditId) {
      params.set('source', 'audit');
      params.set('auditId', String(auditId));
    }
    if (p.aspectRatio) params.set('aspectRatio', p.aspectRatio);
    if (p.referenceImageUrl) params.set('refImage', p.referenceImageUrl);
    window.location.href = `/studio?${params.toString()}`;
  };

  const selectHistoryRow = (row: HistoryRow) => {
    setSelectedHistoryId(row.id);
    setPrompts(row.prompts);
    setCtx(row.productContext);
  };

  // Rendering -------------------------------------------------------------
  const renderPrompts = (items: SuggestedPrompt[]) => (
    <div className="space-y-3">
      {items.map((p, i) => (
        <div key={i} className="rounded-lg border border-gray-200 bg-white p-3 hover:border-indigo-300 transition-colors">
          <div className="mb-1 flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-lg">{KIND_EMOJI[p.kind] ?? '🎨'}</span>
              <div>
                <div className="text-sm font-semibold text-gray-900">{p.title}</div>
                <div className="text-[11px] uppercase tracking-wide text-gray-500">
                  {KIND_LABEL[p.kind] ?? p.kind}
                  {p.targetModel && <span className="ml-1.5 rounded bg-gray-100 px-1 py-px font-mono text-[10px] text-gray-600">{p.targetModel}</span>}
                  {p.aspectRatio && <span className="ml-1 text-gray-500">· {p.aspectRatio}</span>}
                </div>
              </div>
            </div>
            
          </div>
          {p.reasoning && (
            <div className="mb-2 text-xs text-gray-600">
              <span className="font-medium text-gray-700">Зачем: </span>{p.reasoning}
            </div>
          )}
          <pre className="mb-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-700 border border-gray-100">
            {p.promptText}
          </pre>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void copyPrompt(i, p.promptText)}
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              {copiedIdx === i ? <Check className="h-3 w-3 text-green-700" /> : <Copy className="h-3 w-3" />}
              {copiedIdx === i ? 'Скопировано' : 'Копировать'}
            </button>
            <button
              onClick={() => openInStudio(p)}
              className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-700"
            >
              <ExternalLink className="h-3 w-3" />
              {onOpenInStudio ? 'Использовать в форме' : 'Открыть в Студии'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  const body = (
    <>
      <div className="flex items-center justify-between border-b border-gray-200 p-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-indigo-600" />
          <div>
            <div className="text-base font-semibold text-gray-900">Промпты для AI-генерации</div>
            {ctx && (
              <div className="text-xs text-gray-500">
                Артикул {nmId} · {ctx.title.slice(0, 60)}{ctx.title.length > 60 ? '…' : ''}
                {ctx.hasAudit && <span className="ml-2 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">из аудита</span>}
              </div>
            )}
          </div>
        </div>
        <button onClick={onClose} className="rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700">
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Single view — без вкладок. "Сохранённые" теперь только на главной вкладке
          "История промптов" уровня Studio. Здесь — только свежая генерация. */}
      <div className="max-h-[72vh] overflow-y-auto p-4">
        {loading && (
              <div className="flex flex-col items-center gap-2 py-10 text-gray-500">
                <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
                <span className="text-sm">
                  Готовим промпты… {elapsedSec > 0 && <span className="font-mono tabular-nums">{elapsedSec}с</span>}
                </span>
                <span className="text-[11px] text-gray-500">Обычно 15–40 сек — AI пишет под ваш товар</span>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div>
                  <div className="font-medium">Не удалось получить промпты</div>
                  <div className="text-xs">{error}</div>
                  <button onClick={() => void generateFresh()} className="mt-2 rounded border border-red-300 px-2 py-1 text-xs hover:bg-red-100">
                    Попробовать снова
                  </button>
                </div>
              </div>
            )}

            {!loading && !error && prompts.length === 0 && (
              <div className="py-10 text-center">
                <button
                  type="button"
                  onClick={() => void generateFresh()}
                  className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  <Sparkles className="h-4 w-4" />
                  Сгенерировать промпты
                </button>
                <div className="mt-2 text-[11px] text-gray-500">Занимает ~15-40 сек, результат сохранится в «Историю промптов»</div>
              </div>
            )}

            {!loading && !error && prompts.length > 0 && (
              <>
                <div className="mb-3 flex items-center justify-between rounded-md bg-indigo-50 px-3 py-1.5 text-xs text-indigo-800">
                  <span>✨ Свежая генерация — автоматически сохранена в «Историю промптов»</span>
                  <button
                    onClick={() => void generateFresh(true)}
                    className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-white px-2 py-0.5 font-medium hover:bg-indigo-100"
                    title="Новая генерация — обходит кэш"
                  >
                    <RefreshCw className="h-3 w-3" /> Ещё
                  </button>
                </div>
                {renderPrompts(prompts)}
              </>
            )}
      </div>
    </>
  );

  if (embedded) {
    return <div className="rounded-xl border border-gray-200 bg-white shadow-sm">{body}</div>;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>
  );
}
