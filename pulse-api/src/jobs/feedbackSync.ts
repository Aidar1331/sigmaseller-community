/**
 * Feedback / Questions Sync Job
 *
 * Подтягивает свежие отзывы и вопросы со всех активных WB-шопов и upsert-ит
 * в `marketplace_feedback_items`. Раньше синхронизация была только ручной
 * (кнопка «Синхронизировать» на /feedback), из-за чего БД отставала от WB
 * на дни/недели и feedbackAutoReply работать было не с чем.
 *
 * Нормализаторы стянуты по форме с routes/feedback.ts — оба используют один
 * и тот же loose-pick подход, потому что WB периодически меняет поля.
 */

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logJobs as logger } from '../lib/logger.js';
import { marketplaceShops, marketplaceFeedbackItems } from '../db/schema.js';
import { fetchWbFeedbacks, fetchWbQuestions } from '../integrations/wb/feedbacks.js';

// WB API лимит на отзывы/вопросы за один запрос. Документация WB рекомендует
// max 5000, но мы качаем меньшими батчами (200) чтобы не упираться в RPM
// и легче ловить ошибки при разовых сбоях.
const TAKE_PER_REQUEST = 200;
// Окно, за которое подтягиваем УЖЕ отвеченные отзывы, чтобы синкать обратно
// статус is_answered/answer_text/answered_at — если ответили вне Pulse (ЛК ВБ,
// мобильное приложение продавца), наша БД иначе остаётся со старым «без ответа».
const ANSWERED_LOOKBACK_DAYS = 14;

// Pure normalizers вынесены в отдельный файл (без зависимостей от db/env),
// чтобы их можно было покрыть юнит-тестами.
import { normalizeFeedback, normalizeQuestion } from './feedbackSync.normalizers.js';
export { normalizeFeedback, normalizeQuestion };

function extractList(payload: any, path: string[]): any[] {
  let cur: any = payload;
  for (const k of path) {
    if (cur == null) return [];
    cur = cur[k];
  }
  return Array.isArray(cur) ? cur : [];
}

// normalizeFeedback / normalizeQuestion перенесены в feedbackSync.normalizers.ts
// и ре-экспортируются выше.

let isRunning = false;

export async function runFeedbackSync(): Promise<void> {
  if (isRunning) {
    logger.info('feedbackSync already running, skipping');
    return;
  }
  isRunning = true;

  try {
    logger.info('feedbackSync: start');

    const shops = await db
      .select({
        shopId: marketplaceShops.shopId,
        workspaceId: marketplaceShops.workspaceId,
      })
      .from(marketplaceShops)
      .where(
        and(
          eq(marketplaceShops.platform, 'wb'),
          eq(marketplaceShops.isActive, true),
          isNotNull(marketplaceShops.apiKey),
        ),
      );

    let totalReviews = 0;
    let totalQuestions = 0;

    // Unix-секунды за N дней назад (WB v1 ожидает unix timestamp)
    const answeredFrom = Math.floor((Date.now() - ANSWERED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000) / 1000);

    // Race-safe SET для onConflictDoUpdate: исключаем поля статуса ответа,
    // чтобы sync не затёр isAnswered=true / status='answered' / answerText,
    // которые могли быть только что обновлены feedbackAutoReply job'ом.
    // Sync разрешено понижать только если WB сам вернул isAnswered=true.
    const safeStatusSet = (row: any) => ({
      ...row,
      // Берём максимум: true (от sync) или существующее true (от auto-reply)
      isAnswered: sql`${marketplaceFeedbackItems.isAnswered} OR ${row.isAnswered}`,
      // Статус не понижаем: если уже 'answered'/'sent' — оставляем
      status: sql`CASE
        WHEN ${marketplaceFeedbackItems.status} IN ('answered','sent') THEN ${marketplaceFeedbackItems.status}
        ELSE ${row.status}
      END`,
      // answerText не затираем, если уже есть локально, а WB не вернул новый
      answerText: sql`COALESCE(${row.answerText ?? null}, ${marketplaceFeedbackItems.answerText})`,
      syncedAt: new Date(),
    });

    const upsertReview = async (raw: any, workspaceId: number, shopId: number) => {
      const row = normalizeFeedback(raw, workspaceId, shopId);
      if (!row) return false;
      await db
        .insert(marketplaceFeedbackItems)
        .values(row as any)
        .onConflictDoUpdate({
          target: [
            marketplaceFeedbackItems.workspaceId,
            marketplaceFeedbackItems.marketplace,
            marketplaceFeedbackItems.itemType,
            marketplaceFeedbackItems.itemId,
          ],
          set: safeStatusSet(row),
        });
      return true;
    };
    const upsertQuestion = async (raw: any, workspaceId: number, shopId: number) => {
      const row = normalizeQuestion(raw, workspaceId, shopId);
      if (!row) return false;
      await db
        .insert(marketplaceFeedbackItems)
        .values(row as any)
        .onConflictDoUpdate({
          target: [
            marketplaceFeedbackItems.workspaceId,
            marketplaceFeedbackItems.marketplace,
            marketplaceFeedbackItems.itemType,
            marketplaceFeedbackItems.itemId,
          ],
          set: safeStatusSet(row),
        });
      return true;
    };

    for (const shop of shops) {
      try {
        let unanswered = 0;
        let answered = 0;
        let qUnanswered = 0;
        let qAnswered = 0;

        // 1) Свежие неотвеченные отзывы — для auto-reply
        const fbNew = await fetchWbFeedbacks(
          shop.workspaceId,
          { isAnswered: false, take: TAKE_PER_REQUEST, skip: 0 },
          shop.shopId,
        );
        for (const raw of [
          ...extractList(fbNew, ['data', 'feedbacks']),
          ...extractList(fbNew, ['feedbacks']),
          ...extractList(fbNew, ['data']),
        ]) {
          if (await upsertReview(raw, shop.workspaceId, shop.shopId)) {
            unanswered++; totalReviews++;
          }
        }

        // 2) Отвеченные за окно — чтобы в БД догонять статус и текст ответа,
        //    если ответили вне Pulse (мобильное ЛК, веб-кабинет).
        const fbDone = await fetchWbFeedbacks(
          shop.workspaceId,
          { isAnswered: true, take: TAKE_PER_REQUEST, skip: 0, dateFrom: answeredFrom },
          shop.shopId,
        );
        for (const raw of [
          ...extractList(fbDone, ['data', 'feedbacks']),
          ...extractList(fbDone, ['feedbacks']),
          ...extractList(fbDone, ['data']),
        ]) {
          if (await upsertReview(raw, shop.workspaceId, shop.shopId)) {
            answered++; totalReviews++;
          }
        }

        // 3) Вопросы — те же два прохода
        const qNew = await fetchWbQuestions(
          shop.workspaceId,
          { isAnswered: false, take: TAKE_PER_REQUEST, skip: 0 },
          shop.shopId,
        );
        for (const raw of [
          ...extractList(qNew, ['data', 'questions']),
          ...extractList(qNew, ['questions']),
          ...extractList(qNew, ['data']),
        ]) {
          if (await upsertQuestion(raw, shop.workspaceId, shop.shopId)) {
            qUnanswered++; totalQuestions++;
          }
        }
        const qDone = await fetchWbQuestions(
          shop.workspaceId,
          { isAnswered: true, take: TAKE_PER_REQUEST, skip: 0, dateFrom: answeredFrom },
          shop.shopId,
        );
        for (const raw of [
          ...extractList(qDone, ['data', 'questions']),
          ...extractList(qDone, ['questions']),
          ...extractList(qDone, ['data']),
        ]) {
          if (await upsertQuestion(raw, shop.workspaceId, shop.shopId)) {
            qAnswered++; totalQuestions++;
          }
        }

        logger.info(
          { shopId: shop.shopId, unanswered, answered, qUnanswered, qAnswered },
          'feedbackSync: shop done',
        );
      } catch (err) {
        logger.error({ err, shopId: shop.shopId }, 'feedbackSync: shop failed');
      }
    }

    logger.info({ totalReviews, totalQuestions, shops: shops.length }, 'feedbackSync: done');
  } finally {
    isRunning = false;
  }
}
