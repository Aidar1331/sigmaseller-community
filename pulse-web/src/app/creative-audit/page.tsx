'use client';

import { useEffect, useState, useCallback } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { Button } from '@/components/ui/Button';
import { ProductSearchInput } from '@/components/ui/ProductSearchInput';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import { useCreativeAuditStore } from '@/store/creativeAudit';
import { useAuditTaskStore } from '@/store/auditTask';
import { PromptSuggestionsPanel } from '@/components/studio/PromptSuggestionsPanel';
import { useShopChange } from '@/hooks/useShopChange';
import { useShopParam, useActiveShop } from '@/hooks/useShopParam';
import { Paywall } from '@/components/Paywall';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Eye, Download, X, Loader2, Bot, ChevronDown, ChevronRight, Copy, Check, AlertTriangle, Trash2, ExternalLink } from 'lucide-react';
import jsPDF from 'jspdf';

/* ─── Types ─── */

type AuditSummary = {
  auditId: number;
  nmId: number;
  score: number | null;
  summary: string | null;
  isFree: boolean;
  createdAt: string;
};

type AuditDetail = {
  auditId: number;
  nmId: number;
  score: number | null;
  summary: string | null;
  strengths: string[];
  issues: string[];
  quickFixes: string[];
  contentSuggestions: string[];
  photoSuggestions: string[];
  seoSuggestions: string[];
  checklist: string[];
  createdAt: string;
  // v3 fields
  verdict?: any;
  scores?: any;
  perspectives?: any;
  photos?: any;
  seo?: any;
  contentRewrites?: any;
  topStrengths?: any[];
  topIssues?: any[];
  rootCauses?: any[];
  checklistV3?: any;
  roleTasks?: any;
  [key: string]: any;
};

type Limits = {
  freeTotal: number;
  freeUsed: boolean;
  freeLeft: number;
  totalRuns: number;
};

type FixType = 'title' | 'description' | 'remove_irrelevant_chars' | 'seo_keywords' | 'fix_quotes';

type QuickAuditResult = {
  nmId: number;
  score: number;
  estimatedImprovementPotential: 'high' | 'medium' | 'low';
  confidence: number;
  summary: string;
  topIssue: string | null;
  topStrength: string | null;
  scores: {
    titleQuality: number;
    descriptionQuality: number;
    characteristicsCompleteness: number;
    offerClarity: number;
    seoOptimization: number;
    conversionReadiness: number;
  };
  tokenUsage: number;
  costUsd: string;
};

type BulkAuditResult = {
  results: QuickAuditResult[];
  totalTokens: number;
  totalCostUsd: string;
  processedCount: number;
  failedCount: number;
  failedNmIds: number[];
};

/* ─── Helpers ─── */

function detectFixType(text: string): FixType | null {
  const lower = text.toLowerCase();
  if (/название|title/.test(lower)) return 'title';
  if (/описание|description/.test(lower)) return 'description';
  if (/нерелевантн|удалить характеристик/.test(lower)) return 'remove_irrelevant_chars';
  if (/ключев|keyword|seo/.test(lower)) return 'seo_keywords';
  if (/кавычк|quote/.test(lower)) return 'fix_quotes';
  return null;
}

function v3(audit: any, field: string, fallback: any = null) {
  if (!audit) return fallback;
  const parts = field.split('.');
  let val: any = audit;
  for (const p of parts) {
    val = val?.[p];
    if (val === undefined) return fallback;
  }
  return val;
}

function isV3Audit(audit: any): boolean {
  return audit && ('verdict' in audit || 'finalVerdict' in audit || 'overallScore' in audit);
}

function scoreColor(score: number): string {
  if (score >= 70) return 'bg-green-500';
  if (score >= 40) return 'bg-amber-500';
  return 'bg-red-500';
}

function scoreTextColor(score: number): string {
  if (score >= 70) return 'text-green-700';
  if (score >= 40) return 'text-amber-700';
  return 'text-red-600';
}

/* ─── Translation Dictionaries ─── */

const SCORE_LABELS: Record<string, string> = {
  offerClarity: 'Ясность оффера',
  titleSeo: 'SEO заголовка',
  descriptionPersuasion: 'Убедительность описания',
  trustSignals: 'Сигналы доверия',
  benefitCommunication: 'Донесение выгод',
  conversionReadiness: 'Готовность к покупке',
  firstImageEffectiveness: 'Эффективность главного фото',
  galleryLogic: 'Логика галереи',
  infographicQuality: 'Качество инфографики',
  mobileReadability: 'Мобильная читаемость',
  overallVisualQuality: 'Общее качество визуала',
};

const ROLE_LABELS: Record<string, string> = {
  designer: 'Дизайнер',
  contentManager: 'Контент-менеджер',
  seoSpecialist: 'SEO-специалист',
  photographer: 'Фотограф',
  marketer: 'Маркетолог',
};

const PHOTO_TYPE_LABELS: Record<string, string> = {
  main: 'Главное фото',
  infographic: 'Инфографика',
  lifestyle: 'Образ жизни',
  detail: 'Детали',
  size: 'Размеры',
  usage: 'Использование',
  packaging: 'Упаковка',
  comparison: 'Сравнение',
  other: 'Другое',
};

const PRIORITY_LABELS: Record<string, string> = {
  critical: 'Критично',
  high: 'Высокий',
  medium: 'Средний',
  low: 'Низкий',
};

function barColor(score: number): string {
  if (score >= 70) return 'bg-green-500';
  if (score >= 40) return 'bg-amber-500';
  return 'bg-red-500';
}

function priorityBadge(priority: string) {
  const colors: Record<string, string> = {
    high: 'bg-red-100 text-red-700',
    medium: 'bg-amber-100 text-amber-700',
    low: 'bg-green-100 text-green-700',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[priority] ?? 'bg-gray-100 text-gray-600'}`}>
      {PRIORITY_LABELS[priority] ?? priority}
    </span>
  );
}

const impactLabels: Record<string, string> = { critical: 'Критично', high: 'Важно', medium: 'Средне', low: 'Незначительно' };
const assigneeLabelsGlobal: Record<string, string> = {
  designer: 'Дизайнер', photographer: 'Фотограф', marketer: 'Маркетолог',
  contentManager: 'Контент-менеджер', seoSpecialist: 'SEO-специалист',
};

function formatAuditItem(item: unknown): string {
  if (typeof item === 'string') return item;
  if (typeof item !== 'object' || !item) return String(item);
  const obj = item as Record<string, unknown>;
  const text = obj.action ?? obj.task ?? obj.issue ?? obj.text ?? obj.label ?? obj.description ?? obj.fix ?? obj.hypothesis;
  if (typeof text === 'string') {
    const extra: string[] = [];
    if (obj.impact) extra.push(`[${impactLabels[String(obj.impact)] ?? obj.impact}]`);
    if (obj.priority) extra.push(`${obj.priority}`);
    if (obj.assignee) extra.push(`→ ${assigneeLabelsGlobal[String(obj.assignee)] ?? obj.assignee}`);
    if (obj.rootCause) extra.push(`Причина: ${obj.rootCause}`);
    if (obj.fix && obj.fix !== text) extra.push(`Решение: ${obj.fix}`);
    return `${text}${extra.length ? ' — ' + extra.join(', ') : ''}`;
  }
  return JSON.stringify(item);
}

/* ─── V1 Section component ─── */

function Section({ title, items }: { title: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <Card className="p-4">
      <div className="text-sm font-semibold text-[var(--content-text)]">{title}</div>
      <ul className="mt-2 list-disc pl-5 text-sm text-[var(--content-muted)]">
        {items.map((x, i) => (
          <li key={`${title}-${i}`}>{x}</li>
        ))}
      </ul>
    </Card>
  );
}

/* ─── Copy button ─── */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20 transition-colors"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Скопировано' : 'Скопировать'}
    </button>
  );
}

/* ─── Accordion ─── */

function Accordion({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-[var(--card-border)] rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-[var(--content-text)] hover:bg-[var(--card-border)]/30 transition-colors"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        {title}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

/* ─── V3 Tab Definitions ─── */

const V3_TABS = [
  { key: 'overview', label: 'Обзор' },
  { key: 'checklist', label: 'Чек-лист' },
  { key: 'photos', label: 'Фото' },
  { key: 'seo', label: 'SEO' },
];

/* ─── V3 Sub-score bar ─── */

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-36 text-xs text-[var(--content-muted)] truncate">{label}</div>
      <div className="flex-1 h-3 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor(value)} transition-all`} style={{ width: `${value}%` }} />
      </div>
      <div className={`w-8 text-xs font-bold text-right ${scoreTextColor(value)}`}>{value}</div>
    </div>
  );
}

/* ─── V3 Tab Content Components ─── */

function OverviewTab({
  audit,
  onApplyClick,
  editTitle,
  editDescription,
  onEditTitle,
  onEditDescription,
}: {
  audit: any;
  onApplyClick: () => void;
  editTitle: string;
  editDescription: string;
  onEditTitle: (v: string) => void;
  onEditDescription: (v: string) => void;
}) {
  const scores = v3(audit, 'scores', {});
  const scoreEntries = Object.entries(scores).filter(([, v]) => typeof v === 'number') as [string, number][];
  const topStrengths = v3(audit, 'topStrengths', []);
  const topIssues = v3(audit, 'topIssues', []);
  const rootCauses = v3(audit, 'rootCauses', []);
  const rewrites = v3(audit, 'contentRewrites', {});
  const tokenUsage = v3(audit, 'tokenUsage', null);

  const scoreLabels: Record<string, string> = {
    overall: 'Общая оценка',
    title: 'Заголовок',
    description: 'Описание',
    photos: 'Фотографии',
    mainPhoto: 'Главное фото',
    seo: 'SEO',
    pricing: 'Ценообразование',
    emotional: 'Эмоциональность',
    trust: 'Доверие',
    conversion: 'Конверсионность',
    competitiveness: 'Конкурентность',
    cardScore: 'Карточка',
    photoScore: 'Фото',
    titleSeo: 'Заголовок и SEO',
    galleryLogic: 'Логика галереи',
    offerClarity: 'Ясность предложения',
    trustSignals: 'Сигналы доверия',
    mobileReadability: 'Читаемость на мобильном',
    infographicQuality: 'Качество инфографики',
    conversionReadiness: 'Готовность к конверсии',
    benefitCommunication: 'Донесение выгод',
    overallVisualQuality: 'Визуальное качество',
    descriptionPersuasion: 'Убедительность описания',
    firstImageEffectiveness: 'Эффективность главного фото',
  };

  return (
    <div className="space-y-5">
      {/* Token usage panel удалён — финансовая информация показывается только в разделе «Баланс». */}

      {/* Sub-scores */}
      {scoreEntries.length > 0 && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Оценки по категориям</div>
          <div className="space-y-2">
            {scoreEntries.map(([key, val]) => (
              <ScoreBar key={key} label={scoreLabels[key] ?? key} value={val} />
            ))}
          </div>
        </Card>
      )}

      {/* Top Strengths */}
      {topStrengths.length > 0 && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Сильные стороны</div>
          <div className="grid gap-2">
            {topStrengths.map((s: any, i: number) => (
              <div key={i} className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                {formatAuditItem(s)}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Top Issues */}
      {topIssues.length > 0 && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Ключевые проблемы</div>
          <div className="grid gap-2">
            {topIssues.map((issue: any, i: number) => (
              <div key={i} className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">{typeof issue === 'object' ? (issue.issue ?? issue.text ?? formatAuditItem(issue)) : formatAuditItem(issue)}</span>
                  {issue.impact && (
                    <span className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium ${issue.impact === 'critical' ? 'bg-red-200 text-red-800' : 'bg-orange-200 text-orange-800'}`}>
                      {impactLabels[issue.impact] ?? issue.impact}
                    </span>
                  )}
                </div>
                {issue.rootCause && <p className="mt-1 text-xs text-red-600">Причина: {issue.rootCause}</p>}
                {issue.fix && <p className="mt-1 text-xs text-green-700">Решение: {issue.fix}</p>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Root Causes */}
      {rootCauses.length > 0 && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Коренные причины</div>
          <div className="space-y-2">
            {rootCauses.map((c: any, i: number) => (
              <div key={i} className="border-l-4 border-gray-300 pl-3 py-1 text-sm text-muted-foreground">
                {formatAuditItem(c)}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Content Rewrites — редактируемые тексты прямо в обзоре, без модалки.
          Состояние хранится в родителе (PageContent), та же переменная
          используется в dialog'е и при отправке на WB. */}
      {(rewrites.suggestedTitle || rewrites.suggestedDescription || editTitle || editDescription) && (() => {
        const titleLen = editTitle.length;
        const descLen = editDescription.length;
        const titleOver = titleLen > 100;
        const descOver = descLen > 5000;
        const titleEmpty = editTitle.trim().length === 0;
        const descEmpty = editDescription.trim().length === 0;
        const canApply = !titleOver && !descOver && !(titleEmpty && descEmpty);
        return (
        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Рекомендуемые тексты</div>
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-[var(--content-muted)]">Заголовок</label>
                <span className={`text-[11px] ${titleOver ? 'text-red-600' : 'text-[var(--content-muted)]'}`}>
                  {titleLen} / 100
                </span>
              </div>
              <textarea
                value={editTitle}
                onChange={(e) => onEditTitle(e.target.value)}
                placeholder="Заголовок карточки"
                rows={2}
                className={`w-full px-3 py-2 text-sm rounded-lg bg-indigo-50 border resize-y ${titleOver ? 'border-red-400' : 'border-indigo-200'}`}
              />
              {titleOver && <div className="text-[11px] text-red-600 mt-1">Превышен лимит WB (100 символов).</div>}
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-[var(--content-muted)]">Описание</label>
                <span className={`text-[11px] ${descOver ? 'text-red-600' : 'text-[var(--content-muted)]'}`}>
                  {descLen} / 5000
                </span>
              </div>
              <textarea
                value={editDescription}
                onChange={(e) => onEditDescription(e.target.value)}
                placeholder="Описание товара"
                rows={10}
                className={`w-full px-3 py-2 text-sm rounded-lg bg-indigo-50 border resize-y whitespace-pre-wrap ${descOver ? 'border-red-400' : 'border-indigo-200'}`}
              />
              {descOver && <div className="text-[11px] text-red-600 mt-1">Превышен лимит WB (5000 символов).</div>}
            </div>
          </div>
          {/* Apply to WB Button */}
          <div className="mt-4 pt-3 border-t flex items-center justify-between gap-2">
            <p className="text-xs text-[var(--content-muted)]">
              Тексты редактируются прямо здесь. «Применить на WB» отправит
              текущие значения.
            </p>
            <Button
              size="sm"
              onClick={onApplyClick}
              disabled={!canApply}
              className="bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-50"
            >
              🚀 Применить на WB
            </Button>
          </div>
        </Card>
        );
      })()}

      {/* Expert Recommendations (from roleTasks) */}
      {(() => {
        const roleTasks = v3(audit, 'roleTasks', {});
        const roleEntries = Object.entries(roleTasks).filter(([, tasks]) => Array.isArray(tasks) && (tasks as any[]).length > 0) as [string, any[]][];
        if (roleEntries.length === 0) return null;
        const roleNames: Record<string, string> = {
          marketer: '📊 Маркетолог',
          designer: '🎨 Дизайнер',
          photographer: '📸 Фотограф',
          contentManager: '✍️ Контент-менеджер',
          seoSpecialist: '🔍 SEO-специалист',
          psychologist: '🧠 Психолог',
          buyer: '🛒 Покупатель',
        };
        return (
          <Card className="p-4">
            <div className="text-sm font-semibold text-[var(--content-text)] mb-4">Советы специалистов</div>
            <div className="space-y-4">
              {roleEntries.map(([role, tasks]) => (
                <div key={role}>
                  <div className="text-sm font-medium text-[var(--content-text)] mb-2">
                    {roleNames[role] ?? role}
                  </div>
                  <div className="space-y-2 ml-1">
                    {tasks.map((task: any, i: number) => {
                      const taskText = typeof task === 'string' ? task : (task.task ?? task.action ?? task.text ?? formatAuditItem(task));
                      return (
                        <div key={i} className="flex items-start gap-2 text-sm">
                          <span className="shrink-0 text-[var(--content-muted)]">•</span>
                          <span className="text-[var(--content-muted)]">{taskText}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        );
      })()}
    </div>
  );
}

function RoleTasksTab({ audit, roleKey, label }: { audit: any; roleKey: string; label: string }) {
  const tasks = audit?.roleTasks?.[roleKey] ?? audit?.perspectives?.[roleKey]?.tasks ?? [];
  const perspective = audit?.perspectives?.[roleKey];

  if (!tasks.length && !perspective) {
    return <p className="text-muted-foreground p-4 text-center">Данные «{label}» отсутствуют в этом аудите</p>;
  }

  return (
    <div className="space-y-3">
      {/* Show perspective assessment if available */}
      {perspective && typeof perspective === 'object' && (
        <Card className="p-4">
          {Object.entries(perspective).filter(([k, v]) => typeof v === 'string' && k !== 'tasks').map(([k, v]) => (
            <div key={k} className="mb-3">
              <div className="text-sm font-semibold text-[var(--content-text)] mb-1 capitalize">{k.replace(/([A-Z])/g, ' $1').trim()}</div>
              <div className="text-sm text-[var(--content-muted)]">{v as string}</div>
            </div>
          ))}
        </Card>
      )}

      {/* Show role tasks */}
      {tasks.length > 0 && tasks.map((task: any, i: number) => (
        <Card key={i} className="p-4 border-l-4" style={{ borderLeftColor: task.priority === 'critical' ? '#ef4444' : task.priority === 'high' ? '#f59e0b' : '#3b82f6' }}>
          <div className="flex items-start justify-between gap-2 mb-1">
            <p className="text-sm font-medium text-[var(--content-text)]">{typeof task === 'string' ? task : task.task || task.action || formatAuditItem(task)}</p>
            {task.priority && (
              <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${
                task.priority === 'critical' ? 'bg-red-100 text-red-700' :
                task.priority === 'high' ? 'bg-amber-100 text-amber-700' :
                'bg-blue-100 text-blue-700'
              }`}>{task.priority}</span>
            )}
          </div>
          {task.brief && <p className="text-xs text-[var(--content-muted)] mt-1">{task.brief}</p>}
          {task.timeEstimate && <p className="text-xs text-[var(--content-muted)] mt-1 opacity-70">⏱ {task.timeEstimate}</p>}
        </Card>
      ))}

      {/* Show strengths if from old perspective format */}
      {perspective?.strengths?.length > 0 && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)] mb-2">Сильные стороны</div>
          <ul className="list-disc pl-5 text-sm text-[var(--content-muted)] space-y-1">
            {perspective.strengths.map((s: string, i: number) => <li key={i}>{s}</li>)}
          </ul>
        </Card>
      )}
    </div>
  );
}

/* Backward-compatible wrapper components */
function MarketerTab({ audit }: { audit: any }) {
  return <RoleTasksTab audit={audit} roleKey="marketer" label="Маркетолог" />;
}

function PsychologistTab({ audit }: { audit: any }) {
  return <RoleTasksTab audit={audit} roleKey="designer" label="Дизайнер" />;
}

function BuyerTab({ audit }: { audit: any }) {
  return <RoleTasksTab audit={audit} roleKey="photographer" label="Фотограф" />;
}

function PhotosTab({ audit }: { audit: any }) {
  const photos = audit?.photos;
  if (!photos) return <p className="text-muted-foreground p-4 text-center">Данные по фотографиям отсутствуют в этом аудите</p>;
  const firstImage = photos.firstImage;
  const detailedPhotos = photos.detailedPhotos ?? [];
  const gallery = photos.gallery ?? {};
  const missingFrames = photos.missingFrames ?? [];
  const videoRec = photos.videoRecommendation;

  return (
    <div className="space-y-4">
      {/* First Image — photo left, score+brief right */}
      {firstImage && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Главное фото</div>
          <div className="grid grid-cols-[120px_1fr] gap-4 items-start sm:grid-cols-[160px_1fr]">
            {firstImage.imageUrl ? (
              <a href={firstImage.imageUrl} target="_blank" rel="noreferrer" className="block">
                <img
                  src={firstImage.imageUrl}
                  alt="Главное фото"
                  className="w-full aspect-square rounded-lg object-cover border border-gray-200 bg-gray-50 hover:opacity-90 transition-opacity"
                  loading="lazy"
                />
              </a>
            ) : (
              <div className="w-full aspect-square rounded-lg bg-gray-100 border border-gray-200" />
            )}
            <div className="space-y-2">
              {firstImage.score != null && (
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center justify-center w-12 h-12 rounded-full text-sm font-bold text-white ${scoreColor(firstImage.score)}`}>
                    {firstImage.score}
                  </span>
                  <span className="text-xs text-[var(--content-muted)]">из 100</span>
                </div>
              )}
              {firstImage.description && <p className="text-sm text-[var(--content-muted)]">{firstImage.description}</p>}
              {firstImage.designerBrief && (
                <div className="mt-2 p-3 bg-indigo-50 border border-indigo-200 rounded-lg text-sm text-indigo-800">
                  <span className="font-medium">Бриф дизайнеру:</span> {firstImage.designerBrief}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Detailed Photos — 2-col grid: photo left, score+text right */}
      {detailedPhotos.length > 0 && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Все фотографии</div>
          <div className="space-y-4">
            {detailedPhotos.map((photo: any, i: number) => (
              <div key={i} className="grid grid-cols-[100px_1fr] gap-3 items-start sm:grid-cols-[140px_1fr] pb-4 border-b border-gray-100 last:border-0 last:pb-0">
                {photo.imageUrl ? (
                  <a href={photo.imageUrl} target="_blank" rel="noreferrer" className="block">
                    <img
                      src={photo.imageUrl}
                      alt={`Фото ${i + 1}`}
                      className="w-full aspect-square rounded-md object-cover border border-gray-200 bg-gray-50 hover:opacity-90 transition-opacity"
                      loading="lazy"
                    />
                  </a>
                ) : (
                  <div className="w-full aspect-square rounded-md bg-gray-100 border border-gray-200 flex items-center justify-center text-xs text-gray-400">
                    Фото {i + 1}
                  </div>
                )}
                <div className="space-y-2 text-sm text-[var(--content-muted)] min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-[var(--content-text)]">Фото {i + 1}</span>
                    {photo.type && <span className="text-xs text-gray-500">— {PHOTO_TYPE_LABELS[photo.type] ?? photo.type}</span>}
                    {photo.score != null && (
                      <span className={`px-2 py-0.5 rounded text-xs font-bold text-white ${scoreColor(photo.score)}`}>{photo.score}/100</span>
                    )}
                    {photo.mobileReadability && <span className="text-xs text-gray-500">· Моб. читаемость: {photo.mobileReadability}</span>}
                  </div>
                  {photo.description && <p>{photo.description}</p>}
                  {photo.psychologicalImpact && (
                    <p className="text-xs italic text-purple-600">{photo.psychologicalImpact}</p>
                  )}
                  {photo.strengths?.length > 0 && (
                    <ul className="list-disc pl-5 text-green-700">
                      {photo.strengths.map((s: string, j: number) => <li key={j}>{s}</li>)}
                    </ul>
                  )}
                  {photo.issues?.length > 0 && (
                    <ul className="list-disc pl-5 text-red-600">
                      {photo.issues.map((iss: string, j: number) => <li key={j}>{iss}</li>)}
                    </ul>
                  )}
                  {photo.recommendations?.length > 0 && (
                    <ul className="list-disc pl-5 text-blue-600">
                      {photo.recommendations.map((r: string, j: number) => <li key={j}>{r}</li>)}
                    </ul>
                  )}
                  {photo.designerBrief && (
                    <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-lg text-indigo-800">
                      <div className="font-medium mb-1">Бриф дизайнеру:</div>
                      <p>{photo.designerBrief}</p>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Gallery: Recommended Sequence */}
      {gallery.recommendedSequence?.length > 0 && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Рекомендуемый порядок фото</div>
          <ol className="list-decimal pl-5 text-sm text-[var(--content-muted)] space-y-2">
            {gallery.recommendedSequence.map((item: any, i: number) => (
              <li key={i}>
                {typeof item === 'string' ? item : (
                  <div>
                    <span className="font-medium">{PHOTO_TYPE_LABELS[item.type] ?? item.type ?? `Фото ${item.position ?? i + 1}`}</span>
                    {item.content && <span> — {item.content}</span>}
                    {item.why && <div className="text-xs text-gray-500 mt-0.5">{item.why}</div>}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </Card>
      )}

      {/* Missing Frames */}
      {missingFrames.length > 0 && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Недостающие кадры</div>
          <div className="space-y-2">
            {missingFrames.map((frame: any, i: number) => (
              <div key={i} className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <div className="flex items-center gap-2 text-sm text-amber-800">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{formatAuditItem(frame)}</span>
                </div>
                {frame.designerBrief && (
                  <div className="mt-2 text-xs text-amber-700 pl-6">
                    <span className="font-medium">Бриф:</span> {frame.designerBrief}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Video Recommendation */}
      {videoRec && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold text-[var(--content-text)]">Рекомендация по видео</div>
            {videoRec.priority && (
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                videoRec.priority === 'high' || videoRec.priority === 'высокий' ? 'bg-red-100 text-red-700' :
                videoRec.priority === 'medium' || videoRec.priority === 'средний' ? 'bg-amber-100 text-amber-700' :
                'bg-green-100 text-green-700'
              }`}>
                {PRIORITY_LABELS[videoRec.priority] ?? videoRec.priority}
              </span>
            )}
          </div>
          <div className="space-y-3 text-sm text-[var(--content-muted)]">
            {videoRec.content && <p>{videoRec.content}</p>}
            {videoRec.duration && (
              <div className="flex items-center gap-2">
                <span className="font-medium text-[var(--content-text)]">Длительность:</span>
                <span>{videoRec.duration}</span>
              </div>
            )}
            {videoRec.brief && (
              <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-lg text-sm text-indigo-800">
                <div className="font-medium mb-1">ТЗ для видеографа:</div>
                <p>{videoRec.brief}</p>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function SeoTab({ audit }: { audit: any }) {
  const seo = audit?.seo;
  if (!seo) return <p className="text-muted-foreground p-4 text-center">SEO-данные отсутствуют в этом аудите</p>;
  const titleKw = seo.titleKeywords ?? {};
  const descKw = seo.descriptionKeywords ?? {};
  const recommended = seo.recommendedKeywords ?? [];
  const issues = seo.issues ?? [];

  function TagList({ items, color }: { items: string[]; color: string }) {
    if (!items?.length) return null;
    const colors: Record<string, string> = {
      green: 'bg-green-100 text-green-700',
      red: 'bg-red-100 text-red-700',
      orange: 'bg-orange-100 text-orange-700',
      indigo: 'bg-indigo-100 text-indigo-700',
    };
    return (
      <div className="flex flex-wrap gap-1.5">
        {items.map((kw, i) => (
          <span key={i} className={`px-2 py-0.5 rounded text-xs ${colors[color] ?? 'bg-gray-100 text-gray-600'}`}>{kw}</span>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Title Keywords */}
      {(titleKw.found?.length > 0 || titleKw.missing?.length > 0 || titleKw.spam?.length > 0) && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Ключевые слова в заголовке</div>
          <div className="space-y-2">
            {titleKw.found?.length > 0 && (
              <div><span className="text-xs text-[var(--content-muted)]">Найдены:</span> <TagList items={titleKw.found} color="green" /></div>
            )}
            {titleKw.missing?.length > 0 && (
              <div><span className="text-xs text-[var(--content-muted)]">Отсутствуют:</span> <TagList items={titleKw.missing} color="red" /></div>
            )}
            {titleKw.spam?.length > 0 && (
              <div><span className="text-xs text-[var(--content-muted)]">Спам:</span> <TagList items={titleKw.spam} color="orange" /></div>
            )}
          </div>
        </Card>
      )}

      {/* Description Keywords */}
      {(descKw.found?.length > 0 || descKw.missing?.length > 0) && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Ключевые слова в описании</div>
          <div className="space-y-2">
            {descKw.found?.length > 0 && (
              <div><span className="text-xs text-[var(--content-muted)]">Найдены:</span> <TagList items={descKw.found} color="green" /></div>
            )}
            {descKw.missing?.length > 0 && (
              <div><span className="text-xs text-[var(--content-muted)]">Отсутствуют:</span> <TagList items={descKw.missing} color="red" /></div>
            )}
          </div>
        </Card>
      )}

      {/* Recommended Keywords */}
      {recommended.length > 0 && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Рекомендуемые ключевые слова</div>
          <TagList items={recommended} color="indigo" />
        </Card>
      )}

      {/* SEO Issues */}
      {issues.length > 0 && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Проблемы SEO</div>
          <ul className="list-disc pl-5 text-sm text-red-600 space-y-1">
            {issues.map((iss: string, i: number) => <li key={i}>{iss}</li>)}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ChecklistTab({ audit, handleFix, fixLoading }: { audit: any; handleFix: (ft: FixType) => void; fixLoading: string | null }) {
  // V3 checklist can be in checklist (dict), checklistV3, or checklist_v3
  const clRaw = audit?.checklist ?? {};
  const cl = typeof clRaw === 'object' && !Array.isArray(clRaw) ? clRaw : (v3(audit, 'checklistV3', v3(audit, 'checklist_v3', {})));
  const doNow = cl.doNow ?? cl.do_now ?? [];
  const doNext = cl.doNext ?? cl.do_next ?? [];
  const testHypotheses = cl.testHypotheses ?? cl.test_hypotheses ?? [];

  // Fallback to v1 checklist if no v3 data
  const v1Checklist = Array.isArray(audit?.checklist) ? audit.checklist : [];
  const hasV3Data = doNow.length > 0 || doNext.length > 0 || testHypotheses.length > 0;

  const assigneeLabels: Record<string, string> = {
    designer: 'Дизайнер',
    photographer: 'Фотограф',
    marketer: 'Маркетолог',
    contentManager: 'Контент-менеджер',
    seoSpecialist: 'SEO-специалист',
  };

  function TaskRow({ task, idx }: { task: any; idx: number }) {
    const actionText = typeof task === 'string' ? task : (task.action ?? task.task ?? task.issue ?? task.text ?? task.label ?? '');
    const ft = detectFixType(actionText);
    const step = task.step ?? idx + 1;
    return (
      <div className="p-4 bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg space-y-2">
        <div className="flex items-start gap-3">
          <span className="shrink-0 w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-sm font-bold">{step}</span>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm leading-relaxed">{actionText || formatAuditItem(task)}</p>
          </div>
        </div>
        {task.expectedResult && (
          <div className="ml-10 p-2 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded text-sm text-green-700 dark:text-green-300">
            <span className="font-medium">Ожидаемый результат:</span> {task.expectedResult}
          </div>
        )}
        <div className="ml-10 flex items-center gap-2 flex-wrap">
          {task.assignee && (
            <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-xs font-medium">
              {assigneeLabels[task.assignee] ?? task.assignee}
            </span>
          )}
          {task.timeMinutes && (
            <span className="text-xs text-[var(--content-muted)]">⏱ {task.timeMinutes >= 60 ? `${Math.floor(task.timeMinutes / 60)} ч ${task.timeMinutes % 60 > 0 ? `${task.timeMinutes % 60} мин` : ''}` : `${task.timeMinutes} мин`}</span>
          )}
          {task.priority && priorityBadge(task.priority)}
          {task.impact && (
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${task.impact === 'critical' ? 'bg-red-100 text-red-700' : task.impact === 'high' ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-600'}`}>
              {task.impact === 'critical' ? 'Критично' : task.impact === 'high' ? 'Важно' : task.impact}
            </span>
          )}
        </div>
      </div>
    );
  }

  if (!hasV3Data && v1Checklist.length > 0) {
    // Render v1-style checklist with AI fix buttons
    return (
      <Card className="p-4">
        <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Чек-лист</div>
        <ul className="mt-2 list-disc pl-5 text-sm text-[var(--content-muted)]">
          {v1Checklist.map((item: string, i: number) => {
            const ft = detectFixType(item);
            return (
              <li key={`checklist-${i}`} className="flex items-start gap-2 mb-1">
                <span className="flex-1">{item}</span>
              </li>
            );
          })}
        </ul>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {/* Do Now */}
      {doNow.length > 0 && (
        <div>
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Сделать сейчас</div>
          <div className="space-y-2">
            {doNow.map((task: any, i: number) => <TaskRow key={i} task={task} idx={i} />)}
          </div>
        </div>
      )}

      {/* Do Next */}
      {doNext.length > 0 && (
        <div>
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Сделать потом</div>
          <div className="space-y-2">
            {doNext.map((task: any, i: number) => <TaskRow key={i} task={task} idx={i} />)}
          </div>
        </div>
      )}

      {/* Test Hypotheses */}
      {testHypotheses.length > 0 && (
        <div>
          <div className="text-sm font-semibold text-[var(--content-text)] mb-3">Тест-гипотезы</div>
          <div className="space-y-3">
            {testHypotheses.map((hyp: any, i: number) => (
              <Card key={i} className="p-4">
                <div className="text-sm font-medium text-[var(--content-text)] mb-2">{hyp.hypothesis ?? hyp.title ?? `Гипотеза ${i + 1}`}</div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-2 bg-blue-50 border border-blue-200 rounded text-sm">
                    <div className="text-xs text-blue-600 font-medium mb-1">Вариант A</div>
                    <div className="text-blue-800">{hyp.variant_a ?? hyp.variantA ?? '—'}</div>
                  </div>
                  <div className="p-2 bg-purple-50 border border-purple-200 rounded text-sm">
                    <div className="text-xs text-purple-600 font-medium mb-1">Вариант B</div>
                    <div className="text-purple-800">{hyp.variant_b ?? hyp.variantB ?? '—'}</div>
                  </div>
                </div>
                <div className="flex gap-4 mt-2 text-xs text-[var(--content-muted)]">
                  {hyp.metric && <span>Метрика: <b>{hyp.metric}</b></span>}
                  {hyp.expectedLift && <span>Ожидаемый подъем: <b>{hyp.expectedLift}</b></span>}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RolesTab({ audit }: { audit: any }) {
  const roles = v3(audit, 'roleTasks', v3(audit, 'role_tasks', {}));
  const roleLabels: Record<string, string> = {
    designer: 'Дизайнер',
    contentManager: 'Контент-менеджер',
    content_manager: 'Контент-менеджер',
    seoSpecialist: 'SEO-специалист',
    seo_specialist: 'SEO-специалист',
    photographer: 'Фотограф',
    marketer: 'Маркетолог',
  };

  const expectedImpact = v3(audit, 'expectedImpactSummary', v3(audit, 'expected_impact_summary', null));

  const roleEntries = Object.entries(roles).filter(([, tasks]) => Array.isArray(tasks) && (tasks as any[]).length > 0);

  if (roleEntries.length === 0) return <div className="text-sm text-[var(--content-muted)]">Нет задач по ролям.</div>;

  return (
    <div className="space-y-3">
      {roleEntries.map(([role, tasks]) => (
        <Accordion key={role} title={`${roleLabels[role] ?? role} (${(tasks as any[]).length})`}>
          <div className="space-y-2">
            {(tasks as any[]).map((task: any, i: number) => {
              const text = typeof task === 'string' ? task : task.task ?? task.text ?? task.label ?? '';
              return (
                <div key={i} className="p-3 bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg">
                  <div className="text-sm font-medium text-[var(--content-text)]">{text}</div>
                  {task.brief && (
                    <details className="mt-1">
                      <summary className="text-xs text-indigo-600 cursor-pointer">Подробнее</summary>
                      <div className="mt-1 text-xs text-[var(--content-muted)]">{task.brief}</div>
                    </details>
                  )}
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {task.priority && priorityBadge(task.priority)}
                    {task.timeEstimate && <span className="text-xs text-[var(--content-muted)]">{task.timeEstimate}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </Accordion>
      ))}

      {expectedImpact && (
        <Card className="p-4 bg-gradient-to-r from-green-50 to-emerald-50 border-green-200">
          <div className="text-sm font-semibold text-green-800 mb-1">Ожидаемый эффект</div>
          <div className="text-sm text-green-700">{expectedImpact}</div>
        </Card>
      )}
    </div>
  );
}

/* ─── Main Page ─── */

export default function CreativeAuditPage() {
  const storeWorkspaceId = useWorkspaceStore((s) => s.workspaceId);
  const workspaceId = storeWorkspaceId ?? 0;
  const shopParam = useShopParam();
  const { shopId } = useActiveShop();

  // Persisted state (survives page navigation via sessionStorage)
  const audit = useCreativeAuditStore((s) => s.audit);
  const setAudit = useCreativeAuditStore((s) => s.setAudit);
  const selectedNmId = useCreativeAuditStore((s) => s.selectedNmId);
  const setSelectedNmId = useCreativeAuditStore((s) => s.setSelectedNmId);
  const v3Tab = useCreativeAuditStore((s) => s.v3Tab);
  const setV3Tab = useCreativeAuditStore((s) => s.setV3Tab);
  const hasHydrated = useCreativeAuditStore((s) => s._hasHydrated);

  // Transient state (page-local)
  const [activeTab, setActiveTab] = useState<'new' | 'history'>('new');
  const [nmId, setNmId] = useState('');
  const [limits, setLimits] = useState<Limits | null>(null);
  const [list, setList] = useState<AuditSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [auditProgress, setAuditProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Progress message shown in a neutral (non-error) banner during long-running
  // operations like the 3-5 min creative audit. Kept separate from `error`
  // so "Занимает 3-5 минут" doesn't render red with an alarm icon.
  const [progress, setProgress] = useState<string | null>(null);
  const [fixPreview, setFixPreview] = useState<{ fixType: string; original: string; improved: string } | null>(null);
  const [fixLoading, setFixLoading] = useState<string | null>(null);
  const [showPrompts, setShowPrompts] = useState(false);
  const [applyingFix, setApplyingFix] = useState(false);
  // Phase 3: Apply recommendations
  const [showApplyDialog, setShowApplyDialog] = useState(false);
  const [applyFields, setApplyFields] = useState<{ title: boolean; description: boolean }>({ title: true, description: true });
  // Редактируемые тексты в диалоге «Применить на WB» — предзаполняются из
  // contentRewrites при открытии и отправляются как overrideTitle/overrideDescription.
  const [applyTitleText, setApplyTitleText] = useState('');
  const [applyDescText, setApplyDescText] = useState('');

  // При смене аудита подтягиваем suggestedTitle/Description, чтобы пользователь
  // мог их редактировать прямо в OverviewTab (без открытия диалога).
  useEffect(() => {
    const r = ((audit as any)?.contentRewrites ?? {}) as { suggestedTitle?: string; suggestedDescription?: string };
    setApplyTitleText(String(r.suggestedTitle ?? '').trim());
    setApplyDescText(String(r.suggestedDescription ?? '').trim());
  }, [audit]);
  const [applyingRecommendations, setApplyingRecommendations] = useState(false);
  // Experiments state/UI был удалён 2026-05-27 — модалка скрыта `{false && ...}`,
  // а handler'ы остались orphan'ом. Сейчас полная чистка: state, loadExperiments,
  // handleRevertExperiment удалены. Если понадобится — поднимать заново.

  // Bulk Audit state
  const [bulkNmIds, setBulkNmIds] = useState('');
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkResults, setBulkResults] = useState<BulkAuditResult | null>(null);
  const [bulkProgress, setBulkProgress] = useState(0);

  async function loadLimits() {
    const shopQs = shopParam ? `?${shopParam.slice(1)}` : '';
    const res = (await apiFetch(`/creative-audit/${workspaceId}/limits${shopQs}`)) as Limits;
    setLimits(res);
  }

  async function loadList() {
    const res = (await apiFetch(`/creative-audit/${workspaceId}?limit=10${shopParam}`)) as { rows: AuditSummary[] };
    setList(res.rows ?? []);
  }

  async function loadAudit(auditId: number) {
    const shopQs = shopParam ? `?${shopParam.slice(1)}` : '';
    const res = await apiFetch(`/creative-audit/${workspaceId}/${auditId}${shopQs}`);
    // V3 returns flat object, V1 wraps in { audit: ... }
    const auditData = (res as any).audit ?? res;
    setAudit(auditData as AuditDetail);
    setSelectedNmId(String(auditData.nmId));
    setV3Tab('overview');
  }

  useEffect(() => {
    if (!workspaceId) return;
    loadLimits();
    loadList();

    // Safety net: if Zustand persist hasn't hydrated yet, manually rehydrate
    // This handles the Next.js App Router case where async hydration may lag
    if (!hasHydrated) {
      useCreativeAuditStore.persist.rehydrate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useShopChange(() => {
    useCreativeAuditStore.getState().clear();
    loadLimits();
    loadList();
  });

  // Sync UI state from the global audit job. AppShell polls in the background;
  // when it lands a `done`/`failed` we react here. This is what lets the user
  // close the page mid-audit and see the result on return.
  const auditJob = useAuditTaskStore((s) => s.activeTask);
  const setAuditJob = useAuditTaskStore((s) => s.setActiveTask);
  const clearAuditJob = useAuditTaskStore((s) => s.clearActiveTask);

  useEffect(() => {
    if (!auditJob) {
      // No job — make sure the page isn't stuck in the "auditing" state.
      if (auditing) {
        setAuditing(false);
        setLoading(false);
        setAuditProgress(0);
        setProgress(null);
      }
      return;
    }
    // Mirror running state into the local UI flags so existing buttons/banners
    // light up the same way they did when the for-loop was inline.
    if (auditJob.status === 'running') {
      if (!auditing) setAuditing(true);
      if (!loading) setLoading(true);
      const elapsed = Math.floor((Date.now() - auditJob.startedAt) / 1000);
      const mm = Math.floor(elapsed / 60);
      const ss = (elapsed % 60).toString().padStart(2, '0');
      setProgress(`Анализируем карточку… ${mm}:${ss} (можно переключаться, аудит продолжится)`);
      // Reasonable progress staging by elapsed time.
      if (elapsed < 10) setAuditProgress(1);
      else if (elapsed < 25) setAuditProgress(2);
      else setAuditProgress(3);
      return;
    }
    if (auditJob.status === 'done') {
      const res = auditJob.result as any;
      const auditData = res?.finalAudit ?? res?.audit ?? res;
      if (auditData) {
        setAudit(auditData as AuditDetail);
        setSelectedNmId(String(auditJob.nmId));
        setV3Tab('overview');
      }
      setProgress(null);
      setError(null);
      setAuditing(false);
      setLoading(false);
      setAuditProgress(0);
      loadLimits();
      loadList();
      clearAuditJob();
      return;
    }
    if (auditJob.status === 'failed') {
      setError(auditJob.error ?? 'Аудит упал на сервере');
      setProgress(null);
      setAuditing(false);
      setLoading(false);
      setAuditProgress(0);
      clearAuditJob();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditJob]);

  async function runAudit(overrideNmId?: string | number) {
    const raw = overrideNmId ?? nmId;
    const targetNmId = String(raw ?? '').trim();
    const parsedNmId = parseInt(targetNmId, 10);
    setError(null);
    if (!targetNmId || !Number.isFinite(parsedNmId) || parsedNmId <= 0) {
      setError('Выберите товар или введите артикул');
      return;
    }

    if (overrideNmId != null) {
      setNmId(String(overrideNmId));
    }

    setLoading(true);
    setAuditing(true);
    setAuditProgress(1);
    setProgress('Запуск аудита…');

    try {
      // New async-job flow + global polling (DECISIONS#94 pattern).
      //   POST /run-v3 returns { jobId, status:'running' } within ~1 s.
      //   We hand jobId to the global `useAuditTaskStore`, and AppShell-level
      //   `useAuditJobPolling` opens the polling loop. That hook lives above
      //   the page lifecycle, so user can switch tabs / close /creative-audit
      //   and the audit finishes in the background — when status flips to
      //   `done` the effect above mirrors the result back into the page UI.
      //
      // Back-compat: if backend somehow returns the audit synchronously
      // (legacy path), use it directly without a job entry.
      const startRes = (await apiFetch(`/creative-audit/${workspaceId}/run-v3`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nmId: parseInt(String(targetNmId).trim(), 10) || 0, ...(shopId ? { shopId } : {}) }),
      })) as { jobId?: number; status?: string; finalAudit?: any; audit?: any };

      if (!startRes?.jobId && (startRes?.finalAudit || startRes?.audit)) {
        const auditData = startRes.finalAudit ?? startRes.audit ?? startRes;
        setAudit(auditData as AuditDetail);
        setSelectedNmId(String(targetNmId).trim());
        setV3Tab('overview');
        await loadLimits();
        await loadList();
        setProgress(null);
        setAuditing(false);
        setLoading(false);
        setAuditProgress(0);
        return;
      }

      const jobId = startRes.jobId;
      if (!jobId) throw new Error('Сервер не вернул jobId');

      // Hand off to AppShell polling. The effect on `auditJob` will pick up
      // status updates — we don't loop here.
      setAuditJob({
        jobId,
        nmId: parseInt(String(targetNmId).trim(), 10) || 0,
        status: 'running',
        startedAt: Date.now(),
      });
      setError(null);
      setProgress('Аудит запущен. Можно переключаться на другие вкладки — результат догонит.');
    } catch (e: any) {
      // Initial POST itself failed (no jobId returned). Transport-level errors
      // can mean the backend still kicked off the audit (request reached it
      // before the proxy died) — fall back to scanning the audit history list,
      // which writes a row only when a real audit completed. We poll for up to
      // 5 minutes and pick up the first matching row.
      const errMsg = String(e?.message ?? e);
      const looksLikeTransport =
        /timeout|timed out|fetch failed|socket hang|other side closed|network error|ECONNRESET|NetworkError/i.test(errMsg);
      if (looksLikeTransport) {
        setError(null);
        setProgress('Аудит запущен на сервере. Занимает 3–5 минут — ждём результат…');
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 10_000));
          try {
            const listRes = (await apiFetch(`/creative-audit/${workspaceId}?limit=1${shopParam}`)) as { rows: AuditSummary[] };
            const latest = listRes.rows?.[0];
            if (latest && latest.nmId === Number(String(targetNmId).trim())) {
              await loadAudit(latest.auditId ?? (latest as any).id);
              setProgress(null);
              setError(null);
              await loadList();
              break;
            }
          } catch {}
        }
        setProgress(null);
        setAuditing(false);
        setLoading(false);
        setAuditProgress(0);
      } else {
        setError(errMsg);
        setProgress(null);
        setAuditing(false);
        setLoading(false);
        setAuditProgress(0);
      }
    }
  }

  async function downloadPdf(auditData?: AuditDetail, kind: 'full' | 'photo-brief' = 'full') {
    const a = auditData ?? audit;
    if (!a) return;

    if (kind === 'photo-brief') {
      return downloadPhotoBriefPdf(a);
    }

    // Load Cyrillic font for Russian text support
    const doc = new jsPDF();
    try {
      const [fontResp, boldResp] = await Promise.all([
        fetch('/fonts/DejaVuSans.ttf'),
        fetch('/fonts/DejaVuSans-Bold.ttf'),
      ]);
      const [fontBuf, boldBuf] = await Promise.all([fontResp.arrayBuffer(), boldResp.arrayBuffer()]);
      const toBase64 = (buf: ArrayBuffer) => {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      };
      doc.addFileToVFS('DejaVuSans.ttf', toBase64(fontBuf));
      doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
      doc.addFileToVFS('DejaVuSans-Bold.ttf', toBase64(boldBuf));
      doc.addFont('DejaVuSans-Bold.ttf', 'DejaVu', 'bold');
      doc.setFont('DejaVu', 'normal');
    } catch (e) {
      console.warn('Failed to load Cyrillic fonts, PDF may have missing characters', e);
    }

    if (isV3Audit(a)) {
      // V3 PDF
      const verdict = v3(a, 'verdict', {});
      const scores = v3(a, 'scores', {});
      // overallScore приходит на top-level от backend (v3Row.overallScore). Fallback на verdict.score / a.score, чтобы не показывать 0.
      const overallScore = (a as any).overallScore ?? v3(a, 'verdict.score', null) ?? a.score ?? 0;
      const nmIdDisp = (a as any).nmId ?? (a as any).nm_id ?? '—';

      doc.setFontSize(16);
      doc.text(`Креативный аудит v3 — Артикул ${nmIdDisp}`, 14, 20);

      // Score
      doc.setFontSize(32);
      const sc = overallScore;
      const sColor = sc >= 70 ? [34, 197, 94] : sc >= 40 ? [234, 179, 8] : [239, 68, 68];
      doc.setTextColor(sColor[0], sColor[1], sColor[2]);
      doc.text(`${sc}/100`, 14, 40);
      doc.setTextColor(0, 0, 0);

      doc.setFontSize(10);
      let y = 55;

      // Verdict summary
      if (verdict.summary) {
        const lines = doc.splitTextToSize(verdict.summary, 180);
        doc.text(lines, 14, y);
        y += lines.length * 5 + 5;
      }
      if (verdict.mainProblem) {
        doc.setTextColor(200, 0, 0);
        const lines = doc.splitTextToSize(`Главная проблема: ${verdict.mainProblem}`, 180);
        doc.text(lines, 14, y);
        doc.setTextColor(0, 0, 0);
        y += lines.length * 5 + 5;
      }

      // 11 scores
      const scoreEntries = Object.entries(scores).filter(([, v]) => typeof v === 'number') as [string, number][];
      if (scoreEntries.length > 0) {
        if (y > 260) { doc.addPage(); y = 20; }
        doc.setFontSize(12);
        doc.setFont('DejaVu', 'bold');
        doc.text('Оценки', 14, y);
        y += 7;
        doc.setFontSize(9);
        doc.setFont('DejaVu', 'normal');
        for (const [key, val] of scoreEntries) {
          doc.text(`${SCORE_LABELS[key] ?? key}: ${val}/100`, 16, y);
          y += 5;
        }
        y += 4;
      }

      // Writer helper — section header + bullet list items (strings or {text} objs)
      const writeSection = (title: string, items: any[], color?: [number, number, number]) => {
        if (!items?.length) return;
        if (y > 260) { doc.addPage(); y = 20; }
        doc.setFontSize(12);
        doc.setFont('DejaVu', 'bold');
        if (color) doc.setTextColor(color[0], color[1], color[2]);
        doc.text(title, 14, y);
        if (color) doc.setTextColor(0, 0, 0);
        y += 7;
        doc.setFontSize(9);
        doc.setFont('DejaVu', 'normal');
        for (const it of items) {
          const text = typeof it === 'string' ? it : (it.text ?? it.issue ?? it.strength ?? it.task ?? it.action ?? formatAuditItem(it));
          const lines = doc.splitTextToSize(`• ${text}`, 175);
          if (y + lines.length * 4.5 > 280) { doc.addPage(); y = 20; }
          doc.text(lines, 16, y);
          y += lines.length * 4.5 + 2;
        }
        y += 4;
      };

      // Top strengths + top issues
      writeSection('Сильные стороны', v3(a, 'topStrengths', []), [34, 139, 34]);
      writeSection('Главные проблемы', v3(a, 'topIssues', []), [200, 0, 0]);

      // Perspectives summaries
      const perspectiveLabels: Record<string, string> = { marketer: 'Маркетолог', psychologist: 'Психолог', buyer: 'Покупатель' };
      const perspectives = ['marketer', 'psychologist', 'buyer'];
      for (const role of perspectives) {
        const persp = v3(a, `perspectives.${role}`, null);
        if (!persp) continue;
        if (y > 260) { doc.addPage(); y = 20; }
        doc.setFontSize(12);
        doc.setFont('DejaVu', 'bold');
        doc.text(perspectiveLabels[role] ?? role, 14, y);
        y += 7;
        doc.setFontSize(9);
        doc.setFont('DejaVu', 'normal');
        const summary = persp.summary ?? persp.offerAssessment ?? persp.firstImpression ?? '';
        if (summary) {
          const lines = doc.splitTextToSize(summary, 175);
          if (y + lines.length * 4.5 > 280) { doc.addPage(); y = 20; }
          doc.text(lines, 16, y);
          y += lines.length * 4.5 + 4;
        }
      }

      // Checklist doNow / doNext
      const cl = v3(a, 'checklistV3', v3(a, 'checklist_v3', {}));
      const doNow = cl.doNow ?? cl.do_now ?? [];
      const doNext = cl.doNext ?? cl.do_next ?? [];
      for (const [title, items] of [['Сделать сейчас', doNow], ['Сделать далее', doNext]] as [string, any[]][]) {
        if (!items?.length) continue;
        if (y > 260) { doc.addPage(); y = 20; }
        doc.setFontSize(12);
        doc.setFont('DejaVu', 'bold');
        doc.text(title, 14, y);
        y += 7;
        doc.setFontSize(9);
        doc.setFont('DejaVu', 'normal');
        for (const task of items) {
          const text = typeof task === 'string' ? task : task.task ?? task.text ?? formatAuditItem(task);
          const lines = doc.splitTextToSize(`• ${text}`, 175);
          if (y + lines.length * 4.5 > 280) { doc.addPage(); y = 20; }
          doc.text(lines, 16, y);
          y += lines.length * 4.5 + 2;
        }
        y += 4;
      }

      // Role Tasks
      const roles = v3(a, 'roleTasks', v3(a, 'role_tasks', {}));
      for (const [role, tasks] of Object.entries(roles)) {
        if (!Array.isArray(tasks) || tasks.length === 0) continue;
        if (y > 260) { doc.addPage(); y = 20; }
        doc.setFontSize(12);
        doc.setFont('DejaVu', 'bold');
        doc.text(`${ROLE_LABELS[role] ?? role}`, 14, y);
        y += 7;
        doc.setFontSize(9);
        doc.setFont('DejaVu', 'normal');
        for (const task of tasks as any[]) {
          const text = typeof task === 'string' ? task : task.task ?? task.text ?? formatAuditItem(task);
          const lines = doc.splitTextToSize(`• ${text}`, 175);
          if (y + lines.length * 4.5 > 280) { doc.addPage(); y = 20; }
          doc.text(lines, 16, y);
          y += lines.length * 4.5 + 2;
        }
        y += 4;
      }

      // Content rewrites (newTitle + newDescription)
      const rewrites = v3(a, 'contentRewrites', v3(a, 'content_rewrites', {}));
      const newTitle = rewrites.title ?? rewrites.newTitle ?? rewrites.new_title;
      const newDesc = rewrites.description ?? rewrites.newDescription ?? rewrites.new_description;
      if (newTitle || newDesc) {
        if (y > 240) { doc.addPage(); y = 20; }
        doc.setFontSize(12);
        doc.setFont('DejaVu', 'bold');
        doc.text('Предлагаемый контент', 14, y);
        y += 7;
        doc.setFontSize(9);
        doc.setFont('DejaVu', 'normal');
        if (newTitle) {
          doc.setFont('DejaVu', 'bold');
          doc.text('Заголовок:', 16, y); y += 5;
          doc.setFont('DejaVu', 'normal');
          const lines = doc.splitTextToSize(String(newTitle), 175);
          if (y + lines.length * 4.5 > 280) { doc.addPage(); y = 20; }
          doc.text(lines, 16, y);
          y += lines.length * 4.5 + 4;
        }
        if (newDesc) {
          doc.setFont('DejaVu', 'bold');
          doc.text('Описание:', 16, y); y += 5;
          doc.setFont('DejaVu', 'normal');
          const lines = doc.splitTextToSize(String(newDesc), 175);
          if (y + lines.length * 4.5 > 280) { doc.addPage(); y = 20; }
          doc.text(lines, 16, y);
          y += lines.length * 4.5 + 4;
        }
        y += 2;
      }

      // SEO keywords (title / description pools) + issues
      const seo = v3(a, 'seo', {});
      const titleKw: any[] = seo.titleKeywords ?? seo.title_keywords ?? [];
      const descKw: any[] = seo.descriptionKeywords ?? seo.description_keywords ?? [];
      const seoIssues: any[] = seo.issues ?? [];
      if (titleKw.length || descKw.length || seoIssues.length) {
        if (y > 250) { doc.addPage(); y = 20; }
        doc.setFontSize(12);
        doc.setFont('DejaVu', 'bold');
        doc.text('SEO', 14, y);
        y += 7;
        doc.setFontSize(9);
        doc.setFont('DejaVu', 'normal');
        const renderKw = (label: string, kws: any[]) => {
          if (!kws.length) return;
          doc.setFont('DejaVu', 'bold');
          doc.text(label, 16, y); y += 5;
          doc.setFont('DejaVu', 'normal');
          const flat = kws.map((k) => typeof k === 'string' ? k : (k.keyword ?? k.text ?? '')).filter(Boolean).join(', ');
          const lines = doc.splitTextToSize(flat, 175);
          if (y + lines.length * 4.5 > 280) { doc.addPage(); y = 20; }
          doc.text(lines, 16, y);
          y += lines.length * 4.5 + 4;
        };
        renderKw('Ключи для заголовка:', titleKw);
        renderKw('Ключи для описания:', descKw);
        if (seoIssues.length) writeSection('SEO-проблемы', seoIssues);
      }

      // Photos analysis (firstImage + detailed per-photo scores)
      const photos = v3(a, 'photos', {});
      const firstImg = photos.firstImage ?? photos.first_image;
      const detailedPhotos: any[] = photos.detailedPhotos ?? photos.detailed_photos ?? [];
      if (firstImg || detailedPhotos.length) {
        if (y > 250) { doc.addPage(); y = 20; }
        doc.setFontSize(12);
        doc.setFont('DejaVu', 'bold');
        doc.text('Анализ фото', 14, y);
        y += 7;
        doc.setFontSize(9);
        doc.setFont('DejaVu', 'normal');
        if (firstImg?.summary) {
          doc.setFont('DejaVu', 'bold'); doc.text('Главное фото:', 16, y); y += 5;
          doc.setFont('DejaVu', 'normal');
          const lines = doc.splitTextToSize(String(firstImg.summary), 175);
          if (y + lines.length * 4.5 > 280) { doc.addPage(); y = 20; }
          doc.text(lines, 16, y);
          y += lines.length * 4.5 + 4;
        }
        for (let i = 0; i < detailedPhotos.length; i++) {
          const p = detailedPhotos[i];
          if (y > 260) { doc.addPage(); y = 20; }
          doc.setFont('DejaVu', 'bold');
          const hdr = `Фото ${i + 1}${typeof p.score === 'number' ? ` — ${p.score}/100` : ''}${p.role ? ` (${p.role})` : ''}`;
          doc.text(hdr, 16, y); y += 5;
          doc.setFont('DejaVu', 'normal');
          const txt = p.summary ?? p.analysis ?? p.notes ?? '';
          if (txt) {
            const lines = doc.splitTextToSize(String(txt), 175);
            if (y + lines.length * 4.5 > 280) { doc.addPage(); y = 20; }
            doc.text(lines, 18, y);
            y += lines.length * 4.5 + 3;
          }
        }
      }

      // Test hypotheses
      const testHyp = cl.testHypotheses ?? cl.test_hypotheses ?? [];
      if (testHyp.length) writeSection('Гипотезы для теста', testHyp);

      doc.save(`audit-v3-${nmIdDisp}-${Date.now()}.pdf`);
    } else {
      // V1 PDF (original logic)
      doc.setFontSize(16);
      doc.text(`Аудит карточки #${a.nmId}`, 14, 20);
      doc.setFontSize(32);
      const scoreColorArr = (a.score ?? 0) >= 70 ? [34, 197, 94] : (a.score ?? 0) >= 40 ? [234, 179, 8] : [239, 68, 68];
      doc.setTextColor(scoreColorArr[0], scoreColorArr[1], scoreColorArr[2]);
      doc.text(`${a.score ?? 0}/100`, 14, 40);
      doc.setTextColor(0, 0, 0);
      doc.setFontSize(10);
      let y = 55;
      if (a.summary) {
        const lines = doc.splitTextToSize(a.summary, 180);
        doc.text(lines, 14, y);
        y += lines.length * 5 + 8;
      }
      const sections = [
        { title: 'Сильные стороны', items: a.strengths },
        { title: 'Проблемы', items: a.issues },
        { title: 'Быстрые исправления', items: a.quickFixes },
        { title: 'Контент', items: a.contentSuggestions },
        { title: 'Фото', items: a.photoSuggestions },
        { title: 'SEO', items: a.seoSuggestions },
        { title: 'Чек-лист', items: a.checklist },
      ];
      for (const sec of sections) {
        if (!sec.items?.length) continue;
        if (y > 270) { doc.addPage(); y = 20; }
        doc.setFontSize(12);
        doc.setFont('DejaVu', 'bold');
        doc.text(sec.title, 14, y);
        y += 7;
        doc.setFontSize(9);
        doc.setFont('DejaVu', 'normal');
        for (const item of sec.items) {
          const text = typeof item === 'string' ? item : (item as any).text || (item as any).label || formatAuditItem(item);
          const lines = doc.splitTextToSize(`• ${text}`, 175);
          if (y + lines.length * 4.5 > 280) { doc.addPage(); y = 20; }
          doc.text(lines, 16, y);
          y += lines.length * 4.5 + 2;
        }
        y += 4;
      }
      doc.save(`audit-${a.nmId}-${Date.now()}.pdf`);
    }
  }

  /**
   * PDF-brief специально для дизайнера/фотографа. Содержит ТОЛЬКО визуальные
   * секции + текстовое наполнение (УТП, копирайт на фото). SEO/перспективы/
   * scoring-таблица сюда НЕ попадают.
   *
   * Дозапрашивает УТП + copy через /photo-brief-enrich если их нет в finalJson.
   */
  async function downloadPhotoBriefPdf(a: AuditDetail) {
    const doc = new jsPDF();
    try {
      const [fontResp, boldResp] = await Promise.all([
        fetch('/fonts/DejaVuSans.ttf'),
        fetch('/fonts/DejaVuSans-Bold.ttf'),
      ]);
      const [fontBuf, boldBuf] = await Promise.all([fontResp.arrayBuffer(), boldResp.arrayBuffer()]);
      const toBase64 = (buf: ArrayBuffer) => {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      };
      doc.addFileToVFS('DejaVuSans.ttf', toBase64(fontBuf));
      doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
      doc.addFileToVFS('DejaVuSans-Bold.ttf', toBase64(boldBuf));
      doc.addFont('DejaVuSans-Bold.ttf', 'DejaVu', 'bold');
      doc.setFont('DejaVu', 'normal');
    } catch {}

    // Enrich via Haiku (USPs + photo copy + video script + prohibited)
    type Enrichment = {
      usps: string[];
      photoCopy: Array<{ photoIndex: number | null; role: string; overlayTitle?: string | null; overlayBullets?: string[]; caption?: string | null }>;
      videoScript?: string | null;
      prohibitedList: string[];
    };
    let enrichment: Enrichment | null = null;
    try {
      const auditId = (a as { auditId?: number; id?: number }).auditId ?? (a as { id?: number }).id;
      if (auditId) {
        const shopQs = shopParam ? `?${shopParam.slice(1)}` : '';
        const res = (await apiFetch(`/creative-audit/${workspaceId}/${auditId}/photo-brief-enrich${shopQs}`, { method: 'POST' })) as { ok: boolean; enrichment?: Enrichment };
        if (res.ok && res.enrichment) enrichment = res.enrichment;
      }
    } catch (e) {
      console.warn('photo brief enrichment failed, continuing without it', e);
    }

    const photos = v3(a, 'photos', {});
    const detailedPhotos: any[] = photos.detailedPhotos ?? photos.detailed_photos ?? [];
    const missingFrames: unknown[] = photos.gallery?.missingFrames ?? photos.gallery?.missing_frames ?? [];
    const videoRec = photos.videoRecommendation ?? photos.video_recommendation;
    const photoScore = v3(a, 'photos.firstImage.score', v3(a, 'photoScore', 0));

    const MISSING_FRAME_LABELS: Record<string, string> = {
      infographic: 'Инфографика с УТП',
      lifestyle: 'Lifestyle / товар в использовании',
      scale: 'Масштаб (товар рядом с эталоном)',
      detail: 'Деталь / макро на текстуру',
      packaging: 'Упаковка в раскрытом виде',
      back: 'Вид сзади',
      video: 'Видео-демонстрация',
    };

    // Cover
    doc.setFontSize(20);
    doc.setFont('DejaVu', 'bold');
    doc.text('ТЗ для дизайнера (фото)', 14, 22);
    doc.setFontSize(11);
    doc.setFont('DejaVu', 'normal');
    doc.setTextColor(100, 100, 100);
    doc.text(`Артикул ${(a as any).nmId ?? (a as any).nm_id ?? '—'} · Оценка фото ${typeof photoScore === 'number' ? photoScore + '/100' : '—'}`, 14, 30);
    doc.setTextColor(0, 0, 0);

    let y = 42;

    // Section writer
    const h1 = (title: string) => {
      if (y > 260) { doc.addPage(); y = 20; }
      doc.setFontSize(14);
      doc.setFont('DejaVu', 'bold');
      doc.setTextColor(60, 60, 180);
      doc.text(title, 14, y); y += 8;
      doc.setTextColor(0, 0, 0);
      doc.setFontSize(10);
      doc.setFont('DejaVu', 'normal');
    };
    const para = (text: string, indent = 14) => {
      const lines = doc.splitTextToSize(String(text), 200 - indent);
      if (y + lines.length * 4.8 > 280) { doc.addPage(); y = 20; }
      doc.text(lines, indent, y);
      y += lines.length * 4.8 + 2;
    };
    const bullet = (text: string, indent = 16) => {
      const lines = doc.splitTextToSize(`• ${text}`, 200 - indent);
      if (y + lines.length * 4.8 > 280) { doc.addPage(); y = 20; }
      doc.text(lines, indent, y);
      y += lines.length * 4.8 + 1;
    };

    // 1. Product info
    h1('1. О товаре');
    const title = v3(a, 'productTitle', `Артикул ${(a as any).nmId ?? (a as any).nm_id ?? '—'}`);
    para(`Название: ${title}`);
    // Category/brand from card data would require extra fetch; keep placeholder if not in finalJson
    const buyerSummary = v3(a, 'perspectives.buyer.summary', null);
    if (buyerSummary) {
      para(`Что видит покупатель: ${buyerSummary}`, 14);
    }
    y += 3;

    // 2. USPs
    if (enrichment?.usps?.length) {
      h1('2. Ключевые УТП — что ДОЛЖНО звучать на фото');
      enrichment.usps.forEach((u) => bullet(u));
      y += 3;
    }

    // 3. Разбор существующих кадров
    if (detailedPhotos.length) {
      h1('3. Разбор существующих кадров');
      detailedPhotos.forEach((p: any, i: number) => {
        if (y > 255) { doc.addPage(); y = 20; }
        doc.setFont('DejaVu', 'bold');
        const score = typeof p.score === 'number' ? p.score : '—';
        doc.text(`Фото #${i + 1} — ${score}/100${p.role ? ` · ${p.role}` : ''}`, 14, y); y += 6;
        doc.setFont('DejaVu', 'normal');

        if (p.summary || p.analysis || p.notes) para(String(p.summary ?? p.analysis ?? p.notes));
        if (Array.isArray(p.issues) && p.issues.length) {
          doc.setFont('DejaVu', 'bold');
          doc.text('Проблемы:', 16, y); y += 5;
          doc.setFont('DejaVu', 'normal');
          p.issues.slice(0, 5).forEach((iss: any) => bullet(typeof iss === 'string' ? iss : String(iss.text ?? iss)));
        }
        if (Array.isArray(p.recommendations) && p.recommendations.length) {
          doc.setFont('DejaVu', 'bold');
          doc.text('Что улучшить:', 16, y); y += 5;
          doc.setFont('DejaVu', 'normal');
          p.recommendations.slice(0, 5).forEach((r: any) => bullet(typeof r === 'string' ? r : String(r.text ?? r)));
        }

        // Text overlay suggestions from enrichment
        const pc = enrichment?.photoCopy?.find((c) => c.photoIndex === i);
        if (pc && (pc.overlayTitle || pc.overlayBullets?.length || pc.caption)) {
          doc.setFont('DejaVu', 'bold');
          doc.setTextColor(30, 120, 50);
          doc.text('Рекомендуемый текст на фото:', 16, y); y += 5;
          doc.setTextColor(0, 0, 0);
          doc.setFont('DejaVu', 'normal');
          if (pc.overlayTitle) bullet(`Заголовок: ${pc.overlayTitle}`);
          if (pc.overlayBullets?.length) bullet(`Bullet-фразы: ${pc.overlayBullets.join(' · ')}`);
          if (pc.caption) bullet(`Подпись: ${pc.caption}`);
        }
        y += 2;
      });
    }

    // 4. Отсутствующие кадры
    if (missingFrames.length) {
      h1('4. Недостающие кадры — нужно снять / сгенерировать');
      missingFrames.forEach((frame: unknown) => {
        if (y > 260) { doc.addPage(); y = 20; }
        // Backend иногда отдаёт string ('lifestyle'), иногда объект {role, description, reason}. Раньше выводили `${frame}` → "[object Object]" для объектов.
        const role = typeof frame === 'string'
          ? frame
          : ((frame as any)?.role ?? (frame as any)?.type ?? (frame as any)?.label ?? '');
        const label = MISSING_FRAME_LABELS[role] ?? role ?? 'Не указано';
        const description = typeof frame === 'object' && frame
          ? ((frame as any).description ?? (frame as any).reason ?? (frame as any).text ?? null)
          : null;

        doc.setFont('DejaVu', 'bold');
        doc.text(`• ${label}`, 14, y); y += 5;
        doc.setFont('DejaVu', 'normal');
        if (description) para(description, 18);

        // Copy suggestions from enrichment for this missing role
        const pc = enrichment?.photoCopy?.find((c) => c.photoIndex === null && c.role === role);
        if (pc) {
          if (pc.overlayTitle) para(`Заголовок на фото: «${pc.overlayTitle}»`, 18);
          if (pc.overlayBullets?.length) para(`Bullet-фразы: ${pc.overlayBullets.join(' · ')}`, 18);
          if (pc.caption) para(pc.caption, 18);
        }
        y += 1;
      });
      y += 3;
    }

    // 5. Video — render only if there is actual content. Backend often
    // sends videoRec={} or null, which previously left an empty section
    // header in the PDF that read as a truncation point.
    const videoSummary = typeof videoRec === 'string'
      ? videoRec.trim()
      : (typeof videoRec?.summary === 'string' ? videoRec.summary.trim() : '');
    const videoScript = typeof enrichment?.videoScript === 'string' ? enrichment.videoScript.trim() : '';
    if (videoSummary || videoScript) {
      h1('5. Видео-демонстрация');
      if (videoSummary) para(videoSummary);
      if (videoScript) {
        doc.setFont('DejaVu', 'bold');
        doc.text('Скрипт (15-30 сек):', 14, y); y += 5;
        doc.setFont('DejaVu', 'normal');
        para(videoScript);
      }
      y += 2;
    }

    // 6. Tone of voice / мудборд
    h1('6. Стиль и атмосфера');
    const mood = v3(a, 'photos.firstImage.mood', null) ?? v3(a, 'perspectives.buyer.summary', null);
    if (mood) para(`Настроение: ${mood}`);
    else para('Натуральное освещение, чёткий фокус на товаре, без посторонних элементов в кадре. Стиль близкий к текущему hero-фото с улучшениями по замечаниям выше.');
    y += 2;

    // 7. Запрещёнка
    const prohibited = enrichment?.prohibitedList ?? [
      'Блики и пересветы, закрывающие текстуру',
      'Водяные знаки других магазинов (Ozon, Яндекс.Маркет и др.)',
      'Посторонние предметы в кадре',
      'Избыточный Photoshop — товар должен выглядеть как в руках',
    ];
    h1('7. Что НЕ должно быть на фото');
    prohibited.forEach((p) => bullet(p));
    y += 2;

    // 8. WB рекомендации
    h1('8. Технические рекомендации WB');
    bullet('Минимум 450×600 px, максимум 8000×8000. Оптимум для zoom: 2000×2000+');
    bullet('Формат: JPG, PNG, BMP. До 32 МБ на файл');
    bullet('Аспект: 1:1 для большинства категорий, 3:4 для одежды/обуви/аксессуаров');
    bullet('Без водяных знаков других площадок');
    bullet('Белый фон НЕ обязателен — можно контекстный, главное без визуального мусора');
    y += 2;

    // 9. Deliverables
    h1('9. Что нужно сдать');
    const totalNeeded = detailedPhotos.length + missingFrames.length;
    bullet(`Всего кадров: ${totalNeeded} (${detailedPhotos.length} на замену/доработку + ${missingFrames.length} новых)`);
    if (videoRec || enrichment?.videoScript) bullet('Видео-ролик 15-30 сек');
    bullet('Формат ZIP-архивом, в названиях файлов — роль кадра (main_1.jpg, infographic_1.jpg, lifestyle_1.jpg и т.д.)');

    doc.save(`audit-photo-brief-${(a as any).nmId ?? (a as any).nm_id ?? 'unknown'}-${Date.now()}.pdf`);
  }

  async function handleFix(fixType: FixType) {
    if (!audit) return;
    setFixLoading(fixType);
    try {
      const res = (await apiFetch(`/creative-audit/${workspaceId}/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nmId: audit.nmId, fixType, auditContext: audit.summary ?? v3(audit, 'verdict.summary', ''), ...(shopId ? { shopId } : {}) }),
      })) as { original: string; improved: string; fixType: string };
      setFixPreview({ fixType: res.fixType, original: res.original, improved: res.improved });
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setFixLoading(null);
    }
  }

  async function handleApplyFix() {
    if (!fixPreview || !audit) return;
    setApplyingFix(true);
    try {
      await apiFetch(`/creative-audit/${workspaceId}/apply-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nmId: audit.nmId, fixType: fixPreview.fixType, improved: fixPreview.improved, ...(shopId ? { shopId } : {}) }),
      });
      setFixPreview(null);
      setError('Изменение применено');
      setTimeout(() => setError(null), 3000);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setApplyingFix(false);
    }
  }

  /* ─── Phase 3: Apply Recommendations ─── */
  async function handleApplyRecommendations() {
    if (!audit) return;
    // applyFields-стейт может ещё не успеть обновиться (React batches setState).
    // Поэтому источник истины — содержимое textarea: непустой текст = применяем.
    const titleText = applyTitleText.trim();
    const descText = applyDescText.trim();
    const hasTitle = titleText.length > 0;
    const hasDesc = descText.length > 0;
    if (!hasTitle && !hasDesc) {
      setError('Введите хотя бы одно из полей (заголовок или описание).');
      return;
    }
    setApplyingRecommendations(true);
    try {
      const res = await apiFetch(`/creative-audit/${workspaceId}/${audit.auditId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applyTitle: hasTitle,
          applyDescription: hasDesc,
          applyCharacteristics: [],
          overrideTitle: hasTitle ? titleText : undefined,
          overrideDescription: hasDesc ? descText : undefined,
          ...(shopId ? { shopId } : {}),
        }),
      });
      setShowApplyDialog(false);
      setError(`✅ Рекомендации применены! Эксперимент #${(res as any).experimentId}`);
      setTimeout(() => setError(null), 5000);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // Stale audit в sessionStorage — БД его уже не помнит. Чистим store
      // и просим выбрать актуальный аудит из списка.
      if (/Audit not found|not_found/.test(msg)) {
        useCreativeAuditStore.getState().clear();
        setError('Этот аудит устарел или удалён. Выберите актуальный из списка слева.');
        await loadList();
      } else {
        setError(msg);
      }
    } finally {
      setApplyingRecommendations(false);
    }
  }

  // loadExperiments / handleRevertExperiment удалены 2026-05-27 — UI был
  // спрятан под `{false && ...}` (см. историю), эти handler'ы стали orphan'ами.

  async function handleCreateTask(role: string, taskIndex: number, taskText: string) {
    if (!audit) return;
    try {
      const res = await apiFetch(`/creative-audit/${workspaceId}/${audit.auditId}/create-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tasks: [{ role, taskIndex, dueInDays: 7 }],
          ...(shopId ? { shopId } : {}),
        }),
      });
      const created = (res as any).createdTasks ?? [];
      if (created.length > 0) {
        setError(`✅ Задача создана: ${created[0].title}`);
        setTimeout(() => setError(null), 4000);
      }
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  /* ─── Bulk Audit ─── */
  async function runBulkAudit() {
    if (!workspaceId || !bulkNmIds.trim()) return;

    // Parse nmIds from textarea (comma, newline, or space separated)
    const nmIds = bulkNmIds
      .split(/[\s,\n]+/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n > 0);

    if (nmIds.length === 0) {
      setError('Введите хотя бы один артикул');
      return;
    }

    if (nmIds.length > 50) {
      setError('Максимум 50 карточек за раз');
      return;
    }

    setBulkLoading(true);
    setBulkResults(null);
    setBulkProgress(0);
    setError(null);

    // Simulate progress
    const progressInterval = setInterval(() => {
      setBulkProgress((p) => Math.min(p + 100 / nmIds.length / 2, 95));
    }, 1000);

    try {
      const res = await apiFetch(`/creative-audit/${workspaceId}/bulk-audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nmIds, concurrency: 3, ...(shopId ? { shopId } : {}) }),
      }) as BulkAuditResult & { ok: boolean };

      setBulkResults(res);
      setBulkProgress(100);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      clearInterval(progressInterval);
      setBulkLoading(false);
    }
  }

  function potentialColor(potential: 'high' | 'medium' | 'low'): string {
    if (potential === 'high') return 'text-red-600 bg-red-50';
    if (potential === 'medium') return 'text-amber-700 bg-amber-50';
    return 'text-green-700 bg-green-50';
  }

  function potentialLabel(potential: 'high' | 'medium' | 'low'): string {
    if (potential === 'high') return 'Высокий';
    if (potential === 'medium') return 'Средний';
    return 'Низкий';
  }

  /* ─── V3 Verdict Card ─── */
  function VerdictCard() {
    if (!audit || !isV3Audit(audit)) return null;
    const verdict = v3(audit, 'finalVerdict', v3(audit, 'verdict', {}));
    const score = audit.overallScore ?? audit.score ?? v3(audit, 'verdict.score', 0);
    const cardScore = audit.cardScore ?? v3(audit, 'scores.cardScore', v3(audit, 'verdict.cardScore', '—'));
    const photoScore = audit.photoScore ?? v3(audit, 'scores.photoScore', v3(audit, 'verdict.photoScore', '—'));
    const confidence = audit.confidence ?? v3(audit, 'verdict.confidence', v3(audit, 'scores.confidence', '—'));
    // Главное фото товара — берём из photos.firstImage.imageUrl. Дополнительно
    // проверяем gallery/detailedPhotos, если firstImage пуст.
    const photoUrl: string | null =
      v3(audit, 'photos.firstImage.imageUrl', null)
      ?? v3(audit, 'photos.gallery.main', null)
      ?? (Array.isArray(v3(audit, 'photos.detailedPhotos', null)) ? v3(audit, 'photos.detailedPhotos.0.imageUrl', null) : null);
    const wbHref = `https://www.wildberries.ru/catalog/${audit.nmId}/detail.aspx`;

    return (
      <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-6 border">
        <div className="flex items-center justify-between gap-6 flex-wrap">
          {/* Левая часть: фото + ссылка на товар */}
          <div className="flex items-center gap-4">
            {photoUrl ? (
              <a href={wbHref} target="_blank" rel="noopener noreferrer" className="block shrink-0">
                <img
                  src={photoUrl}
                  alt="Товар"
                  className="w-20 h-20 rounded-lg object-cover border border-gray-200 bg-white hover:opacity-90 transition-opacity"
                  loading="lazy"
                />
              </a>
            ) : (
              <a href={wbHref} target="_blank" rel="noopener noreferrer"
                 className="w-20 h-20 rounded-lg border border-dashed border-gray-300 bg-white flex items-center justify-center text-[10px] text-gray-400 shrink-0 hover:bg-gray-50">
                нет фото
              </a>
            )}
            <div className="flex flex-col gap-1">
              <a href={wbHref} target="_blank" rel="noopener noreferrer"
                 className="text-sm font-semibold text-blue-600 hover:underline inline-flex items-center gap-1">
                Открыть на WB <ExternalLink className="w-3 h-3" />
              </a>
              <span className="text-xs text-[var(--content-muted)] font-mono">арт. {audit.nmId}</span>
            </div>
          </div>

          {/* Правая часть: общая оценка + карточка/фото */}
          <div className="flex items-center gap-4">
            <div className="flex gap-4">
              <div className="text-center">
                <div className="text-xs text-gray-500">Карточка</div>
                <div className="text-xl font-bold">{cardScore}</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-500">Фото</div>
                <div className="text-xl font-bold">{photoScore}</div>
              </div>
            </div>
            <div className={`w-20 h-20 rounded-full flex items-center justify-center text-2xl font-bold text-white ${
              score >= 70 ? 'bg-green-500' : score >= 40 ? 'bg-amber-500' : 'bg-red-500'
            }`}>
              {score}
            </div>
          </div>
        </div>
        {verdict.summary && <p className="mt-4 text-sm">{verdict.summary}</p>}
        {verdict.mainProblem && (
          <div className="mt-2 px-3 py-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            Главная проблема: {verdict.mainProblem}
          </div>
        )}
      </div>
    );
  }

  /* ─── V3 Tab Content Router ─── */
  function V3TabContent() {
    if (!audit) return null;
    switch (v3Tab) {
      case 'overview': return <OverviewTab
        audit={audit}
        editTitle={applyTitleText}
        editDescription={applyDescText}
        onEditTitle={setApplyTitleText}
        onEditDescription={setApplyDescText}
        // Без отдельной модалки — применяем прямо тем, что в textarea.
        // applyFields выводим из непустоты полей: пустое = не трогаем.
        onApplyClick={() => {
          setApplyFields({
            title: applyTitleText.trim().length > 0,
            description: applyDescText.trim().length > 0,
          });
          handleApplyRecommendations();
        }}
      />;
      case 'checklist': return <ChecklistTab audit={audit} handleFix={handleFix} fixLoading={fixLoading} />;
      case 'photos': return <PhotosTab audit={audit} />;
      case 'seo': return <SeoTab audit={audit} />;
      default: return null;
    }
  }

  return (
    <AppShell title="Аудит карточки">
      <Paywall workspaceId={workspaceId} feature="Creative Audit">
        <div className="p-6 space-y-6">
          <ErrorBanner error={error} onDismiss={() => setError(null)} />
          {progress && (
            <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-800 flex items-center gap-2">
              <svg className="h-4 w-4 animate-spin text-blue-600 shrink-0" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
                <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
              <span>{progress}</span>
            </div>
          )}

          {/* Main tabs: New / History */}
          <div className="flex gap-2 mb-6">
            <button
              onClick={() => setActiveTab('new')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'new'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-[var(--card-bg)] text-[var(--content-muted)] hover:text-[var(--content-text)] border border-[var(--card-border)]'
              }`}
            >
              Новый аудит
            </button>
            <button
              onClick={() => { if (!auditing) { setActiveTab('history'); loadList(); } }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                auditing
                  ? 'bg-[var(--card-bg)] text-[var(--content-muted)] opacity-50 cursor-not-allowed border border-[var(--card-border)]'
                  : activeTab === 'history'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-[var(--card-bg)] text-[var(--content-muted)] hover:text-[var(--content-text)] border border-[var(--card-border)]'
              }`}
              title={auditing ? 'Дождитесь завершения аудита' : undefined}
            >
              История {list.length > 0 && `(${list.length})`}
            </button>
          </div>

          {activeTab === 'new' && (
            <>
              <Card className="p-4">
                <div className="text-sm font-semibold text-[var(--content-text)]">1 бесплатный аудит карточки</div>
                <div className="mt-2 text-xs text-[var(--content-muted)]">
                  Введите артикул карточки WB и получите чек-лист улучшений.
                </div>
              </Card>

              <Card className="p-4">
                <div className="text-sm font-semibold text-[var(--content-text)]">Запуск аудита</div>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-[var(--content-muted)]">Выберите товар</label>
                    <ProductSearchInput
                      workspaceId={workspaceId}
                      value={nmId}
                      onChange={setNmId}
                      single
                      placeholder="Поиск товара..."
                      className="w-[300px]"
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={() => { void runAudit(); }}
                    loading={loading}
                    disabled={false}
                  >
                    Запустить аудит
                  </Button>
                </div>
                {error ? <div className="mt-2 text-xs text-red-500">{error}</div> : null}

                {/* Progress indicator */}
                {auditing && (
                  <div className="mt-4 space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
                      <span className="text-sm">
                        {auditProgress === 1 && 'Этап 1/3: Анализ текста и SEO...'}
                        {auditProgress === 2 && 'Этап 2/3: Анализ фотографий...'}
                        {auditProgress === 3 && 'Этап 3/3: Синтез Action Plan...'}
                      </span>
                    </div>
                    <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-indigo-500 rounded-full transition-all duration-1000"
                        style={{ width: `${(auditProgress / 3) * 100}%` }}
                      />
                    </div>
                  </div>
                )}
              </Card>

              {/* Audit results */}
              {!hasHydrated ? (
                <Card className="p-4 text-center text-sm text-[var(--content-muted)]">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                  Загрузка...
                </Card>
              ) : audit && !auditing ? (
                <div className="space-y-4">
                  {/* Header card */}
                  <Card className="p-4">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="text-sm font-semibold text-[var(--content-text)]">Результат аудита</div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          onClick={() => downloadPdf(undefined, 'full')}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Скачать PDF
                        </button>
                        <button
                          onClick={() => downloadPdf(undefined, 'photo-brief')}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-indigo-200 text-indigo-700 hover:bg-indigo-50 transition-colors"
                          title="Отдельный PDF только про фото — можно отправлять дизайнеру / фотографу"
                        >
                          📷 ТЗ для дизайнера
                        </button>
                        <button
                          onClick={() => setShowPrompts(true)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-indigo-200 text-indigo-700 hover:bg-indigo-50 transition-colors"
                          title="Готовые промпты для AI-генерации нового контента"
                        >
                          🎨 Промпты
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 text-sm text-[var(--content-muted)]">
                      Артикул: <NmIdLink nmId={audit.nmId} className="font-semibold text-blue-600 hover:underline" />
                    </div>
                  </Card>

                  {isV3Audit(audit) ? (
                    /* ─── V3 Display ─── */
                    <div className="space-y-4">
                      <VerdictCard />

                      {/* V3 sub-tabs */}
                      <div className="overflow-x-auto -mx-6 px-6">
                        <div className="flex gap-2 min-w-max">
                          {V3_TABS.map((tab) => (
                            <button
                              key={tab.key}
                              onClick={() => setV3Tab(tab.key)}
                              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                                v3Tab === tab.key
                                  ? 'bg-indigo-600 text-white'
                                  : 'bg-[var(--card-bg)] text-[var(--content-muted)] hover:text-[var(--content-text)] border border-[var(--card-border)]'
                              }`}
                            >
                              {tab.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <V3TabContent />
                    </div>
                  ) : (
                    /* ─── V1 Display (original) ─── */
                    <div className="space-y-4">
                      <Card className="p-4">
                        <div className="mt-1 text-sm text-[var(--content-muted)]">
                          Оценка: <span className="font-semibold text-[var(--content-text)]">{audit.score ?? '—'} / 100</span>
                        </div>
                        <div className="mt-2 text-xs text-[var(--content-muted)]">{audit.summary ?? '—'}</div>
                      </Card>

                      <Section title="Сильные стороны" items={audit.strengths} />
                      <Section title="Проблемы" items={audit.issues} />
                      <Section title="Быстрые фиксы" items={audit.quickFixes} />
                      <Section title="Контент: что улучшить" items={audit.contentSuggestions} />
                      <Section title="Фотографии" items={audit.photoSuggestions} />
                      <Section title="SEO / поиск" items={audit.seoSuggestions} />
                      {/* Checklist with AI fix buttons */}
                      {audit.checklist?.length > 0 && (
                        <Card className="p-4">
                          <div className="text-sm font-semibold text-[var(--content-text)]">Чек-лист</div>
                          <ul className="mt-2 list-disc pl-5 text-sm text-[var(--content-muted)]">
                            {audit.checklist.map((item: string, i: number) => {
                              const ft = detectFixType(item);
                              return (
                                <li key={`checklist-${i}`} className="flex items-start gap-2 mb-1">
                                  <span className="flex-1">{item}</span>
                                </li>
                              );
                            })}
                          </ul>
                        </Card>
                      )}
                    </div>
                  )}
                </div>
              ) : null}
            </>
          )}

          {activeTab === 'history' && (
            <Card className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-[var(--content-text)]">История аудитов</div>
                {list.length > 0 && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm('Удалить все аудиты? Это действие необратимо.')) return;
                      try {
                        await apiFetch(`/creative-audit/${workspaceId}/all${shopParam ? `?${shopParam.slice(1)}` : ''}`, { method: 'DELETE' });
                        setList([]);
                        setAudit(null);
                        await loadLimits();
                      } catch (e: any) { setError(String(e?.message ?? e)); }
                    }}
                    className="text-xs text-red-500 hover:text-red-700 hover:underline"
                  >
                    Очистить историю
                  </button>
                )}
              </div>
              {list.length === 0 ? (
                <div className="text-xs text-[var(--content-muted)]">Пока нет запусков.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--card-border)]">
                        <th className="text-left py-2 px-3 text-xs font-medium text-[var(--content-muted)]">Дата</th>
                        <th className="text-left py-2 px-3 text-xs font-medium text-[var(--content-muted)]">Артикул</th>
                        <th className="text-left py-2 px-3 text-xs font-medium text-[var(--content-muted)]">Товар</th>
                        <th className="text-left py-2 px-3 text-xs font-medium text-[var(--content-muted)]">Оценка</th>
                        <th className="text-left py-2 px-3 text-xs font-medium text-[var(--content-muted)]">Действия</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((r, idx) => (
                        <tr key={`${(r as unknown as { version?: string | number }).version ?? 'v1'}-${r.auditId ?? (r as unknown as { id?: number }).id ?? idx}`} className="border-b border-[var(--card-border)] last:border-b-0">
                          <td className="py-2 px-3 text-xs text-[var(--content-muted)]">
                            {new Date(r.createdAt).toLocaleDateString('ru-RU')}
                          </td>
                          <td className="py-2 px-3 text-xs font-medium text-[var(--content-text)]"><NmIdLink nmId={r.nmId} /></td>
                          <td className="py-2 px-3 text-xs text-[var(--content-muted)] max-w-[200px] truncate">
                            {r.summary ?? '—'}
                          </td>
                          <td className="py-2 px-3">
                            <span className={`text-xs font-semibold ${
                              (r.score ?? 0) >= 70 ? 'text-green-500' : (r.score ?? 0) >= 40 ? 'text-yellow-500' : 'text-red-500'
                            }`}>
                              {r.score ?? '—'} / 100
                            </span>
                          </td>
                          <td className="py-2 px-3">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={async () => { const id = r.auditId ?? (r as unknown as { id?: number }).id; if (id != null) { await loadAudit(id); setActiveTab('new'); } }}
                                className="p-1.5 rounded-md hover:bg-[var(--card-border)] transition-colors text-[var(--content-muted)] hover:text-[var(--content-text)]"
                                title="Посмотреть"
                              >
                                <Eye className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  const res = (await apiFetch(`/creative-audit/${workspaceId}/${r.auditId}${shopParam ? `?${shopParam.slice(1)}` : ''}`)) as { audit: AuditDetail };
                                  downloadPdf(res.audit);
                                }}
                                className="p-1.5 rounded-md hover:bg-[var(--card-border)] transition-colors text-[var(--content-muted)] hover:text-[var(--content-text)]"
                                title="Скачать PDF"
                              >
                                <Download className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  if (!confirm('Удалить этот аудит?')) return;
                                  try {
                                    const version = (r as any).version ?? 'v1';
                                    const id = r.auditId ?? (r as any).id;
                                    await apiFetch(`/creative-audit/${workspaceId}/${id}?version=${version}${shopParam}`, { method: 'DELETE' });
                                    setList((prev) => prev.filter((item) => (item.auditId ?? (item as any).id) !== id));
                                    if (audit?.auditId === id || (audit as any)?.id === id) setAudit(null);
                                    await loadLimits();
                                  } catch (e: any) { setError(String(e?.message ?? e)); }
                                }}
                                className="p-1.5 rounded-md hover:bg-red-100 transition-colors text-[var(--content-muted)] hover:text-red-600"
                                title="Удалить"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          {/* Bulk Audit Tab removed — legacy массовый скоринг. See git log commit fe3a11b. */}

          {/* Fix preview modal */}
          {fixPreview && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
              <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-xl shadow-xl w-full max-w-lg mx-4 p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-sm font-semibold text-[var(--content-text)]">Предпросмотр исправления</div>
                  <button type="button" onClick={() => setFixPreview(null)} className="p-1 rounded hover:bg-[var(--card-border)] text-[var(--content-muted)]">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="space-y-3">
                  <div>
                    <div className="text-xs font-medium text-[var(--content-muted)] mb-1">Было:</div>
                    <div className="text-sm text-[var(--content-text)] bg-red-500/5 border border-red-500/20 rounded-lg p-3 max-h-32 overflow-y-auto whitespace-pre-wrap">
                      {fixPreview.original || '(пусто)'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-[var(--content-muted)] mb-1">Стало:</div>
                    <div className="text-sm text-[var(--content-text)] bg-green-500/5 border border-green-500/20 rounded-lg p-3 max-h-32 overflow-y-auto whitespace-pre-wrap">
                      {fixPreview.improved || '(пусто)'}
                    </div>
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <button
                    type="button"
                    onClick={() => setFixPreview(null)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--card-border)] text-[var(--content-muted)] hover:text-[var(--content-text)] transition-colors"
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    onClick={handleApplyFix}
                    disabled={applyingFix}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors disabled:opacity-50"
                  >
                    {applyingFix && <Loader2 className="w-3 h-3 animate-spin" />}
                    Применить
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Phase 3: Apply Recommendations Dialog */}
          {showApplyDialog && audit && (() => {
            const titleLen = applyTitleText.length;
            const descLen = applyDescText.length;
            const titleOver = titleLen > 100;
            const descOver = descLen > 5000;
            const titleEmpty = applyFields.title && applyTitleText.trim().length === 0;
            const descEmpty = applyFields.description && applyDescText.trim().length === 0;
            const disabled =
              applyingRecommendations ||
              (!applyFields.title && !applyFields.description) ||
              (applyFields.title && (titleOver || titleEmpty)) ||
              (applyFields.description && (descOver || descEmpty));
            return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
              <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-xl shadow-xl w-full max-w-2xl mx-4 p-5 max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-sm font-semibold text-[var(--content-text)]">🚀 Применить рекомендации</div>
                  <button type="button" onClick={() => setShowApplyDialog(false)} className="p-1 rounded hover:bg-[var(--card-border)] text-[var(--content-muted)]">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-sm text-[var(--content-muted)] mb-4">
                  Отредактируйте тексты перед отправкой на Wildberries. После применения будет создан эксперимент для отслеживания результатов.
                </p>
                <div className="space-y-4 mb-4">
                  <div className="border rounded-lg p-3">
                    <label className="flex items-center gap-3 mb-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={applyFields.title}
                        onChange={(e) => setApplyFields((prev) => ({ ...prev, title: e.target.checked }))}
                        className="w-4 h-4 rounded"
                      />
                      <span className="text-sm font-medium">Заголовок</span>
                      <span className={`ml-auto text-xs ${titleOver ? 'text-red-600' : 'text-[var(--content-muted)]'}`}>
                        {titleLen} / 100
                      </span>
                    </label>
                    <textarea
                      value={applyTitleText}
                      onChange={(e) => setApplyTitleText(e.target.value)}
                      disabled={!applyFields.title}
                      placeholder="Заголовок карточки"
                      rows={2}
                      className={`w-full px-2 py-1.5 text-sm rounded border bg-[var(--card-bg)] resize-y disabled:opacity-50 ${titleOver ? 'border-red-500' : 'border-[var(--card-border)]'}`}
                    />
                    {applyFields.title && titleOver && (
                      <div className="text-xs text-red-600 mt-1">Превышен лимит WB (100 символов).</div>
                    )}
                    {applyFields.title && titleEmpty && (
                      <div className="text-xs text-red-600 mt-1">Заголовок пуст.</div>
                    )}
                  </div>
                  <div className="border rounded-lg p-3">
                    <label className="flex items-center gap-3 mb-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={applyFields.description}
                        onChange={(e) => setApplyFields((prev) => ({ ...prev, description: e.target.checked }))}
                        className="w-4 h-4 rounded"
                      />
                      <span className="text-sm font-medium">Описание</span>
                      <span className={`ml-auto text-xs ${descOver ? 'text-red-600' : 'text-[var(--content-muted)]'}`}>
                        {descLen} / 5000
                      </span>
                    </label>
                    <textarea
                      value={applyDescText}
                      onChange={(e) => setApplyDescText(e.target.value)}
                      disabled={!applyFields.description}
                      placeholder="Описание товара"
                      rows={8}
                      className={`w-full px-2 py-1.5 text-sm rounded border bg-[var(--card-bg)] resize-y disabled:opacity-50 ${descOver ? 'border-red-500' : 'border-[var(--card-border)]'}`}
                    />
                    {applyFields.description && descOver && (
                      <div className="text-xs text-red-600 mt-1">Превышен лимит WB (5000 символов).</div>
                    )}
                    {applyFields.description && descEmpty && (
                      <div className="text-xs text-red-600 mt-1">Описание пустое.</div>
                    )}
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowApplyDialog(false)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--card-border)] text-[var(--content-muted)] hover:text-[var(--content-text)] transition-colors"
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    onClick={handleApplyRecommendations}
                    disabled={disabled}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-purple-600 text-white hover:bg-purple-700 transition-colors disabled:opacity-50"
                  >
                    {applyingRecommendations && <Loader2 className="w-3 h-3 animate-spin" />}
                    Применить на WB
                  </button>
                </div>
              </div>
            </div>
            );
          })()}

          {/* Prompts panel (Task 2) */}
          {showPrompts && audit && workspaceId && (
            <PromptSuggestionsPanel
              nmId={audit.nmId}
              auditId={(audit as { auditId?: number; id?: number }).auditId ?? (audit as { id?: number }).id}
              workspaceId={workspaceId}
              onClose={() => setShowPrompts(false)}
            />
          )}

        </div>
      </Paywall>
    </AppShell>
  );
}
