'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuthReturnTo } from '@/lib/authEntry';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { apiFetch } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { CheckCircle2, Loader2, ShieldCheck, ExternalLink, Zap, XCircle } from 'lucide-react';

const SYNC_STAGES = [
  { key: 'initial-sync:cards', label: 'Карточки' },
  { key: 'initial-sync:orders-sales', label: 'Заказы/продажи' },
  { key: 'initial-sync:adv-spend', label: 'Реклама' },
  { key: 'initial-sync:adv-products', label: 'Реклама по товарам' },
  { key: 'initial-sync:finance', label: 'Финансы' },
  { key: 'initial-sync:funnel-history', label: 'Воронка (история)' },
  { key: 'initial-sync:funnel-products', label: 'Воронка (товары)' },
  { key: 'initial-sync:spp', label: 'SPP' },
  { key: 'initial-sync:stocks', label: 'Остатки' },
  { key: 'done', label: 'Готово' },
];

type OnboardingStatus = {
  status: 'no_shop' | 'syncing' | 'ready';
  stage?: string | null;
  cardsCount?: number;
  funnelCount?: number;
};

export default function OnboardingPage() {
  const router = useRouter();
  const workspaceId = useAuthStore((s) => s.workspaceId) ?? 0;

  const [step, setStep] = useState<'connect' | 'sync'>('connect');
  const [status, setStatus] = useState<OnboardingStatus | null>(null);

  const [shopName, setShopName] = useState('');
  const [wbApiKey, setWbApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);

  const currentStageIndex = useMemo(() => {
    if (!status?.stage) return 0;
    const idx = SYNC_STAGES.findIndex((s) => s.key === status.stage);
    return idx >= 0 ? idx : 0;
  }, [status?.stage]);

  const progress = useMemo(() => {
    if (status?.stage === 'done') return 100;
    return Math.min(100, Math.round(((currentStageIndex + 1) / SYNC_STAGES.length) * 100));
  }, [currentStageIndex, status?.stage]);

  async function loadStatus() {
    if (!workspaceId) return;
    const res = (await apiFetch(`/onboarding/${workspaceId}/status`, { skipShopId: true })) as OnboardingStatus;
    setStatus(res);
    if (res.status === 'ready') {
      const returnTo = getAuthReturnTo(new URLSearchParams(window.location.search).get('returnTo'));
      router.replace(returnTo ?? '/pulse');
    } else if (res.status === 'syncing') {
      setStep('sync');
    } else {
      setStep('connect');
    }
  }

  useEffect(() => {
    loadStatus().catch(() => setError('Не удалось проверить подключение магазина. Обновите страницу.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    if (step !== 'sync') return;
    const t = setInterval(() => { loadStatus().catch(() => setError('Не удалось обновить состояние синхронизации.')); }, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, workspaceId]);



  async function validateAndSave() {
    setError(null);
    if (!wbApiKey.trim()) {
      setError('Введите API‑токен');
      return;
    }
    if (!shopName.trim()) {
      setError('Введите название магазина');
      return;
    }

    setValidating(true);
    try {
      await apiFetch('/shops/validate-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wbApiKey: wbApiKey.trim() }),
      });
    } catch (e: any) {
      setError(String(e?.message ?? 'Ошибка проверки токена'));
      setValidating(false);
      return;
    }

    setValidating(false);
    setSaving(true);
    try {
      await apiFetch(`/shops/${workspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: shopName.trim(),
          platform: 'wb',
          apiKey: wbApiKey.trim(),
          taxRegime: 'usn15',
          vatPct: 0,
        }),
      });
      setStep('sync');
    } catch (e: any) {
      setError(String(e?.message ?? 'Не удалось сохранить магазин'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell title="Подключение магазина">
      <div className="mx-auto max-w-[720px] p-6 space-y-6">


        {step === 'connect' && (
          <Card>
            <div className="p-6 space-y-4">
              <div className="text-sm font-semibold">Шаг 1 — подключите Wildberries</div>
              <div className="rounded-lg border border-blue-100 bg-blue-50/50 p-3 text-xs text-blue-700">
                <div className="flex items-start gap-2">
                  <ShieldCheck className="h-4 w-4 mt-0.5 text-blue-500" />
                  <div className="leading-relaxed">
                    <span className="font-medium">Где взять токен?</span> Перейдите в{' '}
                    <a
                      href="https://seller.wildberries.ru/supplier-settings/access-to-api"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium underline"
                    >
                      Кабинет WB → Настройки → Доступ к API <ExternalLink className="h-3 w-3" />
                    </a>
                    . Создайте токен с <span className="font-medium">полным доступом</span> — отметьте все категории (Контент, Статистика, Аналитика, Цены и скидки, Маркетплейс, Реклама, Поставки, Отзывы, Финансы). Токена только со «Статистикой» недостаточно.
                  </div>
                </div>
              </div>
              <label className="grid gap-1 text-xs text-neutral-400">
                Название магазина
                <Input value={shopName} onChange={(e) => setShopName(e.target.value)} placeholder="Например: ИП Иванов" />
              </label>
              <label className="grid gap-1 text-xs text-neutral-400">
                API‑токен WB
                <textarea
                  className="flex w-full rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--content-text)] placeholder:text-[var(--content-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
                  rows={3}
                  value={wbApiKey}
                  onChange={(e) => setWbApiKey(e.target.value)}
                  placeholder="eyJhbGciOi..."
                />
              </label>
              {error && (
                <div className="flex items-center gap-2 text-xs text-red-500">
                  <XCircle className="h-4 w-4" /> {error}
                </div>
              )}
              <div className="flex items-center gap-3">
                <Button onClick={validateAndSave} disabled={validating || saving} loading={validating || saving}>
                  <Zap className="h-4 w-4" /> Подключить
                </Button>
              </div>
            </div>
          </Card>
        )}

        {step === 'sync' && (
          <Card>
            <div className="p-6 space-y-4">
              <div className="text-sm font-semibold">Шаг 2 — синхронизация данных</div>
              <div className="text-xs text-neutral-400">Данные загружаются в фоне. Это может занять несколько минут.</div>

              <div className="h-2 w-full rounded-full bg-neutral-900">
                <div className="h-2 rounded-full bg-indigo-500" style={{ width: `${progress}%` }} />
              </div>
              <div className="text-xs text-neutral-500">{status?.stage ?? 'Подготовка…'}</div>

              <div className="grid gap-2 text-xs text-neutral-400">
                {SYNC_STAGES.map((s, idx) => (
                  <div key={s.key} className="flex items-center gap-2">
                    {status?.stage === s.key || (idx < currentStageIndex && status?.stage !== 'done') ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    ) : idx === currentStageIndex ? (
                      <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
                    ) : (
                      <div className="h-4 w-4 rounded-full border border-neutral-700" />
                    )}
                    <span>{s.label}</span>
                  </div>
                ))}
              </div>

              <div className="text-xs text-neutral-500">
                Карточек: {status?.cardsCount ?? 0} · Воронка: {status?.funnelCount ?? 0}
              </div>
            </div>
          </Card>
        )}


      </div>
    </AppShell>
  );
}
