'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { apiFetch } from '@/lib/api';
import { AlertCircle, CheckCircle, Activity, Loader2 } from 'lucide-react';

type State = 'verifying' | 'success' | 'error';

function VerifyEmailFlow() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [state, setState] = useState<State>('verifying');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState('error');
      setError('Отсутствует токен подтверждения. Откройте ссылку из письма.');
      return;
    }

    apiFetch('/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(() => setState('success'))
      .catch((err: any) => {
        setError(err?.message || 'Не удалось подтвердить email. Возможно, ссылка устарела.');
        setState('error');
      });
  }, [token]);

  if (state === 'verifying') {
    return (
      <Card className="p-6">
        <div className="flex flex-col items-center justify-center py-4 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
          <p className="text-sm text-gray-500">Подтверждаем email…</p>
        </div>
      </Card>
    );
  }

  if (state === 'success') {
    return (
      <Card className="p-6">
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <CheckCircle className="h-6 w-6 text-green-700" />
            </div>
          </div>
          <div>
            <h3 className="text-lg font-medium text-gray-900">Email подтверждён</h3>
            <p className="text-sm text-gray-500 mt-1">
              Теперь вы можете оплатить подписку и пользоваться всеми возможностями.
            </p>
          </div>
          <Link href="/">
            <Button className="w-full mt-4">Продолжить</Button>
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
        <Link href="/auth/login" className="block">
          <Button variant="secondary" className="w-full">Вернуться к входу</Button>
        </Link>
      </div>
    </Card>
  );
}

function LoadingCard() {
  return (
    <Card className="p-6">
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
      </div>
    </Card>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-600 shadow-lg shadow-indigo-200">
              <Activity className="h-6 w-6 text-white" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Подтверждение email</h1>
        </div>

        <Suspense fallback={<LoadingCard />}>
          <VerifyEmailFlow />
        </Suspense>
      </div>
    </div>
  );
}
