'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { Button } from '@/components/ui/Button';
import { useForm } from 'react-hook-form';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { CheckCircle2 } from 'lucide-react';

interface SEOSettings {
  workspaceId: number;
  checkIntervalHours: number;
  alertOnDropPositions: number;
  alertOnExitTop: number;
  alertOnEnterTop: number;
  alertOnCompetitorPriceDropPct: number;
  alertOnNewCompetitorTopN: number;
  notifyTelegram: boolean;
  notifyEmail: boolean;
}

interface Props {
  workspaceId: number;
}

export function AlertSettings({ workspaceId }: Props) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const { data: settings, isLoading } = useQuery<SEOSettings>({
    queryKey: ['seo-settings', workspaceId],
    queryFn: () => apiFetch<SEOSettings>(`/seo/${workspaceId}/settings`),
  });

  const mutation = useMutation({
    mutationFn: (data: Partial<SEOSettings>) =>
      apiFetch(`/seo/${workspaceId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seo-settings'] });
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
    onError: (err: any) => {
      setSaved(false);
      setError(err?.message ?? 'Не удалось сохранить настройки');
    },
  });

  const { register, handleSubmit, watch, setValue } = useForm<SEOSettings>({
    values: settings,
  });

  const onSubmit = (data: SEOSettings) => {
    mutation.mutate(data);
  };

  if (isLoading) {
    return <div className="p-4 text-gray-500">Загрузка...</div>;
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Card className="p-6">
        <div className="mb-4">
          <h3 className="text-lg font-semibold">⚙️ Настройки алертов</h3>
          <p className="text-sm text-gray-500">
            Настройте условия для уведомлений
          </p>
        </div>
        
        <div className="space-y-6">
          {/* Position Alerts */}
          <div className="space-y-4">
            <h4 className="font-medium">📉 Позиции</h4>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm text-gray-600">
                  Позиция упала на (позиций)
                </label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  {...register('alertOnDropPositions', { valueAsNumber: true })}
                />
              </div>
              
              <div className="space-y-2">
                <label className="text-sm text-gray-600">
                  Выход из ТОП-N
                </label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  {...register('alertOnExitTop', { valueAsNumber: true })}
                />
              </div>
            </div>
          </div>

          {/* Competitor Alerts */}
          <div className="space-y-4">
            <h4 className="font-medium">👥 Конкуренты</h4>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm text-gray-600">
                  Конкурент снизил цену на (%)
                </label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  {...register('alertOnCompetitorPriceDropPct', { valueAsNumber: true })}
                />
              </div>
              
              <div className="space-y-2">
                <label className="text-sm text-gray-600">
                  Новый конкурент в ТОП-N
                </label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  {...register('alertOnNewCompetitorTopN', { valueAsNumber: true })}
                />
              </div>
            </div>
          </div>

          {/* Notifications */}
          <div className="space-y-4">
            <h4 className="font-medium">🔔 Уведомления</h4>
            
            <div className="flex items-center justify-between">
              <label className="text-sm text-gray-600">Telegram</label>
              <Switch
                checked={watch('notifyTelegram')}
                onCheckedChange={(v) => setValue('notifyTelegram', v)}
              />
            </div>
            
            <div className="flex items-center justify-between">
              <label className="text-sm text-gray-600">Email</label>
              <Switch
                checked={watch('notifyEmail')}
                onCheckedChange={(v) => setValue('notifyEmail', v)}
              />
            </div>
          </div>

          {/* Check Interval */}
          <div className="space-y-2">
            <label className="text-sm text-gray-600">
              Интервал проверки (часов)
            </label>
            <Input
              type="number"
              min={1}
              max={48}
              {...register('checkIntervalHours', { valueAsNumber: true })}
            />
          </div>

          {error && (
            <ErrorBanner error={error} onDismiss={() => setError(null)} />
          )}
          {saved && (
            <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4" />
              Настройки сохранены
            </div>
          )}

          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Сохранение...' : 'Сохранить'}
          </Button>
        </div>
      </Card>
    </form>
  );
}
