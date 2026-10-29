'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bot, Sparkles, TrendingDown, TrendingUp, BarChart3, Package, Search,
  Zap, Gift, MessageSquare, ExternalLink, Send, Loader2, Square, X, ListChecks,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAiChat } from '@/hooks/useAiChat';
import { AiChatMessages } from '@/components/ai/AiChatMessages';

type Severity = string;

export interface EventAiContext {
  eventId: number;
  category: string;
  severity?: Severity;
  title: string;
  description?: string;
  nmId?: number | null;
  date?: string;
  evidence?: Record<string, unknown> | null;
}

interface ActionDef {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  primary?: boolean;
  kind: 'ai' | 'link';
  /** For kind=ai: prompt template, {nmId}/{prev}/{curr}/{delta}/{title} get substituted */
  prompt?: string;
  /** For kind=link */
  href?: string;
}

const ACTIONS: Record<string, ActionDef[]> = {
  price: [
    {
      key: 'explain',
      label: 'Объяснить изменение цены',
      icon: Sparkles,
      primary: true,
      kind: 'ai',
      prompt:
        'Объясни почему изменилась цена товара {nmId}. Проверь, могла ли причина быть в акциях Wildberries, изменении скидки покупателя (СПП), действиях автоматического управления ценой, реакции на конкурентов или ошибке данных. Дай ранжированный список вероятных причин с пояснениями.',
    },
    {
      key: 'compete',
      label: 'Сравнить с конкурентами',
      icon: Search,
      kind: 'ai',
      prompt:
        'Найди топ-10 конкурентов товара {nmId} в той же категории и сравни наши цены с их ценами. Покажи в каком перцентиле мы находимся и есть ли явные ценовые дыры.',
    },
    {
      key: 'dynamics',
      label: 'Открыть динамику',
      icon: BarChart3,
      kind: 'link',
      href: '/dynamics?nmId={nmId}',
    },
  ],
  stock: [
    {
      key: 'oos_forecast',
      label: 'Когда закончится товар?',
      icon: Sparkles,
      primary: true,
      kind: 'ai',
      prompt:
        'Спрогнозируй когда закончится товар {nmId}. Учти текущие остатки на складах, темп продаж за 7 и 30 дней, сезонность. Дай ОДНУ конкретную дату когда товар закончится и срок безопасной поставки.',
    },
    {
      key: 'supply_volume',
      label: 'Оптимальный объём поставки?',
      icon: ListChecks,
      kind: 'ai',
      prompt:
        'Какой оптимальный объём следующей поставки товара {nmId}? Учти темп продаж, маржу, стоимость хранения, текущие коэффициенты приёмки складов. Дай конкретное число штук + срок поставки.',
    },
    {
      key: 'supply_create',
      label: 'Создать поставку',
      icon: Package,
      kind: 'link',
      href: '/supplies?nmId={nmId}',
    },
  ],
  sales: [
    {
      key: 'why_drop',
      label: 'Почему упали заказы?',
      icon: Sparkles,
      primary: true,
      kind: 'ai',
      prompt:
        'Заказы товара {nmId} упали. Дай ранжированный список причин: упала ли видимость в выдаче? Конкуренты сбили цену? Товар закончился? Сезонность? Реклама прекратилась? По каждой версии — что проверить.',
    },
    {
      key: 'seo_positions',
      label: 'Где сидим в выдаче',
      icon: BarChart3,
      kind: 'link',
      href: '/seo?nmId={nmId}',
    },
    {
      key: 'boost',
      label: 'Стоит ли бустить рекламой?',
      icon: Zap,
      kind: 'ai',
      prompt:
        'Стоит ли запустить или увеличить рекламную кампанию для оживления продаж {nmId}? Учти ДРР, маржу, текущие позиции. Если да — какой бюджет и стратегия.',
    },
  ],
  review: [
    {
      key: 'reply',
      label: 'Сгенерировать ответ',
      icon: MessageSquare,
      primary: true,
      kind: 'ai',
      prompt:
        'Сгенерируй вежливый ответ на отзыв покупателя. Если есть текст отзыва в контексте — используй его. Отвечай корректно, признай проблему если она есть, предложи действие.',
    },
    {
      key: 'tone',
      label: 'Анализ тона / категория',
      icon: Sparkles,
      kind: 'ai',
      prompt:
        'Проанализируй отзыв: настроение, категория проблемы (качество / доставка / упаковка / несоответствие / сервис), серьёзность. Дай рекомендации что делать.',
    },
  ],
  card: [
    {
      key: 'diff',
      label: 'Что изменилось?',
      icon: Sparkles,
      primary: true,
      kind: 'ai',
      prompt:
        'Опиши что именно изменилось в карточке товара {nmId} и оцени последствия. Что было vs что стало. Особое внимание критическим изменениям: категория, бренд, название, размеры. Какие действия рекомендуешь.',
    },
    {
      key: 'open_card',
      label: 'Открыть карточку',
      icon: ExternalLink,
      kind: 'link',
      href: '/pulse?nmId={nmId}',
    },
  ],
};

// Fallback when category is unknown
const FALLBACK_ACTIONS: ActionDef[] = [
  {
    key: 'analyze',
    label: 'Проанализировать событие',
    icon: Sparkles,
    primary: true,
    kind: 'ai',
    prompt: 'Проанализируй это событие и дай рекомендации что делать дальше.',
  },
];

const CATEGORY_ALIAS: Record<string, string> = {
  card_change: 'card',
};

function substitutePromptVars(template: string, ctx: EventAiContext): string {
  const ev = ctx.evidence ?? {};
  const prev =
    (ev as any).prevPriceRub ?? (ev as any).prevPrice ?? (ev as any).previousValue ?? '';
  const curr =
    (ev as any).currPriceRub ?? (ev as any).currPrice ?? (ev as any).currentValue ?? '';
  const delta = (ev as any).deltaPct ?? '';
  return template
    .replaceAll('{nmId}', String(ctx.nmId ?? '—'))
    .replaceAll('{title}', ctx.title)
    .replaceAll('{description}', ctx.description ?? '')
    .replaceAll('{prev}', String(prev))
    .replaceAll('{curr}', String(curr))
    .replaceAll('{delta}', String(delta));
}

// Translation maps — convert agent-internal English codes from the DB to Russian.
// Any code NOT present in these maps is silently DROPPED rather than shown raw
// to the AI (operator's rule 2026-05-23: no English DB identifiers in user-facing prompts).

const SUGGESTED_ACTION_RU: Record<string, string> = {
  reprice: 'изменить цену',
  pause_ads: 'поставить рекламу на паузу',
  resume_ads: 'возобновить рекламу',
  increase_ads: 'увеличить рекламный бюджет',
  decrease_ads: 'уменьшить рекламный бюджет',
  restock: 'заказать поставку',
  reduce_stock: 'сократить остаток',
  reply_review: 'ответить на отзыв',
  hide_card: 'скрыть карточку',
  join_promo: 'вступить в акцию',
  leave_promo: 'выйти из акции',
  check_competitors: 'проверить конкурентов',
};

const TRIGGER_RU: Record<string, string> = {
  stock_excess: 'избыток остатков',
  stock_oos: 'товар скоро закончится',
  low_stock: 'низкие остатки',
  oos_warning: 'предупреждение об отсутствии в наличии',
  stock_forecast: 'прогноз остатков',
  margin_drop: 'падение маржи',
  order_drop: 'падение заказов',
  feedback_alert: 'негативный отзыв',
  price_war: 'ценовая война с конкурентами',
  review_spike: 'всплеск отзывов',
};

const CARD_CHANGE_RU: Record<string, string> = {
  title_change: 'название',
  description_change: 'описание',
  brand_change: 'бренд',
  subject_change: 'категория',
  photo_change: 'фото',
  video_change: 'видео',
  characteristics_change: 'характеристики',
  sizes_change: 'размеры',
  dimensions_change: 'габариты',
};

function translateOrDrop(value: unknown, dict: Record<string, string>): string | null {
  if (typeof value !== 'string') return null;
  return dict[value] ?? null;
}

function fmtVal(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(fmtVal).join(', ');
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

/**
 * Builds a short, human-readable context paragraph from event evidence.
 * Returned text gets appended to the prompt as plain Russian — never JSON,
 * never raw English codes from the DB.
 */
function buildHumanContext(ctx: EventAiContext): string {
  const lines: string[] = [];
  const ev = (ctx.evidence ?? {}) as Record<string, any>;

  if (ctx.nmId) lines.push(`Товар: ${ctx.nmId}`);
  if (ctx.date) lines.push(`Дата: ${ctx.date}`);

  // Description from the event row carries the most useful "что было → что стало"
  // information for card_change events, and the human-readable diff text otherwise.
  if (ctx.description && ctx.description.trim()) {
    lines.push(`Что произошло: ${ctx.description.trim()}`);
  }

  // Price category fields
  if (ev.prevPriceRub != null && ev.currPriceRub != null) {
    const deltaTxt = ev.deltaPct != null ? ` (${ev.deltaPct > 0 ? '+' : ''}${ev.deltaPct}%)` : '';
    lines.push(`Было: ${ev.prevPriceRub} ₽ → стало: ${ev.currPriceRub} ₽${deltaTxt}`);
  }

  // Stock category fields (qty / daysOfStock from agent_events.meta)
  const meta = (ev.meta ?? {}) as Record<string, any>;
  if (meta.qty != null) lines.push(`Текущий остаток: ${meta.qty} шт`);
  if (meta.daysOfStock != null) lines.push(`Хватит на: ${meta.daysOfStock} дней`);
  if (meta.daysToOos != null) lines.push(`До отсутствия в наличии: ${meta.daysToOos} дней`);
  const triggerRu = translateOrDrop(meta.triggerId, TRIGGER_RU);
  if (triggerRu) lines.push(`Тип события: ${triggerRu}`);

  // Sales category fields
  if (meta.dropPct != null) lines.push(`Падение: ${meta.dropPct}%`);
  if (meta.baseline != null) lines.push(`Норма (baseline): ${meta.baseline}`);
  if (meta.current != null) lines.push(`Текущее значение: ${meta.current}`);

  // Card change category fields — translate code → Russian
  if (Array.isArray(ev.changes) && ev.changes.length > 0) {
    const translated = ev.changes
      .map((c: string) => CARD_CHANGE_RU[c])
      .filter((s): s is string => !!s);
    if (translated.length > 0) {
      lines.push(`Что изменилось: ${translated.join(', ')}`);
    }
  }

  // Card change DEEP details — embed structured changes inline so AI gets
  // concrete "from → to" values instead of vague "characteristics changed".
  const details = ev.details as Record<string, any> | undefined;
  if (details) {
    if (details.title) {
      lines.push(`Название было: «${details.title.from}»; стало: «${details.title.to}»`);
    }
    if (details.brand) {
      lines.push(`Бренд: «${details.brand.from}» → «${details.brand.to}»`);
    }
    if (details.description) {
      lines.push(`Описание изменилось (${details.description.fromLen} → ${details.description.toLen} символов). Начало нового текста: «${(details.description.toPreview ?? '').slice(0, 140)}…»`);
    }
    if (details.characteristics) {
      const { changed = [], added = [], removed = [] } = details.characteristics;
      const items: string[] = [];
      for (const c of changed.slice(0, 12)) items.push(`«${c.name}»: ${fmtVal(c.from)} → ${fmtVal(c.to)}`);
      for (const c of added.slice(0, 6)) items.push(`+ «${c.name}»: ${fmtVal(c.to)}`);
      for (const c of removed.slice(0, 6)) items.push(`− «${c.name}» (было ${fmtVal(c.from)})`);
      if (items.length > 0) {
        lines.push(`Характеристики: ${items.join('; ')}`);
      }
    }
    if (details.photos) {
      const fromN = details.photos.from?.length ?? 0;
      const toN = details.photos.to?.length ?? 0;
      lines.push(`Фото: ${fromN} → ${toN}`);
      // Pass URLs so AI with web access can fetch them and analyze visually.
      const beforeUrls = (details.photos.from ?? []).slice(0, 4).map((p: any) => p.big).filter(Boolean);
      const afterUrls = (details.photos.to ?? []).slice(0, 4).map((p: any) => p.big).filter(Boolean);
      if (beforeUrls.length > 0) lines.push(`URL фото ДО (первые ${beforeUrls.length}): ${beforeUrls.join(' ')}`);
      if (afterUrls.length > 0) lines.push(`URL фото ПОСЛЕ (первые ${afterUrls.length}): ${afterUrls.join(' ')}`);
    }
    if (details.sizes) {
      lines.push(`Размеры/варианты: ${details.sizes.fromCount} → ${details.sizes.toCount}`);
    }
  }

  // Agent's suggested action — only show if we have a Russian translation
  const actionRu = translateOrDrop(ev.suggestedAction, SUGGESTED_ACTION_RU);
  if (actionRu) lines.push(`Возможное действие: ${actionRu}`);

  if (lines.length === 0) return '';
  return lines.join('. ') + '.';
}

function substituteHref(template: string, ctx: EventAiContext): string {
  return template.replaceAll('{nmId}', String(ctx.nmId ?? ''));
}

interface Props {
  event: EventAiContext;
  /** Called when user closes the chat / clicks a deeplink */
  onClose?: () => void;
}

export function EventAiActionsPanel({ event, onClose }: Props) {
  const router = useRouter();
  const [chatOpen, setChatOpen] = useState(false);
  const [customText, setCustomText] = useState('');

  const {
    messages,
    streamStatus,
    streamingText,
    statusText,
    interrupt,
    error,
    sendMessage,
    resumeConversation,
    cancelStream,
  } = useAiChat();

  // Cancel any in-flight stream when the panel unmounts (modal closes)
  useEffect(() => {
    return () => {
      cancelStream();
    };
  }, [cancelStream]);

  const isStreaming = streamStatus === 'streaming' || streamStatus === 'connecting';

  const category = CATEGORY_ALIAS[event.category] ?? event.category;
  const actions = ACTIONS[category] ?? FALLBACK_ACTIONS;

  const humanContext = useMemo(() => buildHumanContext(event), [event]);

  const composePrompt = useCallback(
    (template: string): string => {
      const prompt = substitutePromptVars(template, event);
      // Append a one-line natural-language context, never raw JSON.
      return humanContext ? `${prompt}\n\n${humanContext}` : prompt;
    },
    [event, humanContext],
  );

  const runAi = useCallback(
    (promptTemplate: string) => {
      setChatOpen(true);
      sendMessage(composePrompt(promptTemplate));
    },
    [composePrompt, sendMessage],
  );

  const handleAction = useCallback(
    (a: ActionDef) => {
      if (a.kind === 'link' && a.href) {
        const href = substituteHref(a.href, event);
        router.push(href);
        onClose?.();
        return;
      }
      if (a.kind === 'ai' && a.prompt) {
        runAi(a.prompt);
      }
    },
    [event, router, runAi, onClose],
  );

  const handleCustomSend = useCallback(() => {
    const text = customText.trim();
    if (!text) return;
    setChatOpen(true);
    sendMessage(humanContext ? `${text}\n\n${humanContext}` : text);
    setCustomText('');
  }, [customText, humanContext, sendMessage]);

  const primary = actions.find((a) => a.primary);
  const secondary = actions.filter((a) => !a.primary);

  return (
    <div className="rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50 to-indigo-50 p-3">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-7 h-7 rounded-lg bg-violet-600 flex items-center justify-center text-white">
          <Bot className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-violet-900">AI-ассистент</div>
          <div className="text-[11px] text-violet-700">Выберите действие или задайте вопрос</div>
        </div>
      </div>

      {/* Primary + secondary actions */}
      <div className="flex flex-wrap gap-2">
        {primary && (
          <button
            type="button"
            onClick={() => handleAction(primary)}
            disabled={isStreaming}
            className={cn(
              'inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium',
              'bg-violet-600 text-white hover:bg-violet-700 active:bg-violet-800',
              'shadow-sm shadow-violet-500/20',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors',
            )}
          >
            <primary.icon className="w-4 h-4" />
            {primary.label}
          </button>
        )}
        {secondary.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={() => handleAction(a)}
            disabled={isStreaming}
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium',
              'bg-white border border-violet-200 text-violet-700',
              'hover:bg-violet-100 hover:border-violet-300',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors',
            )}
          >
            <a.icon className="w-3.5 h-3.5" />
            {a.label}
          </button>
        ))}
      </div>

      {/* Inline chat below — appears once any AI action fires or user types */}
      {chatOpen && (
        <div className="mt-3 rounded-lg border border-violet-200 bg-white overflow-hidden flex flex-col" style={{ maxHeight: '50vh' }}>
          <div className="flex items-center justify-between px-3 py-2 border-b border-violet-100 bg-violet-50">
            <span className="text-xs font-semibold text-violet-900">AI чат · по событию #{event.eventId}</span>
            <button
              type="button"
              onClick={() => { setChatOpen(false); cancelStream(); }}
              className="text-violet-500 hover:text-violet-700"
              title="Свернуть чат"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto max-h-[40vh]">
            <AiChatMessages
              messages={messages}
              streamingText={streamingText}
              statusText={statusText}
              streamStatus={streamStatus}
              interrupt={interrupt}
              error={error}
              onApprove={() => resumeConversation('approve')}
              onReject={() => resumeConversation('reject')}
            />
          </div>
        </div>
      )}

      {/* Custom prompt input — always visible at the bottom of the panel */}
      <div className="mt-3 flex items-end gap-2">
        <textarea
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleCustomSend();
            }
          }}
          placeholder="Или спросите своё про это событие…"
          disabled={isStreaming}
          rows={1}
          className={cn(
            'flex-1 resize-none rounded-lg border border-violet-200 bg-white px-3 py-2 text-sm',
            'placeholder:text-violet-400/70 text-gray-900',
            'focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400',
            'disabled:opacity-50',
          )}
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={cancelStream}
            className="p-2 rounded-lg bg-red-500 text-white hover:bg-red-600"
            title="Остановить"
          >
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleCustomSend}
            disabled={!customText.trim()}
            className="p-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Спросить AI"
          >
            <Send className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
