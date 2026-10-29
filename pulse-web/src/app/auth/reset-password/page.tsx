'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { apiFetch } from '@/lib/api';
import { AlertCircle, CheckCircle, Activity, ArrowLeft, Loader2 } from 'lucide-react';

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('Отсутствует токен сброса пароля');
    }
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!token) {
      setError('Отсутствует токен сброса пароля');
      return;
    }

    if (password.length < 8) {
      setError('Пароль должен быть минимум 8 символов');
      return;
    }

    if (password !== confirmPassword) {
      setError('Пароли не совпадают');
      return;
    }

    setLoading(true);

    try {
      await apiFetch('/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      setSuccess(true);
    } catch (err: any) {
      setError(err?.message || 'Ошибка сброса пароля');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="p-6">
      {success ? (
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <CheckCircle className="h-6 w-6 text-green-700" />
            </div>
          </div>
          <div>
            <h3 className="text-lg font-medium text-gray-900">Пароль изменён</h3>
            <p className="text-sm text-gray-500 mt-1">
              Теперь вы можете войти с новым паролем.
            </p>
          </div>
          <Link href="/auth/login">
            <Button className="w-full mt-4">
              Войти
            </Button>
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Новый пароль</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Минимум 8 символов"
              autoComplete="new-password"
              required
              disabled={!token}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Повторите пароль</label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Повторите пароль"
              autoComplete="new-password"
              required
              disabled={!token}
            />
          </div>

          <Button type="submit" className="w-full" loading={loading} disabled={!token}>
            Сменить пароль
          </Button>

          <Link href="/auth/login" className="block text-center">
            <Button variant="ghost" type="button" className="w-full">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Вернуться к входу
            </Button>
          </Link>
        </form>
      )}
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

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-600 shadow-lg shadow-indigo-200">
              <Activity className="h-6 w-6 text-white" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Новый пароль</h1>
          <p className="text-gray-500 mt-2">Введите новый пароль для вашего аккаунта</p>
        </div>

        <Suspense fallback={<LoadingCard />}>
          <ResetPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
