import type { Metadata } from 'next';
import { Playfair_Display, JetBrains_Mono } from 'next/font/google';

// Playfair Display: serif с поддержкой cyrillic.
const serif = Playfair_Display({
  variable: '--font-fraunces-v4',
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '700', '900'],
  style: ['normal', 'italic'],
});

// JetBrains Mono: моноширинный, cyrillic.
const mono = JetBrains_Mono({
  variable: '--font-mono-v4',
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500'],
});

export const metadata: Metadata = {
  title: 'Sigma Seller — Paper Edition',
  description: 'Sigma Seller — paper/editorial вариант лендинга',
};

export default function LandingV4Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${serif.variable} ${mono.variable}`}>
      {children}
    </div>
  );
}
