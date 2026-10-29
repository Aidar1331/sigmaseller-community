/**
 * PeriodAdviceBanner — человеческий баннер "хватает ли данных за этот период".
 *
 * Внутренняя power-analysis (|r|≥0.3/0.5/0.7, α, β) полностью скрыта — показываем
 * лишь итоговый цветовой вердикт и мягкое пояснение.
 */

'use client';

interface PeriodAdvice {
  n: number;
  badge: 'green' | 'yellow' | 'red';
  message: string;
  recommendations: string[];
}

const STYLES: Record<'green' | 'yellow' | 'red', { wrap: string; icon: string }> = {
  green: { wrap: 'bg-emerald-50 border-emerald-200 text-emerald-900', icon: '✓' },
  yellow: { wrap: 'bg-amber-50 border-amber-200 text-amber-900', icon: 'ℹ️' },
  red: { wrap: 'bg-rose-50 border-rose-200 text-rose-900', icon: '⚠' },
};

function humanMessage(advice: PeriodAdvice): string {
  // Перефразируем сообщения backend-а в ещё более мягкий тон, без терминов вроде
  // "статистически значимые".
  if (advice.badge === 'green') {
    return `Данных достаточно для уверенного анализа (${advice.n} дней).`;
  }
  if (advice.badge === 'yellow') {
    return `Данных хватает для заметных зависимостей. Для тонких сигналов лучше расширить период.`;
  }
  return `Данных маловато — только очень сильные зависимости будут заметны.`;
}

interface Props {
  advice: PeriodAdvice | null;
  loading?: boolean;
}

export function PeriodAdviceBanner({ advice, loading }: Props) {
  if (loading) {
    return (
      <div className="text-xs text-slate-500 italic">Оцениваем период…</div>
    );
  }
  if (!advice) return null;

  const style = STYLES[advice.badge];
  const summary = humanMessage(advice);

  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${style.wrap}`}>
      <div className="flex items-start gap-2">
        <span className="text-sm leading-none mt-0.5">{style.icon}</span>
        <div className="flex-1">
          <div className="font-medium">{summary}</div>
          {advice.recommendations?.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-[11px] opacity-90 list-disc list-inside">
              {advice.recommendations.slice(0, 1).map((rec) => (
                <li key={rec}>{humanizeRec(rec)}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** Чистим остатки backend-специфичных выражений из рекомендаций. */
function humanizeRec(rec: string): string {
  return rec
    // Убираем ссылки на статистические пороги
    .replace(/\|r\|≥0\.\d/g, 'слабых связей')
    .replace(/STL-декомпозиция недельной сезонности.*/i, 'Для анализа недельной сезонности нужно минимум 28 дней.')
    .replace(/change-points?.*/i, 'Для обнаружения переломных моментов в истории товара нужно минимум 40 дней.')
    .replace(/Granger|lag-анализ/gi, 'оценки, как реклама влияет на заказы с задержкой,')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
