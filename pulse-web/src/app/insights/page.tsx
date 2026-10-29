'use client';

import { useWorkspaceStore } from '@/store/workspace';
import { useShopChange } from '@/hooks/useShopChange';
import { useShopParam } from '@/hooks/useShopParam';

import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { SlowLoadingWarning } from '@/components/ui/SlowLoadingWarning';
import { apiFetch } from '@/lib/api';
import { Paywall } from '@/components/Paywall';
import { useLoadingTimeout } from '@/hooks/useLoadingTimeout';

const CATEGORIES = [
  { key: 'sales', label: 'Продажи' },
  { key: 'conversion', label: 'Конверсия' },
  { key: 'ads', label: 'Реклама' },
  { key: 'stocks', label: 'Остатки' },
  { key: 'pricing', label: 'Цена/СПП' },
  { key: 'quality', label: 'Качество' },
  { key: 'reviews', label: 'Отзывы' },
];

type Insight = {
  insightId: number;
  nmId: number | null;
  date: string;
  insightType: string;
  category: string;
  severity?: string | null;
  score?: number | null;
  title: string;
  description?: string | null;
  evidence?: any;
  seenAt?: string | null;
  dismissedAt?: string | null;
  createdAt: string;
};

type Settings = {
  sensitivity: 'sensitive' | 'standard' | 'critical';
  minStockDays: number;
  targetDrrPct: number;
  excludedTagIds: number[];
  notifyChannels: any;
  notifyTime: string;
  timezone: string;
};

type Tag = { tagId: number; name: string; color?: string | null };

export default function InsightsPage() {
  const storeWorkspaceId = useWorkspaceStore((s) => s.workspaceId);
  const workspaceId = storeWorkspaceId ?? 0;
  const shopParam = useShopParam();

  const [insights, setInsights] = useState<Insight[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showSlowWarning } = useLoadingTimeout(loading);

  const [status, setStatus] = useState<'all' | 'unread' | 'dismissed'>('all');
  const [category, setCategory] = useState('');
  const [nmId, setNmId] = useState('');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');

  async function loadSettings() {
    const res = (await apiFetch(`/insight-settings/${workspaceId}${shopParam ? `?${shopParam.slice(1)}` : ''}`)) as { settings: Settings };
    setSettings(res.settings as any);
  }

  async function loadTags() {
    const res = (await apiFetch(`/tags/${workspaceId}`)) as { rows: Tag[] };
    setTags(res.rows ?? []);
  }

  async function loadInsights() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('status', status);
      if (category) params.set('category', category);
      if (nmId.trim()) params.set('nmId', nmId.trim());
      if (dateStart) params.set('start', dateStart);
      if (dateEnd) params.set('end', dateEnd);
      const res = (await apiFetch(`/insights/${workspaceId}?${params.toString()}${shopParam}`)) as { rows: Insight[] };
      setInsights(res.rows ?? []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!workspaceId || workspaceId <= 0) return;
    loadSettings();
    loadTags();
    loadInsights();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || workspaceId <= 0) return;
    loadInsights();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, status, category, nmId, dateStart, dateEnd, shopParam]);

  useShopChange(() => {
    loadSettings();
    loadTags();
    loadInsights();
  });

  async function saveSettings(patch: Partial<Settings>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    await apiFetch(`/insight-settings/${workspaceId}${shopParam ? `?${shopParam.slice(1)}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
  }

  async function markSeen(id: number) {
    await apiFetch(`/insights/${workspaceId}/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    await loadInsights();
  }

  async function dismiss(id: number) {
    await apiFetch(`/insights/${workspaceId}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    await loadInsights();
  }

  async function runNow() {
    setLoading(true);
    setError(null);
    try {
      await apiFetch(`/insights/${workspaceId}/run${shopParam ? `?${shopParam.slice(1)}` : ''}`, { method: 'POST' });
      await loadInsights();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  const excludedTagIds = useMemo(() => new Set(settings?.excludedTagIds ?? []), [settings]);

  return (
    <AppShell title="Авто‑инсайты">
      <Paywall workspaceId={workspaceId} feature="Авто-инсайты">
        <div className="p-6 space-y-6">
        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)]">Ежедневные инсайты по ключевым метрикам</div>
          <div className="mt-2 text-xs text-[var(--content-muted)]">
            Сравнение 7 дней с предыдущими 7 днями, учёт дня недели и анти‑шум.
          </div>
          <Button size="sm" className="mt-3" onClick={runNow} loading={loading}>
            Сгенерировать сейчас
          </Button>
          {error ? <div className="mt-2 text-xs text-red-500">{error}</div> : null}
        </Card>

        {settings ? (
          <Card className="p-4">
            <div className="text-sm font-semibold text-[var(--content-text)]">Настройки</div>
            <div className="mt-3 grid gap-4 md:grid-cols-3">
              <label className="text-xs text-[var(--content-muted)]">
                Чувствительность
                <Select value={settings.sensitivity} onValueChange={(v) => saveSettings({ sensitivity: v as any })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sensitive">Чувствительный (10%)</SelectItem>
                    <SelectItem value="standard">Стандарт (20%)</SelectItem>
                    <SelectItem value="critical">Только критичное (40%)</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="text-xs text-[var(--content-muted)]">
                Мин. запас дней
                <Input className="mt-1" type="number" value={settings.minStockDays}
                  onChange={(e) => saveSettings({ minStockDays: Number(e.target.value) })} />
              </label>
              <label className="text-xs text-[var(--content-muted)]">
                Целевой DRR, %
                <Input className="mt-1" type="number" value={settings.targetDrrPct}
                  onChange={(e) => saveSettings({ targetDrrPct: Number(e.target.value) })} />
              </label>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <label className="text-xs text-[var(--content-muted)]">
                Время отправки
                <Input className="mt-1" type="time" value={settings.notifyTime}
                  onChange={(e) => saveSettings({ notifyTime: e.target.value })} />
              </label>
              <label className="text-xs text-[var(--content-muted)]">
                Таймзона
                <Input className="mt-1" value={settings.timezone}
                  onChange={(e) => saveSettings({ timezone: e.target.value })} />
              </label>
              <div className="text-xs text-[var(--content-muted)]">
                Каналы
                <div className="mt-2 space-y-2">
                  <Switch
                    label="UI"
                    checked={!!settings.notifyChannels?.ui}
                    onCheckedChange={(v) => saveSettings({ notifyChannels: { ...settings.notifyChannels, ui: v } })}
                  />
                  <Switch
                    label="Telegram"
                    checked={!!settings.notifyChannels?.telegram}
                    onCheckedChange={(v) => saveSettings({ notifyChannels: { ...settings.notifyChannels, telegram: v } })}
                  />
                </div>
              </div>
            </div>

            <div className="mt-4">
              <div className="text-xs text-[var(--content-muted)]">Исключить товары по тегам</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {tags.length === 0 ? (
                  <div className="text-xs text-[var(--content-muted)]">Тегов нет</div>
                ) : (
                  tags.map((t) => (
                    <label key={t.tagId} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--card-border)] px-2 py-1 text-xs">
                      <input
                        type="checkbox"
                        checked={excludedTagIds.has(t.tagId)}
                        onChange={(e) => {
                          const set = new Set(excludedTagIds);
                          if (e.target.checked) set.add(t.tagId);
                          else set.delete(t.tagId);
                          saveSettings({ excludedTagIds: [...set] });
                        }}
                      />
                      <span>{t.name}</span>
                    </label>
                  ))
                )}
              </div>
            </div>

            <div className="mt-4">
              <div className="text-xs text-[var(--content-muted)]">Telegram по категориям</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {CATEGORIES.map((c) => (
                  <label key={c.key} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--card-border)] px-2 py-1 text-xs">
                    <input
                      type="checkbox"
                      checked={!!settings.notifyChannels?.categories?.[c.key]?.telegram}
                      onChange={(e) => {
                        const categories = { ...(settings.notifyChannels?.categories ?? {}) };
                        categories[c.key] = { ...(categories[c.key] ?? {}), telegram: e.target.checked };
                        saveSettings({ notifyChannels: { ...settings.notifyChannels, categories } });
                      }}
                    />
                    <span>{c.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </Card>
        ) : null}

        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)]">Фильтры</div>
          <div className="mt-3 grid gap-3 md:grid-cols-5">
            <label className="text-xs text-[var(--content-muted)]">
              Статус
              <Select value={status} onValueChange={(v) => setStatus(v as any)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все</SelectItem>
                  <SelectItem value="unread">Непрочитанные</SelectItem>
                  <SelectItem value="dismissed">Скрытые</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="text-xs text-[var(--content-muted)]">
              Категория
              <Select value={category || "__all__"} onValueChange={(v) => setCategory(v === "__all__" ? "" : v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Все</SelectItem>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="text-xs text-[var(--content-muted)]">
              Артикул WB
              <Input className="mt-1" value={nmId} onChange={(e) => setNmId(e.target.value)} />
            </label>
            <label className="text-xs text-[var(--content-muted)]">
              С даты
              <Input className="mt-1" type="date" value={dateStart} onChange={(e) => setDateStart(e.target.value)} />
            </label>
            <label className="text-xs text-[var(--content-muted)]">
              По дату
              <Input className="mt-1" type="date" value={dateEnd} onChange={(e) => setDateEnd(e.target.value)} />
            </label>
          </div>
        </Card>

        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)]">Инсайты</div>
          {showSlowWarning && (
            <div className="mt-3">
              <SlowLoadingWarning onRetry={loadInsights} />
            </div>
          )}
          {insights.length === 0 && !loading ? (
            <div className="mt-2 text-xs text-[var(--content-muted)]">Пока нет инсайтов.</div>
          ) : insights.length === 0 && loading ? (
            <div className="mt-2 text-xs text-[var(--content-muted)]">Загрузка...</div>
          ) : (
            <div className="mt-3 grid gap-2 text-sm">
              {insights.map((i) => (
                <div key={i.insightId} className="rounded-[var(--radius-md)] border border-[var(--card-border)] px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium text-[var(--content-text)]">{i.title}</div>
                    <div className="text-xs text-[var(--content-muted)]">{i.severity ?? 'info'}</div>
                  </div>
                  <div className="mt-1 text-xs text-[var(--content-muted)]">
                    {i.category} · {i.date} · score {i.score ?? '—'}
                  </div>
                  {i.description ? <div className="mt-1 text-xs text-[var(--content-muted)]">{i.description}</div> : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {!i.seenAt ? (
                      <Button size="sm" variant="neutral" onClick={() => markSeen(i.insightId)}>Прочитал</Button>
                    ) : null}
                    <Button size="sm" variant="neutral" onClick={() => dismiss(i.insightId)}>Скрыть</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        </div>
      </Paywall>
    </AppShell>
  );
}
