'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';

type Provider = { provider: string; label: string; features: string; keyUrl: string; configured: boolean; maskedKey: string | null };
type Settings = { providers: Provider[]; canManage: boolean; automationMode?: 'manual' | 'enabled' };

function ProviderCard({ item, workspaceId, canManage }: { item: Provider; workspaceId: number; canManage: boolean }) {
  const [provider, setProvider] = useState(item);
  const [key, setKey] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function update(remove: boolean) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await apiFetch<{ providers: Provider[] }>(`/ai/${workspaceId}/providers/${provider.provider}`, {
        method: remove ? 'DELETE' : 'PUT',
        ...(remove ? {} : { body: JSON.stringify({ apiKey: key.trim(), acceptProviderCharges: accepted }) }),
      });
      setProvider(result.providers.find(p => p.provider === provider.provider)!);
      setKey(''); setAccepted(false);
      setNotice(remove ? 'Ключ удалён. Новые запросы к провайдеру остановлены.' : 'Ключ сохранён. Проверка с платным запросом не выполнялась.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось сохранить настройку'); }
    finally { setBusy(false); }
  }

  return <section className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
    <div className="flex items-start justify-between gap-3">
      <div><h2 className="font-semibold text-gray-900 dark:text-white">{provider.label}</h2><p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{provider.features}</p></div>
      <span className={`shrink-0 rounded-full px-2 py-1 text-xs ${provider.configured ? 'bg-green-50 text-green-800' : 'bg-gray-100 text-gray-600'}`}>{provider.configured ? 'Сохранён' : 'Нет ключа'}</span>
    </div>
    {provider.maskedKey && <p className="mt-3 font-mono text-sm text-gray-500">{provider.maskedKey}</p>}
    {canManage && <form className="mt-4 space-y-3" onSubmit={e => { e.preventDefault(); void update(false); }}>
      <label className="block text-sm font-medium">{provider.configured ? 'Заменить ключ' : 'Ваш API-ключ'}
        <input aria-label={`API-ключ ${provider.label}`} type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} maxLength={4096} disabled={busy} className="mt-1 block w-full rounded-lg border border-gray-300 bg-transparent px-3 py-2 text-base" placeholder="Вставьте ключ провайдера" />
      </label>
      <label className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400"><input className="mt-1" type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} disabled={busy} /><span>Подключаю свой ключ. Запросы команды и включённых автоматизаций могут расходовать мой баланс у провайдера. Лимит расходов настраиваю у провайдера.</span></label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy || !accepted || key.trim().length < 10} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{busy ? 'Сохранение…' : 'Сохранить ключ'}</button>
        <a href={provider.keyUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-indigo-600 underline">Получить ключ</a>
        {provider.configured && <button type="button" disabled={busy} onClick={() => void update(true)} className="ml-auto px-2 py-2 text-sm text-red-700 disabled:opacity-40">Удалить</button>}
      </div>
    </form>}
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="mt-3 text-sm text-green-700">{notice}</p>}
  </section>;
}

function WorkspaceSettings({ workspaceId }: { workspaceId: number }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    apiFetch<Settings>(`/ai/${workspaceId}/providers`).then(r => { if (active) setSettings(r); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [workspaceId]);
  if (error) return <p role="alert" className="text-red-700">{error}</p>;
  if (!settings) return <p role="status">Загружаем настройки…</p>;
  return <>{settings.automationMode === 'manual' && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">Автоматические изменения цен, фото, рекламы и автоответы на этом сервере пока выключены. Синхронизация и задачи, которые вы запускаете сами, доступны.</p>}{!settings.canManage && <p className="mb-4 text-sm">Подключать и удалять ключи может владелец магазина.</p>}<div className="grid gap-4 lg:grid-cols-2">{settings.providers.map(p => <ProviderCard key={p.provider} item={p} workspaceId={workspaceId} canManage={settings.canManage} />)}</div></>;
}

export default function AiSettingsPage() {
  const workspaceId = useWorkspaceStore(s => s.workspaceId);
  return <AppShell><main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
    <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold">Настройки ИИ</h1><Link href="/connections" className="text-sm text-indigo-600 underline">Подключить ChatGPT / Claude</Link><Link href="/settings/team" className="text-sm text-indigo-600 underline">Команда и доступ</Link><Link href="/settings/security" className="text-sm text-indigo-600 underline">Код восстановления</Link></div>
    <div className="rounded-2xl bg-indigo-50 p-5 text-indigo-950 dark:bg-indigo-950 dark:text-indigo-100">
      <h2 className="font-semibold">Sigma Seller бесплатный. ИИ — с вашими ключами.</h2>
      <p className="mt-2 text-sm leading-6">Подписки и пополнения баланса Sigma Seller нет. Подключите только нужные провайдеры: для чата, агентов и ответов на отзывы начните с Anthropic. Генерация фото и видео подключается отдельно. Условия и доступность услуг определяет провайдер.</p>
      <p className="mt-2 text-sm leading-6">Ключи хранятся на сервере в зашифрованном виде и относятся к выбранному магазину. Аналитика и обычные инструменты работают без ключа ИИ. Удаление ключа прекращает новые запросы; уже отправленный запрос может быть оплачен.</p>
    </div>
    {workspaceId ? <WorkspaceSettings key={workspaceId} workspaceId={workspaceId} /> : <p>Сначала выберите или подключите магазин.</p>}
  </main></AppShell>;
}
