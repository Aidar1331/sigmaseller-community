'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Bot,
  Save,
  RefreshCw,
  MessageSquare,
  DollarSign,
  TrendingUp,
  Bell,
  Cpu,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Input } from '@/components/ui/Input';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { useWorkspaceStore } from '@/store/workspace';
import { useAuthStore } from '@/store/auth';

type AgentSettings = {
  settingId?: number;
  workspaceId: number;
  // Auto-reply
  autoReplyPositive: boolean;
  autoReplyNeutral: boolean;
  autoReplyRequiresApproval: boolean;
  // Pricing
  autoPriceProtectOos: boolean;
  minMarginPct: number | null;
  maxPriceChangePct: number | null;
  // Bidder
  autoBidOptimize: boolean;
  maxBidRub: number | null;
  // Notifications
  telegramChatId: string | null;
  telegramCritical: boolean;
  telegramBriefing: boolean;
  // Agent behaviour
  agentModel: string | null;
  agentMaxTokensPerDay: number | null;
};

const defaultSettings: Omit<AgentSettings, 'workspaceId'> = {
  autoReplyPositive: false,
  autoReplyNeutral: false,
  autoReplyRequiresApproval: true,
  autoPriceProtectOos: false,
  minMarginPct: null,
  maxPriceChangePct: 10,
  autoBidOptimize: false,
  maxBidRub: null,
  telegramChatId: null,
  telegramCritical: false,
  telegramBriefing: false,
  agentModel: null,
  agentMaxTokensPerDay: null,
};

export default function AgentSettingsPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const userId = useAuthStore((s) => s.user?.userId ?? null);

  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Fetch settings
  const fetchSettings = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ row: AgentSettings | null }>(
        `/agent-settings?workspaceId=${workspaceId}`
      );
      setSettings(res.row ?? { workspaceId, ...defaultSettings });
    } catch (err: any) {
      console.error('Failed to fetch agent settings:', err);
      setError(err?.message ?? 'Не удалось загрузить настройки');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // Save settings
  const handleSave = async () => {
    if (!workspaceId || !settings) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      if (!userId) {
        throw new Error('Не удалось определить текущего пользователя');
      }
      await apiFetch('/agent-settings', {
        method: 'POST',
        body: JSON.stringify({
          ...settings,
          workspaceId,
          actorUserId: userId,
        }),
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      console.error('Failed to save agent settings:', err);
      setError(err?.message ?? 'Не удалось сохранить настройки');
    } finally {
      setSaving(false);
    }
  };

  // Update field
  const updateField = <K extends keyof AgentSettings>(
    key: K,
    value: AgentSettings[K]
  ) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : null));
  };

  if (!workspaceId) {
    return (
      <AppShell>
        <div className="p-8 text-center text-muted-foreground">
          Выберите workspace
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-6 max-w-3xl">
        {/* Error Banner */}
        <ErrorBanner error={error} onRetry={fetchSettings} onDismiss={() => setError(null)} />

        {/* Success message */}
        {success && (
          <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-green-800">
            Настройки сохранены
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Bot className="h-6 w-6" />
              Настройки AI-агента
            </h1>
            <p className="text-muted-foreground">
              Управление автоматизацией и поведением агента
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="neutral" onClick={fetchSettings} disabled={loading}>
              <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
              Обновить
            </Button>
            <Button onClick={handleSave} disabled={saving || !settings}>
              <Save className="mr-2 h-4 w-4" />
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
          </div>
        </div>

        {loading && !settings ? (
          <div className="text-center p-8 text-muted-foreground">Загрузка...</div>
        ) : settings ? (
          <>
            {/* Auto-Reply Section */}
            <Card className="p-5">
              <h3 className="font-semibold mb-4 flex items-center gap-2">
                <MessageSquare className="h-5 w-5 text-blue-600" />
                Автоответы на отзывы
              </h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">Положительные отзывы (4-5 ⭐)</div>
                    <div className="text-sm text-muted-foreground">
                      Автоматически генерировать ответы на хорошие отзывы
                    </div>
                  </div>
                  <Switch
                    checked={settings.autoReplyPositive}
                    onCheckedChange={(v) => updateField('autoReplyPositive', v)}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">Нейтральные отзывы (3 ⭐)</div>
                    <div className="text-sm text-muted-foreground">
                      Генерировать ответы на средние отзывы
                    </div>
                  </div>
                  <Switch
                    checked={settings.autoReplyNeutral}
                    onCheckedChange={(v) => updateField('autoReplyNeutral', v)}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">Требуется подтверждение</div>
                    <div className="text-sm text-muted-foreground">
                      Ответы отправляются только после одобрения человеком
                    </div>
                  </div>
                  <Switch
                    checked={settings.autoReplyRequiresApproval}
                    onCheckedChange={(v) => updateField('autoReplyRequiresApproval', v)}
                  />
                </div>
              </div>
            </Card>

            {/* Pricing Section */}
            <Card className="p-5">
              <h3 className="font-semibold mb-4 flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-green-700" />
                Ценообразование
              </h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">Защита при аутстоке</div>
                    <div className="text-sm text-muted-foreground">
                      Автоматически поднять цену при критически низком остатке
                    </div>
                  </div>
                  <Switch
                    checked={settings.autoPriceProtectOos}
                    onCheckedChange={(v) => updateField('autoPriceProtectOos', v)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium">Мин. маржа (%)</label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={settings.minMarginPct ?? ''}
                      onChange={(e) =>
                        updateField(
                          'minMarginPct',
                          e.target.value ? Number(e.target.value) : null
                        )
                      }
                      placeholder="Не задано"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Минимальная маржинальность для авто-действий
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium">Макс. изменение цены (%)</label>
                    <Input
                      type="number"
                      min={1}
                      max={50}
                      value={settings.maxPriceChangePct ?? ''}
                      onChange={(e) =>
                        updateField(
                          'maxPriceChangePct',
                          e.target.value ? Number(e.target.value) : null
                        )
                      }
                      placeholder="10"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Максимальное изменение цены за раз
                    </p>
                  </div>
                </div>
              </div>
            </Card>

            {/* Bidder Section */}
            <Card className="p-5">
              <h3 className="font-semibold mb-4 flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-purple-600" />
                Рекламный биддер
              </h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">Автооптимизация ставок</div>
                    <div className="text-sm text-muted-foreground">
                      AI автоматически корректирует ставки для достижения целевого ДРР
                    </div>
                  </div>
                  <Switch
                    checked={settings.autoBidOptimize}
                    onCheckedChange={(v) => updateField('autoBidOptimize', v)}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Макс. ставка (₽)</label>
                  <Input
                    type="number"
                    min={0}
                    value={settings.maxBidRub ?? ''}
                    onChange={(e) =>
                      updateField(
                        'maxBidRub',
                        e.target.value ? Number(e.target.value) : null
                      )
                    }
                    placeholder="Не ограничено"
                    className="max-w-xs"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Максимальная ставка, которую агент может установить
                  </p>
                </div>
              </div>
            </Card>

            {/* Notifications Section */}
            <Card className="p-5">
              <h3 className="font-semibold mb-4 flex items-center gap-2">
                <Bell className="h-5 w-5 text-orange-700" />
                Уведомления
              </h3>
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium">Telegram Chat ID</label>
                  <Input
                    type="text"
                    value={settings.telegramChatId ?? ''}
                    onChange={(e) =>
                      updateField('telegramChatId', e.target.value || null)
                    }
                    placeholder="-1001234567890"
                    className="max-w-xs"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    ID чата или группы для уведомлений
                  </p>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">Критические алерты</div>
                    <div className="text-sm text-muted-foreground">
                      Отправлять критические уведомления в Telegram
                    </div>
                  </div>
                  <Switch
                    checked={settings.telegramCritical}
                    onCheckedChange={(v) => updateField('telegramCritical', v)}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">Утренний брифинг</div>
                    <div className="text-sm text-muted-foreground">
                      Ежедневная сводка по ключевым метрикам
                    </div>
                  </div>
                  <Switch
                    checked={settings.telegramBriefing}
                    onCheckedChange={(v) => updateField('telegramBriefing', v)}
                  />
                </div>
              </div>
            </Card>

            {/* Agent Behaviour Section */}
            <Card className="p-5">
              <h3 className="font-semibold mb-4 flex items-center gap-2">
                <Cpu className="h-5 w-5 text-gray-600" />
                Поведение агента
              </h3>
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium">Модель AI</label>
                  <Input
                    type="text"
                    value={settings.agentModel ?? ''}
                    onChange={(e) =>
                      updateField('agentModel', e.target.value || null)
                    }
                    placeholder="По умолчанию (gpt-4o)"
                    className="max-w-xs"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Переопределить модель для этого workspace
                  </p>
                </div>
                <div>
                  <label className="text-sm font-medium">Лимит токенов в день</label>
                  <Input
                    type="number"
                    min={0}
                    value={settings.agentMaxTokensPerDay ?? ''}
                    onChange={(e) =>
                      updateField(
                        'agentMaxTokensPerDay',
                        e.target.value ? Number(e.target.value) : null
                      )
                    }
                    placeholder="Не ограничено"
                    className="max-w-xs"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Максимальное потребление токенов агентом в день
                  </p>
                </div>
              </div>
            </Card>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}
