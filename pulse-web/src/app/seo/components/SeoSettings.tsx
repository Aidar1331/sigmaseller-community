'use client';

import { useCallback, useEffect, useState } from 'react';
import { Settings, MapPin, Users, Tag, Save, Plus, Trash2, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { CheckCircle2 } from 'lucide-react';

// Types
type SeoSettingsData = {
  workspaceId: number;
  checkIntervalHours: number;
  alertOnDropPositions: number;
  alertOnExitTop: number;
  alertOnEnterTop: number;
  notifyTelegram: boolean;
  notifyEmail: boolean;
};

type Address = {
  addressId: number;
  name: string;
  dest: string | null;
  isDefault: boolean;
};

type Competitor = {
  competitorId: number;
  name: string;
  nmId: number;
  isActive: boolean;
  keywordIds: number[];
};

type KeywordTag = {
  tagId: number;
  name: string;
  color: string | null;
};

type Props = {
  workspaceId: number;
  onClose: () => void;
};

export function SeoSettings({ workspaceId, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<'settings' | 'addresses' | 'competitors'>('settings');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Settings
  const [settings, setSettings] = useState<SeoSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  
  // Addresses
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [newAddress, setNewAddress] = useState({ name: '', dest: '' });
  
  // Competitors
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [newCompetitor, setNewCompetitor] = useState({ name: '', nmId: '' });
  
  // Tags
  const [tags, setTags] = useState<KeywordTag[]>([]);
  const [newTag, setNewTag] = useState({ name: '', color: '#3B82F6' });

  // Fetch all data
  const fetchData = useCallback(async () => {
    try {
      const [sett, addr, comp, t] = await Promise.all([
        apiFetch(`/seo/${workspaceId}/settings`) as Promise<SeoSettingsData>,
        apiFetch(`/seo/${workspaceId}/addresses`) as Promise<Address[]>,
        apiFetch(`/seo/${workspaceId}/competitors`) as Promise<Competitor[]>,
        apiFetch(`/seo/${workspaceId}/tags`) as Promise<KeywordTag[]>,
      ]);
      setSettings(sett);
      setAddresses(addr);
      setCompetitors(comp);
      setTags(t);
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось загрузить настройки SEO');
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Save settings
  const handleSaveSettings = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await apiFetch(`/seo/${workspaceId}/settings`, {
        method: 'PATCH',
        body: JSON.stringify(settings),
      });
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      setSaved(false);
      setError(err?.message ?? 'Не удалось сохранить настройки');
    } finally {
      setSaving(false);
    }
  };

  // Addresses
  const handleAddAddress = async () => {
    if (!newAddress.name) return;
    try {
      await apiFetch(`/seo/${workspaceId}/addresses`, {
        method: 'POST',
        body: JSON.stringify(newAddress),
      });
      setNewAddress({ name: '', dest: '' });
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось добавить адрес');
    }
  };

  const handleDeleteAddress = async (addressId: number) => {
    try {
      await apiFetch(`/seo/${workspaceId}/addresses/${addressId}`, { method: 'DELETE' });
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось удалить адрес');
    }
  };

  // Competitors
  const handleAddCompetitor = async () => {
    if (!newCompetitor.name || !newCompetitor.nmId) return;
    try {
      await apiFetch(`/seo/${workspaceId}/competitors`, {
        method: 'POST',
        body: JSON.stringify({ name: newCompetitor.name, nmId: Number(newCompetitor.nmId) }),
      });
      setNewCompetitor({ name: '', nmId: '' });
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось добавить конкурента');
    }
  };

  const handleDeleteCompetitor = async (competitorId: number) => {
    try {
      await apiFetch(`/seo/${workspaceId}/competitors/${competitorId}`, { method: 'DELETE' });
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось удалить конкурента');
    }
  };

  // Tags
  const handleAddTag = async () => {
    if (!newTag.name) return;
    try {
      await apiFetch(`/seo/${workspaceId}/tags`, {
        method: 'POST',
        body: JSON.stringify(newTag),
      });
      setNewTag({ name: '', color: '#3B82F6' });
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось добавить тег');
    }
  };

  const handleDeleteTag = async (tagId: number) => {
    try {
      await apiFetch(`/seo/${workspaceId}/tags/${tagId}`, { method: 'DELETE' });
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось удалить тег');
    }
  };

  // SEO settings sub-tabs cleanup 2026-05-07: only 'settings' shown until
  // 'addresses' (geo-specific monitoring) and 'competitors' (competitor tracking)
  // stabilise. Components for those tabs still exist below — restore the items
  // here when re-enabling.
  const tabs = [
    { id: 'settings' as const, label: 'Настройки', icon: Settings },
  ];

  return (
    <Card className="p-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b bg-muted/30">
        <h3 className="font-semibold flex items-center gap-2">
          <Settings className="h-5 w-5" />
          Настройки SEO мониторинга
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex border-b">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors',
              activeTab === tab.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-4">
        {error && (
          <div className="mb-3">
            <ErrorBanner error={error} onDismiss={() => setError(null)} />
          </div>
        )}
        {saved && (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            Настройки сохранены
          </div>
        )}
        {/* Settings Tab */}
        {activeTab === 'settings' && settings && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-muted-foreground">Периодичность проверки</label>
                <Select
                  value={String(settings.checkIntervalHours)}
                  onValueChange={(v) => setSettings({ ...settings, checkIntervalHours: Number(v) })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0.5">Каждые 30 минут</SelectItem>
                    <SelectItem value="1">Каждый час</SelectItem>
                    <SelectItem value="2">Каждые 2 часа</SelectItem>
                    <SelectItem value="4">Каждые 4 часа</SelectItem>
                    <SelectItem value="6">Каждые 6 часов</SelectItem>
                    <SelectItem value="12">Каждые 12 часов</SelectItem>
                    <SelectItem value="24">Раз в сутки</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Алерт: падение на N позиций</label>
                <Input
                  type="number"
                  value={settings.alertOnDropPositions}
                  onChange={(e) => setSettings({ ...settings, alertOnDropPositions: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Алерт: выход из ТОП-N</label>
                <Input
                  type="number"
                  value={settings.alertOnExitTop}
                  onChange={(e) => setSettings({ ...settings, alertOnExitTop: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Алерт: вход в ТОП-N (позитив)</label>
                <Input
                  type="number"
                  value={settings.alertOnEnterTop}
                  onChange={(e) => setSettings({ ...settings, alertOnEnterTop: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={settings.notifyTelegram}
                  onChange={(e) => setSettings({ ...settings, notifyTelegram: e.target.checked })}
                  className="rounded"
                />
                <span className="text-sm">Telegram</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={settings.notifyEmail}
                  onChange={(e) => setSettings({ ...settings, notifyEmail: e.target.checked })}
                  className="rounded"
                />
                <span className="text-sm">Email</span>
              </label>
            </div>
            <Button onClick={handleSaveSettings} disabled={saving}>
              <Save className="mr-2 h-4 w-4" />
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
          </div>
        )}

        {/* Addresses Tab */}
        {activeTab === 'addresses' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Адреса для гео-специфичного мониторинга позиций
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="Название (Москва, Тверская 1)"
                value={newAddress.name}
                onChange={(e) => setNewAddress({ ...newAddress, name: e.target.value })}
                className="flex-1"
              />
              <Input
                placeholder="dest (опционально)"
                value={newAddress.dest}
                onChange={(e) => setNewAddress({ ...newAddress, dest: e.target.value })}
                className="w-40"
              />
              <Button onClick={handleAddAddress} disabled={!newAddress.name}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-2">
              {addresses.map((addr) => (
                <div key={addr.addressId} className="flex items-center justify-between p-2 bg-muted/50 rounded">
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-muted-foreground" />
                    <span>{addr.name}</span>
                    {addr.isDefault && <Badge variant="neutral">По умолчанию</Badge>}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => handleDeleteAddress(addr.addressId)}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              ))}
              {addresses.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">Нет адресов</p>
              )}
            </div>
          </div>
        )}

        {/* Competitors Tab */}
        {activeTab === 'competitors' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Отслеживайте позиции конкурентов по вашим ключевым словам
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="Название конкурента"
                value={newCompetitor.name}
                onChange={(e) => setNewCompetitor({ ...newCompetitor, name: e.target.value })}
                className="flex-1"
              />
              <Input
                placeholder="Артикул товара"
                type="number"
                value={newCompetitor.nmId}
                onChange={(e) => setNewCompetitor({ ...newCompetitor, nmId: e.target.value })}
                className="w-40"
              />
              <Button onClick={handleAddCompetitor} disabled={!newCompetitor.name || !newCompetitor.nmId}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-2">
              {competitors.map((comp) => (
                <div key={comp.competitorId} className="flex items-center justify-between p-2 bg-muted/50 rounded">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{comp.name}</span>
                    <span className="text-sm text-muted-foreground">Артикул: {comp.nmId}</span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => handleDeleteCompetitor(comp.competitorId)}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              ))}
              {competitors.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">Нет конкурентов</p>
              )}
            </div>
          </div>
        )}

      </div>
    </Card>
  );
}
