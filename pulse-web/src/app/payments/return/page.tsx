'use client';

import Link from 'next/link';
import { AppShell } from '@/components/AppShell';

export default function PaymentReturnPage() {
  return (
    <AppShell title="Оплата не завершена">
      <div className="p-6">
        <div className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-6">
          <div className="text-lg font-semibold text-amber-200">Платёж не был завершён</div>
          <div className="mt-2 text-sm text-amber-100/80">
            Если возникла ошибка — попробуйте ещё раз или свяжитесь с поддержкой.
          </div>
        </div>

        <div className="mt-6 rounded-lg border border-neutral-900 bg-neutral-950 p-4">
          <div className="text-sm text-neutral-400">
            Вернитесь в раздел «Подписки и платежи», чтобы повторить оплату.
          </div>
          <div className="mt-3">
            <Link className="text-sm text-neutral-200 underline" href="/subscriptions">
              Перейти к подпискам →
            </Link>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
