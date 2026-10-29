'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { RecoveryCodeNotice } from './RecoveryCodeNotice';
export function AccountRecoveryForm({ reset = false }: { reset?: boolean }) {
  const router = useRouter(); const [email, setEmail] = useState(''); const [code, setCode] = useState('');
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState('');
  const [result, setResult] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const inputClass = 'mt-1 block w-full rounded-lg border p-3 text-base';
  if (result) return <><p role="status" className="mb-3">{reset ? 'Пароль изменён. Все старые сеансы завершены.' : 'Новый код создан.'}</p><RecoveryCodeNotice code={result} onContinue={() => reset ? router.push('/auth/login') : setResult('')} /></>;
  return <form className="space-y-4 rounded-xl border bg-white p-5" onSubmit={async e => {
    e.preventDefault(); setError(''); if (reset && password !== confirmation) { setError('Пароли не совпадают'); return; } setBusy(true);
    try { const r = await apiFetch<{ recoveryCode: string }>(reset ? '/auth/reset-with-code' : '/auth/recovery-code', { method: 'POST', skipShopId: true, skipWorkspaceId: true, body: JSON.stringify(reset ? { email: email.trim(), recoveryCode: code, password } : { password }) }); if (reset) useAuthStore.getState().logout(); setResult(r.recoveryCode); setPassword(''); setConfirmation(''); setCode(''); }
    catch (err) { setError(err instanceof Error ? err.message : 'Не удалось выполнить запрос'); }
    finally { setBusy(false); }
  }}><p className="text-sm leading-6">{reset ? 'Введите код, сохранённый при регистрации или в настройках безопасности. Письма для восстановления не отправляются.' : 'Создайте код для восстановления пароля без почты. Новый код отменит предыдущий.'}</p>
    {reset && <><label className="block text-sm">Email<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} className={inputClass} /></label><label className="block text-sm">Код восстановления<input type="password" autoComplete="off" required value={code} onChange={e => setCode(e.target.value)} className={inputClass} /></label></>}
    <label className="block text-sm">{reset ? 'Новый пароль' : 'Текущий пароль'}<input type="password" autoComplete={reset ? 'new-password' : 'current-password'} required minLength={reset ? 8 : 1} value={password} onChange={e => setPassword(e.target.value)} className={inputClass} /></label>
    {reset && <label className="block text-sm">Повторите пароль<input type="password" autoComplete="new-password" required minLength={8} value={confirmation} onChange={e => setConfirmation(e.target.value)} className={inputClass} /></label>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button disabled={busy} className="w-full rounded-lg bg-indigo-600 p-3 text-white disabled:opacity-40">{busy ? 'Проверка…' : reset ? 'Изменить пароль' : 'Создать новый код'}</button>
    {reset && <p className="text-xs leading-5 text-gray-500">Если код потерян, но вы ещё вошли в аккаунт и знаете пароль, создайте новый в настройках безопасности. Иначе обратитесь в поддержку для проверки владения аккаунтом.</p>}
  </form>;
}
