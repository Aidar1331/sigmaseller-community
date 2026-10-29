'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { RecoveryCodeNotice } from '@/components/RecoveryCodeNotice';
import { ServiceGuide } from './ServiceGuide';
import { SellerGathering, SellerHeadline, SellerDescription, SellerPanel } from './SellerGathering';
import { apiFetch } from '@/lib/api';
import { authEntryHref, type AuthEntryMode } from '@/lib/authEntry';
import { useAuthStore } from '@/store/auth';
import { useWorkspaceStore } from '@/store/workspace';
import styles from './StartPage.module.css';

const REGISTRATION_DISABLED = process.env.NEXT_PUBLIC_REGISTRATION_DISABLED === '1';
type User = { userId: number; email: string };

export function StartPage({ initialMode = 'register', returnTo = null }: { initialMode?: AuthEntryMode; returnTo?: string | null }) {
  const router = useRouter();
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const recoveryArea = useRef<HTMLDivElement>(null);
  const sceneRoot = useRef<HTMLElement>(null);
  const registering = mode === 'register';

  useEffect(() => { setMode(initialMode); setError(''); }, [initialMode]);
  useEffect(() => { if (recoveryCode) recoveryArea.current?.focus(); }, [recoveryCode]);

  function switchMode(nextMode: AuthEntryMode) {
    if (busy || recoveryCode) return;
    setMode(nextMode); setPassword(''); setShowPassword(false); setError('');
    router.replace(authEntryHref(nextMode, returnTo), { scroll: false });
    formHeading.current?.focus();
  }

  function rememberSession(user: User, workspaceId: number) {
    useAuthStore.getState().setAuth('cookie-auth', user, workspaceId);
    useWorkspaceStore.getState().setWorkspaceId(workspaceId);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (registering && REGISTRATION_DISABLED)) return;
    setError(''); setBusy(true);
    try {
      const options = { method: 'POST', skipShopId: true, skipWorkspaceId: true,
        body: JSON.stringify({ email: email.trim(), password }) };
      if (registering) {
        const result = await apiFetch<{ user: User; workspace: { workspaceId: number }; recoveryCode: string }>('/auth/register', options);
        rememberSession(result.user, result.workspace.workspaceId);
        setPassword(''); setRecoveryCode(result.recoveryCode);
      } else {
        const result = await apiFetch<{ user: User; workspaces: { workspaceId: number }[] }>('/auth/login', options);
        const workspaceId = result.workspaces?.[0]?.workspaceId;
        if (!workspaceId) throw new Error('У аккаунта нет рабочего кабинета. Обратитесь в поддержку.');
        rememberSession(result.user, workspaceId);
        setPassword('');
        if (returnTo) { router.replace(returnTo); return; }
        try {
          const status = await apiFetch<{ status: string }>(`/onboarding/${workspaceId}/status`, { skipShopId: true });
          router.replace(status.status === 'no_shop' || status.status === 'syncing' ? '/onboarding' : '/pulse');
        } catch { router.replace('/pulse'); }
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не удалось продолжить. Попробуйте ещё раз.');
    } finally { setBusy(false); }
  }

  return <div className={styles.page}>
    <a href="#account" className={styles.skip}>Перейти к форме</a>
    <header className={styles.header}>
      <Link href="/" className={styles.brand} aria-label="Sigma Seller — главная"><span aria-hidden="true" className={styles.mark}>Σ</span><span>Sigma Seller</span></Link>
      {!recoveryCode && <button type="button" className={styles.headerAction} disabled={busy} onClick={() => switchMode(registering ? 'login' : 'register')}>
        {registering ? 'Войти' : 'Создать аккаунт'}
      </button>}
    </header>
    <main className={styles.main} ref={sceneRoot}>
      <section className={styles.intro} aria-labelledby="start-title">
        <p className={styles.audience}>Кабинет продавца Wildberries</p>
        <SellerHeadline />
        <SellerDescription />
        <p className={styles.price}><span aria-hidden="true">✦</span> Сервис бесплатный для продавцов.</p>
      </section>
      <section id="account" className={styles.account} aria-label="Регистрация и вход">
        {recoveryCode ? <div ref={recoveryArea} tabIndex={-1} className={styles.recovery}>
          <p className={styles.success} role="status">Аккаунт создан. Сохраните доступ к нему.</p>
          <RecoveryCodeNotice code={recoveryCode} onContinue={() => router.replace(returnTo ? `/onboarding?returnTo=${encodeURIComponent(returnTo)}` : '/onboarding')} />
        </div> : <>
          <div className={styles.modeSwitch} aria-label="Способ входа">
            <button type="button" aria-pressed={registering} disabled={busy} onClick={() => switchMode('register')}>Регистрация</button>
            <button type="button" aria-pressed={!registering} disabled={busy} onClick={() => switchMode('login')}>Вход</button>
          </div>
          <h2 ref={formHeading} tabIndex={-1}>{registering ? 'Создать аккаунт' : 'С возвращением'}</h2>
          <p className={styles.formIntro}>{registering ? 'Начните с email и пароля.' : 'Введите email и пароль от кабинета.'}</p>
          {registering && REGISTRATION_DISABLED ? <div className={styles.closed} role="status">
            <p>Регистрация временно закрыта.</p>
            <button type="button" onClick={() => switchMode('login')}>Войти в существующий аккаунт</button>
          </div> : <form onSubmit={submit} className={styles.form} aria-busy={busy}>
            <div className={styles.field}>
              <label htmlFor="account-email">Email</label>
              <input id="account-email" name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required
                value={email} disabled={busy} placeholder="you@example.ru" onChange={event => setEmail(event.target.value)} />
            </div>
            <div className={styles.field}>
              <div className={styles.passwordLabel}><label htmlFor="account-password">Пароль</label>
                {!registering && <Link href="/auth/forgot-password">Забыли пароль?</Link>}
              </div>
              <div className={styles.passwordInput}>
                <input id="account-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete={registering ? 'new-password' : 'current-password'} required
                  minLength={registering ? 8 : 1} value={password} disabled={busy} aria-describedby={registering ? 'password-hint' : undefined}
                  onChange={event => setPassword(event.target.value)} />
                <button type="button" disabled={busy} aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'} aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>
                  {showPassword ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}
                </button>
              </div>
              {registering && <p id="password-hint" className={styles.hint}>Не менее 8 символов. Можно использовать менеджер паролей.</p>}
            </div>
            {error && <p className={styles.error} role="alert">{error}</p>}
            <button type="submit" disabled={busy} className={styles.submit}>
              {busy && <Loader2 size={18} className={styles.spinner} aria-hidden="true" />}
              {busy ? 'Подождите…' : registering ? 'Создать бесплатный аккаунт' : 'Войти в кабинет'}
            </button>
            {registering && <p className={styles.terms}>Создавая аккаунт, вы принимаете <Link href="/legal/terms">условия сервиса</Link> и <Link href="/legal/privacy">политику конфиденциальности</Link>.</p>}
          </form>}
          <p className={styles.formFootnote}>Данные магазина доступны и без ИИ. Если хотите помощь ИИ, его можно подключить отдельно. <a href="#service-guide">Как это сделать и за что платить</a>.</p>
        </>}
      </section>
      <SellerPanel />
      <ServiceGuide />
      <SellerGathering rootRef={sceneRoot} />
    </main>
    <footer className={styles.footer}><span>Независимый сервис для продавцов Wildberries</span>
      <nav aria-label="О сервисе"><Link href="/source">Исходный код</Link><Link href="/legal/terms">Условия</Link><Link href="/legal/privacy">Конфиденциальность</Link></nav>
    </footer>
  </div>;
}
