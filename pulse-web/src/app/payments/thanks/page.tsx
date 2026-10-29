'use client';

import Link from 'next/link';
import { AppShell } from '@/components/AppShell';

export default function PaymentThanksPage() {
  return (
    <AppShell title="Спасибо за оплату">
      <div className="p-6">
        <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-6">
          <div className="text-lg font-semibold text-emerald-200">Оплата прошла успешно</div>
          <div className="mt-2 text-sm text-emerald-100/80">
            Подписка активирована. Ниже короткая инструкция, как начать работу.
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
            <div className="text-sm font-medium">1. Подключите магазины</div>
            <div className="mt-2 text-sm text-neutral-400">
              Перейдите в раздел «Магазины» и добавьте WB/Ozon/ЯМ с API‑ключами.
            </div>
            <div className="mt-3">
              <Link className="text-sm text-neutral-200 underline" href="/shops">
                Открыть «Магазины» →
              </Link>
            </div>
          </div>

          <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
            <div className="text-sm font-medium">2. Проверьте данные</div>
            <div className="mt-2 text-sm text-neutral-400">
              После синхронизации откройте «Рука на пульсе» и «Динамика», чтобы увидеть метрики.
            </div>
            <div className="mt-3 space-x-3">
              <Link className="text-sm text-neutral-200 underline" href="/pulse">
                Рука на пульсе →
              </Link>
              <Link className="text-sm text-neutral-200 underline" href="/dynamics">
                Динамика →
              </Link>
            </div>
          </div>

          <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
            <div className="text-sm font-medium">3. Настройте план и себестоимость</div>
            <div className="mt-2 text-sm text-neutral-400">
              Это влияет на план‑факт и юнит‑экономику.
            </div>
            <div className="mt-3 space-x-3">
              <Link className="text-sm text-neutral-200 underline" href="/plan">
                План →
              </Link>
              <Link className="text-sm text-neutral-200 underline" href="/cogs">
                Себестоимость →
              </Link>
            </div>
          </div>

          <div className="rounded-lg border border-neutral-900 bg-neutral-950 p-4">
            <div className="text-sm font-medium">Нужна помощь?</div>
            <div className="mt-2 text-sm text-neutral-400">
              Напишите в поддержку — поможем подключиться и разобраться с метриками.
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
