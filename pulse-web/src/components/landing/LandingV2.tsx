'use client';

/**
 * Sigma Seller — превью в стиле jeen-yuhs.com (студия CTHDRL).
 *
 * Эстетика: чёрный фон, CRT/VHS-глитч на логотипе, intro splash «ENTER SITE»,
 * минимализм, microtypography. Mono + serif микс. Nostalgia + premium.
 *
 * Структура:
 *   1) Intro-сплеш с глитчем Σ + «ENTER SITE» — нужно кликнуть, чтобы перейти
 *      к основному контенту (это и фишка jeen-yuhs).
 *   2) Hero: огромный serif H1, моно-метки, минимальный CTA.
 *   3) Шесть пронумерованных фич (то, что реально работает в продукте).
 *   4) Манифест.
 *   5) Цена.
 *   6) Footer.
 *
 * Доступ: только владельцу (см. middleware → OWNER_PREVIEW_ROUTES).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DemoChatPlayer } from './DemoChatPlayer';

// Палитра «коричневый по жёлтому» — единая основа лендинга v2.
// BG — жирный жёлтый фон (#FBD394), FG/FG_ACCENT — глубокий тёмно-коричневый
// для текста и акцентов. Производные FG_MUTED/FG_DIM — осветлённые тона
// коричневого, чтобы оставаться в одной семье.
const FG = '#3D1A00';        // основной текст
const FG_ACCENT = '#703800'; // акцентный коричневый (как на скрине)
const FG_MUTED = '#8a5828';  // приглушённый
const FG_DIM = '#b58f5e';    // ещё светлее
const BG = '#FBD394';        // жёлто-бежевый фон
const HAIRLINE = 'rgba(61, 26, 0, 0.18)';
const SUCCESS = '#4a7a2a';   // акцент-успех, в тон палитре
const WB_PURPLE = '#CB11AB'; // фирменный пурпур WB — для слова «Wildberries»
const SIGMA = '#6366f1';     // фирменный индиго Sigma — для CTA и кнопок «Применить»
const SIGMA_DARK = '#4f46e5';

// Стили + responsive layout.
// 12-колоночная сетка работает только на desktop; mobile = одна колонка.
// CRT-эффекты (glitch/flicker/scanlines) применяются ТОЛЬКО к intro-splash,
// основной контент — чистый жёлтый/коричневый без анимаций.
const glitchCSS = `
@keyframes glitch-rgb {
  0%, 100% { text-shadow: 0.02em 0 0 rgba(255,0,80,0.55), -0.02em 0 0 rgba(0,255,200,0.55); }
  25%      { text-shadow: 0.03em 0 0 rgba(255,0,80,0.65), -0.03em 0 0 rgba(0,255,200,0.65); }
  50%      { text-shadow: -0.02em 0 0 rgba(255,0,80,0.5),  0.02em 0 0 rgba(0,255,200,0.5);  }
  75%      { text-shadow: 0.04em 0 0 rgba(255,0,80,0.7),  -0.04em 0 0 rgba(0,255,200,0.7);  }
}
@keyframes scanlines {
  0%   { background-position: 0 0; }
  100% { background-position: 0 100%; }
}
@keyframes flicker {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.96; }
}
@keyframes blink-caret {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}
@keyframes slide-up {
  from { transform: translateY(20px); opacity: 0; }
  to   { transform: translateY(0); opacity: 1; }
}
.sigma-glyph {
  animation: glitch-rgb 0.7s infinite, flicker 4s infinite;
}
.intro-scanlines::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    to bottom,
    rgba(0,0,0,0) 0px,
    rgba(0,0,0,0) 2px,
    rgba(255,255,255,0.025) 3px,
    rgba(255,255,255,0.025) 3px
  );
  animation: scanlines 12s linear infinite;
  z-index: 50;
}
.caret { animation: blink-caret 1s infinite; }
@keyframes cta-blink {
  0%, 100% { background: #6366f1; color: #ffffff; transform: scale(1); }
  50%      { background: #4f46e5; color: #ffffff; transform: scale(1.03); }
}
.cta-blink { animation: cta-blink 1.4s ease-in-out infinite; transition: transform 0.15s ease; }
.cta-blink:hover { animation: none; background: #4f46e5; color: #ffffff; }
.cta-blink:active { transform: scale(0.96); }
.feature-row { transition: background 0.4s ease, padding-left 0.4s ease; }
.feature-row:hover { background: rgba(61, 26, 0, 0.04); padding-left: 8px; }
.manifesto-highlight {
  background: linear-gradient(180deg, transparent 62%, rgba(112, 56, 0, 0.18) 62%);
  padding: 0 2px;
}

/* Desktop defaults для классов-флагов */
.nav-desktop { display: flex; }

/* ── DESKTOP grid is default; MOBILE collapses to single column ── */
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

/* Mobile-first overrides. Используем max-width: 900 для перехвата планшетов
 * в портрете тоже. Все правила с !important чтобы перебивать inline display. */
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

/* Мокап AI-чата справа в hero */
.chat-bubble { animation: slide-up 0.5s ease both; }
`;

export function LandingV2() {
  const [entered, setEntered] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Auto-focus body чтобы Enter тоже работал для перехода
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
        fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        minHeight: '100vh',
        overflow: entered ? 'auto' : 'hidden',
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: glitchCSS }} />

      {!entered ? <IntroSplash onEnter={() => setEntered(true)} /> : <MainContent />}
    </div>
  );
}

// ── Intro-splash в стиле jeen-yuhs ──────────────────────────────────────────
// Splash остаётся в оригинальной CRT-эстетике: чёрный фон, бежевый текст,
// glitch+flicker на Σ, scanlines. Контраст с жёлтым основным контентом —
// часть концепции (тёмный «вход» → светлая «гостиная»).
const SPLASH_BG = '#0a0a0a';
const SPLASH_FG = '#ebebe3';
const SPLASH_DIM = '#525248';
function IntroSplash({ onEnter }: { onEnter: () => void }) {
  return (
    <section
      onClick={onEnter}
      className="intro-scanlines"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        background: SPLASH_BG,
        color: SPLASH_FG,
        fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
        zIndex: 60,
      }}
    >
      {/* Верхняя строка mono — credits style */}
      <div
        style={{
          position: 'absolute',
          top: 24,
          left: 24,
          fontSize: '10px',
          color: SPLASH_DIM,
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
          color: SPLASH_DIM,
          textTransform: 'uppercase',
          letterSpacing: '0.15em',
        }}
      >
        v2.0 / Preview
      </div>

      {/* Гигантский Σ с CRT-глитчем */}
      <div
        className="sigma-glyph"
        style={{
          fontFamily: 'var(--font-fraunces), "Times New Roman", serif',
          fontSize: 'clamp(180px, 32vw, 480px)',
          lineHeight: 0.85,
          fontWeight: 400,
          color: SPLASH_FG,
          userSelect: 'none',
        }}
      >
        Σ
      </div>

      {/* ENTER SITE — тонкое и подчёркнутое снизу */}
      <button
        onClick={onEnter}
        style={{
          marginTop: '80px',
          background: 'transparent',
          border: 'none',
          color: SPLASH_FG,
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

      {/* Нижняя credit-строка */}
      <div
        style={{
          position: 'absolute',
          bottom: 20,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: '9px',
          color: SPLASH_DIM,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
        }}
      >
        Wildberries · ИИ · Действия
      </div>
    </section>
  );
}

// ── Основной контент после клика ENTER SITE ─────────────────────────────────
function MainContent() {
  return (
    <>
      <Header />
      <Hero />
      <DemoChatPlayer />
      <UIShowcase />
      <Numbered />
      <Manifesto />
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
        background: 'linear-gradient(180deg, rgba(251, 211, 148, 0.96) 0%, rgba(251, 211, 148, 0) 100%)',
        zIndex: 30,
        backdropFilter: 'blur(8px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span
          style={{
            fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif',
            fontSize: '28px',
            lineHeight: 1,
            letterSpacing: 0,
            textTransform: 'none',
            color: FG_ACCENT,
            fontWeight: 500,
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
        <a href="/source" style={{ color: 'inherit', textDecoration: 'none' }}>Исходный код</a>
        <a href="#price" style={{ color: 'inherit', textDecoration: 'none' }}>03 — Цена</a>
      </nav>
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <a href="/auth/login" className="hide-mobile" style={{ color: FG_MUTED, textDecoration: 'none' }}>Войти</a>
        <a
          href="/auth/register"
          style={{
            color: '#ffffff',
            background: SIGMA,
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
        padding: '140px 24px 80px',
        minHeight: '100vh',
        alignItems: 'start',
      }}
    >
      {/* Левая mono-метка (на mobile — компактная горизонтальная строка) */}
      <div className="col-2 hide-mobile" style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '10px', color: FG_MUTED, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
        <span style={{ color: FG }}>№ 01</span>
        <span>Wildberries</span>
        <span>ИИ · Действия</span>
      </div>

      {/* Заголовок и описание */}
      <div className="col-6">
        <div className="show-mobile" style={{ fontSize: '10px', color: FG_MUTED, textTransform: 'uppercase', letterSpacing: '0.18em', marginBottom: '20px' }}>
          № 01 · Wildberries · ИИ · Действия
        </div>
        <h1
          className="h1-mobile-tight"
          style={{
            fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif',
            fontWeight: 800,
            fontSize: 'clamp(52px, 7.6vw, 132px)',
            lineHeight: 0.94,
            letterSpacing: '-0.035em',
            margin: 0,
            color: FG,
            wordBreak: 'normal',
            overflowWrap: 'break-word',
          }}
        >
          ИИ-помощник продавца{' '}
          <span style={{ color: WB_PURPLE }}>Wildberries</span>
        </h1>

        <p
          style={{
            marginTop: '32px',
            maxWidth: '560px',
            fontSize: '19px',
            lineHeight: 1.5,
            color: FG_MUTED,
            fontWeight: 500,
          }}
        >
          Анализирует кабинет, готовит решения по цене, поставкам, карточкам и отзывам.
          Ты подтверждаешь — <span style={{ color: SIGMA, fontWeight: 600 }}>Sigma</span>
          <span style={{ color: FG, fontWeight: 500 }}> выполняет.</span>
        </p>

        <div style={{ marginTop: '40px', display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
          <a
            href="/auth/register"
            style={{
              display: 'inline-block',
              padding: '15px 28px',
              color: '#ffffff',
              background: SIGMA,
              textDecoration: 'none',
              fontSize: '11px',
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              fontWeight: 600,
              boxShadow: `0 2px 0 ${SIGMA_DARK}`,
            }}
          >
            Начать бесплатно →
          </a>
          <a
            href="#how"
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
            Что внутри
          </a>
        </div>

      </div>

      {/* Правый блок: визуальный мок-чата AI (на mobile — снизу под Hero) */}
      <div className="col-3 chat-mock-mobile" style={{ marginTop: '12px' }}>
        <HeroAiChatMock />
      </div>

      {/* Дальний справа — credits-метки только на desktop */}
      <div className="col-2 hero-meta-right" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', fontSize: '9px', color: FG_DIM, textTransform: 'uppercase', letterSpacing: '0.15em', gap: '6px' }}>
        <span style={{ color: FG_MUTED }}>v 2.0</span>
        <span>Для продавцов WB</span>
        <span>Серверы в России</span>
      </div>
    </section>
  );
}

// Визуальный мокап AI-чата справа в hero. Интерактивный: клик на «Применить»
// переключает в состояние «Применено ✓» — вовлекает посетителя сразу.
// Кнопка «Применить» мигает (CSS-анимация) пока не нажата.
function HeroAiChatMock() {
  const [state, setState] = useState<'pending' | 'applied' | 'cancelled'>('pending');

  return (
    <div
      style={{
        border: `1px solid ${HAIRLINE}`,
        background: 'rgba(255, 250, 230, 0.55)',
        padding: '20px',
        fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
        fontSize: '11px',
        color: FG_MUTED,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px', paddingBottom: '12px', borderBottom: `1px solid ${HAIRLINE}` }}>
        <span style={{ color: FG, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.15em' }}>Sigma · Онлайн</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.15em' }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#4a7a2a' }} />
          ИИ готов
        </span>
      </div>

      {/* User msg справа */}
      <div className="chat-bubble" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '14px' }}>
        <div style={{ background: FG, color: BG, padding: '8px 12px', maxWidth: '85%', textTransform: 'lowercase' }}>
          снизь цену на туфли женские на 5%
        </div>
      </div>

      {/* AI msg слева */}
      <div className="chat-bubble" style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '6px', animationDelay: '0.4s' }}>
        <div style={{ border: `1px solid ${HAIRLINE}`, padding: '10px 12px', maxWidth: '90%', color: FG, lineHeight: 1.5 }}>
          Снижу с 1 500 ₽ до 1 425 ₽. Не уйдёшь в минус,
          {' '}<span style={{ color: '#4a7a2a' }}>+12 заказов в неделю</span>. Применить?
        </div>
      </div>

      {/* Кнопки — интерактивные */}
      <div className="chat-bubble" style={{ display: 'flex', gap: '6px', justifyContent: 'flex-start', paddingLeft: '12px', animationDelay: '0.7s', minHeight: '32px', alignItems: 'center' }}>
        {state === 'pending' && (
          <>
            <button
              onClick={() => setState('applied')}
              className="cta-blink"
              style={{ background: SIGMA, color: '#ffffff', border: `1px solid ${SIGMA}`, padding: '5px 14px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.12em', fontFamily: 'inherit', cursor: 'pointer', fontWeight: 600 }}
            >
              Применить
            </button>
            <button
              onClick={() => setState('cancelled')}
              style={{ background: 'transparent', color: FG_MUTED, border: `1px solid ${HAIRLINE}`, padding: '5px 14px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.12em', fontFamily: 'inherit', cursor: 'pointer' }}
            >
              Отменить
            </button>
          </>
        )}
        {state === 'applied' && (
          <>
            <span style={{ color: '#4a7a2a', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.15em' }}>
              ✓ Применено · цена обновлена в кабинете WB
            </span>
            <button
              onClick={() => setState('pending')}
              style={{ background: 'transparent', color: FG_DIM, border: `1px solid ${HAIRLINE}`, padding: '4px 10px', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.12em', fontFamily: 'inherit', cursor: 'pointer', marginLeft: '8px' }}
            >
              ↺
            </button>
          </>
        )}
        {state === 'cancelled' && (
          <>
            <span style={{ color: FG_MUTED, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.15em' }}>
              ✗ Отменено · цена осталась прежней
            </span>
            <button
              onClick={() => setState('pending')}
              style={{ background: 'transparent', color: FG_DIM, border: `1px solid ${HAIRLINE}`, padding: '4px 10px', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.12em', fontFamily: 'inherit', cursor: 'pointer', marginLeft: '8px' }}
            >
              ↺
            </button>
          </>
        )}
      </div>

      {/* Промпт-строка с caret */}
      <div style={{ marginTop: '20px', paddingTop: '14px', borderTop: `1px solid ${HAIRLINE}`, fontSize: '10px', color: FG_DIM, display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span>{'>'}</span>
        <span>введи команду</span>
        <span className="caret">_</span>
      </div>
    </div>
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
      }}
    >
      <div className="col-2" style={{ fontSize: '10px', color: FG_MUTED, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
        № 03 / Манифест
      </div>

      <div className="col-10">
        <p
          className="manifesto-text"
          style={{
            fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif',
            fontSize: 'clamp(26px, 3.6vw, 52px)',
            lineHeight: 1.3,
            letterSpacing: '-0.02em',
            color: FG_MUTED,
            margin: 0,
            fontWeight: 500,
          }}
        >
          Кабинет <span style={{ color: WB_PURPLE, fontWeight: 700 }}>WB</span>{' '}
          <span style={{ color: FG_DIM }}>→</span> показывает цифры.
        </p>
        <p
          className="manifesto-text"
          style={{
            fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif',
            fontSize: 'clamp(26px, 3.6vw, 52px)',
            lineHeight: 1.3,
            letterSpacing: '-0.02em',
            color: FG_MUTED,
            margin: '14px 0 0',
            fontWeight: 500,
          }}
        >
          Аналитика <span style={{ color: FG_DIM }}>→</span> строит графики.
        </p>
        <p
          className="manifesto-text"
          style={{
            fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif',
            fontSize: 'clamp(32px, 4.8vw, 72px)',
            lineHeight: 1.18,
            letterSpacing: '-0.03em',
            color: FG,
            margin: '40px 0 0',
            fontWeight: 800,
          }}
        >
          <span style={{ color: SIGMA, fontWeight: 800 }}>Sigma</span>{' '}
          <span style={{ color: FG_DIM }}>→</span>{' '}
          <span className="manifesto-highlight">разбирает их за тебя</span>{' '}
          и выполняет действия в кабинете{' '}
          <span style={{ color: WB_PURPLE }}>WB</span>.
        </p>
      </div>
    </section>
  );
}

const FEATURES = [
  {
    n: '01',
    label: 'Поставки',
    title: 'Что и сколько везти — Sigma считает за тебя',
    body: 'ИИ смотрит остатки, скорость продаж и сезонность → подсказывает склад, дату и объём. ROI с разбивкой по 7 статьям затрат — увидишь окупаемость до отгрузки. Для FBW открывает форму брони в ЛК WB с заполненными полями.',
  },
  {
    n: '02',
    label: 'Цена',
    title: 'Репрайс с защитой от убытка',
    body: 'Каждый час пересчитывает цену по твоим правилам min/max, марже и истории продаж. Считает, не уйдёшь ли в минус. Меняет цену в кабинете WB — только после твоего подтверждения в чате.',
  },
  {
    n: '03',
    label: 'А/Б-тесты',
    title: 'Фото, заголовок, описание — победитель за неделю',
    body: 'Грузишь 2–4 варианта → Sigma чередует их в карточке WB каждые 6 часов. Считает реальные открытия, CTR, заказы. Статистическая значимость — победитель без сомнений.',
  },
  {
    n: '04',
    label: 'Отзывы',
    title: 'Анализ отзывов и автоответ',
    body: 'Классифицирует тон каждого отзыва, выделяет повторяющиеся проблемы по партиям и характеристикам, эскалирует негатив. Готовит ответы в стиле твоего бренда. Ничего не публикуется без твоего подтверждения.',
  },
  {
    n: '05',
    label: 'Карточки',
    title: 'Аудит карточки и улучшение текста',
    body: 'Sigma считывает твою карточку, проверяет по чек-листу качества WB: заполненность характеристик, длина описания, ключи в названии. Предлагает новый заголовок, описание и недостающие параметры. Изменения — через официальный API кабинета WB.',
  },
  {
    n: '06',
    label: 'Финансы',
    title: 'ДДС, маржа и прогноз кассового разрыва',
    body: 'Тянет выручку, удержания и оплату хранения из отчётов WB — копейка в копейку с отчётом из ЛК. Прогноз баланса на 30 дней: увидишь приближение к нулю до того, как это случится.',
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
          № 04 / Что внутри
        </div>
        <div className="col-10">
          <h2 className="h2-mobile-tight" style={{ fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif', fontSize: 'clamp(40px, 5.6vw, 88px)', lineHeight: 1, margin: 0, fontWeight: 700, letterSpacing: '-0.03em' }}>
            Шесть зон, где <em style={{ color: SIGMA, fontStyle: 'normal', fontWeight: 800 }}>Sigma</em> делает работу за тебя.
          </h2>
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
              <span style={{ fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif', fontSize: '42px', color: FG_DIM, lineHeight: 0.9, fontWeight: 700 }}>
                {f.n}
              </span>
              <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.15em', color: FG_MUTED, fontWeight: 600 }}>
                {f.label}
              </span>
            </div>
            <div className="hide-mobile" />
            <div>
              <h3 style={{ fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif', fontSize: 'clamp(24px, 2.6vw, 40px)', lineHeight: 1.15, margin: 0, fontWeight: 700, letterSpacing: '-0.02em', color: FG }}>
                {f.title}
              </h3>
            </div>
            <div className="feature-body" style={{ fontSize: '14px', lineHeight: 1.6, color: FG_MUTED, fontWeight: 500 }}>
              {f.body}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

// ── Витрина интерфейса: три mock-блока в стилистике lendingV2 ──────────────
// Имитируем три ключевых экрана Pulse: РНП-таблица, KPI-плашки + мини-чарт ДДС,
// карточка действия AI. Стилистика mono/тёмная — чтобы не выбивалось из лендинга.
function UIShowcase() {
  return (
    <section
      id="ui"
      className="section-pad"
      style={{
        borderTop: `1px solid ${HAIRLINE}`,
        padding: '80px 24px',
      }}
    >
      <div className="grid-12" style={{ paddingBottom: '40px' }}>
        <div className="col-2" style={{ fontSize: '10px', color: FG_MUTED, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
          № 02 / Интерфейс
        </div>
        <div className="col-10">
          <h2 className="h2-mobile-tight" style={{ fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif', fontSize: 'clamp(40px, 5.4vw, 86px)', lineHeight: 1, margin: 0, fontWeight: 700, letterSpacing: '-0.03em' }}>
            Реально <em style={{ color: SIGMA, fontStyle: 'normal', fontWeight: 800 }}>работающие</em> инструменты.
          </h2>
          <p style={{ marginTop: '22px', fontSize: '16px', color: FG_MUTED, maxWidth: '600px', lineHeight: 1.55, fontWeight: 500 }}>
            Каждый блок — попробуй. Переключай, нажимай, выбирай. Так же это делает Sigma в твоём кабинете WB — только с реальными цифрами и подтверждением через ИИ.
          </p>
        </div>
      </div>

      <div
        className="ui-showcase-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '20px',
        }}
      >
        <UIShowcasePulseTable />
        <UIShowcaseKPI />
        <UIShowcaseAction />
        <UIShowcaseABTest />
      </div>
    </section>
  );
}

// Мокап 1 — Рука на пульсе: дневной/недельный разрез, переключатель работает
function UIShowcasePulseTable() {
  const [mode, setMode] = useState<'day' | 'week'>('day');
  // Демо-цифры — для иллюстрации. Не отражают реальных данных магазина.
  const dayData = [
    { m: 'Заказы (₽)', a: '180 000', b: '150 000' },
    { m: 'Выкупы (₽)', a: '25 000', b: '0' },
    { m: 'СПП (%)', a: '35,0', b: '40,0' },
    { m: 'Рекл. расход', a: '7 500', b: '500' },
    { m: 'ДРР (%)', a: '4,2', b: '0,3' },
    { m: 'Выплата (₽)', a: '95 000', b: '0' },
  ];
  const weekData = [
    { m: 'Заказы (₽)', a: '1 200 000', b: '900 000' },
    { m: 'Выкупы (₽)', a: '420 000', b: '300 000' },
    { m: 'СПП (%)', a: '36,0', b: '38,0' },
    { m: 'Рекл. расход', a: '50 000', b: '40 000' },
    { m: 'ДРР (%)', a: '4,5', b: '4,5' },
    { m: 'Выплата (₽)', a: '620 000', b: '480 000' },
  ];
  const data = mode === 'day' ? dayData : weekData;
  const colA = mode === 'day' ? '03.06' : 'нед 22';
  const colB = mode === 'day' ? '04.06' : 'нед 23';
  return (
    <UIMockCard caption="Рука на пульсе" subtitle={mode === 'day' ? 'по дням · 03–04 июн' : 'по неделям · 22–23'}>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
        {(['day', 'week'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              background: mode === m ? FG : 'transparent',
              color: mode === m ? BG : FG_MUTED,
              border: `1px solid ${mode === m ? FG : HAIRLINE}`,
              padding: '4px 12px',
              fontSize: '9px',
              textTransform: 'uppercase',
              letterSpacing: '0.15em',
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {m === 'day' ? 'День' : 'Неделя'}
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.7fr 0.7fr', fontSize: '11px', color: FG_MUTED, padding: '6px 0', borderBottom: `1px solid ${HAIRLINE}`, letterSpacing: '0.05em' }}>
        <span>МЕТРИКА</span>
        <span style={{ textAlign: 'right' }}>{colA}</span>
        <span style={{ textAlign: 'right' }}>{colB}</span>
      </div>
      {data.map((r) => (
        <div key={r.m} style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.7fr 0.7fr', fontSize: '12px', padding: '7px 0', borderBottom: `1px dashed ${HAIRLINE}`, color: FG }}>
          <span style={{ color: FG_MUTED }}>{r.m}</span>
          <span style={{ textAlign: 'right' }}>{r.a}</span>
          <span style={{ textAlign: 'right', color: FG_MUTED }}>{r.b}</span>
        </div>
      ))}
    </UIMockCard>
  );
}

// Мокап 2 — Финансы: переключатель месяца + KPI + мини-чарт ДДС
function UIShowcaseKPI() {
  const [month, setMonth] = useState<'apr' | 'may' | 'jun'>('may');
  const data = {
    apr: { kpi: [['Выручка', '3 200 000 ₽'], ['Чистая прибыль', '580 000 ₽'], ['Маржа', '18,0 %'], ['ДРР', '5,5 %']], bars: [44, 52, 60, 38, 71, 48, 55, 62, 70, 58, 49, 64] },
    may: { kpi: [['Выручка', '4 000 000 ₽'], ['Чистая прибыль', '760 000 ₽'], ['Маржа', '19,0 %'], ['ДРР', '5,0 %']], bars: [62, 48, 71, 55, 80, 44, 68, 90, 76, 58, 84, 92] },
    jun: { kpi: [['Выручка', '600 000 ₽'], ['Чистая прибыль', '110 000 ₽'], ['Маржа', '18,0 %'], ['ДРР', '5,8 %']], bars: [55, 38, 62, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  }[month];
  return (
    <UIMockCard caption="Финансы" subtitle={`${month === 'apr' ? 'Апрель' : month === 'may' ? 'Май' : 'Июнь'} 2026`}>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
        {(['apr', 'may', 'jun'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMonth(m)}
            style={{
              background: month === m ? FG : 'transparent',
              color: month === m ? BG : FG_MUTED,
              border: `1px solid ${month === m ? FG : HAIRLINE}`,
              padding: '4px 10px',
              fontSize: '9px',
              textTransform: 'uppercase',
              letterSpacing: '0.15em',
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {m === 'apr' ? 'Апр' : m === 'may' ? 'Май' : 'Июн'}
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 18px', paddingBottom: '16px', borderBottom: `1px solid ${HAIRLINE}` }}>
        {data.kpi.map(([l, v]) => (
          <div key={l}>
            <div style={{ fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.18em', color: FG_DIM }}>{l}</div>
            <div style={{ marginTop: '6px', fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif', fontSize: '20px', color: FG }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: '18px' }}>
        <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.15em', color: FG_MUTED, marginBottom: '10px' }}>ДДС / прогноз</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: '70px' }}>
          {data.bars.map((h, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: `${Math.max(h, 2)}%`,
                background: h === 0 ? `repeating-linear-gradient(135deg, ${FG_MUTED} 0 2px, transparent 2px 4px)` : FG,
                opacity: h === 0 ? 0.35 : 1,
                transition: 'height 0.4s ease, opacity 0.3s ease',
              }}
              title={`день ${i + 1}`}
            />
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '9px', color: FG_DIM, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          <span>01</span>
          <span>прогноз →</span>
        </div>
      </div>
    </UIMockCard>
  );
}

// Мокап 4 — A/B-тест: выбор победителя по фото с реальными показателями
function UIShowcaseABTest() {
  const [winner, setWinner] = useState<'A' | 'B' | null>(null);
  const variants = [
    { v: 'A' as const, ctr: '4,2', orders: '38', label: 'Фото · светлый фон' },
    { v: 'B' as const, ctr: '5,7', orders: '54', label: 'Фото · модель в кадре' },
  ];
  return (
    <UIMockCard caption="А/Б-тест фото" subtitle="Туфли женские · 14 дней · 95%">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
        {variants.map((it) => {
          const isWinner = winner === it.v;
          return (
            <button
              key={it.v}
              onClick={() => setWinner(it.v)}
              style={{
                background: isWinner ? 'rgba(74, 122, 42, 0.14)' : 'transparent',
                border: `1px solid ${isWinner ? '#4a7a2a' : HAIRLINE}`,
                padding: '12px',
                fontFamily: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'border-color 0.2s, background 0.2s',
              }}
            >
              <div style={{ fontSize: '11px', color: FG, marginBottom: '8px', letterSpacing: '0.05em' }}>Вариант {it.v}</div>
              <div style={{ fontSize: '10px', color: FG_MUTED, marginBottom: '10px', lineHeight: 1.4 }}>{it.label}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: FG }}>
                <span style={{ color: FG_DIM }}>CTR</span>
                <span style={{ fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif' }}>{it.ctr}%</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: FG, marginTop: '4px' }}>
                <span style={{ color: FG_DIM }}>Заказы</span>
                <span style={{ fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif' }}>{it.orders}</span>
              </div>
              {isWinner && (
                <div style={{ marginTop: '10px', fontSize: '9px', color: '#4a7a2a', textTransform: 'uppercase', letterSpacing: '0.18em' }}>
                  ✓ Победитель
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: '11px', color: FG_MUTED, lineHeight: 1.6 }}>
        {winner === null ? (
          <span>Выбери победителя — Sigma сменит фото в карточке.</span>
        ) : winner === 'B' ? (
          <span style={{ color: FG }}>Вариант B · уверенность 96%. <span style={{ color: '#4a7a2a' }}>+42% к заказам</span>. Применяю?</span>
        ) : (
          <span style={{ color: FG_MUTED }}>Вариант A · уверенность 64%. Возможна ошибка — продолжим тест ещё 7 дней?</span>
        )}
      </div>
    </UIMockCard>
  );
}

// Мокап 3 — карточка действия AI. Интерактивная: клик переключает
// состояние pending → applied / cancelled и обратно.
function UIShowcaseAction() {
  const [state, setState] = useState<'pending' | 'applied' | 'cancelled'>('pending');
  return (
    <UIMockCard
      caption="ИИ · действие"
      subtitle={state === 'pending' ? 'ждёт подтверждения' : state === 'applied' ? 'применено ✓' : 'отменено ✗'}
    >
      <div style={{ borderLeft: `2px solid ${SIGMA}`, paddingLeft: '14px', marginBottom: '16px' }}>
        <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.15em', color: FG_MUTED }}>Снижение цены</div>
        <div style={{ marginTop: '6px', fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif', fontSize: '18px', color: FG, lineHeight: 1.3, fontWeight: 600 }}>
          Наушники беспроводные TWS · −5%
        </div>
      </div>
      <div style={{ fontSize: '12px', color: FG_MUTED, lineHeight: 1.6, marginBottom: '14px' }}>
        Сейчас <span style={{ color: FG }}>1 500 ₽</span> · после <span style={{ color: FG }}>1 425 ₽</span><br />
        Маржа упадёт с 25% до <span style={{ color: FG }}>23%</span> — не уйдёшь в минус,
        <span style={{ color: '#4a7a2a' }}> +12 заказов в неделю</span> по прогнозу.
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', minHeight: '32px', flexWrap: 'wrap' }}>
        {state === 'pending' && (
          <>
            <button
              onClick={() => setState('applied')}
              style={{ background: SIGMA, color: '#ffffff', border: 'none', padding: '7px 16px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.12em', fontFamily: 'inherit', cursor: 'pointer', fontWeight: 600 }}
            >
              Применить
            </button>
            <button
              onClick={() => setState('cancelled')}
              style={{ background: 'transparent', color: FG_MUTED, border: `1px solid ${HAIRLINE}`, padding: '7px 16px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.12em', fontFamily: 'inherit', cursor: 'pointer' }}
            >
              Отменить
            </button>
          </>
        )}
        {state === 'applied' && (
          <>
            <span style={{ color: SUCCESS, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 600 }}>
              ✓ Цена обновлена в кабинете WB
            </span>
            <button
              onClick={() => setState('pending')}
              style={{ background: 'transparent', color: FG_DIM, border: `1px solid ${HAIRLINE}`, padding: '4px 10px', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.12em', fontFamily: 'inherit', cursor: 'pointer' }}
            >
              ↺
            </button>
          </>
        )}
        {state === 'cancelled' && (
          <>
            <span style={{ color: FG_MUTED, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.15em' }}>
              ✗ Цена осталась прежней
            </span>
            <button
              onClick={() => setState('pending')}
              style={{ background: 'transparent', color: FG_DIM, border: `1px solid ${HAIRLINE}`, padding: '4px 10px', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.12em', fontFamily: 'inherit', cursor: 'pointer' }}
            >
              ↺
            </button>
          </>
        )}
      </div>
      <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: `1px dashed ${HAIRLINE}`, fontSize: '10px', color: FG_DIM, letterSpacing: '0.08em' }}>
        Источник · Цены WB · подтверждение → отправка
      </div>
    </UIMockCard>
  );
}

function UIMockCard({ caption, subtitle, children }: { caption: string; subtitle: string; children: ReactNode }) {
  return (
    <div
      style={{
        border: `1px solid ${HAIRLINE}`,
        background: 'rgba(255, 250, 230, 0.55)',
        padding: '18px 18px 20px',
        fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', paddingBottom: '10px', borderBottom: `1px solid ${HAIRLINE}` }}>
        <span style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.15em', color: FG }}>{caption}</span>
        <span style={{ fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.15em', color: FG_DIM }}>{subtitle}</span>
      </div>
      {children}
    </div>
  );
}

function BigStatement() {
  return (
    <section
      className="big-statement"
      style={{
        padding: '90px 24px',
        textAlign: 'center',
        borderTop: `1px solid ${HAIRLINE}`,
      }}
    >
      <div style={{ fontSize: '10px', color: FG_MUTED, textTransform: 'uppercase', letterSpacing: '0.18em', marginBottom: '32px' }}>
        № 05 / Тезис
      </div>
      <h2
        style={{
          fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif',
          fontWeight: 600,
          fontSize: 'clamp(40px, 5.8vw, 92px)',
          lineHeight: 1.05,
          letterSpacing: '-0.03em',
          color: FG_MUTED,
          margin: '0 auto',
          maxWidth: '1100px',
        }}
      >
        Продавец на <span style={{ color: WB_PURPLE, fontWeight: 700 }}>WB</span> не должен{' '}
        <em style={{ color: FG, fontStyle: 'normal', fontWeight: 800 }}>учиться аналитике.</em><br />
        Он должен <em style={{ color: FG, fontStyle: 'normal', fontWeight: 800 }}>продавать.</em>
      </h2>
    </section>
  );
}

function PricingBlock() {
  const INCLUDED = [
    'ИИ-чат с 10+ типами действий в кабинете WB',
    'Аудит карточек, А/Б-тесты фото и текста',
    'Управление поставками (FBS/FBW) с ROI-прогнозом',
    'Черновики ответов на отзывы и вопросы',
    'Сводки: финансы, ДДС, остатки, выручка',
    'ИИ с вашими ключами — расходы напрямую у провайдера',
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
      <div className="price-num" style={{ fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif', fontSize: 'clamp(88px, 13vw, 220px)', lineHeight: 0.9, fontWeight: 800, letterSpacing: '-0.045em', color: FG }}>
        0 <em style={{ fontSize: '0.3em', color: FG_MUTED, fontStyle: 'normal', letterSpacing: '0', fontWeight: 600 }}>₽/мес</em>
      </div>
      <div className="pricing-subtitle" style={{ marginTop: '14px', fontSize: '11px', color: FG_DIM, textTransform: 'uppercase', letterSpacing: '0.18em' }}>
        Бесплатный сервис · Открытый исходный код
      </div>

      {/* Что входит */}
      <ul style={{ listStyle: 'none', padding: 0, margin: '50px auto 0', maxWidth: '480px', textAlign: 'left' }}>
        {INCLUDED.map((item, i) => (
          <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '10px 0', borderBottom: i < INCLUDED.length - 1 ? `1px solid ${HAIRLINE}` : 'none', fontSize: '13px', color: FG, lineHeight: 1.5 }}>
            <span style={{ color: FG_MUTED, fontFamily: 'var(--font-geist-mono), ui-monospace, monospace', fontSize: '11px', minWidth: '24px' }}>
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
          color: '#ffffff',
          background: SIGMA,
          textDecoration: 'none',
          fontSize: '11px',
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          fontWeight: 600,
          boxShadow: `0 3px 0 ${SIGMA_DARK}`,
        }}
      >
        Подключить магазин →
      </a>
      <div style={{ marginTop: '14px', fontSize: '10px', color: FG_DIM, textTransform: 'uppercase', letterSpacing: '0.15em' }}>
        Без подписки и привязки банковской карты
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
