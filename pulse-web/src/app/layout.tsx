import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Providers } from '@/components/Providers';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const SITE_URL = 'https://sigmaseller.ru';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Sigma Seller — бесплатный кабинет продавца Wildberries',
    template: '%s · Sigma Seller',
  },
  description:
    'Продажи, остатки, финансы, отзывы и карточки Wildberries в одном бесплатном кабинете. Создайте аккаунт и подключите магазин. ИИ доступен с ключом продавца.',
  keywords: [
    'Wildberries',
    'аналитика Wildberries',
    'AI Wildberries',
    'автоматизация Wildberries',
    'биддер Wildberries',
    'A/B тесты Wildberries',
    'поставки Wildberries',
    'отзывы Wildberries',
    'аудит карточек WB',
  ],
  alternates: {
    canonical: SITE_URL,
  },
  openGraph: {
    type: 'website',
    locale: 'ru_RU',
    url: SITE_URL,
    siteName: 'Sigma Seller',
    title: 'Sigma Seller — ваш магазин WB в одном кабинете',
    description:
      'Бесплатный кабинет продавца Wildberries: продажи, остатки, финансы, отзывы и карточки. Регистрация и инструкция на одной странице.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Sigma Seller — ваш магазин WB в одном кабинете',
    description:
      'Бесплатный кабинет продавца Wildberries. Создайте аккаунт и подключите магазин. ИИ-функции используют ключи продавца.',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  // Verification теги для Яндекс.Вебмастера и Google Search Console.
  // оператор добавит реальные строки когда подключит панели.
  // verification: { yandex: 'XXXXXX', google: 'XXXXXX' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
