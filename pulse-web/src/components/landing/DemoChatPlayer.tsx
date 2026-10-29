'use client';

/**
 * Demo Chat Player — интерактивный демо-чат на лендинге.
 *
 * Идея: посетитель выбирает один из 10 сценариев → видит реалистичный
 * диалог «продавец ↔ Sigma AI» в формате:
 *   User-вопрос → AI-диагноз → User-уточнение → AI-предложение → [Применить]
 *   → ✓ → опц. AI-предложение → [Применить] → ✓
 *
 * Поддерживается MULTI-ACTION: action может быть на любом AI-step, и после
 * клика «Применить» плеер продолжает рендерить следующие steps (включая
 * вторую action-точку). Это даёт паттерн «AI сделал черновую работу →
 * спросил → опубликовал».
 *
 * Никаких реальных вызовов API — это marketing-материал. Цель: показать
 * глубину фич Pulse (feedback severity, F-13 приёмка, лаборатория и т.д.)
 * — а не общие «AI поможет».
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

type Role = 'user' | 'ai';
type ActionState = 'idle' | 'applied' | 'cancelled';

interface Step {
  role: Role;
  content: ReactNode;
  /** Если есть — реплика заканчивается action-card с кнопками */
  action?: {
    applyLabel?: string;
    cancelLabel?: string;
    appliedText: ReactNode;
    cancelledText?: ReactNode;
  };
  /** Задержка перед показом этой реплики, мс. По умолчанию 900. */
  delayMs?: number;
}

interface Scenario {
  key: string;
  /** Короткий вопрос-чип, отображается на табе */
  question: string;
  segment: string;
  steps: Step[];
}

// Демо-сценарии без реальных данных магазинов: товары обобщены
// (туфли женские, наушники TWS, кружка термо — синтетические примеры),
// конкретные бренды/конкуренты/складские раскладки — намеренно убраны.
const SCENARIOS: Scenario[] = [
  // ── 1. Отзывы (глубокий feedback_summary) ──────────────────────────────
  {
    key: 'reviews-deep',
    question: 'Проанализируй мои отзывы за 60 дней',
    segment: 'Отзывы и вопросы',
    steps: [
      {
        role: 'user',
        content: 'проанализируй мои отзывы за последние 60 дней',
      },
      {
        role: 'ai',
        delayMs: 1500,
        content: (
          <>
            <p style={{ margin: 0 }}>
              За 60 дней — <span className="dc-bold">50 отзывов</span> по товару{' '}
              <span className="dc-mono">туфли женские</span>, рейтинг{' '}
              <span className="dc-bold">4.5</span>{' '}
              <span style={{ color: '#b8553f' }}>↓ 0.2★</span> за месяц.
            </p>

            <div className="dc-section-title">⚠ Повторяющиеся проблемы</div>

            <div className="dc-severity dc-severity-medium">
              <div className="dc-severity-head">
                <span className="dc-severity-title">Характеристика A — несоответствие ожиданиям</span>
                <span className="dc-severity-meta">8 отзывов</span>
                <span className="dc-severity-badge dc-badge-medium">MEDIUM</span>
              </div>
              <p style={{ margin: '6px 0 0', fontSize: '11px', color: '#8a5828', fontStyle: 'italic' }}>
                Пользователи ожидают другого значения по ключевой характеристике из описания.
              </p>
            </div>

            <div className="dc-severity dc-severity-medium">
              <div className="dc-severity-head">
                <span className="dc-severity-title">Характеристика B — снижение со временем</span>
                <span className="dc-severity-meta">4 отзыва</span>
                <span className="dc-severity-badge dc-badge-medium">MEDIUM</span>
              </div>
            </div>

            <div className="dc-severity dc-severity-low">
              <div className="dc-severity-head">
                <span className="dc-severity-title">Замечания по упаковке</span>
                <span className="dc-severity-meta">2 отзыва</span>
                <span className="dc-severity-badge dc-badge-low">LOW</span>
              </div>
            </div>

            <div className="dc-section-title">👍 Что чаще всего хвалят</div>
            <div className="dc-chips">
              <span className="dc-chip-positive">Качество (9)</span>
              <span className="dc-chip-positive">Эргономика (7)</span>
              <span className="dc-chip-positive">Соответствие описанию (5)</span>
              <span className="dc-chip-positive">Скорость доставки (4)</span>
            </div>

            <div className="dc-trend">
              📈 <span className="dc-bold">Тренд:</span> рейтинг 4.7 → 4.5 за месяц.
              Основной драйвер — 8 отзывов про ключевую характеристику из описания
              и 4 жалобы по партии последней закупки.
            </div>
          </>
        ),
      },
      {
        role: 'user',
        content: 'что предлагаешь сделать?',
      },
      {
        role: 'ai',
        delayMs: 1200,
        content: (
          <>
            <p style={{ margin: 0 }}>Три действия одной пачкой:</p>
            <ol className="dc-list-num">
              <li>Обновлю описание карточки — приведу спорную характеристику в соответствие с реальностью.</li>
              <li>Подготовлю сообщение поставщику с цифрами и цитатами отзывов.</li>
              <li>На 4 негативных отзыва — черновики ответов в твоём тоне.</li>
            </ol>
            <p style={{ margin: '8px 0 0' }}>Запустить?</p>
          </>
        ),
        action: {
          appliedText: (
            <>
              ✓ Описание обновлено · Сообщение поставщику в <span className="dc-bold">документе</span>{' '}
              · 4 ответа на отзывы готовы.
            </>
          ),
          cancelledText: 'Окей, не запускаю. Список действий сохранил — вернёшься, когда захочешь.',
        },
      },
      {
        role: 'ai',
        delayMs: 1200,
        content: <>Отправить ответы на отзывы?</>,
        action: {
          applyLabel: 'Отправить',
          cancelLabel: 'Позже',
          appliedText: <>✓ 4 ответа опубликованы под отзывами.</>,
          cancelledText: 'Ок, оставлю черновики — отправишь сам или попроси позже.',
        },
      },
    ],
  },

  // ── 2. История цен ─────────────────────────────────────────────────────
  {
    key: 'price-changes',
    question: 'Какие были изменения моей цены за неделю?',
    segment: 'Ценообразование',
    steps: [
      {
        role: 'user',
        content: 'какие были изменения моей цены на сайте за неделю?',
      },
      {
        role: 'ai',
        delayMs: 1400,
        content: (
          <>
            <p style={{ margin: 0 }}>
              За неделю — <span className="dc-bold">11 изменений</span> по 7 артикулам.
            </p>
            <pre className="dc-pre">
{`Товар         Дата        Было    Стало   Источник
Туфли         Пн 09ч      1 500   1 425   Sigma (репрайс)
Туфли         Ср 14ч      1 425   1 350   Ты, ручной
Наушники      Вт 10ч      2 000   1 900   Sigma (под промо)
Наушники      Сб 18ч      1 900   2 000   Sigma (после промо)
Кружка        Чт 12ч        800     850   Ты, ручной
…ещё 6 строк`}
            </pre>
            <p style={{ margin: '8px 0 0' }}>
              4 автоматически по твоим правилам, 7 — ручные.
            </p>
          </>
        ),
      },
      {
        role: 'user',
        content: 'есть просадки по марже?',
      },
      {
        role: 'ai',
        delayMs: 1200,
        content: (
          <>
            <p style={{ margin: 0 }}>
              Да, одна.{' '}
              <span className="dc-mono">Туфли женские</span> в среду — твоё снижение до{' '}
              <span className="dc-bold">1 350 ₽</span> ниже твоего же min-порога 1 400 ₽,
              маржа просела до <span style={{ color: '#b8553f' }}>9%</span> (твоя норма 22–27%).
            </p>
            <p style={{ margin: '8px 0 0' }}>Откатить к моему репрайсу 1 425 ₽?</p>
          </>
        ),
        action: {
          appliedText: (
            <>
              ✓ Цена <span className="dc-mono">Туфли женские</span> = 1 425 ₽,
              маржа восстановлена до 22%.
            </>
          ),
          cancelledText:
            'Оставляю как есть. Помни — на 9% маржи небольшой рост закупки убьёт прибыль.',
        },
      },
    ],
  },

  // ── 3. Аудит карточки ──────────────────────────────────────────────────
  {
    key: 'audit',
    question: 'Сделай аудит карточки туфли женские',
    segment: 'Креативы и карточки',
    steps: [
      {
        role: 'user',
        content: 'сделай аудит карточки туфли женские — данные и каждое фото',
      },
      {
        role: 'ai',
        delayMs: 1700,
        content: (
          <>
            <p style={{ margin: 0 }}>
              Карточка{' '}
              <span className="dc-mono">Туфли женские</span>. Проверяю по чек-листу качества WB
              и нормам ниши:
            </p>

            <div className="dc-section-title">📊 Метрики карточки</div>
            <pre className="dc-pre">
{`Метрика            Ты         Норма ниши      Δ
Рейтинг            4.7        4.6              норма
Отзывы             50         200+             ⚠ мало
CTR в выдаче       1.2%       2.0%             −40%  🔴
Конверсия в заказ  3.5%       4.8%             −27%  🟠
Позиция (ключ)     #240       #1–#30           −210  🔴`}
            </pre>

            <div className="dc-section-title">📝 Название и текст</div>
            <div className="dc-severity dc-severity-high">
              <div className="dc-severity-head">
                <span className="dc-severity-title">Название — ключ не первым словом</span>
                <span className="dc-severity-badge dc-badge-high">HIGH</span>
              </div>
              <p style={{ margin: '6px 0 0', fontSize: '11px', color: '#8a5828' }}>
                Ключевой запрос стоит во 2-м слове. Алгоритм WB ранжирует выше карточки
                с ключом в начале названия — это поднимает релевантность по поиску.
              </p>
            </div>
            <div className="dc-severity dc-severity-high">
              <div className="dc-severity-head">
                <span className="dc-severity-title">Характеристики — заполнено 30%</span>
                <span className="dc-severity-badge dc-badge-high">HIGH</span>
              </div>
              <p style={{ margin: '6px 0 0', fontSize: '11px', color: '#8a5828' }}>
                Не закрыт ряд ключевых параметров категории.
                Алгоритм WB штрафует за &lt; 80% заполненности.
              </p>
            </div>
            <div className="dc-severity dc-severity-medium">
              <div className="dc-severity-head">
                <span className="dc-severity-title">Описание — короткое</span>
                <span className="dc-severity-badge dc-badge-medium">MEDIUM</span>
              </div>
              <p style={{ margin: '6px 0 0', fontSize: '11px', color: '#8a5828' }}>
                Норма по нише — 2200–2800 симв. Не раскрыты сценарии использования,
                комплектация, гарантия.
              </p>
            </div>

            <div className="dc-section-title">📸 Фото (5 шт)</div>
            <ul className="dc-list">
              <li>
                <span className="dc-bold">1️⃣ Главное</span> —{' '}
                <span style={{ color: '#4a7a2a' }}>✓</span> Чистый фон, читаемо в превью.{' '}
                <span style={{ color: '#b8553f' }}>✗</span> Нет инфографики о ключевой фиче —
                карточки с подложкой и цифрами на главном фото имеют +75% к CTR в нише.
              </li>
              <li>
                <span className="dc-bold">2️⃣ Деталь</span> —{' '}
                <span style={{ color: '#4a7a2a' }}>✓</span> композиция норм.{' '}
                Можно усилить продающей подписью.
              </li>
              <li>
                <span className="dc-bold">3️⃣ Лайфстайл</span> —{' '}
                <span style={{ color: '#b8553f' }}>✗</span> низкое качество,
                Перегенерация ИИ сделает чище за 2 минуты.
              </li>
              <li>
                <span className="dc-bold">4️⃣ Размер с линейкой</span> —{' '}
                <span style={{ color: '#b8553f' }}>✗</span> слот занят без продающего сообщения.
                Лучше заменить на «что в комплекте».
              </li>
              <li>
                <span className="dc-bold">5️⃣ Упаковка</span> —{' '}
                <span style={{ color: '#b8553f' }}>✗</span> нулевая продающая функция.
                Заменить на инфографику ключевых преимуществ.
              </li>
            </ul>

            <div className="dc-trend">
              💡 <span className="dc-bold">Главные рычаги:</span> переписать
              название с ключом первым + закрыть характеристики — это{' '}
              <span className="dc-bold">+120 позиций за 14 дней</span> без денежных вложений.
              Замена фото 4 и 5 на инфографику добавит ещё ~+30% к CTR.
            </div>
          </>
        ),
      },
      {
        role: 'user',
        content: 'с чего начнём?',
      },
      {
        role: 'ai',
        delayMs: 1200,
        content: (
          <>
            Самый дешёвый и быстрый рычаг — текст. Применю новое название
            и закрою недостающие характеристики через API кабинета WB.
            Прогноз: позиция 240 → ~110 за 14 дней. Применить?
          </>
        ),
        action: {
          appliedText: (
            <>
              ✓ Название и характеристики применены через API кабинета WB.
              <br />
              ✓ Контроль позиции по запросу — ежедневно, отчёт в понедельник.
            </>
          ),
          cancelledText: 'Окей, не применяю — черновик сохранил в карточке.',
        },
      },
      {
        role: 'ai',
        delayMs: 1300,
        content: (
          <>
            Сгенерировать <span className="dc-bold">2 новых фото</span> (4 и 5)
            с инфографикой ключевых преимуществ? Генерация ИИ ~2 минуты,
            на твоей проверке перед публикацией.
          </>
        ),
        action: {
          applyLabel: 'Сгенерировать',
          cancelLabel: 'Позже',
          appliedText: (
            <>
              ✓ 2 новых фото сгенерированы. Черновики ждут твоей проверки.
            </>
          ),
          cancelledText: 'Хорошо. Дашь сигнал — за 2 минуты приготовлю черновики.',
        },
      },
    ],
  },

  // ── 4. А/Б главного фото ───────────────────────────────────────────────
  {
    key: 'ab',
    question: 'Почему CTR упал на туфлях?',
    segment: 'А/Б-тесты',
    steps: [
      {
        role: 'user',
        content: 'товар плохо покупают, что не так?',
      },
      {
        role: 'ai',
        delayMs: 1400,
        content: (
          <>
            <p style={{ margin: 0 }}>
              Товар <span className="dc-mono">Туфли женские</span>. CTR{' '}
              <span className="dc-bold">1.2%</span> — ниже категории (медиана 2.0%).
              Главное фото на простом фоне, без подложки с цифрами и УТП.
              Карточки с CTR выше нормы используют фото с текстовой подложкой про ключевое преимущество.
            </p>
          </>
        ),
      },
      {
        role: 'user',
        content: 'что предлагаешь сделать?',
      },
      {
        role: 'ai',
        delayMs: 1100,
        content: (
          <>
            Запустить А/Б главного фото на 7 дней. Готов бриф для дизайнера и промпт для
            ИИ-генерации обложки. Запустить?
          </>
        ),
        action: {
          appliedText: <>✓ Фото с инфографикой сгенерировано, А/Б-тест #112 запущен на 7 дней.</>,
          cancelledText: 'Окей, не запускаю — бриф и промпт сохранил в документе.',
        },
      },
    ],
  },

  // ── 5. Воронка продаж ──────────────────────────────────────────────────
  {
    key: 'funnel',
    question: 'Сделай анализ воронки продаж по туфлям женским',
    segment: 'Аналитика воронки',
    steps: [
      {
        role: 'user',
        content: 'сделай анализ воронки продаж по туфлям женским',
      },
      {
        role: 'ai',
        delayMs: 1500,
        content: (
          <>
            <p style={{ margin: 0 }}>Воронка за 30 дней:</p>
            <pre className="dc-pre">
{`Этап                Кол-во      Конв.    Норма ниши
Показы              150 000     —        —
Переходы              1 800     1.2%     2.0%     ⚠ −40%
В корзину               180     10.0%    14.0%    ⚠ −29%
Заказали                 60     33.3%    38.0%    норма
Выкупили                 40     66.7%    72.0%    ⚠ −7%
──────────────────────────────────────────────────────────
Сквозная             0.027%     vs       0.080%`}
            </pre>
            <p style={{ margin: '8px 0 0' }}>Три узких места:</p>
            <ul className="dc-list">
              <li>🔴 <span className="dc-bold">CTR</span> — главное фото не цепляет</li>
              <li>🟡 <span className="dc-bold">Корзина</span> — описание короче нормы ниши в 5×, мало характеристик</li>
              <li>🟡 <span className="dc-bold">Выкуп</span> — несколько отзывов жалуются на детали</li>
            </ul>
            <p style={{ margin: '8px 0 0' }}>
              Если закрыть все три:{' '}
              <span className="dc-bold">60 → 150 заказов/мес</span>,{' '}
              выручка <span style={{ color: '#4a7a2a' }}>+150%</span>.
            </p>
          </>
        ),
      },
      {
        role: 'user',
        content: 'с чего начнём?',
      },
      {
        role: 'ai',
        delayMs: 1100,
        content: (
          <>
            Самое больное — CTR в выдаче. Запустить А/Б главного фото на 7 дней — эффект +50%
            к CTR, заметим за неделю. Применить?
          </>
        ),
        action: {
          appliedText: <>✓ А/Б-тест #113 главного фото запущен на 7 дней.</>,
          cancelledText: 'Окей. С CTR начать — самый быстрый рычаг, имей в виду.',
        },
      },
    ],
  },

  // ── 6. Остатки / out-of-stock ──────────────────────────────────────────
  {
    key: 'oos',
    question: 'Какие остатки у наушников TWS?',
    segment: 'Остатки и спрос',
    steps: [
      {
        role: 'user',
        content: 'какие остатки у наушников TWS? и насколько это критично',
      },
      {
        role: 'ai',
        delayMs: 1500,
        content: (
          <>
            <p style={{ margin: 0 }}>
              Товар{' '}
              <span className="dc-mono">Наушники TWS</span>, остатки по вариантам:
            </p>
            <pre className="dc-pre">
{`Вариант  Всего   Темп/день   Хватит до
  A       90      3,0         через ~30 дн.
  B       55      4,0         через ~14 дн.  ⚠
  L      105      3,5         через ~30 дн.
  XL      75      1,5         через ~50 дн.
  XXL     35      0,5         через ~70 дн.
─────────────────────────────────────────────
Итого           360 шт    12,5/день`}
            </pre>
            <p style={{ margin: '8px 0 0' }}>
              ⚠ Вариант <span className="dc-bold">B</span> кончится{' '}
              <span className="dc-bold">через 14 дней</span> — за 4 дня до плановой поставки.
              4 дня без B: <span style={{ color: '#b8553f' }}>−15 заказов</span>
              {' '}+ алгоритм WB снизит позицию.
            </p>
          </>
        ),
      },
      {
        role: 'user',
        content: 'что предлагаешь?',
      },
      {
        role: 'ai',
        delayMs: 1200,
        content: (
          <>
            FBS-поставка <span className="dc-bold">100 шт варианта B на ближайший склад</span> — приёмка
            завтра, дыра закрыта. Оформить?
          </>
        ),
        action: {
          appliedText: (
            <>
              ✓ Заявка FBS на 100 шт создана.
              Документы и ШК ушли в Telegram.
            </>
          ),
          cancelledText:
            'Понял. Следи за датой — если решишь раньше, я пересчитаю по актуальным остаткам.',
        },
      },
    ],
  },

];

const STYLES = `
.dc-section {
  background: #FBD394;
  color: #3D1A00;
  padding: 100px 24px;
  border-top: 1px solid rgba(61, 26, 0, 0.18);
  font-family: var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif;
}
.dc-wrap { max-width: 920px; margin: 0 auto; }
.dc-eyebrow {
  font-size: 10px;
  color: #8a5828;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  margin-bottom: 18px;
}
.dc-title {
  font-family: var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: clamp(38px, 6vw, 78px);
  line-height: 1.02;
  letter-spacing: -0.035em;
  margin: 0 0 18px;
  color: #3D1A00;
  font-weight: 800;
}
.dc-title em { color: #6366f1; font-style: normal; font-weight: 700; }
.dc-sub {
  font-size: 14px;
  line-height: 1.55;
  color: #8a5828;
  max-width: 560px;
  margin: 0 0 36px;
}
.dc-tabs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
  margin-bottom: 22px;
}
.dc-tab {
  border: 1px solid rgba(61, 26, 0, 0.18);
  background: rgba(255, 250, 230, 0.55);
  color: #3D1A00;
  padding: 12px 14px;
  text-align: left;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.3;
  cursor: pointer;
  transition: border 0.2s, background 0.2s, transform 0.2s;
}
.dc-tab:hover { border-color: #703800; background: rgba(255, 250, 230, 0.85); }
.dc-tab.dc-tab-active {
  border-color: #703800;
  background: rgba(112, 56, 0, 0.08);
}
.dc-tab-segment {
  font-size: 9px;
  color: #b58f5e;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  margin-bottom: 8px;
}
.dc-tab-question {
  font-size: 13px;
  color: #3D1A00;
  font-weight: 500;
  line-height: 1.35;
}
.dc-tab-question::before { content: '«'; color: #8a5828; }
.dc-tab-question::after  { content: '»'; color: #8a5828; }

.dc-window {
  border: 1px solid rgba(61, 26, 0, 0.18);
  background: rgba(255, 250, 230, 0.55);
  min-height: 320px;
}
.dc-window-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 18px;
  border-bottom: 1px solid rgba(61, 26, 0, 0.18);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  color: #8a5828;
}
.dc-live-dot { display: inline-flex; align-items: center; gap: 7px; font-size: 9px; }
.dc-live-dot::before {
  content: '';
  width: 6px; height: 6px; border-radius: 50%;
  background: #4a7a2a;
  box-shadow: 0 0 8px rgba(74, 122, 42, 0.55);
}
.dc-window-actions { display: flex; gap: 14px; }
.dc-window-actions button {
  background: none; border: none; color: #8a5828;
  font-family: inherit; font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.15em;
  cursor: pointer; padding: 0;
}
.dc-window-actions button:hover { color: #3D1A00; }

.dc-body {
  padding: 22px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 240px;
}

@keyframes dc-fade-up {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.dc-msg { animation: dc-fade-up 0.45s ease both; }

.dc-msg-row { display: flex; }
.dc-msg-row-user { justify-content: flex-end; }
.dc-msg-row-ai   { justify-content: flex-start; }

.dc-bubble {
  max-width: 86%;
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.55;
  font-family: var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif;
  word-break: normal;
  overflow-wrap: break-word;
}
.dc-bubble-user {
  background: #6366f1;
  color: #ffffff;
  border-radius: 0;
}
.dc-bubble-ai {
  background: rgba(255, 250, 230, 0.7);
  color: #3D1A00;
  border: 1px solid rgba(61, 26, 0, 0.18);
}
.dc-label {
  font-size: 9px;
  color: #b58f5e;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  margin-bottom: 4px;
}
.dc-label-user { text-align: right; }

.dc-typing { display: inline-flex; gap: 4px; padding: 6px 0; }
.dc-typing span {
  width: 6px; height: 6px; border-radius: 50%;
  background: #b58f5e;
  animation: dc-blink 1.2s infinite ease-in-out;
}
.dc-typing span:nth-child(2) { animation-delay: 0.2s; }
.dc-typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dc-blink {
  0%, 80%, 100% { opacity: 0.3; }
  40%           { opacity: 1; }
}

.dc-action-buttons {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.dc-action-buttons button {
  font-family: inherit;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  padding: 7px 16px;
  border: 1px solid #6366f1;
  background: #6366f1;
  color: #ffffff;
  cursor: pointer;
  transition: background 0.2s, color 0.2s;
  font-weight: 600;
}
.dc-action-buttons button.dc-btn-cancel { border-color: rgba(61, 26, 0, 0.25); color: #8a5828; background: transparent; font-weight: 500; }
.dc-action-buttons button:hover.dc-btn-apply { background: #4f46e5; }
.dc-action-buttons button:hover.dc-btn-cancel { color: #3D1A00; border-color: #703800; }

.dc-pre {
  background: rgba(255, 250, 230, 0.55);
  border: 1px solid rgba(61, 26, 0, 0.18);
  padding: 10px 12px;
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre;
  overflow-x: auto;
  color: #3D1A00;
  font-family: var(--font-geist-mono), ui-monospace, monospace;
}
.dc-mono {
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  color: #8a5828;
}
.dc-bold { color: #3D1A00; font-weight: 600; }
.dc-green { color: #4a7a2a; font-weight: 600; }
.dc-quote { color: #8a5828; font-style: italic; }
.dc-quote-block {
  margin: 6px 0;
  padding: 8px 12px;
  border-left: 2px solid #b58f5e;
  color: #8a5828;
  font-size: 12px;
  line-height: 1.55;
}
.dc-list { margin: 8px 0 0; padding: 0 0 0 18px; font-size: 12px; line-height: 1.55; }
.dc-list li { margin-bottom: 4px; color: #8a5828; }
.dc-list li .dc-bold { color: #3D1A00; }
.dc-list-num { margin: 6px 0 0; padding: 0 0 0 22px; font-size: 12px; line-height: 1.55; }
.dc-list-num li { margin-bottom: 4px; color: #3D1A00; }

.dc-section-title {
  margin-top: 14px;
  font-size: 10px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: #3D1A00;
  font-weight: 600;
}

/* severity-cards (как в реальной фиче feedback) */
.dc-severity {
  margin-top: 10px;
  padding: 10px 12px;
  border-left: 3px solid;
  background: rgba(255, 250, 230, 0.65);
}
.dc-severity-high   { border-color: #b8553f; }
.dc-severity-medium { border-color: #c47830; }
.dc-severity-low    { border-color: #c4a830; }
.dc-severity-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.dc-severity-title {
  font-size: 13px;
  color: #3D1A00;
  font-weight: 600;
  flex: 1;
  min-width: 160px;
}
.dc-severity-meta {
  font-size: 10px;
  color: #8a5828;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.dc-severity-badge {
  font-size: 9px;
  padding: 2px 7px;
  letter-spacing: 0.15em;
  font-weight: 600;
  border-radius: 2px;
}
.dc-badge-high   { background: #b8553f; color: #ffffff; }
.dc-badge-medium { background: #c47830; color: #ffffff; }
.dc-badge-low    { background: #c4a830; color: #3D1A00; }
.dc-quotes {
  margin: 6px 0 0;
  padding: 0 0 0 16px;
  font-size: 11px;
  line-height: 1.5;
  color: #8a5828;
  font-style: italic;
}
.dc-quotes li { margin-bottom: 2px; }

/* chips для похвал */
.dc-chips {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dc-chip-positive {
  display: inline-block;
  padding: 4px 10px;
  font-size: 11px;
  color: #4a7a2a;
  border: 1px solid rgba(74, 122, 42, 0.4);
  background: rgba(74, 122, 42, 0.1);
  border-radius: 999px;
  font-weight: 500;
}

/* trend block */
.dc-trend {
  margin-top: 12px;
  padding: 10px 12px;
  background: rgba(196, 168, 48, 0.15);
  border: 1px solid rgba(196, 168, 48, 0.4);
  font-size: 12px;
  color: #3D1A00;
  line-height: 1.5;
}

.dc-footnote {
  margin-top: 18px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.dc-footnote-text {
  font-size: 11px;
  color: #8a5828;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.dc-footnote-cta {
  display: inline-block;
  padding: 12px 22px;
  background: #6366f1;
  color: #ffffff;
  text-decoration: none;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  font-weight: 600;
  box-shadow: 0 2px 0 #4f46e5;
}

@media (max-width: 900px) {
  .dc-section { padding: 70px 18px; }
  .dc-tabs { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
  .dc-bubble { max-width: 92%; font-size: 13px; }
  .dc-pre { font-size: 10px; }
  .dc-window-actions { gap: 10px; }
  .dc-footnote { flex-direction: column; align-items: stretch; gap: 12px; }
  .dc-footnote-cta { text-align: center; }
}
`;

export function DemoChatPlayer() {
  const [activeKey, setActiveKey] = useState<string>(SCENARIOS[0].key);
  // Состояние каждой action-точки сценария по индексу step'а.
  const [actionStates, setActionStates] = useState<Record<number, ActionState>>({});
  const [visibleSteps, setVisibleSteps] = useState(0);
  const [typing, setTyping] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const scenario = SCENARIOS.find((s) => s.key === activeKey) ?? SCENARIOS[0];

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };

  const restart = (key: string) => {
    clearTimers();
    setActiveKey(key);
    setVisibleSteps(0);
    setTyping(false);
    setActionStates({});
  };

  // Найти индекс следующего «idle» action-step, до которого можно проиграть.
  // Если такого нет — рисуем до конца сценария.
  const findNextStop = (states: Record<number, ActionState>): number => {
    for (let i = 0; i < scenario.steps.length; i++) {
      const s = scenario.steps[i];
      if (s.action && (states[i] ?? 'idle') === 'idle') {
        return i + 1; // включая сам action-step
      }
    }
    return scenario.steps.length;
  };

  // Прогрессивно показываем реплики по таймерам — от текущего visibleSteps
  // до nextStop (первая idle-action или конец).
  useEffect(() => {
    clearTimers();
    const steps = scenario.steps;
    const nextStop = findNextStop(actionStates);
    if (visibleSteps >= nextStop) return;

    let accumulated = 0;
    for (let i = visibleSteps; i < nextStop; i++) {
      const step = steps[i];
      const delay = step.delayMs ?? (step.role === 'ai' ? 1200 : 700);
      accumulated += delay;

      if (step.role === 'ai') {
        const showTypingAt = accumulated - delay + 200;
        const t1 = setTimeout(() => setTyping(true), showTypingAt);
        timersRef.current.push(t1);
      }
      const targetIdx = i + 1;
      const t2 = setTimeout(() => {
        setTyping(false);
        setVisibleSteps(targetIdx);
      }, accumulated);
      timersRef.current.push(t2);
    }

    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, actionStates, scenario.steps.length]);

  // Автоскролл вниз когда появляются новые реплики
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [visibleSteps, typing, actionStates]);

  const handleApply = (idx: number) => {
    setActionStates((prev) => ({ ...prev, [idx]: 'applied' }));
  };
  const handleCancel = (idx: number) => {
    setActionStates((prev) => ({ ...prev, [idx]: 'cancelled' }));
  };

  return (
    <section className="dc-section" id="demo">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div className="dc-wrap">
        <div className="dc-eyebrow">№ 02 · Попробуй прямо здесь</div>
        <h2 className="dc-title">
          Спроси Sigma — <em>как реального помощника.</em>
        </h2>
        <p className="dc-sub">
          Это не аналитика и не дашборд. Sigma готовит конкретное действие в твоём
          кабинете WB — с цифрами, артикулом и кнопкой «Применить». Ниже — 6 живых
          сценариев. Кликни любой вопрос — увидишь как Sigma отвечает.
        </p>

        {/* Табы со сценариями (теперь user-вопросы) */}
        <div className="dc-tabs">
          {SCENARIOS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`dc-tab ${s.key === activeKey ? 'dc-tab-active' : ''}`}
              onClick={() => restart(s.key)}
            >
              <div className="dc-tab-segment">{s.segment}</div>
              <div className="dc-tab-question">{s.question}</div>
            </button>
          ))}
        </div>

        {/* Окно чата */}
        <div className="dc-window">
          <div className="dc-window-header">
            <span>SIGMA · ДЕМО</span>
            <div className="dc-window-actions">
              <span className="dc-live-dot">ИИ ГОТОВ</span>
              <button type="button" onClick={() => restart(activeKey)}>Заново</button>
            </div>
          </div>

          <div className="dc-body" ref={bodyRef}>
            {scenario.steps.slice(0, visibleSteps).map((step, i) => {
              const state = actionStates[i] ?? 'idle';
              const isLastVisible = i === visibleSteps - 1;
              const showButtons = step.action && state === 'idle' && isLastVisible;

              return (
                <div key={`${activeKey}-${i}`}>
                  <div className={`dc-msg dc-msg-row dc-msg-row-${step.role}`}>
                    <div style={{ maxWidth: '86%' }}>
                      <div className={`dc-label ${step.role === 'user' ? 'dc-label-user' : ''}`}>
                        {step.role === 'user' ? 'Ты' : 'Sigma'}
                      </div>
                      <div className={`dc-bubble dc-bubble-${step.role}`}>
                        {step.content}
                      </div>
                      {showButtons && step.action && (
                        <div className="dc-action-buttons">
                          <button
                            type="button"
                            className="dc-btn-apply"
                            onClick={() => handleApply(i)}
                          >
                            {step.action.applyLabel ?? 'Применить'}
                          </button>
                          <button
                            type="button"
                            className="dc-btn-cancel"
                            onClick={() => handleCancel(i)}
                          >
                            {step.action.cancelLabel ?? 'Отменить'}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Результат действия — applied / cancelled — как новая AI-реплика */}
                  {step.action && state !== 'idle' && (
                    <div className="dc-msg dc-msg-row dc-msg-row-ai" style={{ marginTop: '14px' }}>
                      <div style={{ maxWidth: '86%' }}>
                        <div className="dc-label">Sigma</div>
                        <div className="dc-bubble dc-bubble-ai">
                          {state === 'applied'
                            ? step.action.appliedText
                            : (step.action.cancelledText ?? 'Понял, не делаю.')}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Индикатор печати */}
            {typing && (
              <div className="dc-msg-row dc-msg-row-ai">
                <div>
                  <div className="dc-label">Sigma</div>
                  <div className="dc-bubble dc-bubble-ai">
                    <span className="dc-typing">
                      <span /><span /><span />
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footnote + CTA */}
        <div className="dc-footnote">
          <div className="dc-footnote-text">
            Хочешь так в своём кабинете WB? — подключи магазин за 3 минуты
          </div>
          <a href="/auth/register" className="dc-footnote-cta">
            Подключить магазин →
          </a>
        </div>
      </div>
    </section>
  );
}
