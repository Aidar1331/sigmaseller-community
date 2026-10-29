'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { apiFetch } from '@/lib/api';
import {
  Store,
  Plus,
  CheckCircle2,
  XCircle,
  Loader2,
  Trash2,
  Pencil,
  ExternalLink,
  ShieldCheck,
  Zap,
  RefreshCw,
  RotateCcw,
  Send,
} from 'lucide-react';
import { useWorkspaceStore } from '@/store/workspace';
import { TelegramLinkCard } from '@/components/telegram/TelegramLinkCard';
import { cn } from '@/lib/cn';

type ShopsTab = 'shops' | 'telegram';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Shop {
  shopId: number;
  platform: string;
  name: string;
  wbDeliveryType?: string | null;
  taxRegime: string;
  vatPct: string;
  isActive: boolean;
  createdAt: string;
}

type WizardStep = 'token' | 'validating' | 'params' | 'saving' | 'syncing' | 'done';

const TAX_LABELS: Record<string, string> = {
  usn6: 'УСН 6%',
  usn15: 'УСН 15%',
  osno: 'ОСНО',
  osn: 'ОСН',
  patent: 'Патент',
  ausn8: 'АУСН Доходы (8%)',
  ausn20: 'АУСН Д−Р (20%)',
};

const VAT_OPTIONS = ['0', '5', '7', '10', '20', 'custom'] as const;
const VAT_LABELS: Record<string, string> = {
  '0': 'Без НДС (0%)',
  '5': 'НДС 5%',
  '7': 'НДС 7%',
  '10': 'НДС 10%',
  '20': 'НДС 20%',
  custom: 'Свой %',
};

const PLATFORM_LABELS: Record<string, string> = {
  wb: 'Wildberries',
  ozon: 'Ozon',
  yandex_market: 'Яндекс Маркет',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ShopsPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId) ?? 0;
  const [activeTab, setActiveTab] = useState<ShopsTab>('shops');

  const [shops, setShops] = useState<Shop[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // Per-shop manual refresh state. Force refresh bypasses gap-detection
  // and syncs the full 120-day window — intended for "данные выглядят
  // битыми, перезалей". Plan v2 block D3.
  const [refreshingShopId, setRefreshingShopId] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const triggerRefresh = useCallback(async (shopId: number, force: boolean) => {
    if (!workspaceId) return;
    setRefreshingShopId(shopId);
    setRefreshError(null);
    try {
      const body: Record<string, unknown> = { shopId };
      if (force) {
        body.force = true;
        // C5 2026-05-07: cut from 120 → 30 days. WB Statistics API
        // throttles 120-day backfills hard (per-stream 60s rate-limit waits
        // ×many → exit-1 chains). 30 days is enough for most «data looks
        // wrong, reload» cases and finishes within reasonable time.
        body.daysBack = 30;
      }
      await apiFetch(`/wb/${workspaceId}/sync/refresh`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshingShopId(null);
    }
  }, [workspaceId]);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>('token');
  const [platform, setPlatform] = useState<'wb' | 'ozon' | 'yandex_market'>('wb');
  const [token, setToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [tokenValid, setTokenValid] = useState<boolean | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const [shopName, setShopName] = useState('');
  const [taxRegime, setTaxRegime] = useState<'usn6' | 'usn15' | 'osn' | 'patent'>('usn15');
  const [vatOption, setVatOption] = useState<string>('0');
  const [customVat, setCustomVat] = useState<string>('');
  const [saveError, setSaveError] = useState<string | null>(null);

  const [editingShop, setEditingShop] = useState<Shop | null>(null);
  const [editName, setEditName] = useState('');
  const [editTax, setEditTax] = useState('usn15');
  const [editVatOption, setEditVatOption] = useState<string>('0');
  const [editCustomVat, setEditCustomVat] = useState<string>('');
  const [editApiKey, setEditApiKey] = useState('');
  const [editClientId, setEditClientId] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // --- Helpers ---
  function getVatPct(option: string, custom: string): number {
    if (option === 'custom') return Number(custom) || 0;
    return Number(option) || 0;
  }

  function vatDisplay(pct: string | number): string {
    const n = Number(pct);
    if (n === 0) return 'Без НДС';
    return `НДС ${n}%`;
  }

  function vatOptionFromPct(pct: string | number): { option: string; custom: string } {
    const n = String(Number(pct));
    if (['0', '5', '7', '10', '20'].includes(n)) return { option: n, custom: '' };
    return { option: 'custom', custom: n };
  }

  // --- Load shops ---
  const loadShops = useCallback(async () => {
    if (workspaceId === 0) {
      setListLoading(false);
      return;
    }
    setListLoading(true);
    setListError(null);
    try {
      const data = await apiFetch(`/shops/${workspaceId}?platform=all`);
      setShops(data.rows ?? []);
    } catch (e: any) {
      setListError(String(e?.message ?? e));
    } finally {
      setListLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { loadShops(); }, [loadShops]);

  // --- Wizard ---
  function resetWizard() {
    setStep('token'); setPlatform('wb'); setToken(''); setClientId(''); setTokenValid(null); setTokenError(null);
    setShopName(''); setTaxRegime('usn15'); setVatOption('0'); setCustomVat(''); setSaveError(null);
  }
  function openWizard() { resetWizard(); setWizardOpen(true); }
  function closeWizard() { setWizardOpen(false); resetWizard(); }

  async function validateToken() {
    if (!token.trim()) return;
    setStep('validating'); setTokenValid(null); setTokenError(null);
    if (platform !== 'wb') {
      if (!token.trim()) {
        setTokenError('API ключ обязателен');
        setStep('token');
        return;
      }
      if ((platform === 'ozon' || platform === 'yandex_market') && !clientId.trim()) {
        setTokenError('Client ID обязателен для этой платформы');
        setStep('token');
        return;
      }
      setTokenValid(true);
      setStep('params');
      return;
    }
    try {
      await apiFetch('/shops/validate-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wbApiKey: token.trim() }),
      });
      setTokenValid(true); setStep('params');
    } catch (e: any) {
      setTokenValid(false);
      setTokenError(String(e?.message ?? 'Неверный токен'));
      setStep('token');
    }
  }

  async function saveShop() {
    if (!shopName.trim()) return;
    setStep('saving'); setSaveError(null);
    try {
      await apiFetch(`/shops/${workspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: shopName.trim(),
          platform,
          apiKey: token.trim(),
          clientId: clientId.trim() || undefined,
          taxRegime,
          vatPct: getVatPct(vatOption, customVat),
        }),
      });
      if (platform === 'wb') {
        // Auto-sync for WB only
        setStep('syncing');
        try { await apiFetch(`/wb/${workspaceId}/sync/start`, { method: 'POST' }); } catch (e) { console.error('Sync start failed:', e); }
        setStep('done');
      } else {
        setStep('done');
      }
      await loadShops();
      // Notify sidebar to refresh shop names
      window.dispatchEvent(new Event('shops-updated'));
    } catch (e: any) {
      setSaveError(String(e?.message ?? 'Ошибка сохранения'));
      setStep('params');
    }
  }

  // --- Edit ---
  function startEdit(shop: Shop) {
    setEditingShop(shop); setEditName(shop.name); setEditTax(shop.taxRegime);
    const { option, custom } = vatOptionFromPct(shop.vatPct);
    setEditVatOption(option); setEditCustomVat(custom);
    setEditApiKey('');
    setEditClientId('');
  }

  async function saveEdit() {
    if (!editingShop) return;
    setEditLoading(true);
    try {
      await apiFetch(`/shops/${workspaceId}/${editingShop.shopId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editName.trim(),
          taxRegime: editTax,
          vatPct: getVatPct(editVatOption, editCustomVat),
          ...(editApiKey.trim() ? { apiKey: editApiKey.trim() } : {}),
          ...(editClientId.trim() ? { clientId: editClientId.trim() } : {}),
        }),
      });
      setEditingShop(null); await loadShops();
    } catch (e) { console.error('Failed to save shop:', e); } finally { setEditLoading(false); }
  }

  // --- Delete ---
  async function confirmDelete() {
    if (deletingId === null) return;
    setDeleteLoading(true);
    try {
      await apiFetch(`/shops/${workspaceId}/${deletingId}`, { method: 'DELETE' });
      setDeletingId(null); await loadShops();
    } catch (e) { console.error('Failed to delete shop:', e); } finally { setDeleteLoading(false); }
  }

  // --- VAT selector component ---
  function renderVatField(opt: string, onOpt: (v: string) => void, cust: string, onCust: (v: string) => void, disabled?: boolean) {
    return (
      <div>
        <label className="block text-xs font-medium text-[var(--content-muted)] mb-1.5">Ставка НДС</label>
        <Select value={opt} onValueChange={onOpt} disabled={disabled}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {VAT_OPTIONS.map((v) => (<SelectItem key={v} value={v}>{VAT_LABELS[v]}</SelectItem>))}
          </SelectContent>
        </Select>
        {opt === 'custom' && (
          <div className="mt-2">
            <Input type="number" min={0} max={100} step="0.01" placeholder="Введите ставку %" value={cust} onChange={(e) => onCust(e.target.value)} disabled={disabled} />
          </div>
        )}
      </div>
    );
  }

  // --- Render ---
  return (
    <AppShell title="Магазины">
      <div className="space-y-5">
        {/* Top tabs — Магазины vs Telegram. Same page hosts both because
            connecting WB / connecting Telegram are conceptually the same
            onboarding step ("hook up an external account"). */}
        <Card className="p-0 overflow-hidden">
          <div className="flex border-b border-gray-200">
            <button
              type="button"
              onClick={() => setActiveTab('shops')}
              className={cn(
                'px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors inline-flex items-center gap-2',
                activeTab === 'shops'
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50',
              )}
            >
              <Store className="h-4 w-4" />
              Магазины
              {shops.length > 0 && (
                <span className={cn(
                  'text-xs px-1.5 py-0.5 rounded-full',
                  activeTab === 'shops' ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600',
                )}>
                  {shops.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('telegram')}
              className={cn(
                'px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors inline-flex items-center gap-2',
                activeTab === 'telegram'
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50',
              )}
            >
              <Send className="h-4 w-4" />
              Telegram
            </button>
          </div>
        </Card>

        {activeTab === 'telegram' ? (
          <TelegramLinkCard />
        ) : (
        <>
        {wizardOpen ? (
          <Card>
            <div className="p-5">
              <div className="flex items-center gap-3 mb-5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600"><Plus className="h-5 w-5" /></div>
                <div>
                  <div className="text-sm font-semibold text-[var(--content-text)]">Подключить магазин</div>
                  <div className="text-xs text-[var(--content-muted)]">
                    {step === 'token' || step === 'validating' ? 'Шаг 1 из 3 — API-токен' : step === 'params' || step === 'saving' || step === 'syncing' ? 'Шаг 2 из 3 — Параметры' : 'Готово!'}
                  </div>
                </div>
              </div>

              <div className="flex gap-2 mb-5">
                {['token', 'params', 'done'].map((s) => {
                  const isCurrent = (s === 'token' && (step === 'token' || step === 'validating')) || (s === 'params' && (step === 'params' || step === 'saving' || step === 'syncing')) || (s === 'done' && step === 'done');
                  const isPast = (s === 'token' && step !== 'token' && step !== 'validating') || (s === 'params' && step === 'done');
                  return <div key={s} className={`h-1 flex-1 rounded-full transition-colors ${isCurrent ? 'bg-indigo-500' : isPast ? 'bg-indigo-300' : 'bg-slate-200'}`} />;
                })}
              </div>

              {/* Token step */}
              {(step === 'token' || step === 'validating') && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-[var(--content-muted)] mb-1.5">Платформа</label>
                    {/* Только WB по решению 2026-05-25 — поддержка Ozon и Яндекс Маркета
                        пока под вопросом и убрана из выбора, чтобы не вводить
                        пользователей в заблуждение. Локальный state platform остаётся
                        для совместимости с веткующим ниже кодом. */}
                    <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm">
                      <span className="font-medium text-[var(--content-text)]">Wildberries</span>
                      <span className="text-xs text-[var(--content-muted)]">Ozon и Я.Маркет — скоро</span>
                    </div>
                  </div>

                  {platform === 'wb' && (
                    <div className="rounded-lg border border-blue-100 bg-blue-50/50 p-3">
                      <div className="flex items-start gap-2">
                        <ShieldCheck className="h-4 w-4 mt-0.5 text-blue-500 shrink-0" />
                        <div className="text-xs text-blue-700 leading-relaxed">
                          <span className="font-medium">Где взять токен?</span> Перейдите в{' '}
                          <a href="https://seller.wildberries.ru/supplier-settings/access-to-api" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium underline underline-offset-2">
                            Кабинет продавца WB → Настройки → Доступ к API <ExternalLink className="h-3 w-3" />
                          </a>. Создайте токен с <span className="font-medium">полным доступом</span> — отметьте все категории (Контент, Статистика, Аналитика, Цены и скидки, Маркетплейс, Реклама, Поставки, Отзывы, Финансы). Токена только со «Статистикой» недостаточно.
                        </div>
                      </div>
                    </div>
                  )}

                  {platform === 'ozon' && (
                    <div className="rounded-lg border border-blue-100 bg-blue-50/50 p-3">
                      <div className="flex items-start gap-2">
                        <ShieldCheck className="h-4 w-4 mt-0.5 text-blue-500 shrink-0" />
                        <div className="text-xs text-blue-700 leading-relaxed">
                          <span className="font-medium">Где взять ключи?</span> Откройте{' '}
                          <a href="https://seller.ozon.ru/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium underline underline-offset-2">
                            кабинет Ozon Seller <ExternalLink className="h-3 w-3" />
                          </a>, затем «Настройки → API ключи». Нужны <b>Client‑Id</b> и <b>API‑ключ</b>.
                        </div>
                      </div>
                    </div>
                  )}

                  {platform === 'yandex_market' && (
                    <div className="rounded-lg border border-blue-100 bg-blue-50/50 p-3">
                      <div className="flex items-start gap-2">
                        <ShieldCheck className="h-4 w-4 mt-0.5 text-blue-500 shrink-0" />
                        <div className="text-xs text-blue-700 leading-relaxed">
                          <span className="font-medium">Где взять токен?</span> Войдите в{' '}
                          <a href="https://partner.market.yandex.ru/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium underline underline-offset-2">
                            кабинет Яндекс Маркета <ExternalLink className="h-3 w-3" />
                          </a>, затем «Настройки → API». Нужны <b>токен</b> и <b>Campaign ID</b>.
                        </div>
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-[var(--content-muted)] mb-1.5">
                      {platform === 'wb' ? 'API-токен Wildberries' : platform === 'ozon' ? 'API ключ Ozon' : 'OAuth токен Яндекс Маркета'}
                    </label>
                    <textarea className="flex w-full rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--content-text)] placeholder:text-[var(--content-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:cursor-not-allowed disabled:opacity-50 resize-none font-mono" rows={3} placeholder="eyJhbGciOiJFUzI1NiIsIn..." value={token} onChange={(e) => { setToken(e.target.value); setTokenValid(null); setTokenError(null); }} disabled={step === 'validating'} />
                  </div>

                  {(platform === 'ozon' || platform === 'yandex_market') && (
                    <div>
                      <label className="block text-xs font-medium text-[var(--content-muted)] mb-1.5">
                        {platform === 'ozon' ? 'Client-Id Ozon' : 'Campaign ID Яндекс Маркета'}
                      </label>
                      <Input placeholder={platform === 'ozon' ? 'например 123456' : 'например 148895516'} value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={step === 'validating'} />
                    </div>
                  )}
                  {tokenError && <div className="flex items-center gap-2 text-xs text-red-600"><XCircle className="h-4 w-4 shrink-0" />{tokenError}</div>}
                  <div className="flex items-center gap-3">
                    <Button disabled={!token.trim() || step === 'validating'} loading={step === 'validating'} onClick={validateToken}>
                      {step === 'validating' ? 'Проверяем…' : (platform === 'wb' ? 'Проверить токен' : 'Далее')}
                    </Button>
                    <Button variant="ghost" onClick={closeWizard} disabled={step === 'validating'}>Отмена</Button>
                  </div>
                </div>
              )}

              {/* Params step */}
              {(step === 'params' || step === 'saving' || step === 'syncing') && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-xs text-emerald-600 bg-emerald-50 rounded-lg px-3 py-2 border border-emerald-100">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />{platform === 'wb' ? 'Токен проверен и действителен' : 'Данные готовы к сохранению'}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[var(--content-muted)] mb-1.5">Название магазина</label>
                    <Input placeholder="Например: ООО Ромашка" value={shopName} onChange={(e) => setShopName(e.target.value)} disabled={step === 'saving' || step === 'syncing'} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-[var(--content-muted)] mb-1.5">Налоговый режим</label>
                      <Select value={taxRegime} onValueChange={(v) => setTaxRegime(v as any)} disabled={step === 'saving' || step === 'syncing'}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="usn6">УСН 6%</SelectItem>
                          <SelectItem value="usn15">УСН 15%</SelectItem>
                          <SelectItem value="osno">ОСНО</SelectItem>
                          <SelectItem value="patent">Патент</SelectItem>
                          <SelectItem value="ausn8">АУСН Доходы (8%)</SelectItem>
                          <SelectItem value="ausn20">АУСН Д−Р (20%)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {renderVatField(vatOption, setVatOption, customVat, setCustomVat, step === 'saving' || step === 'syncing')}
                  </div>
                  {saveError && <div className="flex items-center gap-2 text-xs text-red-600"><XCircle className="h-4 w-4 shrink-0" />{saveError}</div>}
                  <div className="flex items-center gap-3">
                    <Button disabled={!shopName.trim() || step === 'saving' || step === 'syncing'} loading={step === 'saving' || step === 'syncing'} onClick={saveShop}>
                      <Zap className="h-4 w-4" />{step === 'saving' ? 'Сохраняем…' : step === 'syncing' ? 'Синхронизация…' : 'Подключить магазин'}
                    </Button>
                    <Button variant="ghost" onClick={() => setStep('token')} disabled={step === 'saving' || step === 'syncing'}>Назад</Button>
                  </div>
                </div>
              )}

              {/* Done step */}
              {step === 'done' && (
                <div className="space-y-4">
                  <div className="flex flex-col items-center py-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50"><CheckCircle2 className="h-7 w-7 text-emerald-500" /></div>
                    <div className="mt-3 text-sm font-medium text-[var(--content-text)]">Магазин подключён!</div>
                    <div className="mt-1 text-xs text-[var(--content-muted)] text-center max-w-xs">
                      {platform === 'wb'
                        ? 'Синхронизация запущена. Данные появятся на странице «Пульс» через несколько минут.'
                        : 'Магазин подключён для FBS‑отгрузок. Настройте расписание в разделе «Отгрузки FBS».'}
                    </div>
                  </div>
                  <div className="flex items-center justify-center gap-3">
                    <Button onClick={closeWizard}>Готово</Button>
                    <Button variant="neutral" onClick={openWizard}><Plus className="h-4 w-4" />Ещё один</Button>
                  </div>
                </div>
              )}
            </div>
          </Card>
        ) : (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-[var(--content-text)]">Подключённые магазины</div>
              <div className="mt-0.5 text-xs text-[var(--content-muted)]">API‑ключи для подключения маркетплейсов</div>
            </div>
            <Button onClick={openWizard}><Plus className="h-4 w-4" />Подключить магазин</Button>
          </div>
        )}

        {/* Inline refresh error banner — stays above the shop list so
            users can still interact with other shops. */}
        {refreshError && (
          <Card className="border-red-200 bg-red-50">
            <div className="p-3 text-sm text-red-700 flex items-center justify-between">
              <span>Ошибка запуска обновления: {refreshError}</span>
              <button className="text-red-400 hover:text-red-600" onClick={() => setRefreshError(null)}>✕</button>
            </div>
          </Card>
        )}

        {/* Shop list */}
        {listLoading && !shops.length ? (
          <Card><div className="flex items-center justify-center p-8 text-sm text-[var(--content-muted)]"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Загрузка…</div></Card>
        ) : listError ? (
          <Card><div className="p-5 text-sm text-red-600">{listError}</div></Card>
        ) : shops.length === 0 && !wizardOpen ? (
          <Card>
            <div className="flex flex-col items-center py-10">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100"><Store className="h-7 w-7 text-slate-400" /></div>
              <div className="mt-4 text-sm font-medium text-[var(--content-text)]">Нет подключённых магазинов</div>
              <div className="mt-1 text-xs text-[var(--content-muted)]">Подключите свой первый магазин для загрузки данных</div>
              <Button className="mt-4" onClick={openWizard}><Plus className="h-4 w-4" />Подключить магазин</Button>
            </div>
          </Card>
        ) : (
          <div className="space-y-2">
            {shops.map((shop) => (
              <Card key={shop.shopId}>
                <div className="flex items-center gap-4 p-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600"><Store className="h-5 w-5" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-medium text-[var(--content-text)] truncate">{shop.name}</div>
                      {shop.isActive && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600 border border-emerald-100">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Активен
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--content-muted)]">
                      {PLATFORM_LABELS[shop.platform] ?? shop.platform} · {TAX_LABELS[shop.taxRegime] ?? shop.taxRegime} · {vatDisplay(shop.vatPct)} · Подключён {new Date(shop.createdAt).toLocaleDateString('ru-RU')}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Обновить (только пропущенные дни)"
                      onClick={() => triggerRefresh(shop.shopId, false)}
                      disabled={refreshingShopId === shop.shopId}
                    >
                      <RefreshCw
                        className={`h-4 w-4 ${refreshingShopId === shop.shopId ? 'animate-spin' : ''}`}
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Принудительное обновление (игнорировать gap detection, 120 дней)"
                      onClick={() => {
                        if (confirm('Полный 120-дневный backfill может занять 10-30 минут и перезаписать существующие данные. Продолжить?')) {
                          triggerRefresh(shop.shopId, true);
                        }
                      }}
                      disabled={refreshingShopId === shop.shopId}
                    >
                      <RotateCcw className="h-4 w-4 text-amber-700" />
                    </Button>
                    <Button variant="ghost" size="icon" title="Редактировать" onClick={() => startEdit(shop)}><Pencil className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" title="Удалить" onClick={() => setDeletingId(shop.shopId)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
        </>
        )}
      </div>

      {/* Edit modal */}
      {editingShop && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <Card className="w-full max-w-md mx-4">
            <div className="p-5 space-y-4">
              <div className="text-sm font-semibold text-[var(--content-text)]">Редактировать магазин</div>
              <div>
                <label className="block text-xs font-medium text-[var(--content-muted)] mb-1.5">Название</label>
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--content-muted)] mb-1.5">Новый API‑ключ (если нужно заменить)</label>
                <Input placeholder="оставьте пустым, если не менять" value={editApiKey} onChange={(e) => setEditApiKey(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--content-muted)] mb-1.5">Client ID / Campaign ID</label>
                <Input placeholder="оставьте пустым, если не менять" value={editClientId} onChange={(e) => setEditClientId(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--content-muted)] mb-1.5">Налоговый режим</label>
                  <Select value={editTax} onValueChange={setEditTax}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="usn6">УСН 6%</SelectItem>
                      <SelectItem value="usn15">УСН 15%</SelectItem>
                      <SelectItem value="osno">ОСНО</SelectItem>
                      <SelectItem value="patent">Патент</SelectItem>
                      <SelectItem value="ausn8">АУСН Доходы (8%)</SelectItem>
                      <SelectItem value="ausn20">АУСН Д−Р (20%)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {renderVatField(editVatOption, setEditVatOption, editCustomVat, setEditCustomVat)}
              </div>
              <div className="flex items-center gap-3 pt-1">
                <Button onClick={saveEdit} loading={editLoading} disabled={!editName.trim()}>Сохранить</Button>
                <Button variant="ghost" onClick={() => setEditingShop(null)} disabled={editLoading}>Отмена</Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Delete confirm */}
      {deletingId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <Card className="w-full max-w-sm mx-4">
            <div className="p-5 space-y-4">
              <div className="text-sm font-semibold text-[var(--content-text)]">Удалить магазин?</div>
              <div className="text-sm text-[var(--content-muted)]">Магазин «{shops.find((s) => s.shopId === deletingId)?.name}» будет удалён. Данные синхронизации сохранятся.</div>
              <div className="flex items-center gap-3">
                <Button variant="danger" onClick={confirmDelete} loading={deleteLoading}>Удалить</Button>
                <Button variant="ghost" onClick={() => setDeletingId(null)} disabled={deleteLoading}>Отмена</Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </AppShell>
  );
}
