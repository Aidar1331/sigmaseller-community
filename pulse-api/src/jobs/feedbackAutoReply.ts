/**
 * Feedback Auto-Reply Job
 *
 * Automatically generates AI replies for new feedbacks and questions.
 * Runs every 2 hours.
 *
 * Improvements 2026-05-24:
 *  - Window extended from 24h to 7 days (catches backlog of unanswered).
 *  - Per-workspace settings (tone, maxLength, praise/complaint style, signature,
 *    forbidden words, star_5_template) propagated into the AI prompt.
 *  - Knowledge base entries (scope_type=workspace OR matching nmId) merged
 *    into knowledgeContext for grounded answers.
 *  - Each draft creation emits a calendar event into wb_events
 *    (category='review', severity by rating) so user sees it in /events.
 */

import { createHash } from 'node:crypto';
import { eq, and, isNull, desc, sql, gte, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logJobs as logger } from '../lib/logger.js';
import {
  marketplaceFeedbackItems,
  marketplaceReplyDrafts,
  marketplaceReplySettings,
  knowledgeEntries,
  wbEvents,
  wbCards,
} from '../db/schema.js';
import { generateReplyDraft } from '../integrations/ai/feedbacks.js';
import { sendWbFeedbackAnswer, sendWbQuestionAnswer } from '../integrations/wb/feedbacks.js';

const BATCH_SIZE = 10;
// Cap на товары/ws за один прогон. Защита от перерасхода LLM-токенов на
// большом бэклоге (например при первом подключении магазина с тысячами отзывов).
// Остальные подберутся следующим часовым прогоном.
const MAX_PER_WORKSPACE = 100;
// Окно для поиска неотвеченных. 7 дней — после этого WB обычно не позволяет
// ответить (или клиент уже забыл), отвечать бессмысленно.
const LOOKBACK_DAYS = 7;
const LOW_RATING_THRESHOLD = 3; // negative reviews trigger calendar event w/ alert severity

const MIN_REPLY_LENGTH = 20;
const MAX_REPLY_LENGTH = 1500;
// Regex для запрещённых паттернов в ответе (правила WB: нельзя ссылки,
// контакты, промокоды). Применяем перед отправкой; если паттерн найден —
// ответ НЕ улетает, остаётся как draft, продавец проверит сам.
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/i, label: 'ссылка' },
  { pattern: /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i, label: 'email' },
  { pattern: /(?:\+7|7|8)[\s\-(]*\d{3}[\s\-)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/, label: 'телефон' },
  { pattern: /@[a-z0-9_]{4,}\b/i, label: 'telegram/instagram-юзернейм' },
  { pattern: /\b(?:промокод|купон|скидк[аи]\s*\d|кэшбэк|cashback)\b/i, label: 'промо/купон' },
];

/**
 * Проверка контента перед auto-send. Возвращает null если ответ безопасен,
 * иначе строку с причиной — её логируем и оставляем как draft.
 */
export function validateReplyContent(text: string): string | null {
  const t = (text ?? '').trim();
  if (t.length < MIN_REPLY_LENGTH) return `слишком короткий (${t.length} < ${MIN_REPLY_LENGTH})`;
  if (t.length > MAX_REPLY_LENGTH) return `слишком длинный (${t.length} > ${MAX_REPLY_LENGTH})`;
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    if (pattern.test(t)) return `обнаружено: ${label}`;
  }
  return null;
}

// Simple in-memory mutex to prevent concurrent runs
let isRunning = false;

type WorkspaceSettings = typeof marketplaceReplySettings.$inferSelect;

export async function runFeedbackAutoReply(): Promise<void> {
  if (isRunning) {
    logger.info('already running, skipping');
    return;
  }
  isRunning = true;

  try {
    logger.info('starting auto-reply job');

    const settings = await db
      .select()
      .from(marketplaceReplySettings);

    if (settings.length === 0) {
      logger.info('no settings configured');
      return;
    }

    const settingsByWorkspace = new Map<number, WorkspaceSettings[]>();
    for (const s of settings) {
      const list = settingsByWorkspace.get(s.workspaceId) || [];
      list.push(s);
      settingsByWorkspace.set(s.workspaceId, list);
    }

    let totalProcessed = 0;
    let totalDrafts = 0;
    let totalSent = 0;
    let totalEvents = 0;

    for (const [workspaceId, workspaceSettings] of settingsByWorkspace) {
      try {
        const result = await processWorkspace(workspaceId, workspaceSettings);
        totalProcessed += result.processed;
        totalDrafts += result.drafts;
        totalSent += result.sent;
        totalEvents += result.events;
      } catch (err) {
        logger.error({ err, workspaceId }, 'error processing workspace');
      }
    }

    logger.info({ totalProcessed, totalDrafts, totalSent, totalEvents }, 'auto-reply completed');
  } finally {
    isRunning = false;
  }
}

/**
 * Load the WB card to feed the AI with product-specific context: title,
 * description, brand, subject, key characteristics. AI uses this to answer
 * factually instead of inventing details about the product.
 *
 * Returns "" if card not found (item has no nmId or card not synced).
 */
async function loadProductCardContext(workspaceId: number, nmId: number | null): Promise<string> {
  if (nmId == null) return '';

  const cards = await db
    .select({
      title: wbCards.title,
      brandName: wbCards.brandName,
      subjectName: wbCards.subjectName,
      vendorCode: wbCards.vendorCode,
      raw: wbCards.raw,
    })
    .from(wbCards)
    .where(and(eq(wbCards.workspaceId, workspaceId), eq(wbCards.nmId, nmId)))
    .limit(1);

  if (cards.length === 0) return '';
  const card = cards[0];
  const raw = (card.raw ?? {}) as Record<string, any>;

  const lines: string[] = [];
  if (card.title) lines.push(`Название: ${card.title}`);
  if (card.brandName) lines.push(`Бренд: ${card.brandName}`);
  if (card.subjectName) lines.push(`Категория: ${card.subjectName}`);
  if (card.vendorCode) lines.push(`Артикул продавца: ${card.vendorCode}`);

  // Description from raw card (first 600 chars to keep prompt compact)
  if (typeof raw.description === 'string' && raw.description.trim()) {
    lines.push(`Описание товара: ${raw.description.slice(0, 600)}`);
  }

  // Key characteristics — limit to first 12 to avoid bloating the prompt
  if (Array.isArray(raw.characteristics) && raw.characteristics.length > 0) {
    const chars = raw.characteristics
      .slice(0, 12)
      .map((c: any) => {
        const name = c?.name ?? '';
        const value = Array.isArray(c?.value) ? c.value.join(', ') : c?.value;
        if (!name || value == null || value === '') return null;
        return `  - ${name}: ${value}`;
      })
      .filter(Boolean)
      .join('\n');
    if (chars) lines.push(`Характеристики:\n${chars}`);
  }

  return lines.join('\n');
}

/**
 * Load workspace-level + product-level knowledge entries and merge into a
 * single text block to ground the AI answer. nmIds[] filtering keeps it
 * compact (only entries linked to this product OR to the whole workspace).
 */
async function loadKnowledgeContext(workspaceId: number, nmId: number | null): Promise<string> {
  const entries = await db
    .select({
      title: knowledgeEntries.title,
      content: knowledgeEntries.content,
      entryType: knowledgeEntries.entryType,
      category: knowledgeEntries.category,
      nmIds: knowledgeEntries.nmIds,
      priority: knowledgeEntries.priority,
    })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.workspaceId, workspaceId),
        eq(knowledgeEntries.isActive, true),
      ),
    )
    .orderBy(desc(knowledgeEntries.priority))
    .limit(40);

  // Filter: keep workspace-level entries (empty nmIds) and entries linked to this product
  const relevant = entries.filter((e) => {
    const ids = Array.isArray(e.nmIds) ? (e.nmIds as unknown[]) : [];
    if (ids.length === 0) return true;
    if (nmId == null) return false;
    return ids.includes(nmId);
  });

  if (relevant.length === 0) return '';

  return relevant
    .map((e) => {
      const tag = e.category ?? e.entryType ?? 'info';
      return `[${tag}] ${e.title}: ${e.content}`;
    })
    .join('\n');
}

function reviewEventFingerprint(workspaceId: number, itemId: string): string {
  return `review:autoreply:${workspaceId}:${itemId}`;
}

/**
 * Emit a wb_events row when a draft is created — so the user sees the new
 * review in /events Calendar with a quick link to the approve UI. For
 * negative reviews (rating ≤ 3) severity='warn' so it shows up in critical
 * events push notifications too.
 */
async function emitReviewEvent(args: {
  workspaceId: number;
  shopId: number | null;
  nmId: number | null;
  productTitle: string | null;
  itemId: string;
  itemType: 'review' | 'question';
  rating: number | null;
  text: string | null;
  draftConfidence: number;
  willAutoSend: boolean;
}): Promise<boolean> {
  const fingerprint = reviewEventFingerprint(args.workspaceId, args.itemId);

  // Check existence first (partial unique index — same pattern as bridge)
  const existing = await db
    .select({ eventId: wbEvents.eventId })
    .from(wbEvents)
    .where(and(eq(wbEvents.workspaceId, args.workspaceId), eq(wbEvents.fingerprint, fingerprint)))
    .limit(1);
  if (existing.length > 0) return false;

  const today = new Date().toISOString().slice(0, 10);
  const isNegative = args.rating != null && args.rating <= LOW_RATING_THRESHOLD;
  const severity = isNegative ? 'warn' : 'info';
  const type = isNegative ? 'alert' : 'log';
  const ratingTxt = args.rating != null ? `${'★'.repeat(args.rating)}` : '?';
  const productTxt = args.productTitle ? ` — ${args.productTitle.slice(0, 50)}` : '';
  const kindRu = args.itemType === 'review' ? 'отзыв' : 'вопрос';
  // В заголовок выносим первые 60 символов текста — сразу понятно про что,
  // а не просто «новый отзыв ★★★★★». Если текста нет (пустой отзыв с одной
  // оценкой) — fallback на старый формат.
  const textPreview = args.text ? args.text.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  const titleBase = isNegative
    ? `🔴 Негативный ${kindRu} ${ratingTxt}`
    : `💬 ${kindRu === 'отзыв' ? 'Отзыв' : 'Вопрос'} ${ratingTxt}`;
  const title = textPreview
    ? `${titleBase}: «${textPreview}${args.text && args.text.length > 60 ? '…' : ''}»${productTxt}`
    : `${titleBase}${productTxt}`;

  const description = [
    args.text && args.text.length > 60 ? `Полный текст: ${args.text.slice(0, 240)}${args.text.length > 240 ? '…' : ''}` : null,
    `Черновик ответа подготовил AI (уверенность ${args.draftConfidence}%).`,
    args.willAutoSend
      ? '✓ Будет отправлен автоматически.'
      : 'Открой раздел «Отзывы» — подтверди или поправь ответ.',
  ]
    .filter(Boolean)
    .join(' ');

  try {
    await db.insert(wbEvents).values({
      workspaceId: args.workspaceId,
      shopId: args.shopId ?? null,
      nmId: args.nmId ?? null,
      date: today,
      time: null,
      type,
      category: 'review',
      severity,
      status: 'open',
      priority: isNegative ? 'high' : 'medium',
      title,
      description,
      evidence: {
        source: 'feedbackAutoReply',
        itemType: args.itemType,
        itemId: args.itemId,
        rating: args.rating,
        confidence: args.draftConfidence,
        autoSend: args.willAutoSend,
      },
      tags: [],
      fingerprint,
      source: 'feedback',
      sourceId: args.itemId,
    });
    return true;
  } catch (err) {
    logger.warn({ err, itemId: args.itemId }, 'failed to emit review event (probably race)');
    return false;
  }
}

/**
 * QC escalation: when AI classifies a review as "quality" complaint AND
 * rating is ≤3, emit a `task`-type event for the QC team. This is separate
 * from the regular "new review" event — it's an actionable task with a
 * due date that shows up on the Kanban board, not just a notification.
 *
 * Fingerprint includes 'qc:' prefix so it can coexist with the regular
 * review event for the same itemId.
 */
async function emitQcEscalation(args: {
  workspaceId: number;
  shopId: number | null;
  nmId: number | null;
  productTitle: string | null;
  itemId: string;
  rating: number | null;
  text: string | null;
  category: string;
}): Promise<boolean> {
  const fingerprint = `qc:escalation:${args.workspaceId}:${args.itemId}`;

  const existing = await db
    .select({ eventId: wbEvents.eventId })
    .from(wbEvents)
    .where(and(eq(wbEvents.workspaceId, args.workspaceId), eq(wbEvents.fingerprint, fingerprint)))
    .limit(1);
  if (existing.length > 0) return false;

  const today = new Date().toISOString().slice(0, 10);
  const dueAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 дня на проверку
  const ratingTxt = args.rating != null ? `${args.rating}★` : '?';
  const productTxt = args.productTitle ? ` — ${args.productTitle.slice(0, 60)}` : '';
  const nmTxt = args.nmId ? ` (товар ${args.nmId})` : '';

  try {
    await db.insert(wbEvents).values({
      workspaceId: args.workspaceId,
      shopId: args.shopId ?? null,
      nmId: args.nmId ?? null,
      date: today,
      time: null,
      type: 'task', // not 'alert' — этим QC должен заняться
      category: 'review',
      severity: 'warn',
      status: 'open',
      priority: args.rating != null && args.rating <= 2 ? 'urgent' : 'high',
      title: `🔧 Проверить качество ${ratingTxt}${nmTxt}${productTxt}`,
      description: [
        args.text ? `Жалоба покупателя: «${args.text.slice(0, 280)}${args.text.length > 280 ? '…' : ''}»` : null,
        'AI определил тему жалобы как «качество». Проверьте товар и при необходимости — отзовите партию / уточните QC процесс.',
        `Срок проверки: ${dueAt.toLocaleDateString('ru-RU')}.`,
      ]
        .filter(Boolean)
        .join(' '),
      evidence: {
        source: 'feedbackAutoReply:qc_escalation',
        itemId: args.itemId,
        rating: args.rating,
        category: args.category,
      },
      tags: ['qc', 'качество'],
      fingerprint,
      source: 'feedback',
      sourceId: args.itemId,
      dueAt,
    });
    return true;
  } catch (err) {
    logger.warn({ err, itemId: args.itemId }, 'failed to emit QC escalation task');
    return false;
  }
}

export async function processWorkspace(
  workspaceId: number,
  settings: WorkspaceSettings[],
): Promise<{ processed: number; drafts: number; sent: number; events: number }> {
  let processed = 0;
  let drafts = 0;
  let sent = 0;
  let events = 0;

  for (const setting of settings) {
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    const items = await db
      .select({
        itemId: marketplaceFeedbackItems.itemId,
        nmId: marketplaceFeedbackItems.nmId,
        shopId: marketplaceFeedbackItems.shopId,
        text: marketplaceFeedbackItems.text,
        pros: marketplaceFeedbackItems.pros,
        cons: marketplaceFeedbackItems.cons,
        rating: marketplaceFeedbackItems.rating,
        productTitle: marketplaceFeedbackItems.productTitle,
        brandName: marketplaceFeedbackItems.brandName,
        userName: marketplaceFeedbackItems.userName,
        photosCount: marketplaceFeedbackItems.photosCount,
        hasVideo: marketplaceFeedbackItems.hasVideo,
        isAnswered: marketplaceFeedbackItems.isAnswered,
      })
      .from(marketplaceFeedbackItems)
      .leftJoin(
        marketplaceReplyDrafts,
        and(
          eq(marketplaceReplyDrafts.workspaceId, marketplaceFeedbackItems.workspaceId),
          eq(marketplaceReplyDrafts.itemId, marketplaceFeedbackItems.itemId),
        ),
      )
      .where(
        and(
          eq(marketplaceFeedbackItems.workspaceId, workspaceId),
          eq(marketplaceFeedbackItems.marketplace, setting.marketplace),
          eq(marketplaceFeedbackItems.itemType, setting.itemType),
          eq(marketplaceFeedbackItems.isAnswered, false),
          isNull(marketplaceReplyDrafts.draftId),
          gte(marketplaceFeedbackItems.createdAt, cutoff),
          // Shop scope: settings.shopId=NULL → workspace-wide (all shops),
          // settings.shopId=N → only this shop. Different shops can have
          // different tone/templates/auto-send rules.
          ...(setting.shopId != null ? [eq(marketplaceFeedbackItems.shopId, setting.shopId)] : []),
        ),
      )
      .limit(MAX_PER_WORKSPACE);

    if (items.length === 0) continue;

    logger.info(
      { workspaceId, itemCount: items.length, marketplace: setting.marketplace, itemType: setting.itemType },
      'processing items',
    );

    for (const item of items) {
      try {
        // Per-item context: product card details + knowledge base entries.
        // Both feed into the same knowledgeContext block so the AI has full
        // grounding (real product specs + saved Q&A patterns + brand voice).
        const nmIdNum = item.nmId != null ? Number(item.nmId) : null;
        const [productCardContext, knowledgeRaw] = await Promise.all([
          loadProductCardContext(workspaceId, nmIdNum),
          loadKnowledgeContext(workspaceId, nmIdNum),
        ]);
        const knowledgeContext = [
          productCardContext ? `Карточка товара:\n${productCardContext}` : '',
          knowledgeRaw ? `Знания продавца:\n${knowledgeRaw}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');

        // Build the rich settings object expected by generateReplyDraft
        const draft = await generateReplyDraft({
          itemType: setting.itemType as 'review' | 'question',
          text: item.text || '',
          pros: item.pros,
          cons: item.cons,
          rating: item.rating,
          productTitle: item.productTitle,
          brandName: item.brandName,
          userName: item.userName,
          photosCount: item.photosCount ?? 0,
          hasVideo: item.hasVideo ?? false,
          knowledgeContext: knowledgeContext || undefined,
          settings: {
            tone: setting.tone ?? undefined,
            maxLength: setting.maxLength ?? undefined,
            praiseLevel: (setting.praiseLevel as any) ?? undefined,
            photoBonus: setting.photoBonus ?? undefined,
            star5Template: setting.star5Template ?? undefined,
            complaintStyle: (setting.complaintStyle as any) ?? undefined,
            signature: setting.signature ?? undefined,
            forbiddenWords: Array.isArray(setting.forbiddenWords)
              ? (setting.forbiddenWords as string[])
              : undefined,
          },
          workspaceId,
          itemId: item.itemId,
        });

        if (!draft || !draft.answer) {
          logger.info({ itemId: item.itemId }, 'no draft generated');
          continue;
        }

        // Старые pending-draft'ы для этого item помечаем 'superseded' — чтобы
        // в UI не накапливалась стопка конкурирующих черновиков.
        await db
          .update(marketplaceReplyDrafts)
          .set({ status: 'superseded', updatedAt: new Date() })
          .where(
            and(
              eq(marketplaceReplyDrafts.workspaceId, workspaceId),
              eq(marketplaceReplyDrafts.itemType, setting.itemType),
              eq(marketplaceReplyDrafts.itemId, item.itemId),
              eq(marketplaceReplyDrafts.status, 'draft'),
            ),
          );

        const [draftRow] = await db
          .insert(marketplaceReplyDrafts)
          .values({
            workspaceId,
            shopId: item.shopId ?? null,
            marketplace: setting.marketplace,
            itemType: setting.itemType,
            itemId: item.itemId,
            source: 'ai',
            content: draft.answer,
            confidence: draft.confidence,
            status: 'draft',
            decisionReason: draft.rationale,
            webSources: draft.usedSources || [],
          })
          .returning();

        // Persist AI-inferred category + sentiment back to the source item
        // so the /feedback dashboard can group complaints by theme.
        if (draft.category || draft.sentiment) {
          await db
            .update(marketplaceFeedbackItems)
            .set({
              category: draft.category ?? undefined,
              sentiment: draft.sentiment ?? undefined,
            })
            .where(
              and(
                eq(marketplaceFeedbackItems.workspaceId, workspaceId),
                eq(marketplaceFeedbackItems.itemId, item.itemId),
              ),
            );
        }

        drafts++;

        // Pre-send moderation: проверяем контент на запрещённые паттерны
        // (ссылки, телефоны, email, промокоды). Если найдено — auto-send блокируется,
        // ответ остаётся как draft для ручной проверки продавцом.
        const moderationFail = validateReplyContent(draft.answer);

        const willAutoSend =
          setting.autoSend &&
          !setting.requireApproval &&
          draft.confidence >= setting.minConfidence &&
          (item.rating == null || item.rating >= (setting.autoSendMinRating ?? 4)) &&
          moderationFail == null;

        if (moderationFail && setting.autoSend && !setting.requireApproval) {
          logger.warn(
            { itemId: item.itemId, reason: moderationFail },
            'auto-send blocked by content moderation — left as draft',
          );
        }

        // Emit calendar event so the user sees this in /events
        const eventEmitted = await emitReviewEvent({
          workspaceId,
          shopId: item.shopId ?? null,
          nmId: item.nmId != null ? Number(item.nmId) : null,
          productTitle: item.productTitle,
          itemId: item.itemId,
          itemType: setting.itemType as 'review' | 'question',
          rating: item.rating ?? null,
          text: item.text,
          draftConfidence: draft.confidence,
          willAutoSend,
        });
        if (eventEmitted) events++;

        // QC Escalation: AI quality complaint + low rating → task for QC team
        if (
          draft.category === 'quality' &&
          item.rating != null &&
          item.rating <= 3 &&
          setting.itemType === 'review'
        ) {
          await emitQcEscalation({
            workspaceId,
            shopId: item.shopId ?? null,
            nmId: nmIdNum,
            productTitle: item.productTitle,
            itemId: item.itemId,
            rating: item.rating ?? null,
            text: item.text,
            category: draft.category,
          });
        }

        if (willAutoSend) {
          try {
            if (setting.marketplace === 'wb') {
              const shopId = item.shopId ?? null;
              if (setting.itemType === 'review') {
                await sendWbFeedbackAnswer(workspaceId, shopId, item.itemId, draft.answer);
              } else {
                await sendWbQuestionAnswer(workspaceId, shopId, item.itemId, draft.answer);
              }
            }

            await db
              .update(marketplaceReplyDrafts)
              .set({ status: 'sent', sentAt: new Date() })
              .where(eq(marketplaceReplyDrafts.draftId, draftRow.draftId));

            await db
              .update(marketplaceFeedbackItems)
              .set({
                isAnswered: true,
                answerText: draft.answer,
                answeredAt: new Date(),
              })
              .where(
                and(
                  eq(marketplaceFeedbackItems.workspaceId, workspaceId),
                  eq(marketplaceFeedbackItems.itemId, item.itemId),
                ),
              );

            sent++;
            logger.info({ itemId: item.itemId }, 'auto-sent reply');
          } catch (sendErr) {
            logger.error({ err: sendErr, itemId: item.itemId }, 'failed to send reply');
          }
        }

        processed++;

        // Rate limiting (WB API + LLM cost)
        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        logger.error({ err, itemId: item.itemId }, 'error processing item');
      }
    }
  }

  return { processed, drafts, sent, events };
}
