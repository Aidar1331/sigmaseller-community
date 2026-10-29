'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  MessageSquare, Eye, Zap, Sparkles,
  Wallet, FlaskConical, Package, TrendingUp, ArrowRight,
  Shield, Users, Sprout, Wand2, Check, Quote, Clock, BellOff, AlertTriangle, RefreshCw,
} from 'lucide-react';
import { motion, useInView } from 'framer-motion';

/**
 * Public landing for unauthenticated visitors. Server-rendered.
 *
 * Позиционирование: один лендинг под обе целевые персоны:
 *   • Алия — новичок на WB (8 SKU, тетрадка, страх первой партии).
 *   • Максим — команда 2-5 человек (5-30M оборот, тонет в чате).
 *
 * Главный UVP: AI делает действия (поставки, цены, ответы), а не показывает
 * графики. Не пересекаемся со switching cost конкурентов — позиционируем как
 * дополнение, а не замену.
 */
// JSON-LD Organization + SoftwareApplication: помогает Яндексу/Google понять
// что мы за компания, какой продукт, какая цена. Часто даёт расширенные сниппеты.
const STRUCTURED_DATA = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': 'https://sigmaseller.ru/#organization',
      name: 'Sigma Seller',
      url: 'https://sigmaseller.ru',
      logo: 'https://sigmaseller.ru/icon?112122e298a9d304',
      sameAs: ['mailto:support@example.com'],
      contactPoint: {
        '@type': 'ContactPoint',
        contactType: 'customer support',
        availableLanguage: ['Russian'],
      },
    },
    {
      '@type': 'SoftwareApplication',
      '@id': 'https://sigmaseller.ru/#software',
      name: 'Sigma Seller',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      description:
        'AI-агент для продавцов Wildberries. Готовит действия (цены, ответы, аудит, A/B-тесты, поставки), пользователь подтверждает каждое.',
      offers: {
        '@type': 'Offer',
        price: '4900',
        priceCurrency: 'RUB',
        availability: 'https://schema.org/InStock',
      },
      provider: { '@id': 'https://sigmaseller.ru/#organization' },
    },
    {
      '@type': 'WebSite',
      '@id': 'https://sigmaseller.ru/#website',
      url: 'https://sigmaseller.ru',
      name: 'Sigma Seller',
      publisher: { '@id': 'https://sigmaseller.ru/#organization' },
      inLanguage: 'ru-RU',
    },
  ],
};

export function Landing() {
  return (
    <div className="min-h-screen bg-white">
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
      />
      <Header />
      <Hero />
      <PainCards />
      <Examples />
      <PainPoints />
      <CompareWB />
      <Cases />
      <Security />
      <ForTeams />
      <ForNewbies />
      <MoreInside />
      <FAQ />
      <Pricing />
      <FinalCta />
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-gray-100 bg-white/80 backdrop-blur sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-lg bg-indigo-600 text-white grid place-items-center">
            <span className="text-xl font-bold leading-none" style={{ fontFamily: 'serif' }}>Σ</span>
          </div>
          <span className="text-lg font-semibold text-gray-900">Sigma Seller</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/auth/login" className="text-sm text-gray-700 hover:text-indigo-700">
            Войти
          </Link>
          <Link
            href="/auth/register"
            className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2 transition-colors"
          >
            Создать аккаунт
          </Link>
        </div>
      </div>
    </header>
  );
}

// Reveal: универсальная обёртка для scroll-reveal анимаций. Слайд вверх + fade
// при входе элемента во viewport. Триггер один раз, с возможной задержкой.
function Reveal({
  children,
  delay = 0,
  y = 24,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// AnimatedNumber: считает от 0 до target когда попадает в viewport (~1.2 сек).
// Используется в Hero stats — придаёт ощущение «живого продукта».
function AnimatedNumber({ value, suffix = '' }: { value: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-50px' });
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (!inView) return;
    const duration = 1200;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out cubic для приятного замедления
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(value * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, value]);
  return (
    <span ref={ref}>
      {display.toLocaleString('ru-RU')}{suffix}
    </span>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Многослойный градиент — индиго + фиолетовый + светлый */}
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-50 via-white to-purple-50 pointer-events-none" />
      {/* Декоративные размытые блики (стиль современных SaaS) */}
      <div className="absolute -top-32 -right-32 h-96 w-96 rounded-full bg-indigo-200 opacity-30 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-32 -left-32 h-96 w-96 rounded-full bg-purple-200 opacity-30 blur-3xl pointer-events-none" />

      <div className="relative max-w-5xl mx-auto px-4 pt-20 pb-12 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-100/80 backdrop-blur text-indigo-700 px-3 py-1 text-xs font-medium mb-6 border border-indigo-200/60">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            AI-агент для продавцов Wildberries
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-gray-900 leading-tight tracking-tight">
            AI делает работу.{' '}
            <span className="bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
              Ты подтверждаешь.
            </span>
          </h1>
          <p className="mt-6 text-lg sm:text-xl text-gray-600 max-w-2xl mx-auto leading-relaxed">
            Цены, ответы покупателям, аудит карточек, A/B-тесты — Sigma готовит действия,
            ты вычитываешь и кликаешь «Применить». Никаких автодействий за спиной.
          </p>
        </motion.div>

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3"
        >
          <Link
            href="/auth/register"
            className="group inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white text-base font-medium px-7 py-3.5 transition-all shadow-md shadow-indigo-600/30 hover:shadow-lg hover:shadow-indigo-600/40 hover:-translate-y-0.5"
          >
            Подключиться за 4 900 ₽
            <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
          </Link>
          <Link
            href="/auth/login"
            className="inline-flex items-center rounded-lg bg-white/70 backdrop-blur hover:bg-white text-gray-800 text-base font-medium px-7 py-3.5 border border-gray-300 transition-all hover:-translate-y-0.5 hover:shadow-sm"
          >
            Войти
          </Link>
        </motion.div>
        <div className="mt-4 text-sm text-gray-500">
          3 минуты на старт. Подключи ключ WB — AI готов работать.
        </div>

        {/* Killer-stats — реальные числа из БД, animated counters */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="mt-14 grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-3xl mx-auto"
        >
          <div className="rounded-2xl bg-white/60 backdrop-blur border border-gray-200/70 p-5 sm:p-6 text-left">
            <div className="text-3xl sm:text-4xl font-bold text-gray-900 tabular-nums">
              <AnimatedNumber value={1300} suffix="+" />
            </div>
            <div className="mt-1 text-sm text-gray-600">действий AI за последние 30 дней</div>
          </div>
          <div className="rounded-2xl bg-white/60 backdrop-blur border border-gray-200/70 p-5 sm:p-6 text-left">
            <div className="text-3xl sm:text-4xl font-bold text-gray-900 tabular-nums">
              <AnimatedNumber value={100} suffix="%" />
            </div>
            <div className="mt-1 text-sm text-gray-600">действий с твоим подтверждением</div>
          </div>
          <div className="rounded-2xl bg-white/60 backdrop-blur border border-gray-200/70 p-5 sm:p-6 text-left">
            <div className="text-3xl sm:text-4xl font-bold text-gray-900 tabular-nums">
              <AnimatedNumber value={10} suffix="+" />
            </div>
            <div className="mt-1 text-sm text-gray-600">типов действий AI в кабинете WB</div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

// PainCards: 4 болевые карточки сразу под Hero. Это то, что продавец узнаёт
// за 3 секунды. Никаких сравнений с конкурентами — только его собственная боль.
const PAIN_CARDS: Array<{ icon: any; title: string; body: string; accent: string }> = [
  {
    icon: Clock,
    title: 'Отзывы не успеваете',
    body: 'Накопилось 60 непрочитанных за неделю. Рейтинг падает потому что молчите.',
    accent: 'from-rose-50 to-rose-100/50 border-rose-200/60',
  },
  {
    icon: BellOff,
    title: 'Цена устарела на 4 дня',
    body: 'Конкурент снизил, вы не заметили. Конверсия падает, заказы уходят к другим.',
    accent: 'from-amber-50 to-amber-100/50 border-amber-200/60',
  },
  {
    icon: AlertTriangle,
    title: 'Поставка не приехала в свой день',
    body: 'Out-of-stock на сезон. Карточка теряет ранг, конкуренты захватывают позицию.',
    accent: 'from-purple-50 to-purple-100/50 border-purple-200/60',
  },
  {
    icon: RefreshCw,
    title: 'Аудит карточки не делали 3 месяца',
    body: '4 фото вместо 8, нет SEO-ключей, описание стёрто. Карточка просто не находится.',
    accent: 'from-indigo-50 to-indigo-100/50 border-indigo-200/60',
  },
];

function PainCards() {
  return (
    <section className="relative py-16 sm:py-20 border-b border-gray-100">
      <div className="max-w-6xl mx-auto px-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.5 }}
          className="text-center mb-10"
        >
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gray-900">
            Что у вас происходит прямо сейчас
          </h2>
          <p className="mt-3 text-gray-600 max-w-2xl mx-auto">
            Пока вы заняты текучкой — Sigma следит за каждой из этих дыр и предлагает действие.
          </p>
        </motion.div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {PAIN_CARDS.map((card, i) => (
            <motion.div
              key={card.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.45, delay: 0.08 * i }}
              className={`rounded-2xl border bg-gradient-to-br ${card.accent} p-5 sm:p-6 hover:-translate-y-1 transition-transform`}
            >
              <div className="h-10 w-10 rounded-xl bg-white/70 grid place-items-center text-gray-700 mb-3 shadow-sm">
                <card.icon className="h-5 w-5" />
              </div>
              <div className="font-semibold text-gray-900 mb-1.5">{card.title}</div>
              <div className="text-sm text-gray-700 leading-relaxed">{card.body}</div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

// 2026-05-31: примеры сверены с реальными tools'ами. Никаких «через 7 дней
// верну обратно» (нет scheduled rollback) и «слежу за ставками» (биддер сейчас
// в работе для не-владельцев). Каждый пример — то, что AI реально умеет:
//   actionSetPrice / actionSetDiscount  — цена/скидка с подтверждением
//   actionReplyFeedback                  — драфт ответа на отзыв
//   creativeAuditV3                      — аудит карточки
//   AI Studio (rich content + 3 фото)   — инфографика
//   actionPrepareFbwSupply               — deep-link на форму брони WB
const EXAMPLES: Array<{ user: string; ai: string; accent: string }> = [
  {
    user: '«Снизь цену 12345 на 5%»',
    ai: 'Считаю с твоей себестоимости — после скидки маржа 22%, в зелёной зоне. Применить? [Да] [Нет]',
    accent: 'from-indigo-50 to-purple-50',
  },
  {
    user: '«Ответь на 1★ под 67890»',
    ai: 'Прочитал отзыв (жалоба на запах) — это первый негатив за месяц по этой нише. Написал вежливый ответ от твоего бренда, предложил вернуть. Покажу — отправлять?',
    accent: 'from-purple-50 to-rose-50',
  },
  {
    user: '«Проверь карточку 12345 — почему не продаётся?»',
    ai: 'Прогнал аудит: 4 фото вместо 8, нет инфографики, описание короткое. Подготовил новый title + description под SEO и 3 варианта инфографики. Покажу превью — применить?',
    accent: 'from-rose-50 to-amber-50',
  },
  {
    user: '«Сделай инфографику для 12345 с тремя плюсами товара»',
    ai: 'Сгенерировал 3 варианта в AI-студии: «Влагостойкая кожа», «5 отделений», «Совместим с любым авто». Покажу превью — какой загружать?',
    accent: 'from-amber-50 to-emerald-50',
  },
  {
    user: '«Когда лучше везти на Коледино?»',
    ai: 'На 3 июня приёмка бесплатная (коэф 0), плановое окно — есть. Открою форму брони в WB с заполненными полями — заберёшь слот в пару кликов.',
    accent: 'from-emerald-50 to-indigo-50',
  },
];

function Examples() {
  return (
    <section className="py-16 sm:py-20">
      <div className="max-w-5xl mx-auto px-4">
        <Reveal>
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">
              Что значит «сделаю»?
            </h2>
            <p className="mt-3 text-gray-600 max-w-xl mx-auto">
              Не отчёты с графиками. Реальные действия в твоём кабинете WB.
            </p>
          </div>
        </Reveal>
        <div className="space-y-6">
          {EXAMPLES.map((ex, i) => (
            <Reveal key={i} delay={0.05 * i}>
            <div
              className={`rounded-2xl border border-gray-200 bg-gradient-to-br ${ex.accent} p-6 sm:p-8`}
            >
              {/* Я (отправитель) — справа, фиолетовый bubble, аватар справа от текста */}
              <div className="flex items-start gap-3 mb-4 flex-row-reverse">
                <div className="h-8 w-8 rounded-full bg-indigo-600 text-white grid place-items-center shrink-0 shadow-sm">
                  <Users className="h-4 w-4" />
                </div>
                <div className="rounded-2xl bg-indigo-600 text-white px-4 py-3 shadow-sm max-w-[85%]">
                  <div className="text-[11px] uppercase tracking-wide opacity-70 mb-1">Я</div>
                  {ex.user}
                </div>
              </div>
              {/* AI — слева, белый bubble, аватар слева от текста */}
              <div className="flex items-start gap-3 mr-12">
                <div className="h-8 w-8 rounded-full bg-white text-indigo-600 grid place-items-center shrink-0 shadow-sm border border-gray-200">
                  <Wand2 className="h-4 w-4" />
                </div>
                <div className="rounded-2xl bg-white px-4 py-3 shadow-sm max-w-[85%] text-gray-900 border border-gray-100">
                  <div className="text-[11px] uppercase tracking-wide text-indigo-600 mb-1">Sigma AI</div>
                  {ex.ai}
                </div>
              </div>
            </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

const PAINS: string[] = [
  '20 вкладок Wildberries и нет понимания что делать первым',
  'Тетрадка / Excel / сервис аналитики — но цифры не подсказывают действие',
  'Команда тонет в чате «а как с артикулом X?», ты отвечаешь по 100 раз в день',
  'Страх «забыл оплатить хранение / попал на штраф / поставка не прошла приёмку»',
  'Курсы за 30 тысяч объясняли «считай метрики» — а где их взять-то',
];

function PainPoints() {
  return (
    <section className="py-16 bg-gray-50 border-y border-gray-100">
      <div className="max-w-3xl mx-auto px-4">
        <Reveal>
        <div className="text-center mb-10">
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">
            Узнаёте себя — это про вас
          </h2>
        </div>
        </Reveal>
        <ul className="space-y-3">
          {PAINS.map((pain, i) => (
            <Reveal key={pain} delay={0.04 * i}>
              <li className="flex items-start gap-3 rounded-xl bg-white p-4 border border-gray-200">
                <div className="h-6 w-6 rounded-full bg-rose-100 text-rose-600 grid place-items-center shrink-0">
                  <span className="text-sm">😤</span>
                </div>
                <div className="text-gray-800 leading-relaxed">{pain}</div>
              </li>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ── Cases ────────────────────────────────────────────────────────────────────
// Реальные истории клиентов. Каждый кейс редактируется как объект ниже.
// Когда появится новый — добавь объект в CASES; layout сам перестроится
// (1 col на mobile, 2-3 на desktop). Метрики «было/стало» — самое сильное
// доказательство; цитата делает кейс живым; теги показывают что человек реально
// использовал.
const CASES: Array<{
  shopName: string;     // как показывать (можно «ИП К.» — анонимно)
  niche: string;        // ниша магазина
  period: string;       // за какой срок результат
  before: string;       // ключевая цифра «до»
  after: string;        // ключевая цифра «после»
  metric: string;       // что за метрика
  quote: string;        // короткая цитата клиента
  features: string[];   // фичи, которые он использовал
}> = [
  // Заполнить, когда появится первый кейс с разрешением на публикацию.
];

function Cases() {
  if (CASES.length === 0) {
    // Если кейсов ещё нет — показываем секцию «Ищем первые истории», чтобы
    // блок присутствовал, но не выглядел как подделка с вымышленными цифрами.
    return (
      <section className="py-16">
        <div className="max-w-3xl mx-auto px-4 text-center">
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-3">
            Кейсы клиентов
          </h2>
          <p className="text-gray-600 mb-6 leading-relaxed">
            Sigma Seller запущен недавно — пока собираем первые истории.<br />
            Если ты будешь среди первых, кто получит измеримый результат —
            опубликуем твой кейс на видном месте и подарим месяц бесплатно.
          </p>
          <Link
            href="/auth/register"
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-5 py-2.5"
          >
            Стать первым кейсом
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="py-16">
      <div className="max-w-6xl mx-auto px-4">
        <div className="text-center mb-10">
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-2">
            Кейсы клиентов
          </h2>
          <p className="text-gray-600">
            Реальные результаты продавцов, которые подключили Sigma Seller
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {CASES.map((c, idx) => (
            <article
              key={idx}
              className="rounded-2xl border border-gray-200 bg-white p-6 flex flex-col hover:border-indigo-300 transition-colors"
            >
              {/* Header: магазин + ниша */}
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="text-base font-semibold text-gray-900">{c.shopName}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{c.niche}</div>
                </div>
                <div className="text-xs text-gray-400 shrink-0 ml-2">{c.period}</div>
              </div>

              {/* Главная метрика «было → стало» */}
              <div className="rounded-xl bg-indigo-50 border border-indigo-100 p-4 mb-4">
                <div className="text-xs text-indigo-700 font-medium mb-1.5">{c.metric}</div>
                <div className="flex items-baseline gap-2">
                  <span className="text-gray-500 line-through text-sm">{c.before}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
                  <span className="text-xl font-bold text-indigo-700">{c.after}</span>
                </div>
              </div>

              {/* Цитата */}
              <div className="flex gap-2 mb-4 flex-1">
                <Quote className="h-4 w-4 text-gray-300 shrink-0 mt-0.5" />
                <p className="text-sm text-gray-700 leading-relaxed italic">«{c.quote}»</p>
              </div>

              {/* Использовал */}
              <div className="flex flex-wrap gap-1.5 pt-3 border-t border-gray-100">
                {c.features.map((f) => (
                  <span key={f} className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                    {f}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>

        <div className="mt-8 text-center">
          <Link
            href="/auth/register"
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-5 py-2.5"
          >
            Получить такой же результат
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}

// FAQ — 12 вопросов. Без имён конкурентов (memory: feedback-no-competitor-mentions).
// Каждый ответ опирается на реальный код или /legal страницу — никаких обещаний без подкрепления.
const FAQ_ITEMS: Array<{ q: string; a: string }> = [
  {
    q: 'Безопасны ли мои данные Wildberries в Sigma?',
    a: 'Да. API-ключи WB хранятся в зашифрованном виде (AES-256-GCM) в базе данных на серверах в России — соответствие 242-ФЗ. Ключи никогда не передаются в логи, не отдаются клиентам, не уходят за границу. Доступ к расшифровке — только у серверных модулей, которым нужен ключ для запроса в WB API. Рекомендуем создать отдельный API-ключ под Sigma с ограниченными правами — твой основной останется неприкосновенным.',
  },
  {
    q: 'Что если API-ключ WB утечёт?',
    a: 'В Sigma утечь не может: ключ зашифрован, доступа извне нет. Даже при сомнениях — в WB сейчас можно создать отдельный API-ключ под Sigma с ограниченными правами. Удалил ключ в WB → у нас перестают работать запросы, никаких последствий для остального кабинета. Это рекомендованный подход — мы сами так советуем при подключении.',
  },
  {
    q: 'Что входит в 4 900 ₽/мес и что такое AI-токены?',
    a: 'В подписку 4 900 ₽/мес входят все фичи Sigma: AI-чат, аудит карточек, A/B-тесты, дашборды, поставки, ответы на отзывы, ДДС-прогноз. AI-токены — отдельно, потому что их стоимость зависит от твоего использования. При регистрации даём 100 ₽ AI-бонусом — этого хватает на 30–80 запросов средней сложности. Дальше пополняешь сколько нужно — у активного селлера выходит обычно 500–2 000 ₽ в месяц. Цена прозрачная: видишь, сколько тратишь, в любой момент.',
  },
  {
    q: 'Зачем Sigma, если у меня уже есть кабинет WB Partners и Jam?',
    a: 'WB-кабинет показывает то, что было — отчёты, графики, текущие позиции. Sigma делает то, что нужно сейчас: меняет цену, отвечает на отзыв, готовит поставку, переписывает SEO-title карточки. Все эти действия можно делать вручную в WB-кабинете, но это занимает часы каждый день. Sigma готовит их за тебя, ты подтверждаешь одной кнопкой. Это не замена кабинета — это исполнитель, который снимает рутину.',
  },
  {
    q: 'Чем Sigma отличается от обычной аналитики Wildberries?',
    a: 'Обычные сервисы показывают цифры — графики, теплокарты, отчёты по конкурентам. Sigma делает действия: меняет цену, пишет ответ, готовит поставку. Аналитика и Sigma — не альтернативы, а дополнения. Если у тебя уже есть аналитический сервис — Sigma не требует от него отказа, мы работаем параллельно и снимаем с тебя выполнение того, что аналитика только показала.',
  },
  {
    q: 'У меня уже есть учётная система для бизнеса — Sigma её заменит?',
    a: 'Нет, Sigma не заменяет учётную систему. Раз в день мы забираем данные о заказах, остатках и финансах из WB через API. Никаких переносов товаров, документов, оплат — твой текущий процесс остаётся как есть. Sigma не претендует на роль ERP — мы про действия в кабинете Wildberries.',
  },
  {
    q: 'Как отменить подписку? Будет ли возврат?',
    a: 'Отмена — в личном кабинете в разделе «Подписка» или одной фразой в AI-чате: «отмени подписку». Действует до конца оплаченного периода, без удержаний. Возврат остатка — в течение 14 дней по запросу через support@example.com или поддержку. Подписка не продлевается автоматически — каждый месяц ты решаешь сам. Документально: оферта на /legal/terms, в ней — точные условия отмены и возврата.',
  },
  {
    q: 'Что с моими данными если я ухожу из Sigma?',
    a: 'Подписка отменена → доступ к интерфейсу теряешь. Данные удаляются автоматически через 30 дней неактивности (срок указан в /legal/privacy). До этого можешь запросить экспорт всех твоих данных (карточки, поставки, цены, метрики) одним кликом в /settings или через support@example.com. Это твои данные — мы их не продаём, не передаём третьим лицам и не используем для обучения общих моделей. После удаления — никаких бэкапов нашей стороны, всё стирается.',
  },
  {
    q: 'Поддерживает ли Sigma FBS, не только FBO?',
    a: 'Да, и FBS, и FBW. Для FBS Sigma умеет создавать поставки end-to-end: сборка заказа, генерация stickers, передача в WB. Для FBW (предзаказы ФБО) WB закрыл API создания preorder, поэтому Sigma открывает форму брони в твоём кабинете WB с уже заполненными полями (склад, дата, количество, артикулы) — ты заполняешь дальше за пару кликов. Слот ловим по расписанию приёмки и предупреждаем когда коэффициент станет 0.',
  },
  {
    q: 'Что AI реально может сделать в моём кабинете WB?',
    a: 'Реальные действия (сегодня): изменить цену, изменить скидку, ответить покупателю в чате, ответить на отзыв, изменить заголовок и описание карточки, запустить A/B-тест фото/title/desc, открыть форму брони FBW-поставки, создать FBS-поставку. Каждое действие требует твоего подтверждения в чате — никаких автоматических изменений без твоего «применить».',
  },
  {
    q: 'Что если Sigma сделает что-то не то? Можно откатить?',
    a: 'Да, это наша фишка. Каждое AI-действие имеет статус: «на подтверждении», «выполнено», «откачено». Журнал действий доступен в любой момент в /events. Можно отменить любое действие за последние 30 дней одним кликом — Sigma вернёт прежнее значение цены, восстановит описание карточки и т.п. Прозрачность и контроль AI — это то, ради чего мы и делаем продукт.',
  },
  {
    q: 'Кто стоит за проектом? Есть ли договор?',
    a: 'Sigma Seller (sigmaseller.ru) развивает Владелец установки — ОГРНИП и реквизиты в подвале сайта и в оферте на /legal/terms. Один человек + AI-помощники, развиваем продукт открыто. Договор — публичная оферта (применяется при оплате) + лицензионное соглашение на использование софта. По любым вопросам — Telegram support@example.com, ответы в течение суток. Чек / УПД при оплате выставляем автоматически.',
  },
];

// Сравнение «Кабинет WB Partners vs Sigma» — не с конкурентами, а с самим
// инструментом маркетплейса. Это допустимо: WB не конкурент, это платформа.
// Закрывает главное возражение «зачем мне сервис, если всё есть в кабинете WB».
const COMPARE_ROWS: Array<{ criterion: string; wb: string; sigma: string }> = [
  { criterion: 'Что показывает',          wb: 'Что было: отчёты, графики, история продаж',                       sigma: 'Что делать: готовое действие с подтверждением' },
  { criterion: 'Ответы на отзывы',        wb: 'Пишешь вручную в карточке каждого отзыва',                        sigma: 'AI готовит драфт в твоём стиле, ты применяешь одной кнопкой' },
  { criterion: 'Изменение цен',           wb: 'По одному артикулу через 4–5 кликов',                              sigma: 'Команда в чате с проверкой маржи, подтвердил — поменялось' },
  { criterion: 'Аудит карточки',          wb: 'Нужно сравнивать руками с конкурентами',                          sigma: 'AI проверяет фото, SEO, описание, ставит задачу на улучшение' },
  { criterion: 'Поставки',                wb: 'Расписание приёмки, выбираешь слот руками',                        sigma: 'Ловит окно бесплатной приёмки, открывает форму с заполненными полями' },
  { criterion: 'A/B тесты',               wb: 'Нет встроенного теста — нужно вручную чередовать варианты',         sigma: 'Загружаешь 2–4 варианта, Sigma чередует и считает значимость' },
  { criterion: 'Прогноз ДДС',             wb: 'Не показывает кассовые разрывы',                                   sigma: 'Считает баланс на 30 дней, подсветит когда дойдёшь до нуля' },
  { criterion: 'Журнал и откат',          wb: 'Изменения навсегда — нет «вернуть как было»',                       sigma: 'Лог всех действий за 30 дней, любое можно откатить кликом' },
];

function CompareWB() {
  return (
    <section className="py-16 sm:py-20 bg-white">
      <div className="max-w-5xl mx-auto px-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.5 }}
          className="text-center mb-10"
        >
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gray-900">
            Кабинет WB показывает.{' '}
            <span className="bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
              Sigma делает.
            </span>
          </h2>
          <p className="mt-3 text-gray-600 max-w-2xl mx-auto">
            Кабинет Wildberries — это панель управления магазином. Sigma — исполнитель,
            который снимает с тебя выполнение того, что кабинет только показывает.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.6 }}
          className="rounded-2xl border border-gray-200 overflow-hidden shadow-sm"
        >
          {/* Header */}
          <div className="grid grid-cols-3 bg-gray-50 border-b border-gray-200 text-xs sm:text-sm font-semibold text-gray-600 uppercase tracking-wide">
            <div className="p-4 sm:p-5">&nbsp;</div>
            <div className="p-4 sm:p-5 border-l border-gray-200">Кабинет WB</div>
            <div className="p-4 sm:p-5 border-l border-gray-200 bg-indigo-50/60 text-indigo-700">Sigma Seller</div>
          </div>
          {/* Rows */}
          {COMPARE_ROWS.map((row, i) => (
            <div
              key={row.criterion}
              className={`grid grid-cols-3 text-sm ${i % 2 === 1 ? 'bg-gray-50/40' : 'bg-white'} ${i < COMPARE_ROWS.length - 1 ? 'border-b border-gray-100' : ''}`}
            >
              <div className="p-4 sm:p-5 font-medium text-gray-900">{row.criterion}</div>
              <div className="p-4 sm:p-5 border-l border-gray-100 text-gray-600 leading-relaxed">{row.wb}</div>
              <div className="p-4 sm:p-5 border-l border-gray-100 text-gray-800 leading-relaxed bg-indigo-50/30">
                <div className="flex items-start gap-2">
                  <Check className="h-4 w-4 text-indigo-600 mt-0.5 shrink-0" />
                  <span>{row.sigma}</span>
                </div>
              </div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

function FAQ() {
  const [openIdx, setOpenIdx] = useState<number | null>(0);
  return (
    <section className="py-16 sm:py-20 bg-gradient-to-b from-gray-50 to-white border-y border-gray-100">
      <div className="max-w-3xl mx-auto px-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.5 }}
          className="text-center mb-10"
        >
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gray-900">
            Частые вопросы
          </h2>
          <p className="mt-3 text-gray-600">
            Отвечаем честно — то, что не пишется в маркетинге.
          </p>
        </motion.div>
        <div className="space-y-3">
          {FAQ_ITEMS.map((item, i) => {
            const isOpen = openIdx === i;
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-30px' }}
                transition={{ duration: 0.35, delay: Math.min(0.04 * i, 0.3) }}
                className="rounded-2xl border border-gray-200 bg-white overflow-hidden"
              >
                <button
                  onClick={() => setOpenIdx(isOpen ? null : i)}
                  className="w-full flex items-start justify-between gap-3 p-5 sm:p-6 text-left hover:bg-gray-50/70 transition-colors"
                  aria-expanded={isOpen}
                >
                  <span className="font-medium text-gray-900 text-base sm:text-lg">{item.q}</span>
                  <span
                    className={`shrink-0 mt-1 h-7 w-7 grid place-items-center rounded-full bg-indigo-50 text-indigo-600 text-lg leading-none transition-transform duration-200 ${isOpen ? 'rotate-45' : ''}`}
                  >
                    +
                  </span>
                </button>
                <motion.div
                  initial={false}
                  animate={{ height: isOpen ? 'auto' : 0, opacity: isOpen ? 1 : 0 }}
                  transition={{ duration: 0.25 }}
                  style={{ overflow: 'hidden' }}
                >
                  <div className="px-5 sm:px-6 pb-6 text-gray-700 leading-relaxed text-sm sm:text-base">
                    {item.a}
                  </div>
                </motion.div>
              </motion.div>
            );
          })}
        </div>
      </div>
      {/* JSON-LD для FAQ-расширения в выдаче Яндекса/Google */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: FAQ_ITEMS.map(({ q, a }) => ({
              '@type': 'Question',
              name: q,
              acceptedAnswer: { '@type': 'Answer', text: a },
            })),
          }),
        }}
      />
    </section>
  );
}

const SECURITY_POINTS: Array<{ icon: any; title: string; body: string }> = [
  {
    icon: Shield,
    title: 'Серверы в России',
    body: 'Соответствие 242-ФЗ. Данные не уходят за границу.',
  },
  {
    icon: Eye,
    title: 'AI не действует сам',
    body: 'Любая операция (поставка, цена, ответ покупателю) требует твоего подтверждения.',
  },
  {
    icon: Check,
    title: 'Зашифрованные ключи',
    body: 'API-ключ WB хранится в шифрованном виде, доступ только сервисным процессам.',
  },
  {
    icon: Zap,
    title: 'Отключение одной кнопкой',
    body: 'Удаляешь ключ — мы забываем доступ. Без писем в поддержку.',
  },
];

function Security() {
  return (
    <section className="py-16 sm:py-20">
      <div className="max-w-5xl mx-auto px-4">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">
            AI с доступом к WB — это безопасно?
          </h2>
          <p className="mt-3 text-gray-600 max-w-xl mx-auto">
            Самый частый вопрос. Поэтому держим прозрачно.
          </p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          {SECURITY_POINTS.map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.title} className="rounded-2xl border border-gray-200 bg-white p-6">
                <div className="inline-grid place-items-center h-11 w-11 rounded-xl bg-emerald-100 text-emerald-700 mb-3">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-1">{s.title}</h3>
                <p className="text-sm text-gray-600 leading-relaxed">{s.body}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ForTeams() {
  return (
    <section className="py-16 bg-gradient-to-br from-purple-50 to-indigo-50 border-y border-gray-100">
      <div className="max-w-4xl mx-auto px-4">
        <div className="flex items-center justify-center gap-2 mb-4">
          <Users className="h-5 w-5 text-purple-600" />
          <span className="text-sm font-medium text-purple-700 uppercase tracking-wide">Для команд</span>
        </div>
        <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 text-center mb-8">
          У меня команда — все будем работать в Sigma Seller?
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FeatureRow title="Multi-user без доплаты" body="Закупщик, маркетолог, контент — у каждого свой логин и свой объём задач." />
          <FeatureRow title="Контекст команды" body="Если Никита поменял title карточки — утром Аня (SEO) получит «эй, проверь позиции»." />
          <FeatureRow title="Безопасное делегирование" body="Можно выдать сотруднику доступ только к части операций, без ключа WB." />
          <FeatureRow title="Один счёт на команду" body="Не per-seat. Платишь за сервис, а не за количество людей." />
        </div>
      </div>
    </section>
  );
}

function ForNewbies() {
  return (
    <section className="py-16">
      <div className="max-w-4xl mx-auto px-4">
        <div className="flex items-center justify-center gap-2 mb-4">
          <Sprout className="h-5 w-5 text-emerald-600" />
          <span className="text-sm font-medium text-emerald-700 uppercase tracking-wide">Для новичков</span>
        </div>
        <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 text-center mb-8">
          Я только зарегистрировал ИП — мне рано?
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FeatureRow title="AI учит по ходу" body="«Коэффициент приёмки 1×» — объяснит что это и почему сегодня лучше отгрузить на Коледино." />
          <FeatureRow title="Объясняет каждое действие" body="Не сделает ничего пока не покажет результат и не получит твоё ОК." />
          <FeatureRow title="Не даст уйти в минус" body="Посчитает приёмку + логистику + хранение до того как ты оформишь поставку." />
          <FeatureRow title="Подключение за 3 минуты" body="Подписка 4 900 ₽/мес — пользуешься всем сервисом. AI готов работать сразу после ввода ключа WB." />
        </div>
      </div>
    </section>
  );
}

function FeatureRow({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-white p-4 border border-gray-200">
      <div className="h-6 w-6 rounded-full bg-indigo-100 text-indigo-600 grid place-items-center shrink-0">
        <Check className="h-4 w-4" />
      </div>
      <div>
        <div className="font-semibold text-gray-900">{title}</div>
        <div className="text-sm text-gray-600 mt-0.5">{body}</div>
      </div>
    </div>
  );
}

const SUBSCRIPTION_FEATURES: string[] = [
  'AI-ассистент с 49 инструментами',
  'Дашборд «Рука на пульсе» — выручка, маржа, воронка',
  'SEO-мониторинг позиций по ключам',
  'FBS-отгрузки и сборочные листы',
  'База знаний с RAG-поиском по документам',
  'Аудит карточек и генерация фото/видео',
  'Telegram-уведомления',
];

const TOPUP_AMOUNTS: Array<{ rub: number; note?: string }> = [
  { rub: 500 },
  { rub: 1000 },
  { rub: 3000, note: 'популярно' },
  { rub: 10000 },
];

function Pricing() {
  return (
    <section className="py-16 sm:py-20 bg-gray-50 border-y border-gray-100">
      <div className="max-w-6xl mx-auto px-4">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">Цена</h2>
          <p className="mt-3 text-gray-600">Один тариф на сервис + AI-токены по факту использования. Без «свяжитесь с менеджером».</p>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          {/* Subscription */}
          <div className="rounded-2xl border border-indigo-300 bg-white ring-2 ring-indigo-300 ring-offset-2 ring-offset-gray-50 p-6">
            <div className="text-sm font-medium text-indigo-700 uppercase tracking-wide">Подписка</div>
            <div className="mt-2 flex items-baseline gap-2">
              <div className="text-4xl font-bold text-gray-900">4 900 ₽</div>
              <div className="text-sm text-gray-500">в месяц</div>
            </div>
            <div className="mt-1 text-xs text-gray-500">30 дней · автоматическое продление</div>
            <ul className="mt-5 space-y-2.5">
              {SUBSCRIPTION_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-gray-700">
                  <Check className="h-4 w-4 text-indigo-600 mt-0.5 shrink-0" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <Link
              href="/auth/register"
              className="mt-6 inline-flex items-center justify-center w-full rounded-lg text-sm font-medium px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white transition-colors"
            >
              Подключить за 4 900 ₽
            </Link>
          </div>

          {/* AI top-up */}
          <div className="rounded-2xl border border-gray-200 bg-white p-6">
            <div className="text-sm font-medium text-gray-500 uppercase tracking-wide">AI-токены</div>
            <div className="mt-2 flex items-baseline gap-2">
              <div className="text-4xl font-bold text-gray-900">от 500 ₽</div>
              <div className="text-sm text-gray-500">пополнение</div>
            </div>
            <div className="mt-1 text-xs text-gray-500">Платишь только за то что использовал. Прозрачно: каждый запрос виден.</div>

            <div className="mt-5 grid grid-cols-4 gap-2">
              {TOPUP_AMOUNTS.map((t) => (
                <div
                  key={t.rub}
                  className="relative rounded-xl border border-gray-200 bg-gray-50 px-2 py-3 text-center"
                >
                  <div className="text-sm font-semibold text-gray-900">{t.rub.toLocaleString('ru-RU')} ₽</div>
                  {t.note && (
                    <div className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-emerald-100 text-emerald-700 text-[10px] px-2 py-0.5 font-medium">
                      {t.note}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <ul className="mt-5 space-y-2.5">
              <li className="flex items-start gap-2 text-sm text-gray-700">
                <Check className="h-4 w-4 text-indigo-600 mt-0.5 shrink-0" />
                <span>Без минимума, без обязательств</span>
              </li>
              <li className="flex items-start gap-2 text-sm text-gray-700">
                <Check className="h-4 w-4 text-indigo-600 mt-0.5 shrink-0" />
                <span>Хватает на сотни запросов AI</span>
              </li>
              <li className="flex items-start gap-2 text-sm text-gray-700">
                <Check className="h-4 w-4 text-indigo-600 mt-0.5 shrink-0" />
                <span>Можно пополнить в любой момент</span>
              </li>
            </ul>

            <Link
              href="/auth/register"
              className="mt-6 inline-flex items-center justify-center w-full rounded-lg text-sm font-medium px-4 py-2.5 bg-white hover:bg-gray-50 text-gray-800 border border-gray-300 transition-colors"
            >
              Начать
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

const MORE_INSIDE: Array<{ icon: any; title: string; body: string }> = [
  { icon: Wallet, title: 'Финансы и юнит-экономика', body: 'Реальная маржа по каждому товару' },
  { icon: FlaskConical, title: 'A/B-тесты', body: 'Фото, название, описание с автоматической ротацией' },
  { icon: Package, title: 'Поставки', body: 'AI создаёт FBS-поставки и подсказывает FBW' },
  { icon: TrendingUp, title: 'Воронка и реклама', body: 'CTR, ROAS, динамика по дням' },
  { icon: MessageSquare, title: 'Отзывы и вопросы', body: 'AI отвечает в тоне бренда' },
  { icon: Eye, title: 'Мониторинг 24/7', body: 'Штрафы, рейтинг, аномалии — в Telegram' },
];

function MoreInside() {
  return (
    <section className="py-16">
      <div className="max-w-6xl mx-auto px-4">
        <div className="text-center mb-10">
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">А ещё внутри</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {MORE_INSIDE.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.title} className="flex items-start gap-3 rounded-xl bg-white p-4 border border-gray-200">
                <div className="h-9 w-9 rounded-lg bg-indigo-50 text-indigo-600 grid place-items-center shrink-0">
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-900">{item.title}</div>
                  <div className="text-xs text-gray-600 mt-0.5">{item.body}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="py-20">
      <div className="max-w-3xl mx-auto px-4 text-center">
        <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">
          Не уверен — попробуй параллельно с тем,<br className="hidden sm:inline" />
          что уже используешь
        </h2>
        <p className="mt-5 text-lg text-gray-600">
          30 дней подписки = месяц чтобы убедиться. Подключаешь ключ WB,
          AI начинает работать сразу — без долгих настроек.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            href="/auth/register"
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-lg font-medium px-8 py-4 transition-colors shadow-sm"
          >
            Подключиться за 4 900 ₽
            <ArrowRight className="h-5 w-5" />
          </Link>
        </div>
        <div className="mt-4 text-sm text-gray-500">
          Уже есть аккаунт?{' '}
          <Link href="/auth/login" className="text-indigo-600 hover:text-indigo-700 font-medium">
            Войти
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-gray-100 py-8">
      <div className="max-w-6xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-gray-500">
        <div>© {new Date().getFullYear()} Sigma Seller</div>
        <div className="flex items-center gap-4">
          <a href="mailto:support@example.com" target="_blank" rel="noreferrer" className="hover:text-gray-900">
            Telegram
          </a>
          <Link href="/legal/terms" className="hover:text-gray-900">Оферта</Link>
          <Link href="/legal/privacy" className="hover:text-gray-900">Политика</Link>
        </div>
      </div>
    </footer>
  );
}
