'use client';
import { useState } from 'react';
export function RecoveryCodeNotice({ code, onContinue }: { code: string; onContinue: () => void }) {
  const [saved, setSaved] = useState(false);
  return <section className="rounded-2xl border bg-white p-6 text-gray-900"><h2 className="text-xl font-semibold">Сохраните код восстановления</h2>
    <p className="mt-3 text-sm leading-6">Код понадобится, если вы забудете пароль. Почтовой рассылки нет. Сохраните его в менеджере паролей и никому не передавайте. Он показывается один раз; предыдущий код больше не действует.</p>
    <code className="my-5 block break-all rounded-lg bg-gray-100 p-4 font-mono text-base select-all">{code}</code>
    <label className="my-4 flex gap-2 text-sm"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />Я сохранил код в безопасном месте</label>
    <button disabled={!saved} onClick={onContinue} className="w-full rounded-lg bg-indigo-600 p-3 text-white disabled:opacity-40">Продолжить</button></section>;
}
