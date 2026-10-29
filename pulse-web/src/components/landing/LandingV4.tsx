'use client';

/**
 * Sigma Seller — paper/editorial вариант.
 *
 * Эстетика: кремовая бумага, чёрная типографика, redacted/газетная сетка,
 * акценты прибыли/убытка как в финансовой прессе (FT/Economist). Чат-блок —
 * тёмная карточка-инверсия на светлом фоне для wow-эффекта (как у Stripe).
 *
 * Структура повторяет V2; DemoChatPlayer переиспользуется (он сам автономно
 * тёмный — это и нужно).
 */

import { useEffect, useRef, useState } from 'react';
import { DemoChatPlayer } from './DemoChatPlayer';

const BG = '#F5F0E6';        // paper
const BG_ALT = '#ECE6D8';    // slightly darker paper для секции
const FG = '#1A1A1A';
const FG_MUTED = '#5B5650';
const FG_DIM = '#8A8579';
const HAIRLINE = '#D8D2C2';

const paperCSS = `
@keyframes slide-up {
  from { transform: translateY(20px); opacity: 0; }
  to   { transform: translateY(0); opacity: 1; }
}
@keyframes blink-caret {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}
@keyframes paper-glitch {
  0%, 100% { text-shadow: 0.012em 0 0 rgba(168,37,43,0.55), -0.012em 0 0 rgba(10,110,58,0.55); }
  25%      { text-shadow: 0.018em 0 0 rgba(168,37,43,0.7),  -0.018em 0 0 rgba(10,110,58,0.7);  }
  50%      { text-shadow: -0.012em 0 0 rgba(168,37,43,0.5),  0.012em 0 0 rgba(10,110,58,0.5);  }
  75%      { text-shadow: 0.024em 0 0 rgba(168,37,43,0.65), -0.024em 0 0 rgba(10,110,58,0.65); }
}
@keyframes paper-flicker {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.94; }
}
@keyframes fade-in-up {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}
.sigma-glyph {
  animation: paper-glitch 0.7s infinite, paper-flicker 4s infinite;
}
.caret { animation: blink-caret 1s infinite; }
.feature-row { transition: background 0.4s ease, padding-left 0.4s ease, transform 0.4s ease; }
.feature-row:hover { background: rgba(26,26,26,0.04); padding-left: 8px; }
.hero-h1, .manifesto-text, .h2-mobile-tight { animation: fade-in-up 0.7s ease both; }
.hero-p { animation: fade-in-up 0.7s 0.15s ease both; opacity: 0; animation-fill-mode: both; }
.hero-cta { animation: fade-in-up 0.7s 0.3s ease both; opacity: 0; animation-fill-mode: both; }

.nav-desktop { display: flex; }

.grid-12 { display: grid; grid-template-columns: repeat(12, 1fr); gap: 24px; }
.col-2 { grid-column: span 2; }
.col-3 { grid-column: span 3; }
.col-6 { grid-column: span 6; }
.col-8 { grid-column: span 8; }
.col-10 { grid-column: span 10; }

.feature-row-grid {
  display: grid;
  grid-template-columns: 1fr 2fr 6fr 3fr;
  gap: 24px;
}

@media (max-width: 900px) {
  .grid-12 { display: flex !important; flex-direction: column !important; gap: 28px !important; }
  .feature-row-grid { display: flex !important; flex-direction: column !important; gap: 12px !important; }
  .col-2, .col-3, .col-6, .col-8, .col-10 { grid-column: auto !important; width: 100% !important; }
  .hide-mobile { display: none !important; }
  .nav-desktop { display: none !important; }
  .hero-meta-right { display: none !important; }
  .header-pad { padding: 12px 16px !important; }
  .hero-section { padding: 96px 18px 60px !important; }
  .section-pad { padding: 60px 18px !important; }
  .h1-mobile-tight { font-size: clamp(34px, 8.5vw, 52px) !important; line-height: 1 !important; word-break: normal !important; hyphens: none; }
  .h1-mobile-tight span { display: inline !important; }
  .h2-mobile-tight { font-size: clamp(30px, 8vw, 48px) !important; line-height: 1 !important; }
  .manifesto-text { font-size: clamp(20px, 5.2vw, 32px) !important; line-height: 1.3 !important; }
  .killer-stats-mobile {
    display: grid !important;
    grid-template-columns: 1fr 1fr !important;
    gap: 18px 24px !important;
  }
  .killer-stats-mobile > div > div:first-child { font-size: 26px !important; }
  .killer-stats-mobile > div > div:last-child { font-size: 9px !important; }
  .chat-mock-mobile { padding: 14px !important; font-size: 12px !important; }
  .feature-block { padding: 22px 0 !important; }
  .feature-block h3 { font-size: clamp(22px, 6vw, 32px) !important; }
  .feature-block .feature-body { font-size: 14px !important; }
  .big-statement { padding: 80px 18px !important; font-size: clamp(28px, 8vw, 44px) !important; line-height: 1.15 !important; }
  .pricing-card { padding: 28px 20px !important; }
  .pricing-card .price-num { font-size: clamp(56px, 16vw, 96px) !important; }
  .pricing-subtitle { font-size: 9px !important; letter-spacing: 0.1em !important; }
  .footer-mobile { padding: 40px 18px !important; flex-direction: column !important; gap: 24px !important; align-items: flex-start !important; }
}
@media (min-width: 901px) {
  .show-mobile { display: none !important; }
  .nav-mobile { display: none !important; }
}

.chat-bubble { animation: slide-up 0.5s ease both; }
`;

export function LandingV4() {
  const [entered, setEntered] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!entered && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        setEntered(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entered]);

  return (
    <div
      ref={wrapRef}
      style={{
        background: BG,
        color: FG,
        fontFamily: 'var(--font-mono-v4), ui-monospace, monospace',
        minHeight: '100vh',
        overflow: entered ? 'auto' : 'hidden',
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: paperCSS }} />

      {!entered ? <IntroSplash onEnter={() => setEntered(true)} /> : <MainContent />}
    </div>
  );
}

function IntroSplash({ onEnter }: { onEnter: () => void }) {
  return (
    <section
      onClick={onEnter}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        background: BG,
        zIndex: 60,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 24,
          left: 24,
          fontSize: '10px',
          color: FG_DIM,
          textTransform: 'uppercase',
          letterSpacing: '0.15em',
        }}
      >
        Σ — Sigma Seller / 2026
      </div>
      <div
        style={{
          position: 'absolute',
          top: 24,
          right: 24,
          fontSize: '10px',
          color: FG_DIM,
          textTransform: 'uppercase',
          letterSpacing: '0.15em',
        }}
      >
        Paper Edition
      </div>

      <div
        className="sigma-glyph"
        style={{
          fontFamily: 'var(--font-fraunces-v4), "Times New Roman", serif',
          fontSize: 'clamp(180px, 32vw, 480px)',
          lineHeight: 0.85,
          fontWeight: 400,
          color: FG,
          userSelect: 'none',
        }}
      >
        Σ
      </div>

      <button
        onClick={onEnter}
        style={{
          marginTop: '80px',
          background: 'transparent',
          border: 'none',
          color: FG,
          fontSize: '11px',
          letterSpacing: '0.5em',
          textTransform: 'uppercase',
          textDecoration: 'underline',
          textUnderlineOffset: '6px',
          cursor: 'pointer',
          fontFamily: 'inherit',
          padding: '12px 16px',
        }}
      >
        ENTER SITE
      </button>

      <div
        style={{
          position: 'absolute',
          bottom: 20,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: '9px',
          color: FG_DIM,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
        }}
      >
        Wildberries · AI · Action
      </div>
    </section>
  );
}

function MainContent() {
  return (
    <>
      <Header />
      <Hero />
      <DemoChatPlayer />
      <Manifesto />
      <Numbered />
      <BigStatement />
      <PricingBlock />
      <Footer />
    </>
  );
}

function Header() {
  return (
    <header
      className="header-pad"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        padding: '18px 24px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: '11px',
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        background: 'linear-gradient(180deg, rgba(245,240,230,0.95) 0%, rgba(245,240,230,0) 100%)',
        zIndex: 30,
        backdropFilter: 'blur(8px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span
          className="sigma-glyph"
          style={{
            fontFamily: 'var(--font-fraunces-v4), "Times New Roman", serif',
            fontSize: '28px',
            lineHeight: 1,
            letterSpacing: 0,
            textTransform: 'none',
            color: FG,
          }}
        >
          Σ
        </span>
        <span style={{ color: FG, textTransform: 'none', letterSpacing: 0, fontSize: '15px', fontWeight: 500 }}>
          Sigma Seller
        </span>
      </div>
      <nav className="nav-desktop" style={{ gap: '36px', justifyContent: 'center', color: FG_MUTED }}>
        <a href="#what" style={{ color: 'inherit', textDecoration: 'none' }}>01 — Что это</a>
        <a href="#how"  style={{ color: 'inherit', textDecoration: 'none' }}>02 — Как</a>
        <a href="#price" style={{ color: 'inherit', textDecoration: 'none' }}>03 — Цена</a>
      </nav>
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <a href="/auth/login" className="hide-mobile" style={{ color: FG_MUTED, textDecoration: 'none' }}>Войти</a>
        <a
          href="/auth/register"
          style={{
            color: BG,
            background: FG,
            textDecoration: 'none',
            padding: '8px 14px',
            fontSize: '11px',
            letterSpacing: '0.12em',
            whiteSpace: 'nowrap',
          }}
        >
          Начать →
        </a>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section
      className="grid-12 hero-section"
      style={{
        padding: '128px 24px 40px',
        alignItems: 'start',
      }}
    >
      <div className="col-2 hide-mobile" style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '10px', color: FG_MUTED, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
        <span style={{ color: FG }}>№ 01</span>
        <span>Wildberries</span>
        <span>AI · Action</span>
      </div>

      <div className="col-10">
        <div className="show-mobile" style={{ fontSize: '10px', color: FG_MUTED, textTransform: 'uppercase', letterSpacing: '0.18em', marginBottom: '20px' }}>
          № 01 · Wildberries · AI · Action
        </div>
        <h1
          className="h1-mobile-tight hero-h1"
          style={{
            fontFamily: 'var(--font-fraunces-v4), "Times New Roman", serif',
            fontWeight: 400,
            fontSize: 'clamp(48px, 8vw, 124px)',
            lineHeight: 0.9,
            letterSpacing: '-0.025em',
            margin: 0,
            color: FG,
            wordBreak: 'normal',
            overflowWrap: 'break-word',
          }}
        >
          AI делает.{' '}
          <span style={{ fontStyle: 'italic', color: FG_MUTED }}>
            Ты подтверждаешь.
          </span>
        </h1>

        <p
          className="hero-p"
          style={{
            marginTop: '28px',
            maxWidth: '560px',
            fontSize: '15px',
            lineHeight: 1.6,
            color: FG_MUTED,
          }}
        >
          Sigma готовит действия в твоём кабинете Wildberries: цена, отзыв, аудит карточки,
          поставка, A/B-тест. Ты вычитываешь и кликаешь «Применить». Никаких автодействий
          за спиной.
        </p>

        <div style={{ marginTop: '20px', display: 'flex', gap: '18px', flexWrap: 'wrap', fontSize: '10px', color: FG_DIM, textTransform: 'uppercase', letterSpacing: '0.15em' }}>
          <span>Без установки</span>
          <span>·</span>
          <span>В браузере</span>
          <span>·</span>
          <span>3 минуты на старт</span>
        </div>

        <div className="hero-cta" style={{ marginTop: '32px', display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
          <a
            href="/auth/register"
            style={{
              display: 'inline-block',
              padding: '15px 28px',
              color: BG,
              background: FG,
              textDecoration: 'none',
              fontSize: '11px',
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              fontWeight: 500,
            }}
          >
            Попробовать — 100 ₽ AI в подарок →
          </a>
          <a
            href="#demo"
            style={{
              fontSize: '11px',
              color: FG_MUTED,
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              textDecoration: 'none',
              borderBottom: `1px solid ${HAIRLINE}`,
              paddingBottom: '4px',
            }}
          >
            Спросить Sigma ↓
          </a>
        </div>
      </div>
    </section>
  );
}

function Manifesto() {
  return (
    <section
      id="what"
      className="grid-12 section-pad"
      style={{
        padding: '100px 24px',
        borderTop: `1px solid ${HAIRLINE}`,
        background: BG_ALT,
      }}
    >
      <div className="col-2" style={{ fontSize: '10px', color: FG_MUTED, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
        № 02 / Манифест
      </div>

      <div className="col-10">
        <p
          className="manifesto-text"
          style={{
            fontFamily: 'var(--font-fraunces-v4), "Times New Roman", serif',
            fontSize: 'clamp(22px, 3.2vw, 46px)',
            lineHeight: 1.25,
            letterSpacing: '-0.01em',
            color: FG,
            margin: 0,
            fontWeight: 300,
          }}
        >
          Кабинет WB <em style={{ color: FG_MUTED }}>показывает.</em>{' '}
          Аналитика <em style={{ color: FG_MUTED }}>показывает.</em>{' '}
          <span style={{ color: FG }}>
            Sigma — единственный, кто делает действие в твоём кабинете
            и спрашивает «применить?». Время на принятие решения — твоё.
            Выполнение — наше.
          </span>
        </p>
      </div>
    </section>
  );
}

const FEATURES = [
  {
    n: '01',
    label: 'Поставки',
    title: 'Что и куда везти — считает за тебя',
    body: 'AI подсказывает склад, дату, количество. ROI с разбивкой по 7 статьям затрат. Для FBW открывает форму брони в ЛК WB с заполненными полями.',
  },
  {
    n: '02',
    label: 'Цена',
    title: 'Защита от демпинга и убытка',
    body: 'Считает рекомендованную цену с учётом конкурентов, маржи, твоих границ min/max. Меняет — только после подтверждения в чате.',
  },
  {
    n: '03',
    label: 'A/B тесты',
    title: 'Фото, title, description',
    body: 'Загружаешь 2–4 варианта, Sigma чередует их в карточке WB каждые 6 часов и считает реальные показы, переходы, заказы. Z-тест значимости.',
  },
  {
    n: '04',
    label: 'Отзывы',
    title: 'Драфты готовы — ты вычитываешь',
    body: 'Классифицирует тон, эскалирует негатив, готовит ответы в стиле твоего бренда. Ничего не отправляется без подтверждения.',
  },
  {
    n: '05',
    label: 'Карточки',
    title: 'Title, description, SEO',
    body: 'AI предлагает новые формулировки под SEO и продажи, ты смотришь превью и подтверждаешь. Изменения через официальный content API.',
  },
  {
    n: '06',
    label: 'Финансы',
    title: 'ДДС с прогнозом разрывов',
    body: 'Тянет выручку, удержания и оплату хранения из отчётов WB. Прогноз баланса на 30 дней — увидишь когда дойдёшь до нуля до того, как это случится.',
  },
];

function Numbered() {
  return (
    <section
      id="how"
      className="section-pad"
      style={{
        borderTop: `1px solid ${HAIRLINE}`,
        padding: '100px 24px 0',
      }}
    >
      <div className="grid-12" style={{ paddingBottom: '50px' }}>
        <div className="col-2" style={{ fontSize: '10px', color: FG_MUTED, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
          № 03 / Что внутри
        </div>
        <div className="col-10">
          <h2 className="h2-mobile-tight" style={{ fontFamily: 'var(--font-fraunces-v4), "Times New Roman", serif', fontSize: 'clamp(36px, 5vw, 78px)', lineHeight: 0.95, margin: 0, fontWeight: 400, letterSpacing: '-0.02em' }}>
            Шесть <em style={{ color: FG_MUTED }}>зон ответственности.</em>
          </h2>
          <p style={{ marginTop: '20px', fontSize: '14px', color: FG_MUTED, maxWidth: '560px', lineHeight: 1.6 }}>
            Каждая фича — реально работающий инструмент. Никаких «скоро» и «в работе».
            Всё перечисленное вы получаете в день регистрации.
          </p>
        </div>
      </div>

      <div>
        {FEATURES.map((f, i) => (
          <article
            key={f.n}
            className="feature-row feature-row-grid feature-block"
            style={{
              borderTop: `1px solid ${HAIRLINE}`,
              padding: '28px 0',
              ...(i === FEATURES.length - 1 ? { borderBottom: `1px solid ${HAIRLINE}` } : {}),
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px' }}>
              <span style={{ fontFamily: 'var(--font-fraunces-v4), serif', fontSize: '36px', color: FG_DIM, lineHeight: 0.9 }}>
                {f.n}
              </span>
              <span style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.15em', color: FG_MUTED }}>
                {f.label}
              </span>
            </div>
            <div className="hide-mobile" />
            <div>
              <h3 style={{ fontFamily: 'var(--font-fraunces-v4), serif', fontSize: 'clamp(22px, 2.4vw, 36px)', lineHeight: 1.12, margin: 0, fontWeight: 400, letterSpacing: '-0.015em', color: FG }}>
                {f.title}
              </h3>
            </div>
            <div className="feature-body" style={{ fontSize: '13px', lineHeight: 1.65, color: FG_MUTED }}>
              {f.body}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function BigStatement() {
  return (
    <section
      className="big-statement"
      style={{
        padding: '160px 24px',
        textAlign: 'center',
        borderTop: `1px solid ${HAIRLINE}`,
        background: BG_ALT,
      }}
    >
      <div style={{ fontSize: '10px', color: FG_MUTED, textTransform: 'uppercase', letterSpacing: '0.18em', marginBottom: '40px' }}>
        № 04 / Тезис
      </div>
      <h2
        style={{
          fontFamily: 'var(--font-fraunces-v4), serif',
          fontWeight: 300,
          fontSize: 'clamp(34px, 5vw, 80px)',
          lineHeight: 1.08,
          letterSpacing: '-0.02em',
          color: FG_MUTED,
          margin: '0 auto',
          maxWidth: '1100px',
        }}
      >
        Продавец на WB не должен{' '}
        <em style={{ color: FG }}>учиться аналитике.</em><br />
        Он должен <em style={{ color: FG }}>продавать.</em>
      </h2>
    </section>
  );
}

function PricingBlock() {
  const INCLUDED = [
    'AI-чат с 10+ типами действий в кабинете WB',
    'Аудит карточек, A/B-тесты фото и текста',
    'Управление поставками (FBS/FBW) с ROI-прогнозом',
    'Драфты ответов на отзывы и вопросы',
    'Дашборды: финансы, ДДС, остатки, выручка',
    '100 ₽ AI-токенов в подарок при регистрации',
  ];
  return (
    <section
      id="price"
      className="pricing-card section-pad"
      style={{
        padding: '140px 24px',
        borderTop: `1px solid ${HAIRLINE}`,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: '10px', color: FG_MUTED, textTransform: 'uppercase', letterSpacing: '0.18em', marginBottom: '30px' }}>
        № 05 / Цена
      </div>
      <div className="price-num" style={{ fontFamily: 'var(--font-fraunces-v4), serif', fontSize: 'clamp(72px, 11vw, 180px)', lineHeight: 0.9, fontWeight: 400, letterSpacing: '-0.04em', color: FG }}>
        4 900 <em style={{ fontSize: '0.32em', color: FG_MUTED, fontStyle: 'normal', letterSpacing: '0' }}>₽/мес</em>
      </div>
      <div className="pricing-subtitle" style={{ marginTop: '14px', fontSize: '11px', color: FG_DIM, textTransform: 'uppercase', letterSpacing: '0.18em' }}>
        Подписка · Отмена в любой момент
      </div>
      <div style={{ marginTop: '8px', fontSize: '11px', color: FG_DIM, maxWidth: '420px', margin: '8px auto 0', lineHeight: 1.5 }}>
        AI-действия — pay-as-you-go: платишь по факту использования, ×2 от стоимости модели.
        100 ₽ токенов в подарок при регистрации — попробовать без обязательств.
      </div>

      <ul style={{ listStyle: 'none', padding: 0, margin: '50px auto 0', maxWidth: '480px', textAlign: 'left' }}>
        {INCLUDED.map((item, i) => (
          <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '10px 0', borderBottom: i < INCLUDED.length - 1 ? `1px solid ${HAIRLINE}` : 'none', fontSize: '13px', color: FG, lineHeight: 1.5 }}>
            <span style={{ color: FG_MUTED, fontFamily: 'var(--font-mono-v4), monospace', fontSize: '11px', minWidth: '24px' }}>
              0{i + 1}
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>

      <a
        href="/auth/register"
        style={{
          display: 'inline-block',
          marginTop: '50px',
          padding: '18px 40px',
          color: BG,
          background: FG,
          textDecoration: 'none',
          fontSize: '11px',
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          fontWeight: 500,
        }}
      >
        Подключить магазин →
      </a>
      <div style={{ marginTop: '14px', fontSize: '10px', color: FG_DIM, textTransform: 'uppercase', letterSpacing: '0.15em' }}>
        3 минуты на старт · Серверы в России
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer
      className="grid-12 footer-mobile"
      style={{
        borderTop: `1px solid ${HAIRLINE}`,
        padding: '60px 24px 40px',
        fontSize: '11px',
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        color: FG_MUTED,
        background: BG_ALT,
      }}
    >
      <div className="col-3">
        <div style={{ fontSize: '10px', color: FG_DIM, textTransform: 'uppercase', letterSpacing: '0.18em', marginBottom: '8px' }}>
          © 2026
        </div>
        <div style={{ fontSize: '10px', color: FG_DIM, textTransform: 'none', letterSpacing: 0, lineHeight: 1.55 }}>
          Владелец установки<br />
          Помощник продавцам Wildberries
        </div>
      </div>

      <div className="col-3" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ color: FG_DIM }}>Сервис</div>
        <a href="#how"   style={{ color: 'inherit', textDecoration: 'none' }}>Возможности</a>
        <a href="#price" style={{ color: 'inherit', textDecoration: 'none' }}>Цена</a>
      </div>

      <div className="col-3" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ color: FG_DIM }}>Контакты</div>
        <a href="mailto:support@example.com" target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
          Telegram
        </a>
        <a href="/auth/login" style={{ color: 'inherit', textDecoration: 'none' }}>Войти</a>
      </div>

      <div className="col-3" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ color: FG_DIM }}>Правовое</div>
        <a href="/legal/terms"   style={{ color: 'inherit', textDecoration: 'none' }}>Оферта</a>
        <a href="/legal/privacy" style={{ color: 'inherit', textDecoration: 'none' }}>Политика данных</a>
      </div>
    </footer>
  );
}
