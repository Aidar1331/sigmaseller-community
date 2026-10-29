'use client';

import { useShopChange } from '@/hooks/useShopChange';
import { useShopParam } from '@/hooks/useShopParam';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/Select';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import { 
  MessageSquare, HelpCircle, RefreshCw, Sparkles, Send, X, Star,
  Settings, BookOpen, Download, Image, Video, ThumbsUp, AlertTriangle,
  Zap, Trash2, CheckCircle, Pencil, Save
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { AiAnalyzeButton } from '@/components/ai';
import { FeedbackSummaryPanel } from '@/components/feedback/FeedbackSummaryPanel';
import { FeedbackCategoriesDashboard } from '@/components/feedback/FeedbackCategoriesDashboard';

type FeedbackItem = {
  marketplace: string;
  itemType: 'review' | 'question';
  itemId: string;
  nmId?: number | null;
  productTitle: string | null;
  brandName: string | null;
  userName?: string | null;
  rating: number | null;
  text: string | null;
  pros: string | null;
  cons: string | null;
  photosCount?: number;
  hasVideo?: boolean;
  status: string;
  createdAt: string | null;
  answerText?: string | null;
  answerState?: string | null;
  answeredAt?: string | null;
  /** WB-флаг: можно ли запросить возврат по отзыву. */
  isAbleReturnProductOrders?: boolean;
  draft?: { draftId: number; content: string; status: string; confidence?: number } | null;
  analysis?: { sentiment: string; summary: string; keyPoints: string[]; issues?: string[] } | null;
};

type FeedbackSettings = {
  autoSend: boolean;
  minConfidence: number;
  allowWebSearch: boolean;
  requireApproval: boolean;
  notifyTelegram: boolean;
  tone: string | null;
  maxLength: number | null;
  praiseLevel: 'minimal' | 'moderate' | 'enthusiastic' | null;
  photoBonus: boolean;
  star5Template: string | null;
  complaintStyle: 'apologetic' | 'solution_focused' | 'balanced' | null;
  signature: string | null;
  forbiddenWords: string[];
  autoSendPositive: boolean;
  autoSendMinRating: number;
};

type KnowledgeStats = {
  total: number;
  byType: Record<string, number>;
  byScope: Record<string, number>;
};

export default function FeedbackPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopParam = useShopParam();
  const [marketplace, setMarketplace] = useState<'wb' | 'ozon'>('wb');
  const [tab, setTab] = useState<'review' | 'question'>('review');
  const [filterNmId, setFilterNmId] = useState('');
  const [filterRating, setFilterRating] = useState<number | null>(null);
  const [filterHasPhoto, setFilterHasPhoto] = useState<boolean | null>(null);
  const [filterStatus, setFilterStatus] = useState<'all' | 'new' | 'answered'>('all');
  const [filterDateFrom, setFilterDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [filterDateTo, setFilterDateTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<FeedbackSettings | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [knowledgeRows, setKnowledgeRows] = useState<any[]>([]);
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgeStats | null>(null);
  const [knowledgeImporting, setKnowledgeImporting] = useState(false);
  const [syncingHistory, setSyncingHistory] = useState(false);
  const [knowledgeForm, setKnowledgeForm] = useState({
    // Этой странице принадлежит только feedback-scope. Документы из
    // documentHub (workspace:document) сюда не подмешиваются.
    scopeType: 'feedback',
    scopeKey: 'global',
    title: '',
    content: '',
    entryType: 'instruction',
    tags: '',
  });
  const [uploadingFile, setUploadingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showKnowledgeBase, setShowKnowledgeBase] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ title: '', content: '', tags: '' });
  const [error, setError] = useState<string | null>(null);

  const keyFor = useCallback((item: FeedbackItem) => `${item.itemType}:${item.itemId}`, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let url = `/feedback/${workspaceId}/items?marketplace=${marketplace}&itemType=${tab}&limit=100${shopParam}`;
      const nmIdNum = Number.parseInt(filterNmId.trim(), 10);
      if (Number.isFinite(nmIdNum) && nmIdNum > 0) url += `&nmId=${nmIdNum}`;
      if (filterStatus !== 'all') url += `&status=${filterStatus}`;
      if (filterDateFrom) url += `&dateFrom=${filterDateFrom}`;
      if (filterDateTo) url += `&dateTo=${filterDateTo}`;
      if (filterRating !== null) url += `&rating=${filterRating}`;
      if (filterHasPhoto !== null) url += `&hasPhoto=${filterHasPhoto ? '1' : '0'}`;
      const res = (await apiFetch(url)) as { rows: FeedbackItem[] };
      setItems(res.rows ?? []);
      const edits: Record<string, string> = {};
      (res.rows ?? []).forEach((it) => {
        edits[keyFor(it)] = it.draft?.content ?? '';
      });
      setDraftEdits(edits);
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось загрузить данные');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, marketplace, tab, filterNmId, filterStatus, filterDateFrom, filterDateTo, filterRating, keyFor, shopParam]);

  const loadSettings = useCallback(async () => {
    try {
      const res = (await apiFetch(
        `/feedback/${workspaceId}/settings?marketplace=${marketplace}&itemType=${tab}`
      )) as { settings: FeedbackSettings };
      setSettings(res.settings ?? null);
    } catch (e: any) {
      console.error('Failed to load settings:', e);
    }
  }, [workspaceId, marketplace, tab]);

  const loadKnowledge = useCallback(async (search?: string) => {
    try {
      const q = search ? `&q=${encodeURIComponent(search)}` : '';
      const [rows, stats] = await Promise.all([
        apiFetch(`/knowledge/${workspaceId}?limit=50${q}`) as Promise<{ rows: any[] }>,
        apiFetch(`/knowledge/${workspaceId}/stats`) as Promise<KnowledgeStats>,
      ]);
      setKnowledgeRows(rows.rows ?? []);
      setKnowledgeStats(stats);
    } catch (e: any) {
      console.error('Failed to load knowledge:', e);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadItems();
    loadSettings();
  }, [loadItems, loadSettings]);
  useShopChange(loadItems);

  useEffect(() => {
    loadKnowledge();
  }, [loadKnowledge]);

  const onSync = async () => {
    try {
      await apiFetch(`/feedback/${workspaceId}/sync${shopParam ? `?${shopParam.slice(1)}` : ''}`, {
        method: 'POST',
        body: JSON.stringify({ marketplace, itemType: tab, take: 200, skip: 0 }),
        headers: { 'Content-Type': 'application/json' },
      });
      await loadItems();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось синхронизировать');
    }
  };

  const onSyncHistory = async () => {
    setSyncingHistory(true);
    try {
      await apiFetch(`/feedback/${workspaceId}/sync-history${shopParam ? `?${shopParam.slice(1)}` : ''}`, {
        method: 'POST',
        body: JSON.stringify({ marketplace, take: 1000 }),
        headers: { 'Content-Type': 'application/json' },
      });
      await loadItems();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось синхронизировать историю');
    } finally {
      setSyncingHistory(false);
    }
  };

  const onImportKnowledge = async () => {
    setKnowledgeImporting(true);
    try {
      await apiFetch(`/knowledge/${workspaceId}/import`, { method: 'POST' });
      await loadKnowledge();
    } finally {
      setKnowledgeImporting(false);
    }
  };

  const [draftingId, setDraftingId] = useState<string | null>(null);
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);

  const startEditingReply = (item: FeedbackItem) => {
    setDraftEdits((prev) => ({ ...prev, [keyFor(item)]: item.answerText ?? '' }));
    setEditingReplyId(item.itemId);
  };
  const cancelEditingReply = (item: FeedbackItem) => {
    setEditingReplyId(null);
    setDraftEdits((prev) => {
      const next = { ...prev };
      delete next[keyFor(item)];
      return next;
    });
  };
  const onSaveEditedReply = async (item: FeedbackItem) => {
    const next = (draftEdits[keyFor(item)] ?? '').trim();
    if (!next || next === item.answerText) {
      setEditingReplyId(null);
      return;
    }
    try {
      await apiFetch(`/feedback/${workspaceId}/items/feedback/${item.itemId}/edit-reply${shopParam ? `?${shopParam.slice(1)}` : ''}`, {
        method: 'POST',
        body: JSON.stringify({ text: next }),
        headers: { 'Content-Type': 'application/json' },
      });
      setEditingReplyId(null);
      await loadItems();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось обновить ответ');
    }
  };

  const onDraft = async (item: FeedbackItem) => {
    setDraftingId(item.itemId);
    try {
      await apiFetch(`/feedback/${workspaceId}/items/${item.itemType}/${item.itemId}/draft`, {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      });
      await loadItems();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось создать черновик');
    } finally {
      setDraftingId(null);
    }
  };

  const onAnalyze = async (item: FeedbackItem) => {
    try {
      await apiFetch(`/feedback/${workspaceId}/items/${item.itemType}/${item.itemId}/analyze`, {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      });
      await loadItems();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось проанализировать');
    }
  };

  const onApprove = async (item: FeedbackItem) => {
    try {
      let content = (draftEdits[keyFor(item)] ?? '').trim();
      // Replace [имя] placeholder with actual user name
      if (item.userName) {
        content = content.replace(/\[имя\]/gi, item.userName);
      } else {
        // Remove placeholder if no name available
        content = content.replace(/\[имя\],?\s*/gi, '');
      }
      await apiFetch(`/feedback/${workspaceId}/items/${item.itemType}/${item.itemId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ content, draftId: item.draft?.draftId }),
        headers: { 'Content-Type': 'application/json' },
      });
      await loadItems();
    } catch (err: any) {
      console.error('Failed to approve:', err);
      setError(err?.message ?? 'Не удалось отправить ответ');
    }
  };

  const onReject = async (item: FeedbackItem) => {
    try {
      await apiFetch(`/feedback/${workspaceId}/items/${item.itemType}/${item.itemId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ draftId: item.draft?.draftId }),
        headers: { 'Content-Type': 'application/json' },
      });
      await loadItems();
    } catch (err: any) {
      console.error('Failed to reject:', err);
      setError(err?.message ?? 'Не удалось отклонить ответ');
    }
  };

  // ─── WB-actions: возврат / отклонение вопроса ──
  const onReturnByReview = async (item: FeedbackItem) => {
    if (!confirm(`Оформить возврат товара по этому отзыву? Если товар у покупателя — возврат пройдёт после доставки в ПВЗ.`)) return;
    try {
      await apiFetch(`/feedback/${workspaceId}/items/feedback/${item.itemId}/return-by-review${shopParam ? `?${shopParam.slice(1)}` : ''}`, {
        method: 'POST',
      });
      alert('✅ Заявка на возврат оформлена');
      await loadItems();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось оформить возврат');
    }
  };

  const onRejectQuestion = async (item: FeedbackItem) => {
    const text = window.prompt('Текст ответа покупателю (не будет опубликован на WB, виден только ему):', '');
    if (text == null || text.trim() === '') return;
    try {
      await apiFetch(`/feedback/${workspaceId}/items/question/${item.itemId}/reject-on-wb${shopParam ? `?${shopParam.slice(1)}` : ''}`, {
        method: 'POST',
        body: JSON.stringify({ text: text.trim() }),
        headers: { 'Content-Type': 'application/json' },
      });
      await loadItems();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось отклонить вопрос');
    }
  };

  const onSaveSettings = async () => {
    if (!settings) return;
    setSettingsSaving(true);
    try {
      const res = await apiFetch(`/feedback/${workspaceId}/settings/extended`, {
        method: 'PUT',
        body: JSON.stringify({
          marketplace,
          itemType: tab,
          ...settings,
        }),
        headers: { 'Content-Type': 'application/json' },
      });
      setSettings((res as any).settings ?? settings);
    } finally {
      setSettingsSaving(false);
    }
  };

  const onAddKnowledge = async () => {
    if (!knowledgeForm.title || !knowledgeForm.content) return;
    // Если в форме указан scopeKey — это nmId (через ProductSearchInput).
    // Записываем его в nmIds, чтобы Feedback Pipeline v2 правильно
    // подбирал инструкцию при ответе на отзыв этого товара.
    const nmIdNum = knowledgeForm.scopeKey && knowledgeForm.scopeKey !== 'global'
      ? Number.parseInt(knowledgeForm.scopeKey, 10)
      : null;
    await apiFetch(`/knowledge/${workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({
        scopeType: 'feedback',
        scopeKey: nmIdNum ? `nm:${nmIdNum}` : 'global',
        title: knowledgeForm.title,
        content: knowledgeForm.content,
        entryType: knowledgeForm.entryType,
        nmIds: nmIdNum ? [nmIdNum] : [],
        tags: knowledgeForm.tags ? knowledgeForm.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    setKnowledgeForm({ ...knowledgeForm, scopeKey: 'global', title: '', content: '', tags: '' });
    await loadKnowledge();
  };

  // Загрузка файла-инструкции (PDF/DOCX/TXT/MD/CSV/XLSX). Файл парсится
  // backend'ом и сохраняется как обычная запись knowledge_entries с
  // scopeType='feedback'. Использует существующий парсер documentHub.
  const onUploadKnowledgeFile = async (file: File) => {
    if (!file) return;
    setUploadingFile(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const params = new URLSearchParams();
      params.set('entryType', knowledgeForm.entryType);
      // scopeKey формы — это либо 'global', либо строковый nmId из ProductSearchInput.
      const nmIdNum = knowledgeForm.scopeKey && knowledgeForm.scopeKey !== 'global'
        ? Number.parseInt(knowledgeForm.scopeKey, 10)
        : null;
      if (nmIdNum) params.set('nmId', String(nmIdNum));
      await apiFetch(`/knowledge/${workspaceId}/upload?${params.toString()}`, {
        method: 'POST',
        body: formData,
        // не указываем Content-Type — браузер сам выставит multipart/form-data с boundary
      });
      setKbSuccess('Файл загружен и добавлен в базу знаний');
      setTimeout(() => setKbSuccess(null), 3000);
      await loadKnowledge();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось загрузить файл');
    } finally {
      setUploadingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const [kbSuccess, setKbSuccess] = useState<string | null>(null);

  const onAddToKnowledge = async (item: FeedbackItem) => {
    const title = item.text?.slice(0, 100) || `${item.itemType === 'review' ? 'Отзыв' : 'Вопрос'} ${item.itemId}`;
    const content = `${item.text || ''}\n\n---\nОтвет: ${draftEdits[keyFor(item)] || item.draft?.content || ''}`.trim();

    try {
      await apiFetch(`/knowledge/${workspaceId}`, {
        method: 'POST',
        body: JSON.stringify({
          scopeType: 'feedback',
          scopeKey: item.nmId ? `nm:${item.nmId}` : 'global',
          entryType: 'complaint_solution',
          title,
          content,
          nmIds: item.nmId ? [item.nmId] : [],
          tags: [item.itemType === 'review' ? 'отзыв' : 'вопрос'],
        }),
      });
      await loadKnowledge();
      setError(null);
      setKbSuccess('Добавлено в базу знаний');
      setTimeout(() => setKbSuccess(null), 3000);
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось добавить в базу знаний');
    }
  };

  const onDeleteKnowledge = async (entryId: number) => {
    if (!confirm('Удалить эту запись из базы знаний?')) return;
    await apiFetch(`/knowledge/${workspaceId}/${entryId}`, { method: 'DELETE' });
    await loadKnowledge();
  };

  const onEditKnowledge = (row: any) => {
    setEditingEntryId(row.entryId);
    setEditForm({
      title: row.title ?? '',
      content: row.content ?? '',
      tags: Array.isArray(row.tags) ? row.tags.join(', ') : '',
    });
  };

  const onSaveKnowledge = async () => {
    if (!editingEntryId || !editForm.title || !editForm.content) return;
    await apiFetch(`/knowledge/${workspaceId}/${editingEntryId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: editForm.title,
        content: editForm.content,
        tags: editForm.tags ? editForm.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    setEditingEntryId(null);
    await loadKnowledge();
  };

  const title = useMemo(() => (tab === 'review' ? 'Отзывы' : 'Вопросы'), [tab]);

  // Сводка по текущему списку
  const summary = useMemo(() => {
    const total = items.length;
    const unanswered = items.filter((i) => !i.answerText).length;
    const reviews = items.filter((i) => i.itemType === 'review');
    const ratings = reviews.map((i) => i.rating).filter((r): r is number => typeof r === 'number');
    const avgRating = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
    const fiveStars = ratings.filter((r) => r === 5).length;
    const lowStars = ratings.filter((r) => r <= 2).length;
    return { total, unanswered, avgRating, fiveStars, lowStars };
  }, [items]);

  const [autoReplying, setAutoReplying] = useState(false);
  const onAutoReplyAll = async () => {
    if (summary.unanswered === 0) return;
    if (!confirm(`AI ответит и сразу отправит ответы на ${summary.unanswered} ${summary.unanswered === 1 ? 'отзыв/вопрос' : 'отзывов/вопросов'}. Продолжить?`)) return;
    setAutoReplying(true);
    setError(null);
    try {
      const res: any = await apiFetch(`/feedback/${workspaceId}/auto-reply-now${shopParam ?? ''}`, { method: 'POST' });
      if (res?.ok === false && res?.reason === 'no_settings') {
        setError('Сначала настройте режим AI-ответов ниже и нажмите «Сохранить настройки».');
      } else {
        alert(`Готово.\nЧерновиков создано: ${res?.drafts ?? 0}\nОтправлено: ${res?.sent ?? 0}`);
      }
      await loadItems();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось запустить автоответ');
    } finally {
      setAutoReplying(false);
    }
  };

  const modeValue = !settings?.autoSend ? 'manual' : settings?.requireApproval ? 'draft' : 'auto';
  const onChangeMode = async (mode: 'manual' | 'draft' | 'auto') => {
    if (!settings) return;
    const next = { ...settings, autoSend: mode !== 'manual', requireApproval: mode !== 'auto' };
    setSettings(next);
    try {
      await apiFetch(`/feedback/${workspaceId}/settings${shopParam ?? ''}`, {
        method: 'PUT',
        body: JSON.stringify({
          autoSend: next.autoSend,
          requireApproval: next.requireApproval,
          notifyTelegram: next.notifyTelegram,
        }),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось сохранить режим');
    }
  };

  const getSentimentColor = (sentiment: string) => {
    if (sentiment === 'positive') return 'text-green-700 bg-green-50';
    if (sentiment === 'negative') return 'text-red-600 bg-red-50';
    return 'text-gray-600 bg-gray-50';
  };

  if (workspaceId === null) {
    return (
      <AppShell title="Отзывы и вопросы">
        <div className="p-6">
          <Card className="p-8 text-center text-[var(--content-muted)]">
            Выберите магазин для просмотра отзывов
          </Card>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Отзывы и вопросы">
      <div className="space-y-4">
        {/* Error Banner */}
        <ErrorBanner error={error} onRetry={loadItems} onDismiss={() => setError(null)} />
        {kbSuccess && (
          <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700">{kbSuccess}</div>
        )}

        {/* AI-инсайты по отзывам: дашборд распределения + сводка по запросу */}
        {workspaceId && (
          <div className="grid gap-3 md:grid-cols-2">
            <FeedbackCategoriesDashboard workspaceId={workspaceId} />
            <FeedbackSummaryPanel workspaceId={workspaceId} />
          </div>
        )}

        {/* Filters */}
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Multi-marketplace switcher свёрнут до одной плашки 2026-05-25 —
                Ozon под вопросом, не хотим показывать как "скоро". */}
            <div className="text-sm font-medium text-gray-700">Wildberries</div>
            <div className="flex gap-2">
              <Button variant="neutral" size="sm" onClick={onSync}>
                <RefreshCw className="h-4 w-4" />
                Синхронизировать
              </Button>
              <Button variant="neutral" size="sm" onClick={onSyncHistory} loading={syncingHistory}>
                <Download className="h-4 w-4" />
                История
              </Button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="flex gap-2">
              <button
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  tab === 'review' && !showKnowledgeBase
                    ? 'bg-indigo-50 text-indigo-700' 
                    : 'text-gray-500 hover:bg-gray-100'
                )}
                onClick={() => { setTab('review'); setShowKnowledgeBase(false); }}
              >
                <MessageSquare className="h-4 w-4" />
                Отзывы
              </button>
              <button
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  tab === 'question' && !showKnowledgeBase
                    ? 'bg-indigo-50 text-indigo-700' 
                    : 'text-gray-500 hover:bg-gray-100'
                )}
                onClick={() => { setTab('question'); setShowKnowledgeBase(false); }}
              >
                <HelpCircle className="h-4 w-4" />
                Вопросы
              </button>
              <button
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  showKnowledgeBase
                    ? 'bg-indigo-50 text-indigo-700' 
                    : 'text-gray-500 hover:bg-gray-100'
                )}
                onClick={() => setShowKnowledgeBase(true)}
              >
                <BookOpen className="h-4 w-4" />
                Шаблоны ответов
              </button>
            </div>

            <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-[350px]">
              <span className="text-xs text-gray-500 whitespace-nowrap">Товар:</span>
              <ProductSearchInput
                workspaceId={workspaceId}
                value={filterNmId}
                onChange={setFilterNmId}
                single
                compact
                placeholder="Все товары"
                className="flex-1"
              />
            </div>

            {/* Rating filter */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Оценка:</span>
              <select
                className="h-8 rounded-lg border border-gray-300 bg-white px-2 text-sm"
                value={filterRating ?? ''}
                onChange={(e) => setFilterRating(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Все</option>
                <option value="5">⭐ 5</option>
                <option value="4">⭐ 4</option>
                <option value="3">⭐ 3</option>
                <option value="2">⭐ 2</option>
                <option value="1">⭐ 1</option>
              </select>
            </div>

            {/* Photo filter */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Фото:</span>
              <select
                className="h-8 rounded-lg border border-gray-300 bg-white px-2 text-sm"
                value={filterHasPhoto === null ? '' : filterHasPhoto ? 'yes' : 'no'}
                onChange={(e) => setFilterHasPhoto(e.target.value === '' ? null : e.target.value === 'yes')}
              >
                <option value="">Все</option>
                <option value="yes">📷 С фото</option>
                <option value="no">Без фото</option>
              </select>
            </div>

            {/* Status filter */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Статус:</span>
              <select
                className="h-8 rounded-lg border border-gray-300 bg-white px-2 text-sm"
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as 'all' | 'new' | 'answered')}
              >
                <option value="all">Все</option>
                <option value="new">🆕 Новые</option>
                <option value="answered">✅ Обработанные</option>
              </select>
            </div>

            {/* Date filters */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Дата:</span>
              <input
                type="date"
                className="h-8 rounded-lg border border-gray-300 bg-white px-2 text-sm"
                value={filterDateFrom}
                onChange={(e) => setFilterDateFrom(e.target.value)}
              />
              <span className="text-xs text-gray-500">—</span>
              <input
                type="date"
                className="h-8 rounded-lg border border-gray-300 bg-white px-2 text-sm"
                value={filterDateTo}
                onChange={(e) => setFilterDateTo(e.target.value)}
              />
            </div>

            {/* A5 cleanup 2026-05-07: removed duplicate Автоответ/Telegram
                checkboxes from filter header — same controls live in the
                «Настройки AI-ответов» card below. */}
          </div>
        </Card>

        {/* Управление ответами: сводка + режим + bulk-автоответ + (раскрывается) AI-тюнинг */}
        {!showKnowledgeBase && (
          <Card className="p-4 space-y-3">
            {loading ? (
              <div className="text-sm text-gray-500">Загрузка…</div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3 justify-between">
                  {/* Счётчики */}
                  <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                    <div>
                      <span className="text-2xl font-semibold text-gray-900">{summary.total}</span>
                      <span className="ml-1 text-xs text-gray-500">всего {tab === 'review' ? 'отзывов' : 'вопросов'}</span>
                    </div>
                    <div>
                      <span className={cn('text-2xl font-semibold', summary.unanswered > 0 ? 'text-amber-600' : 'text-gray-400')}>
                        {summary.unanswered}
                      </span>
                      <span className="ml-1 text-xs text-gray-500">без ответа</span>
                    </div>
                    {tab === 'review' && summary.avgRating != null && (
                      <div>
                        <span className="text-lg font-semibold text-gray-900">★ {summary.avgRating.toFixed(2)}</span>
                        <span className="ml-2 text-xs text-gray-500">
                          5★: {summary.fiveStars}{summary.lowStars > 0 && <> · ≤2★: <span className="text-red-600 font-medium">{summary.lowStars}</span></>}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Режим + bulk-автоответ */}
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-xs">
                      <span className="text-gray-500">Режим (для новых):</span>
                      <select
                        value={modeValue}
                        onChange={(e) => onChangeMode(e.target.value as 'manual' | 'draft' | 'auto')}
                        className="h-9 rounded-lg border border-gray-300 bg-white px-2 text-sm focus:ring-2 focus:ring-indigo-500"
                        disabled={!settings}
                      >
                        <option value="manual">Ручной</option>
                        <option value="draft">Полуавто (черновики)</option>
                        <option value="auto">⚡ Автомат (без подтверждения)</option>
                      </select>
                    </label>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={onAutoReplyAll}
                      loading={autoReplying}
                      disabled={summary.unanswered === 0 || autoReplying}
                      title={summary.unanswered === 0
                        ? 'Нет неотвеченных'
                        : modeValue === 'auto'
                          ? `AI сразу ответит на ${summary.unanswered}`
                          : `AI создаст черновики на ${summary.unanswered} — просмотришь и подтвердишь`}
                    >
                      <Zap className="h-4 w-4" />
                      {summary.unanswered === 0
                        ? 'Все отвечены'
                        : modeValue === 'auto'
                          ? `Ответить на ${summary.unanswered} сейчас`
                          : `Создать ${summary.unanswered} черновиков`}
                    </Button>
                  </div>
                  <p className="text-[11px] text-gray-500 -mt-1">
                    {modeValue === 'manual' && 'Режим «Ручной» — AI не работает сам, пишешь ответы вручную или жмёшь «Сгенерировать» на карточке.'}
                    {modeValue === 'draft' && 'Режим «Полуавто» — AI каждый час создаёт черновики ответов; ты проверяешь и отправляешь.'}
                    {modeValue === 'auto' && '⚠ Режим «Автомат» — AI отправляет ответы без твоего подтверждения. Перед отправкой автоматически блокируются ответы со ссылками, телефонами, email, промокодами. Негативные отзывы (≤3★) всё равно остаются как черновики.'}
                  </p>
                </div>

                {/* Раскрывающиеся настройки AI */}
                {settings && (
                  <div className="pt-2 border-t border-gray-100">
                    <button
                      type="button"
                      className="text-xs text-indigo-600 hover:underline inline-flex items-center gap-1"
                      onClick={() => setShowAdvancedSettings(!showAdvancedSettings)}
                    >
                      <Settings className="h-3 w-3" />
                      {showAdvancedSettings ? 'Скрыть настройки AI-ответов' : 'Настройки AI-ответов'}
                    </button>

                    {showAdvancedSettings && (
                      <div className="mt-3 space-y-3 text-sm">
                        <label className="flex items-center gap-2 text-gray-700">
                          <input
                            type="checkbox"
                            checked={Boolean(settings.notifyTelegram)}
                            onChange={(e) => setSettings((s) => s ? ({ ...s, notifyTelegram: e.target.checked }) : s)}
                            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                          />
                          Уведомления в Telegram
                        </label>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <div>
                            <label className="text-xs text-gray-500">Уровень похвалы</label>
                            <select
                              className="w-full mt-1 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm"
                              value={settings.praiseLevel ?? 'moderate'}
                              onChange={(e) => setSettings((s) => s ? ({ ...s, praiseLevel: e.target.value as any }) : s)}
                            >
                              <option value="minimal">Минимальный</option>
                              <option value="moderate">Умеренный</option>
                              <option value="enthusiastic">Восторженный</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-xs text-gray-500">Стиль жалоб</label>
                            <select
                              className="w-full mt-1 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm"
                              value={settings.complaintStyle ?? 'balanced'}
                              onChange={(e) => setSettings((s) => s ? ({ ...s, complaintStyle: e.target.value as any }) : s)}
                            >
                              <option value="apologetic">Извиняющийся</option>
                              <option value="balanced">Сбалансированный</option>
                              <option value="solution_focused">Решение проблемы</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-xs text-gray-500">Тон</label>
                            <Input
                              className="mt-1 text-sm"
                              placeholder="дружелюбный"
                              value={settings.tone ?? ''}
                              onChange={(e) => setSettings((s) => s ? ({ ...s, tone: e.target.value }) : s)}
                            />
                          </div>
                          <div>
                            <label className="text-xs text-gray-500">Макс. длина</label>
                            <Input
                              type="number"
                              className="mt-1 text-sm"
                              placeholder="500"
                              value={settings.maxLength ?? ''}
                              onChange={(e) => setSettings((s) => s ? ({ ...s, maxLength: Number(e.target.value) }) : s)}
                            />
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-4">
                          <label className="flex items-center gap-2 text-gray-700">
                            <input
                              type="checkbox"
                              checked={Boolean(settings.photoBonus)}
                              onChange={(e) => setSettings((s) => s ? ({ ...s, photoBonus: e.target.checked }) : s)}
                              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                            />
                            Благодарить за фото
                          </label>
                          <label className="flex items-center gap-2 text-gray-700">
                            <input
                              type="checkbox"
                              checked={Boolean(settings.autoSendPositive)}
                              onChange={(e) => setSettings((s) => s ? ({ ...s, autoSendPositive: e.target.checked }) : s)}
                              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                            />
                            Автоотправка позитивных (от {settings.autoSendMinRating ?? 4}★)
                          </label>
                        </div>

                        <div className="grid md:grid-cols-2 gap-3">
                          <div>
                            <label className="text-xs text-gray-500">Шаблон для 5★</label>
                            <Textarea
                              rows={2}
                              className="mt-1 text-sm"
                              placeholder="Спасибо за отличный отзыв! Мы рады, что..."
                              value={settings.star5Template ?? ''}
                              onChange={(e) => setSettings((s) => s ? ({ ...s, star5Template: e.target.value }) : s)}
                            />
                          </div>
                          <div>
                            <label className="text-xs text-gray-500">Подпись</label>
                            <Input
                              className="mt-1 text-sm"
                              placeholder="С уважением, команда..."
                              value={settings.signature ?? ''}
                              onChange={(e) => setSettings((s) => s ? ({ ...s, signature: e.target.value }) : s)}
                            />
                          </div>
                        </div>

                        <Button variant="neutral" size="sm" onClick={onSaveSettings} loading={settingsSaving}>
                          Сохранить настройки
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </Card>
        )}

        {/* Knowledge Base Full View */}
        {showKnowledgeBase && (
          <Card className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <BookOpen className="h-5 w-5" />
                База знаний
              </div>
              <div className="flex gap-2">
                <Button variant="neutral" size="sm" onClick={onImportKnowledge} loading={knowledgeImporting}>
                  <Sparkles className="h-4 w-4" />
                  Импорт из истории
                </Button>
                <Button variant="neutral" size="sm" onClick={() => loadKnowledge()}>
                  <RefreshCw className="h-4 w-4" />
                  Обновить
                </Button>
              </div>
            </div>

            {/* Stats */}
            {knowledgeStats && (
              <div className="flex flex-wrap gap-2">
                <Badge variant="info">Всего: {knowledgeStats.total}</Badge>
                {knowledgeStats.byType.faq && <Badge variant="neutral">FAQ: {knowledgeStats.byType.faq}</Badge>}
                {knowledgeStats.byType.complaint_solution && <Badge variant="warning">Решения: {knowledgeStats.byType.complaint_solution}</Badge>}
                {knowledgeStats.byType.product_feature && <Badge variant="success">Фичи: {knowledgeStats.byType.product_feature}</Badge>}
              </div>
            )}

            {/* Search */}
            <div className="flex gap-2">
              <Input
                placeholder="Поиск по базе знаний..."
                onKeyDown={(e) => e.key === 'Enter' && loadKnowledge(knowledgeSearch)}
                value={knowledgeSearch}
                onChange={(e) => setKnowledgeSearch(e.target.value)}
                className="flex-1"
              />
              <Button variant="neutral" onClick={() => loadKnowledge(knowledgeSearch)}>
                Найти
              </Button>
            </div>

            {/* Add form */}
            <div className="border rounded-lg p-4 bg-gray-50 space-y-3">
              <div className="text-sm font-medium">Добавить инструкцию для ответов на отзывы и вопросы</div>
              <div className="grid md:grid-cols-2 gap-2">
                <select
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  value={knowledgeForm.entryType}
                  onChange={(e) => setKnowledgeForm((f) => ({ ...f, entryType: e.target.value }))}
                >
                  <option value="instruction">📋 Инструкция</option>
                  <option value="faq">❓ FAQ</option>
                  <option value="complaint_solution">🛠 Решение жалобы</option>
                  <option value="product_feature">✨ Фича товара</option>
                  <option value="brand_voice">🎙 Голос бренда</option>
                  <option value="general">📝 Общее</option>
                </select>
                <ProductSearchInput
                  workspaceId={workspaceId}
                  value={knowledgeForm.scopeKey === 'global' ? '' : knowledgeForm.scopeKey}
                  onChange={(v) => setKnowledgeForm((f) => ({ ...f, scopeKey: v || 'global' }))}
                  single
                  compact
                  placeholder="Привязать к товару (необязательно — иначе для всех)"
                  className="flex-1"
                />
              </div>
              <input
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                placeholder="Заголовок"
                value={knowledgeForm.title}
                onChange={(e) => setKnowledgeForm((f) => ({ ...f, title: e.target.value }))}
              />
              <textarea
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                rows={3}
                placeholder="Контент (как отвечать на типичный вопрос/жалобу, голос бренда, особенности товара...)"
                value={knowledgeForm.content}
                onChange={(e) => setKnowledgeForm((f) => ({ ...f, content: e.target.value }))}
              />
              <div className="flex gap-2 flex-wrap">
                <Button variant="primary" size="sm" onClick={onAddKnowledge}>
                  Добавить запись
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,.txt,.md,.csv,.xlsx"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onUploadKnowledgeFile(f);
                  }}
                />
                <Button
                  variant="neutral"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  loading={uploadingFile}
                  disabled={uploadingFile}
                >
                  📎 Загрузить файл (PDF / DOCX / TXT)
                </Button>
                <span className="text-xs text-gray-500 self-center">
                  Файл превратится в запись и станет доступен AI при ответе на отзыв или вопрос.
                </span>
              </div>
            </div>

            {/* List */}
            <div className="space-y-3">
              <div className="text-sm font-medium">Записи ({knowledgeRows.length})</div>
              {knowledgeRows.map((row) => (
                <div key={row.entryId} className="rounded-lg border border-gray-200 p-3 bg-white group">
                  {editingEntryId === row.entryId ? (
                    <div className="space-y-2">
                      <input
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium"
                        value={editForm.title}
                        onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                        placeholder="Заголовок"
                      />
                      <textarea
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                        rows={4}
                        value={editForm.content}
                        onChange={(e) => setEditForm((f) => ({ ...f, content: e.target.value }))}
                        placeholder="Контент"
                      />
                      <input
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                        value={editForm.tags}
                        onChange={(e) => setEditForm((f) => ({ ...f, tags: e.target.value }))}
                        placeholder="Теги (через запятую)"
                      />
                      <div className="flex gap-2">
                        <Button variant="primary" size="sm" onClick={onSaveKnowledge}>
                          <Save className="h-4 w-4 mr-1" /> Сохранить
                        </Button>
                        <Button variant="neutral" size="sm" onClick={() => setEditingEntryId(null)}>
                          Отмена
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <div className="font-medium text-gray-900">{row.title}</div>
                        <div className="text-xs text-gray-500 mt-0.5">{row.scopeType}:{row.scopeKey}</div>
                        <div className="text-sm text-gray-600 mt-2 whitespace-pre-wrap">{row.content}</div>
                        {row.tags?.length > 0 && (
                          <div className="flex gap-1 mt-2">
                            {row.tags.map((tag: string) => (
                              <Badge key={tag} variant="neutral" size="sm">{tag}</Badge>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="info" size="sm">{row.entryType ?? 'general'}</Badge>
                        <button
                          onClick={() => onEditKnowledge(row)}
                          className="p-1.5 rounded hover:bg-blue-100 text-blue-500 transition-colors"
                          title="Редактировать"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => onDeleteKnowledge(row.entryId)}
                          className="p-1.5 rounded hover:bg-red-100 text-red-500 transition-colors"
                          title="Удалить"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {knowledgeRows.length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  Нет записей в базе знаний
                </div>
              )}
            </div>
          </Card>
        )}

        {/* Items list */}
        {!showKnowledgeBase && <div className="space-y-4">
          {items
            .filter((item) => filterRating === null || item.rating === filterRating)
            .filter((item) => filterHasPhoto === null || (filterHasPhoto ? (item.photosCount ?? 0) > 0 : (item.photosCount ?? 0) === 0))
            .map((item) => (
            <Card key={keyFor(item)} className="p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-gray-900">
                    {item.productTitle || 'Без названия'}{' '}
                    {item.brandName && <span className="text-gray-500">({item.brandName})</span>}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-gray-500 mt-1">
                    <Badge variant={item.itemType === 'review' ? 'info' : 'purple'} size="sm">
                      {item.itemType === 'review' ? 'Отзыв' : 'Вопрос'}
                    </Badge>
                    <Badge variant={item.status === 'sent' ? 'success' : item.status === 'draft' ? 'warning' : 'secondary'} size="sm">
                      {item.status}
                    </Badge>
                    {item.userName && <span>от {item.userName}</span>}
                    {item.createdAt && <span>{new Date(item.createdAt).toLocaleString()}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {/* Media indicators */}
                  {(item.photosCount ?? 0) > 0 && (
                    <div className="flex items-center gap-1 text-blue-500" title="С фото">
                      <Image className="h-4 w-4" />
                      <span className="text-xs">{item.photosCount}</span>
                    </div>
                  )}
                  {item.hasVideo && (
                    <div className="text-purple-500" title="С видео">
                      <Video className="h-4 w-4" />
                    </div>
                  )}
                  {/* Rating */}
                  {item.rating != null && (
                    <div className={cn(
                      'flex items-center gap-1 px-2 py-1 rounded-full',
                      item.rating >= 4 ? 'bg-green-50 text-green-700' :
                      item.rating >= 3 ? 'bg-yellow-50 text-yellow-700' :
                      'bg-red-50 text-red-600'
                    )}>
                      <Star className="h-4 w-4 fill-current" />
                      <span className="text-sm font-medium">{item.rating}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Review text */}
              <div className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 rounded-lg p-3">
                {item.text || 'Без текста'}
                {item.pros && (
                  <div className="mt-2 text-green-700">
                    <ThumbsUp className="h-3 w-3 inline mr-1" />
                    Плюсы: {item.pros}
                  </div>
                )}
                {item.cons && (
                  <div className="mt-1 text-red-700">
                    <AlertTriangle className="h-3 w-3 inline mr-1" />
                    Минусы: {item.cons}
                  </div>
                )}
              </div>

              {/* Official answer */}
              {item.answerText && (
                <div className="text-sm rounded-lg p-3 bg-green-50 border border-green-200">
                  <div className="flex items-center gap-2 text-green-700 font-medium text-xs mb-1">
                    <CheckCircle className="h-3.5 w-3.5" />
                    Официальный ответ
                    {item.answeredAt && <span className="text-green-700 font-normal">· {new Date(item.answeredAt).toLocaleDateString('ru-RU')}</span>}
                  </div>
                  <div className="text-gray-700 whitespace-pre-wrap">{item.answerText}</div>
                </div>
              )}

              {/* Analysis */}
              {item.analysis && (
                <div className={cn('text-xs rounded-lg p-2', getSentimentColor(item.analysis.sentiment))}>
                  <div className="font-medium">
                    Анализ: {item.analysis.sentiment === 'positive' ? '😊 Позитивный' : 
                            item.analysis.sentiment === 'negative' ? '😔 Негативный' : '😐 Нейтральный'}
                  </div>
                  <div className="mt-1">{item.analysis.summary}</div>
                  {item.analysis.issues && item.analysis.issues.length > 0 && (
                    <div className="mt-1 text-red-600">
                      Проблемы: {item.analysis.issues.join(', ')}
                    </div>
                  )}
                </div>
              )}

              {/* Secondary tools — общие для любого состояния */}
              <div className="flex flex-wrap gap-1.5 text-xs">
                <button
                  type="button"
                  onClick={() => onAnalyze(item)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-gray-600 hover:bg-gray-100 transition"
                >
                  <Sparkles className="h-3.5 w-3.5" /> Анализ
                </button>
                {item.itemType === 'question' && !item.answerText && (
                  <button
                    type="button"
                    onClick={() => onRejectQuestion(item)}
                    title="Ответить покупателю без публикации"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-gray-600 hover:bg-gray-100 transition"
                  >
                    🚫 Личный ответ
                  </button>
                )}
              </div>

              {/* Primary action / Draft editor — зависит от состояния */}
              {item.answerText && editingReplyId !== item.itemId ? (
                /* Состояние А: уже отвечен — только одна кнопка «Изменить ответ» */
                item.itemType === 'review' && (
                  <div className="pt-2 border-t border-gray-100">
                    <Button variant="neutral" size="sm" onClick={() => startEditingReply(item)} title="ВБ разрешает 1 правку в течение 60 дней">
                      <Pencil className="h-4 w-4" />
                      Изменить ответ
                    </Button>
                  </div>
                )
              ) : (
                /* Состояние Б: пишем новый ответ или редактируем существующий */
                <div className="space-y-2 pt-2 border-t border-gray-100">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium text-gray-500">
                      {editingReplyId === item.itemId ? 'Изменить ответ' : 'Ответ'}
                    </div>
                    {item.draft?.confidence != null && editingReplyId !== item.itemId && (
                      <div className="text-xs text-gray-400">
                        AI уверен на {item.draft.confidence}%
                      </div>
                    )}
                  </div>
                  <Textarea
                    rows={4}
                    value={draftEdits[keyFor(item)] ?? ''}
                    onChange={(e) =>
                      setDraftEdits((prev) => ({
                        ...prev,
                        [keyFor(item)]: e.target.value,
                      }))
                    }
                    placeholder={editingReplyId === item.itemId ? 'Новый текст ответа' : 'Напишите ответ или нажмите «Сгенерировать»'}
                  />
                  <div className="text-xs text-gray-400">
                    💡 <code className="bg-gray-100 px-1 rounded">[имя]</code> подставит имя покупателя
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {editingReplyId === item.itemId ? (
                      <>
                        <Button variant="success" size="sm" onClick={() => onSaveEditedReply(item)}>
                          <Send className="h-4 w-4" /> Сохранить
                        </Button>
                        <Button variant="neutral" size="sm" onClick={() => cancelEditingReply(item)}>
                          Отмена
                        </Button>
                      </>
                    ) : (
                      <>
                        {!((draftEdits[keyFor(item)] ?? '').trim()) ? (
                          <Button variant="primary" size="sm" onClick={() => onDraft(item)} loading={draftingId === item.itemId} disabled={!!draftingId}>
                            <Zap className="h-4 w-4" />
                            {draftingId === item.itemId ? 'Генерация…' : 'Сгенерировать ответ'}
                          </Button>
                        ) : (
                          <Button variant="success" size="sm" onClick={() => onApprove(item)}>
                            <Send className="h-4 w-4" /> Отправить
                          </Button>
                        )}
                        <Button variant="neutral" size="sm" onClick={() => onReject(item)}>
                          Пропустить
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </Card>
          ))}

          {!loading && items.length === 0 && (
            <Card className="p-6 text-center text-gray-500">
              Пока нет данных. Нажмите «Синхронизировать».
            </Card>
          )}
        </div>}

        {/* AI Analyze Button */}
        <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-30">
          <AiAnalyzeButton
            context={{ page: 'feedback' }}
            prompt="Проанализируй отзывы и вопросы"
          />
        </div>
      </div>
    </AppShell>
  );
}
