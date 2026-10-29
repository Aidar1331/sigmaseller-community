'use client';

/**
 * Состояние "нет сигналов" — показывается когда Лаборатория пробежала но
 * ничего значимого не нашла (или sparsity заблокировал все пары).
 */

interface Props {
  reason: 'sparse' | 'no_signal' | 'short_period';
  onGoToAbc?: () => void;
}

const COPY: Record<Props['reason'], { title: string; body: string; cta?: string }> = {
  sparse: {
    title: 'Мало активных дней по этому товару',
    body:
      'По этому артикулу слишком мало дней с заказами для анализа зависимостей. ' +
      'Попробуйте расширить период или выберите более продаваемый товар.',
    cta: 'Открыть ABC-анализ',
  },
  no_signal: {
    title: 'Заметных зависимостей не найдено',
    body:
      'За выбранный период метрики двигались независимо друг от друга — товар стабилен. ' +
      'Попробуйте более длинный период или другой артикул.',
  },
  short_period: {
    title: 'Период коротковат для надёжного анализа',
    body: 'Минимум 14 дней, рекомендованно 30–60. Расширьте диапазон дат сверху.',
  },
};

export function NoSignalEmpty({ reason, onGoToAbc }: Props) {
  const { title, body, cta } = COPY[reason];
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-6 text-center">
      <div className="text-sm font-semibold text-slate-700">{title}</div>
      <div className="mt-1 text-xs text-slate-600 leading-relaxed max-w-md mx-auto">{body}</div>
      {cta && onGoToAbc && (
        <button
          type="button"
          onClick={onGoToAbc}
          className="mt-3 inline-block text-xs font-medium text-indigo-700 hover:underline"
        >
          {cta}
        </button>
      )}
    </div>
  );
}
