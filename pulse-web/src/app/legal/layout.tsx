import type { ReactNode } from 'react';
import Link from 'next/link';
import { Rocket, ArrowLeft } from 'lucide-react';

/**
 * Wrapper layout for /legal/* pages (oferta, privacy). Mirrors the public
 * landing's header so an unauth visitor stays in the same visual context.
 * Prose styling is intentionally plain — these are legal documents, not
 * marketing pages.
 */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-100 bg-white/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-gray-900 hover:opacity-80">
            <div className="h-9 w-9 rounded-lg bg-indigo-600 text-white grid place-items-center">
              <span className="text-xl font-bold leading-none" style={{ fontFamily: 'serif' }}>Σ</span>
            </div>
            <span className="text-lg font-semibold">Sigma Seller</span>
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-sm text-gray-700 hover:text-indigo-700"
          >
            <ArrowLeft className="h-4 w-4" />
            На главную
          </Link>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-4 py-10 sm:py-14">
        <article className="prose prose-gray max-w-none prose-headings:scroll-mt-20 prose-h1:text-3xl prose-h1:font-bold prose-h2:text-xl prose-h2:font-semibold prose-h3:text-base prose-h3:font-semibold prose-p:text-gray-700 prose-li:text-gray-700">
          {children}
        </article>
      </main>
      <footer className="border-t border-gray-100 py-6 mt-10">
        <div className="max-w-4xl mx-auto px-4 text-sm text-gray-500 flex flex-col sm:flex-row gap-2 sm:gap-4 sm:items-center sm:justify-between">
          <div>© {new Date().getFullYear()} Sigma Seller</div>
          <div className="flex gap-4">
            <Link href="/legal/terms" className="hover:text-gray-900">Оферта</Link>
            <Link href="/legal/privacy" className="hover:text-gray-900">Политика</Link>
            <a href="mailto:support@example.com" target="_blank" rel="noreferrer" className="hover:text-gray-900">Telegram</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
