/**
 * Pulse Telegram Bot — entry point.
 *
 * Single grammY bot instance is constructed lazily on first webhook hit
 * and cached for the life of the process. Webhook payloads are handed
 * to `bot.handleUpdate(rawUpdate)` by the existing /telegram/bot-webhook
 * route (after secret-token validation).
 *
 * Outbound messaging from cron jobs / digest functions still uses the
 * older raw-fetch helpers in ../telegram.ts. grammY is for INBOUND
 * (commands, callbacks). Mixing is fine — both speak Telegram Bot API.
 */

import { Bot } from 'grammy';
import { env } from '../../env.js';
import log from '../../lib/logger.js';
import { registerHandlers } from './handlers.js';

const logger = log.child({ module: 'tgBot' });

let _bot: Bot | null = null;
let _initialised = false;

function getBot(): Bot | null {
  if (_bot) return _bot;
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn('TELEGRAM_BOT_TOKEN missing — bot not constructed');
    return null;
  }
  _bot = new Bot(token);
  registerHandlers(_bot);
  return _bot;
}

/**
 * Entry point for the webhook route. Parses raw body into grammY's
 * Update shape and dispatches to handlers. Errors are caught and
 * logged so a malformed update doesn't 5xx the webhook (Telegram retries
 * 5xx aggressively, amplifying any handler bug).
 */
export async function handleTelegramUpdate(update: unknown): Promise<void> {
  const bot = getBot();
  if (!bot) return;
  try {
    if (!_initialised) {
      await bot.init();
      _initialised = true;
    }
    await bot.handleUpdate(update as any);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'bot handleUpdate failed');
  }
}

/**
 * One-off helper to publish the command list to Telegram. Called from
 * server bootstrap once per process; idempotent (Telegram allows
 * resending the same list).
 */
export async function publishBotCommands(): Promise<void> {
  const bot = getBot();
  if (!bot) return;
  try {
    if (!_initialised) {
      await bot.init();
      _initialised = true;
    }
    await bot.api.setMyCommands([
      { command: 'start', description: 'Запуск бота / привязка чата' },
      { command: 'today', description: 'Сводка за сегодня' },
      { command: 'shops', description: 'Магазины' },
      { command: 'alerts', description: 'Активные алёрты' },
      { command: 'seo', description: 'SEO позиции — топ движения' },
      { command: 'feedback', description: 'Отзывы + AI-ответ' },
      { command: 'supplies', description: 'Черновики поставок' },
      { command: 'prices', description: 'Ценовые рекомендации' },
      { command: 'abc', description: 'ABC-анализ ассортимента' },
      { command: 'abtests', description: 'A/B-тесты фотографий' },
      { command: 'unit', description: 'Юнит-экономика по nm_id' },
      { command: 'balance', description: 'Баланс на WB + AI-токены' },
      { command: 'chats', description: 'История чатов с ИИ' },
      { command: 'newchat', description: 'Новый чат с ИИ (сброс контекста)' },
      { command: 'settings', description: 'Настройки уведомлений' },
      { command: 'help', description: 'Помощь и список команд' },
      { command: 'unsub', description: 'Отписаться от рассылок' },
    ]);
    logger.info('bot commands published');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'failed to publish bot commands');
  }
}
