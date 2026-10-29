'use client';
import { useWorkspaceStore } from '@/store/workspace';

import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';
import { apiFetch } from '@/lib/api';
import { useShopParam, useActiveShop } from '@/hooks/useShopParam';
import { Badge } from '@/components/ui/Badge';
import { RefreshCw, Sparkles, Wand2 } from 'lucide-react';

interface CardDetail {
  nmId: number;
  vendorCode?: string | null;
  title?: string | null;
  brandName?: string | null;
  subjectName?: string | null;
  description?: string | null;
  characteristics?: any[];
  photoUrls?: string[];
}

export default function SeoPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId) ?? 0;
  const shopParam = useShopParam();
  const { shopId } = useActiveShop();
  const [nmIds, setNmIds] = useState('');
  const [card, setCard] = useState<CardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queries, setQueries] = useState('');
  const [note, setNote] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [jobs, setJobs] = useState<any[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [cardLoading, setCardLoading] = useState(false);

  // AI SEO Generator state
  const [aiTone, setAiTone] = useState<'informative' | 'marketing' | 'premium'>('marketing');
  const [aiKeywords, setAiKeywords] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiTitle, setAiTitle] = useState('');
  const [aiDescription, setAiDescription] = useState('');
  const [aiKeywordsUsed, setAiKeywordsUsed] = useState<string[]>([]);

  const nmId = nmIds.split(',').map((s) => Number(s.trim())).find((n) => Number.isFinite(n) && n > 0);

  const queryIdeas = useMemo(() => {
    if (!card) return [] as string[];
    return [card.title, card.subjectName, card.brandName].filter(Boolean) as string[];
  }, [card]);

  async function loadCard() {
    if (!nmId) return;
    setCardLoading(true);
    setError(null);
    try {
      const data = await apiFetch(`/cards/${workspaceId}/${nmId}`);
      setCard(data.card);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setCardLoading(false);
    }
  }

  useEffect(() => {
    setCard(null);
    setTitle('');
    setDescription('');
    setJobs([]);
    if (nmId) {
      loadCard();
      loadJobs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nmId]);

  async function loadJobs() {
    if (!nmId) return;
    setJobsLoading(true);
    try {
      const res = await apiFetch(`/creative/seo/${workspaceId}/jobs?nmId=${nmId}${shopParam}`);
      setJobs(res.rows || []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setJobsLoading(false);
    }
  }

  async function runAiSeo() {
    if (!nmId) return;
    setAiLoading(true);
    try {
      const keywords = aiKeywords.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      const res = await apiFetch('/seo/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nmId, tone: aiTone, keywords: keywords.length ? keywords : undefined }),
      });
      setAiTitle(res.title || '');
      setAiDescription(res.description || '');
      setAiKeywordsUsed(res.keywordsUsed || []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setAiLoading(false);
    }
  }

  async function runSeo() {
    if (!nmId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/creative/seo/${workspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nmId, queries, note: note.trim() || undefined, ...(shopId ? { shopId } : {}) }),
      });
      setTitle(res.title || '');
      setDescription(res.description || '');
      await loadJobs();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="Контент · SEO">
      <div className="p-6 space-y-6">
        {error && <div className="text-sm text-red-600">{error}</div>}

        <div className="grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-6">
          {/* Left: input */}
          <div className="space-y-6">
            <Card>
              <div className="p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-[var(--content-text)]">Ваш товар</div>
                  <div className="text-xs text-[var(--content-muted)]">01</div>
                </div>

                <ProductSearchInput workspaceId={workspaceId} value={nmIds} onChange={setNmIds} />

                {nmId && (
                  <div className="flex items-center gap-2">
                    <Button variant="neutral" size="sm" onClick={loadCard} loading={cardLoading}>
                      <RefreshCw className={cardLoading ? 'mr-2 h-4 w-4 animate-spin' : 'mr-2 h-4 w-4'} />
                      Обновить карточку
                    </Button>
                  </div>
                )}

                {card && (
                  <div className="space-y-3">
                    <div className="text-xs text-[var(--content-muted)]">
                      {card.vendorCode ? `${card.vendorCode}` : ''} {card.title ? `· ${card.title}` : ''}
                    </div>
                    {card.photoUrls?.length ? (
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                        {card.photoUrls.slice(0, 4).map((url) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={url} src={url} alt="" className="h-16 w-full rounded-md border border-[var(--card-border)] object-cover" />
                        ))}
                      </div>
                    ) : null}
                    <div>
                      <div className="text-[11px] text-[var(--content-muted)]">Категория</div>
                      <Input value={card.subjectName || ''} readOnly />
                    </div>
                  </div>
                )}
              </div>
            </Card>

            <Card>
              <div className="p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-[var(--content-text)]">Настройте SEO</div>
                  <div className="text-xs text-[var(--content-muted)]">02</div>
                </div>

                <div>
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium text-[var(--content-muted)]">Поисковые запросы</div>
                    <Button variant="ghost" size="sm" onClick={() => setQueries(queryIdeas.join('\n'))}>
                      <Sparkles className="mr-1 h-3 w-3" />AI идеи
                    </Button>
                  </div>
                  <textarea
                    className="mt-2 w-full min-h-[120px] rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-xs text-[var(--content-text)]"
                    placeholder="Каждая строка — запрос. Можно добавить вес через ; или | (например: ‘чехол айфон;1200’)"
                    value={queries}
                    onChange={(e) => setQueries(e.target.value)}
                  />
                </div>

                <div>
                  <div className="text-xs font-medium text-[var(--content-muted)]">Доп. заметки</div>
                  <Input placeholder="Стиль, фокус, ограничения" value={note} onChange={(e) => setNote(e.target.value)} />
                </div>

                <Button onClick={runSeo} loading={loading} disabled={!nmId}>
                  Сгенерировать SEO
                </Button>
              </div>
            </Card>

            <Card>
              <div className="p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Wand2 className="h-4 w-4 text-violet-500" />
                    <div className="text-sm font-semibold text-[var(--content-text)]">AI SEO (Claude)</div>
                  </div>
                  <div className="text-xs text-[var(--content-muted)]">03</div>
                </div>

                <div>
                  <div className="text-xs font-medium text-[var(--content-muted)] mb-2">Тон текста</div>
                  <div className="flex gap-2">
                    {([
                      { value: 'informative' as const, label: 'Инфо' },
                      { value: 'marketing' as const, label: 'Маркетинг' },
                      { value: 'premium' as const, label: 'Премиум' },
                    ]).map(({ value, label }) => (
                      <button
                        key={value}
                        onClick={() => setAiTone(value)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                          aiTone === value
                            ? 'bg-violet-100 text-violet-700 border border-violet-200'
                            : 'bg-gray-50 text-gray-500 border border-gray-200 hover:bg-gray-100'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-xs font-medium text-[var(--content-muted)]">Ключевые слова (через запятую)</div>
                  <Input
                    placeholder="чехол, айфон, защитный"
                    value={aiKeywords}
                    onChange={(e) => setAiKeywords(e.target.value)}
                  />
                </div>

                <Button onClick={runAiSeo} loading={aiLoading} disabled={!nmId} variant="primary">
                  <Wand2 className="h-4 w-4" />
                  AI Генерация
                </Button>
              </div>
            </Card>
          </div>

          {/* Right: results */}
          <div className="space-y-6">
            <Card>
              <div className="p-5 space-y-2">
                <div className="text-sm font-semibold text-[var(--content-text)]">Результаты</div>
                <div className="text-xs text-[var(--content-muted)]">
                  {title || description ? 'Готово · можно копировать' : 'Пока нет данных — запустите генерацию'}
                </div>
              </div>
            </Card>

            <Card>
              <div className="p-5 space-y-3">
                <div className="text-sm font-semibold text-[var(--content-text)]">Название</div>
                {title ? (
                  <div className="text-sm font-medium text-[var(--content-text)]">{title}</div>
                ) : (
                  <div className="text-xs text-[var(--content-muted)]">Название появится после генерации.</div>
                )}
              </div>
            </Card>

            <Card>
              <div className="p-5 space-y-3">
                <div className="text-sm font-semibold text-[var(--content-text)]">Описание</div>
                {description ? (
                  <div className="text-xs text-[var(--content-muted)] whitespace-pre-wrap">{description}</div>
                ) : (
                  <div className="text-xs text-[var(--content-muted)]">Описание появится после генерации.</div>
                )}
              </div>
            </Card>

            {/* AI SEO Results */}
            {(aiTitle || aiDescription) && (
              <Card>
                <div className="p-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <Wand2 className="h-4 w-4 text-violet-500" />
                    <div className="text-sm font-semibold text-[var(--content-text)]">AI SEO результат</div>
                    <Badge variant="purple" size="sm">{aiTone}</Badge>
                  </div>
                  {aiTitle && (
                    <div>
                      <div className="text-xs text-[var(--content-muted)] mb-1">Название</div>
                      <div className="text-sm font-medium text-[var(--content-text)]">{aiTitle}</div>
                    </div>
                  )}
                  {aiDescription && (
                    <div>
                      <div className="text-xs text-[var(--content-muted)] mb-1">Описание</div>
                      <div className="text-xs text-[var(--content-text)] whitespace-pre-wrap">{aiDescription}</div>
                    </div>
                  )}
                  {aiKeywordsUsed.length > 0 && (
                    <div>
                      <div className="text-xs text-[var(--content-muted)] mb-1">Использованные ключевые слова</div>
                      <div className="flex flex-wrap gap-1">
                        {aiKeywordsUsed.map((kw, i) => (
                          <Badge key={i} variant="neutral" size="sm">{kw}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            )}

            <Card>
              <div className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-[var(--content-text)]">История генераций</div>
                  <button className="text-xs text-indigo-600" onClick={loadJobs} disabled={jobsLoading}>
                    {jobsLoading ? 'Обновление…' : 'Обновить'}
                  </button>
                </div>
                {jobs.length === 0 ? (
                  <div className="text-xs text-[var(--content-muted)]">Пока нет генераций.</div>
                ) : (
                  <div className="space-y-2">
                    {jobs.map((j) => (
                      <div key={j.jobId} className="rounded-[var(--radius-md)] border border-[var(--card-border)] p-2">
                        <div className="text-xs text-[var(--content-muted)]">
                          {new Date(j.createdAt).toLocaleString('ru-RU')}
                        </div>
                        {j.outputTitle && <div className="text-sm font-medium text-[var(--content-text)]">{j.outputTitle}</div>}
                        {j.outputDescription && (
                          <div className="text-xs text-[var(--content-muted)] line-clamp-2">{j.outputDescription}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
