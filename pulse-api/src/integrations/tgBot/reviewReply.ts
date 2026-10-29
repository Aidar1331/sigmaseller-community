import { requireSellerAiKey } from '../../services/sellerAiCredentials.js';
/**
 * AI-generated reply draft for a customer review (rev 25n).
 *
 * Calls Claude Sonnet (copywriting model — quality matters here, not
 * speed) with a tightly-scoped system prompt that bakes in the
 * communication standards: polite, brief, never blame the customer,
 * thank them for any positive note, address the criticism concretely,
 * end with an invitation to contact support.
 *
 * Returns plain text — the calling code wraps it in HTML for Telegram.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../env.js';
import log from '../../lib/logger.js';
import type { PendingReviewRow } from './data.js';

const logger = log.child({ module: 'tgBotReviewReply' });

const SYSTEM_PROMPT = [
  'Ты — менеджер магазина на Wildberries и пишешь публичный ответ на отзыв покупателя.',
  '',
  'ПРИНЦИПЫ',
  '— Тон: уважительный, человечный, без канцелярита и без слащавости.',
  '— Длина: 2–4 коротких предложения, до 400 символов. Никаких заголовков, маркдауна, эмодзи.',
  '— Обращение по имени, если оно есть.',
  '— Если покупатель отметил плюсы — поблагодари за них коротко.',
  '— Если есть конкретная претензия — назови её прямо и скажи, что предпримешь (например: проверим качество с производством, заменим, разберёмся со складом).',
  '— Никогда не спорь, не обвиняй покупателя, не предлагай "написать в личные сообщения" размыто — если зовёшь, дай конкретный канал.',
  '— Заверши предложением помочь: попроси написать в чат продавца на WB с номером заказа.',
  '— Никаких выдуманных компенсаций, никаких скидок, никаких ссылок.',
  '',
  'ВЫХОД: только текст ответа на русском, без префиксов и без подписи.',
].join('\n');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 350;

/**
 * rev 27b: tone shifter for the AI reply draft. Caller passes `tone` and
 * we splice an extra instruction into the prompt accordingly.
 */
export type ReviewReplyTone = 'neutral' | 'softer' | 'firmer' | 'custom';

function toneInstruction(tone: ReviewReplyTone, custom?: string): string {
  switch (tone) {
    case 'softer':
      return 'Тон должен быть мягче обычного — больше эмпатии, признание неудобств, чуть теплее. Не лебезить.';
    case 'firmer':
      return 'Тон должен быть строже и собраннее — без извинений за пустяки, чёткая позиция магазина, корректно но твёрдо.';
    case 'custom':
      return custom ? `Дополнительная инструкция от продавца: «${custom}»` : '';
    case 'neutral':
    default:
      return '';
  }
}

function buildUserMessage(review: PendingReviewRow, tone: ReviewReplyTone, custom?: string): string {
  const lines: string[] = [];
  if (review.productTitle) lines.push(`Товар: ${review.productTitle}`);
  if (review.rating != null) lines.push(`Оценка покупателя: ${review.rating}/5`);
  if (review.userName) lines.push(`Имя покупателя: ${review.userName}`);
  lines.push('');
  lines.push('Текст отзыва:');
  lines.push(review.text || '(пустой)');
  if (review.pros) {
    lines.push('');
    lines.push(`Понравилось: ${review.pros}`);
  }
  if (review.cons) {
    lines.push('');
    lines.push(`Не понравилось: ${review.cons}`);
  }
  const toneNote = toneInstruction(tone, custom);
  if (toneNote) {
    lines.push('');
    lines.push(toneNote);
  }
  lines.push('');
  lines.push('Напиши публичный ответ от лица магазина.');
  return lines.join('\n');
}

/**
 * Generate a single-shot reply draft. No tool-loop — pure text in,
 * text out. Caller should already have rate-limited the user.
 *
 * rev 27b: optional `tone` lets the seller request softer/firmer wording
 * or supply their own custom instruction; default is neutral.
 */
export async function draftReviewReply(
  workspaceId: number,
  review: PendingReviewRow,
  tone: ReviewReplyTone = 'neutral',
  custom?: string,
): Promise<string> {
  const apiKey = await requireSellerAiKey('anthropic', workspaceId);
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  const client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 0 });
  const userMessage = buildUserMessage(review, tone, custom);
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });
  const text = resp.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
    .trim();
  if (!text) {
    logger.warn({ itemId: review.itemId }, 'empty draft from model');
    throw new Error('empty draft');
  }
  return text;
}
