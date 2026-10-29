'use client';
import { useWorkspaceStore } from '@/store/workspace';

import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/ToggleGroup';
import { Switch } from '@/components/ui/Switch';
import { apiFetch } from '@/lib/api';
import { useShopParam, useActiveShop } from '@/hooks/useShopParam';
import { cn } from '@/lib/cn';
import { RefreshCw, Sparkles } from 'lucide-react';

interface CardDetail {
  nmId: number;
  vendorCode?: string | null;
  title?: string | null;
  brandName?: string | null;
  subjectName?: string | null;
  photoUrls: string[];
  description?: string | null;
  characteristics?: any[];
}

interface SlideRow {
  slideId: number;
  sortOrder: number;
  title?: string | null;
  goal?: string | null;
  utp?: string | null;
  copy?: string | null;
  layoutHint?: string | null;
}

export default function VisualAuditPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId) ?? 0;
  const shopParam = useShopParam();
  const { shopId } = useActiveShop();

  const [nmIds, setNmIds] = useState('');
  const [card, setCard] = useState<CardDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [analysis, setAnalysis] = useState<string>('');
  const [structured, setStructured] = useState<any>(null);
  const [slides, setSlides] = useState<SlideRow[]>([]);
  const [running, setRunning] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [generated, setGenerated] = useState<Record<number, string>>({});
  const [genLoading, setGenLoading] = useState<Record<number, boolean>>({});
  const [promptBySlide, setPromptBySlide] = useState<Record<number, string>>({});
  const [providerBySlide, setProviderBySlide] = useState<Record<number, string>>({});

  const [contentType, setContentType] = useState<'photo' | 'card' | 'video'>('card');
  const [storyText, setStoryText] = useState('');
  const [videoDesc, setVideoDesc] = useState('');
  const [basePhoto, setBasePhoto] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [videoDuration, setVideoDuration] = useState<'5' | '10'>('5');
  const [photoScene, setPhotoScene] = useState<'interior' | 'person' | 'close' | 'studio'>('interior');
  const [photoNotes, setPhotoNotes] = useState('');

  const nmId = nmIds.split(',').map((s) => Number(s.trim())).find((n) => Number.isFinite(n) && n > 0);

  const ideas = useMemo(() => {
    if (!card) return [] as string[];
    return [
      `Почему ${card.title || 'товар'} удобен каждый день`,
      'Экономия пространства и порядок',
      'Стильный дизайн и прочные материалы',
      'Лёгкий доступ и продуманная эргономика',
    ];
  }, [card]);

  const photoScenes: Array<{ id: 'interior' | 'person' | 'close' | 'studio'; title: string; desc: string }> = [
    { id: 'interior', title: 'В интерьере', desc: 'в реальной обстановке' },
    { id: 'person', title: 'С человеком', desc: 'человек рядом' },
    { id: 'close', title: 'Крупный план', desc: 'текстура, материал' },
    { id: 'studio', title: 'Каталог (студийно)', desc: 'нейтральный фон' },
  ];

  const storyPlaceholder = contentType === 'card'
    ? 'Опишите преимущества и ключевые идеи для карточки'
    : 'Опишите преимущества и ключевые идеи для слайда/фото';

  async function loadCard() {
    if (!nmId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch(`/cards/${workspaceId}/${nmId}`);
      setCard(data.card);
      const first = data.card?.photoUrls?.[0] || null;
      setBasePhoto(first);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setAnalysis('');
    setStructured(null);
    setSlides([]);
    setJobId(null);
    setGenerated({});
    setPromptBySlide({});
    setProviderBySlide({});
    setCard(null);
    setStoryText('');
    setVideoDesc('');
    setBasePhoto(null);
    setPhotoNotes('');
    setPhotoScene('interior');
    if (nmId) loadCard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nmId]);

  async function loadJobDetails(id: string) {
    try {
      const shopQs = shopParam ? `?${shopParam.slice(1)}` : '';
      const res = await apiFetch(`/creative/visual-audit/${workspaceId}/jobs/${id}${shopQs}`);
      setSlides(res.slides ?? []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  async function runAudit() {
    if (!nmId) return;
    setRunning(true);
    setError(null);
    try {
      const sceneLabel = {
        interior: 'В интерьере',
        person: 'С человеком',
        close: 'Крупный план',
        studio: 'Каталог (студийно)',
      }[photoScene];
      const noteParts = [
        `Тип контента: ${contentType}`,
        storyText.trim() ? `О чём рассказать:\n${storyText.trim()}` : null,
        contentType === 'photo' ? `Сценарий фото: ${sceneLabel}` : null,
        contentType === 'photo' && photoNotes.trim() ? `Пожелания:\n${photoNotes.trim()}` : null,
        contentType === 'video' && videoDesc.trim() ? `Описание видео:\n${videoDesc.trim()}` : null,
        contentType === 'video' ? `Длительность: ${videoDuration} сек` : null,
        note.trim() ? `Стиль/тон:\n${note.trim()}` : null,
      ].filter(Boolean) as string[];
      const fullNote = noteParts.join('\n\n');

      const res = await apiFetch(`/creative/visual-audit/${workspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nmId, note: fullNote || undefined, ...(shopId ? { shopId } : {}) }),
      });
      setAnalysis(res.analysis || '');
      setStructured(res.structured || null);
      setJobId(res.jobId || null);
      setGenerated({});
      if (res.jobId) await loadJobDetails(res.jobId);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setRunning(false);
    }
  }

  async function generateSlide(slideId: number) {
    if (!jobId) return;
    setGenLoading((prev) => ({ ...prev, [slideId]: true }));
    try {
      const promptOverride = (promptBySlide[slideId] || '').trim();
      const provider = providerBySlide[slideId] || 'openai';
      const payload: Record<string, unknown> = promptOverride ? { promptOverride, provider } : { provider };
      if (shopId) payload.shopId = shopId;
      const res = await apiFetch(`/creative/visual-audit/${workspaceId}/jobs/${jobId}/slides/${slideId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res?.asset?.downloadUrl) {
        setGenerated((prev) => ({ ...prev, [slideId]: res.asset.downloadUrl }));
      }
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setGenLoading((prev) => ({ ...prev, [slideId]: false }));
    }
  }

  return (
    <AppShell title="Контент · Визуальный аудит">
      <div className="p-6 space-y-6">
        {error && <div className="text-sm text-red-600">{error}</div>}

        <div className="grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-6">
          {/* Left: steps */}
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
                    <Button variant="neutral" size="sm" onClick={loadCard} loading={loading}>
                      <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
                      Обновить карточку
                    </Button>
                  </div>
                )}

                {card && (
                  <div className="space-y-3">
                    <div className="text-xs text-[var(--content-muted)]">
                      {card.vendorCode ? `${card.vendorCode}` : ''} {card.title ? `· ${card.title}` : ''}
                    </div>
                    {card.photoUrls?.length > 0 && (
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                        {card.photoUrls.slice(0, 4).map((url) => {
                          const active = basePhoto === url;
                          return (
                            <button
                              type="button"
                              key={url}
                              className={cn(
                                'relative rounded-lg border overflow-hidden',
                                active ? 'border-indigo-500 ring-2 ring-indigo-200' : 'border-[var(--card-border)]'
                              )}
                              onClick={() => setBasePhoto(url)}
                              title="Сделать базовым"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={url} alt="" className="h-16 w-full object-cover" />
                            </button>
                          );
                        })}
                        {card.photoUrls.length > 4 && (
                          <div className="rounded-lg border border-dashed border-[var(--card-border)] flex items-center justify-center text-[10px] text-[var(--content-muted)]">
                            +{card.photoUrls.length - 4}
                          </div>
                        )}
                      </div>
                    )}

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
                  <div className="text-sm font-semibold text-[var(--content-text)]">Настройте генерацию</div>
                  <div className="text-xs text-[var(--content-muted)]">02</div>
                </div>

                <div>
                  <div className="text-xs font-medium text-[var(--content-muted)] mb-1.5">Тип контента</div>
                  <ToggleGroup type="single" value={contentType} onValueChange={(v) => v && setContentType(v as any)}>
                    <ToggleGroupItem value="photo">Фото</ToggleGroupItem>
                    <ToggleGroupItem value="card">Карточка</ToggleGroupItem>
                    <ToggleGroupItem value="video">Видео</ToggleGroupItem>
                  </ToggleGroup>
                </div>

                {contentType !== 'video' ? (
                  <div className="space-y-4">
                    <div>
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-medium text-[var(--content-muted)]">О чём рассказать</div>
                        <Button variant="ghost" size="sm" onClick={() => setStoryText(ideas.join('\n'))}>
                          <Sparkles className="mr-1 h-3 w-3" />AI идеи
                        </Button>
                      </div>
                      <textarea
                        className="mt-2 w-full rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-xs text-[var(--content-text)]"
                        rows={5}
                        placeholder={storyPlaceholder}
                        value={storyText}
                        onChange={(e) => setStoryText(e.target.value)}
                      />
                    </div>

                    {contentType === 'photo' && (
                      <div className="space-y-3">
                        <div className="text-xs font-medium text-[var(--content-muted)]">Как показать товар?</div>
                        <div className="grid gap-2">
                          {photoScenes.map((scene) => {
                            const active = scene.id === photoScene;
                            return (
                              <button
                                key={scene.id}
                                type="button"
                                onClick={() => setPhotoScene(scene.id)}
                                className={cn(
                                  'flex items-center gap-3 rounded-lg border px-3 py-2 text-left',
                                  active
                                    ? 'border-indigo-500 bg-indigo-50/60'
                                    : 'border-[var(--card-border)] bg-[var(--card-bg)]'
                                )}
                              >
                                <div
                                  className={cn(
                                    'h-10 w-10 rounded-md border',
                                    active ? 'border-indigo-300 bg-white' : 'border-[var(--card-border)]'
                                  )}
                                />
                                <div>
                                  <div className="text-xs font-semibold text-[var(--content-text)]">{scene.title}</div>
                                  <div className="text-[11px] text-[var(--content-muted)]">{scene.desc}</div>
                                </div>
                              </button>
                            );
                          })}
                        </div>

                        <div>
                          <div className="flex items-center justify-between">
                            <div className="text-xs font-medium text-[var(--content-muted)]">Пожелания</div>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setPhotoNotes('Мягкий свет, минимализм, нейтральный фон')}
                            >
                              <Sparkles className="mr-1 h-3 w-3" />AI идеи
                            </Button>
                          </div>
                          <textarea
                            className="mt-2 w-full rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-xs text-[var(--content-text)]"
                            rows={4}
                            maxLength={2000}
                            placeholder="Например: мягкий свет, минимализм, нейтральный фон"
                            value={photoNotes}
                            onChange={(e) => setPhotoNotes(e.target.value)}
                          />
                          <div className="text-[10px] text-[var(--content-muted)] text-right">{photoNotes.length}/2000</div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="text-xs font-medium text-[var(--content-muted)]">Фото‑основа для видео</div>
                    {basePhoto ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={basePhoto} alt="" className="h-28 w-28 rounded-md border border-[var(--card-border)] object-cover" />
                    ) : (
                      <div className="text-xs text-[var(--content-muted)]">Выберите фото выше</div>
                    )}
                    <div>
                      <div className="text-xs font-medium text-[var(--content-muted)]">Описание видео</div>
                      <textarea
                        className="mt-2 w-full rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-xs text-[var(--content-text)]"
                        rows={4}
                        placeholder="Опишите движение камеры, смену ракурсов, настроение"
                        value={videoDesc}
                        onChange={(e) => setVideoDesc(e.target.value)}
                      />
                    </div>
                    <div>
                      <div className="text-xs font-medium text-[var(--content-muted)]">Длительность</div>
                      <ToggleGroup type="single" value={videoDuration} onValueChange={(v) => v && setVideoDuration(v as any)}>
                        <ToggleGroupItem value="5">5 сек</ToggleGroupItem>
                        <ToggleGroupItem value="10">10 сек</ToggleGroupItem>
                      </ToggleGroup>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div className="text-xs text-[var(--content-muted)]">Расширенные настройки</div>
                  <Switch checked={advancedOpen} onCheckedChange={setAdvancedOpen} />
                </div>

                {advancedOpen && (
                  <div className="grid grid-cols-1 gap-2">
                    <Input placeholder="Стиль / тон / настроение" value={note} onChange={(e) => setNote(e.target.value)} />
                  </div>
                )}

                <Button onClick={runAudit} loading={running} disabled={!nmId}>
                  Запустить анализ
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
                  {analysis ? 'Анализ готов · ТЗ формируется' : 'Пока нет данных — запустите анализ'}
                </div>
              </div>
            </Card>

            <Card>
              <div className="p-5 space-y-3">
                <div className="text-sm font-semibold text-[var(--content-text)]">01 · Анализ карточки</div>
                {analysis ? (
                  <div className="text-xs whitespace-pre-wrap text-[var(--content-muted)]">{analysis}</div>
                ) : (
                  <div className="text-xs text-[var(--content-muted)]">Запустите анализ, чтобы увидеть сильные/слабые стороны карточки.</div>
                )}
              </div>
            </Card>

            <Card>
              <div className="p-5 space-y-3">
                <div className="text-sm font-semibold text-[var(--content-text)]">02 · Техническое задание</div>
                {structured ? (
                  <pre className="text-xs whitespace-pre-wrap text-[var(--content-muted)]">{JSON.stringify(structured, null, 2)}</pre>
                ) : (
                  <div className="text-xs text-[var(--content-muted)]">После анализа мы сформируем ТЗ по слайдам.</div>
                )}
              </div>
            </Card>

            <Card>
              <div className="p-5 space-y-4">
                <div className="text-sm font-semibold text-[var(--content-text)]">03 · Работа по ТЗ</div>
                {slides.length === 0 ? (
                  <div className="text-xs text-[var(--content-muted)]">Слайды появятся после формирования ТЗ.</div>
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {slides.map((s) => (
                      <div key={s.slideId} className="rounded-md border border-[var(--card-border)] p-4 space-y-2">
                        <div className="text-xs text-[var(--content-muted)]">Слайд {s.sortOrder}</div>
                        <div className="text-sm font-medium text-[var(--content-text)]">{s.title}</div>
                        <div className="text-xs text-[var(--content-muted)]">{s.goal}</div>
                        {s.utp && <div className="text-xs text-[var(--content-muted)]">УТП: {s.utp}</div>}
                        {s.copy && <div className="text-xs text-[var(--content-muted)]">Текст: {s.copy}</div>}
                        {s.layoutHint && <div className="text-xs text-[var(--content-muted)]">Верстка: {s.layoutHint}</div>}

                        <div className="flex items-center gap-2">
                          <Input
                            placeholder="Промпт (опционально)"
                            value={promptBySlide[s.slideId] || ''}
                            onChange={(e) => setPromptBySlide((prev) => ({ ...prev, [s.slideId]: e.target.value }))}
                          />
                          <select
                            className="rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-2 py-1 text-xs"
                            value={providerBySlide[s.slideId] || 'openai'}
                            onChange={(e) => setProviderBySlide((prev) => ({ ...prev, [s.slideId]: e.target.value }))}
                          >
                            <option value="openai">OpenAI</option>
                            <option value="ideogram">Ideogram</option>
                          </select>
                        </div>
                        <Button size="sm" onClick={() => generateSlide(s.slideId)} loading={genLoading[s.slideId]}>Сгенерировать</Button>
                        {generated[s.slideId] && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={generated[s.slideId]} alt="" className="w-full rounded-md border border-[var(--card-border)]" />
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
