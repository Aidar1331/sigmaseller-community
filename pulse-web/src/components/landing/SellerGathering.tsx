'use client';

import { useEffect, useRef, type CSSProperties, type RefObject } from 'react';
import styles from './SellerGathering.module.css';

const features = [
  { kind: 'sales', label: 'Продажи' },
  { kind: 'stock', label: 'Остатки' },
  { kind: 'finance', label: 'Финансы' },
  { kind: 'reviews', label: 'Отзывы' },
  { kind: 'ai', label: 'ИИ' },
] as const;
type Kind = typeof features[number]['kind'];

function FeatureArt({ kind }: { kind: Kind }) {
  return <span className={`${styles.art} ${styles[kind]}`}>
    <svg viewBox="0 0 100 100" fill="none" aria-hidden="true">
      {kind === 'sales' && <>
        <path d="M15 81 85 87 91 25 26 15Z" fill="#8B165E" opacity=".25" />
        <path d="M19 18 86 24 80 80 13 74Z" fill="#FFF6FE" />
        <path d="m28 60 8 1 2-19-8-1Zm16 2 8 1 3-30-8-1Zm16 2 8 1 4-40-8-1Z" fill="#D5319A" />
        <path d="m23 39 15-9 13 3 22-17m-11 0h11v11" stroke="#5E26C5" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="81" cy="76" r="14" fill="#FFD662" /><path d="m75 76 4 4 8-9" stroke="#64320C" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </>}
      {kind === 'stock' && <>
        <ellipse cx="50" cy="83" rx="33" ry="8" fill="#944206" opacity=".2" />
        <path d="m18 40 32 12v34L18 72Z" fill="#E8852A" /><path d="m50 52 33-13v33L50 86Z" fill="#B55021" />
        <path d="m18 40 32-16 33 15-33 13Z" fill="#FFE7AF" />
        <path d="m18 40-9-14 32-15 9 13Zm32-16 10-13 32 15-9 13Z" fill="#FFF1CD" />
        <path d="m18 40 32 12-9 15L9 52Zm32 12 33-13 9 13-32 15Z" fill="#FFC96E" />
        <path d="m60 66 14-6v9l-14 6Z" fill="#FFE9B9" />
        <circle cx="72" cy="21" r="11" fill="#32D6C1" /><path d="m68 21 3 3 6-7" stroke="#064C44" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </>}
      {kind === 'finance' && <>
        <path d="m13 39 57-15 16 47-57 15Z" fill="#086D83" opacity=".35" />
        <rect x="16" y="36" width="69" height="44" rx="10" fill="#136078" transform="rotate(-8 16 36)" />
        <rect x="17" y="30" width="67" height="42" rx="9" fill="#EBFFFA" transform="rotate(-8 17 30)" />
        <path d="m67 42 22-3 3 21-22 3a7 7 0 0 1-8-6l-1-7a7 7 0 0 1 6-8Z" fill="#186E8B" /><circle cx="73" cy="51" r="3" fill="#D9FFF7" />
        <circle cx="40" cy="30" r="21" fill="#D58A12" /><circle cx="40" cy="26" r="21" fill="#FFDC6E" />
        <text x="40" y="36" textAnchor="middle" fill="#79510E" fontFamily="Arial, sans-serif" fontSize="29" fontWeight="700">₽</text>
      </>}
      {kind === 'reviews' && <>
        <path d="M19 28a12 12 0 0 1 12-12h46a12 12 0 0 1 12 12v31a12 12 0 0 1-12 12H46L27 85V71a12 12 0 0 1-8-12Z" fill="#956624" opacity=".24" />
        <path d="M12 24a12 12 0 0 1 12-12h46a12 12 0 0 1 12 12v31a12 12 0 0 1-12 12H40L21 80V67a12 12 0 0 1-9-12Z" fill="#FFFDF1" />
        <path d="m30 31 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Zm30 0 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z" fill="#EBA900" />
        <circle cx="76" cy="74" r="17" fill="#E7479C" /><path d="M76 82c-13-7-10-17-4-15 2 0 3 2 4 3 1-1 2-3 4-3 6-2 9 8-4 15Z" fill="white" />
      </>}
      {kind === 'ai' && <>
        <ellipse cx="50" cy="52" rx="39" ry="16" stroke="#D3B8FF" strokeWidth="2" transform="rotate(-33 50 52)" />
        <ellipse cx="50" cy="52" rx="36" ry="15" stroke="#D3B8FF" strokeWidth="2" transform="rotate(38 50 52)" />
        <path d="m51 14 9 26 25 10-25 10-9 26-10-26-25-10 25-10Z" fill="#41117C" opacity=".35" transform="translate(3 5)" />
        <path d="m48 11 9 26 25 10-25 10-9 26-10-26-25-10 25-10Z" fill="#FFF2FF" />
        <path d="m48 29 5 14 13 4-13 5-5 14-5-14-13-5 13-4Z" fill="#F097E0" />
        <circle cx="77" cy="21" r="6" fill="#FFDC6E" /><circle cx="16" cy="72" r="5" fill="#68F2DA" />
      </>}
    </svg>
  </span>;
}

function FeatureSlot({ index, small = false }: { index: number; small?: boolean }) {
  return <span className={`${styles.slot}${small ? ` ${styles.smallSlot}` : ''}`} data-flight-source={index} aria-hidden="true">
    <span className={styles.sourceArt}><FeatureArt kind={features[index].kind} /></span>
  </span>;
}

export function SellerHeadline() {
  return <h1 id="start-title" className={styles.headline} aria-label="ИИ-помощник продавца Wildberries">
    <span className={styles.phrase}><span className={styles.word}>ИИ-помощник</span>{' '}<FeatureSlot index={4} /></span>{' '}
    <span className={styles.word} style={{ '--word': 1 } as CSSProperties}>продавца</span>{' '}
    <span className={styles.word} style={{ '--word': 2 } as CSSProperties}>Wildberries</span>
  </h1>;
}

export function SellerDescription() {
  return <p data-seller-description>
    Анализирует <span className={styles.phrase}>кабинет <FeatureSlot index={0} small /></span>, готовит решения по{' '}
    <span className={styles.phrase}>цене <FeatureSlot index={2} small /></span>,{' '}
    <span className={styles.phrase}>поставкам <FeatureSlot index={1} small /></span>, карточкам и{' '}
    <span className={styles.phrase}>отзывам <FeatureSlot index={3} small /></span>.{' '}
    Ты подтверждаешь — Sigma выполняет.
  </p>;
}

export function SellerPanel() {
  return <section className={styles.scene} aria-label="Инструменты Sigma Seller в одном кабинете" data-seller-panel>
    <div className={styles.panel}>
      <div className={styles.panelHeader}><span className={styles.panelBrand}><span aria-hidden="true">Σ</span> Ваш кабинет</span><span className={styles.panelNote}>Sigma Seller</span></div>
      <div className={styles.track}>
        {features.map((feature, index) => <div className={styles.cell} key={feature.kind}>
          <span className={styles.target} data-flight-target={index}><span className={styles.targetArt}><FeatureArt kind={feature.kind} /></span></span>
          <span className={styles.cellLabel}>{feature.label}</span>
        </div>)}
      </div>
      <p className={styles.panelCaption}>От цифр и остатков — к решениям и действиям.</p>
    </div>
  </section>;
}

/** Recreates the supplied reference's slot-to-panel flight without scroll hijacking or CDN dependencies. */
export function SellerGathering({ rootRef }: { rootRef: RefObject<HTMLElement | null> }) {
  const layerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    const layer = layerRef.current;
    if (!root || !layer) return;
    const sources = Array.from(root.querySelectorAll<HTMLElement>('[data-flight-source]'))
      .sort((a, b) => Number(a.dataset.flightSource) - Number(b.dataset.flightSource));
    const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-flight-target]'));
    const tiles = Array.from(layer.children) as HTMLElement[];
    const panel = root.querySelector<HTMLElement>('[data-seller-panel]');
    if (!panel || sources.length !== 5 || targets.length !== 5) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const compact = window.matchMedia('(max-width: 760px)');
    let frame = 0, alive = true, needsMeasure = true, progress = -1;
    let start = 0, end = 1, mobile = false;
    let points: { sx: number; sy: number; sw: number; tx: number; ty: number; tw: number }[] = [];
    const clamp = (value: number) => Math.min(1, Math.max(0, value));

    function draw() {
      frame = 0;
      if (!alive) return;
      if (reduced.matches) {
        root!.removeAttribute('data-flight-ready');
        root!.removeAttribute('data-flight-progress');
        progress = -1;
        return;
      }
      if (needsMeasure) {
        needsMeasure = false;
        mobile = compact.matches;
        const origin = root!.getBoundingClientRect();
        points = targets.map((target, index) => {
          const to = target.getBoundingClientRect(), from = sources[index].getBoundingClientRect();
          return { sx: mobile ? to.left - origin.left : from.left - origin.left,
            sy: mobile ? to.top - origin.top - 65 - index * 7 : from.top - origin.top,
            sw: mobile ? to.width * .65 : from.width,
            tx: to.left - origin.left, ty: to.top - origin.top, tw: to.width };
        });
        const panelTop = panel!.getBoundingClientRect().top + window.scrollY;
        start = mobile ? panelTop - window.innerHeight * .87 : Math.max(0, origin.top + window.scrollY - 160);
        end = mobile ? panelTop - window.innerHeight * .4 : Math.max(start + 180, panelTop - 180);
        root!.setAttribute('data-flight-ready', mobile ? 'compact' : 'full');
        progress = -1;
      }
      const goal = clamp((window.scrollY - start) / Math.max(1, end - start));
      progress = progress < 0 ? goal : progress + (goal - progress) * .18;
      if (Math.abs(goal - progress) < .001) progress = goal;
      points.forEach((point, index) => {
        const part = clamp((progress * 1.32 - index * .08));
        const eased = part * part * (3 - 2 * part);
        const arc = Math.sin(eased * Math.PI);
        const x = point.sx + (point.tx - point.sx) * eased + arc * (index % 2 ? 14 : -14);
        const y = point.sy + (point.ty - point.sy) * eased;
        const scale = (point.sw + (point.tw - point.sw) * eased) / 80;
        tiles[index].style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${arc * (index % 2 ? -12 : 12)}deg) scale(${scale})`;
        tiles[index].style.opacity = mobile ? String(clamp(part * 4)) : '1';
      });
      root!.setAttribute('data-flight-progress', progress.toFixed(3));
      if (progress !== goal) frame = requestAnimationFrame(draw);
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(draw); }
    function measure() { needsMeasure = true; schedule(); }
    function visibility() { if (!document.hidden) measure(); else { cancelAnimationFrame(frame); frame = 0; } }
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', measure);
    document.addEventListener('visibilitychange', visibility);
    reduced.addEventListener('change', measure);
    compact.addEventListener('change', measure);
    void document.fonts.ready.then(() => { if (alive) measure(); });
    measure();
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', measure);
      document.removeEventListener('visibilitychange', visibility);
      reduced.removeEventListener('change', measure);
      compact.removeEventListener('change', measure);
      root.removeAttribute('data-flight-ready');
      root.removeAttribute('data-flight-progress');
    };
  }, [rootRef]);

  return <div className={styles.flightLayer} ref={layerRef} aria-hidden="true">
    {features.map(feature => <span key={feature.kind} className={styles.flyingTile}><FeatureArt kind={feature.kind} /></span>)}
  </div>;
}
