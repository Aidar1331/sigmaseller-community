import type { Metadata } from 'next';
import { Playfair_Display } from 'next/font/google';

// Playfair Display нужен только для Σ-логотипа в intro-splash (CRT-эстетика).
// Основной контент использует Geist (из root layout).
const serif = Playfair_Display({
  variable: '--font-fraunces',
  subsets: ['latin', 'cyrillic'],
  weight: ['400'],
});

export const metadata: Metadata = {
  title: 'Sigma Seller — Editorial Preview',
  description: 'Sigma Seller — версия лендинга в editorial-стиле для оценки',
};

export default function LandingV2Layout({ children }: { children: React.ReactNode }) {
  return <div className={serif.variable}>{children}</div>;
}
