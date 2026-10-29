/**
 * Telegram notification service.
 * Sends alerts and briefings to workspace-level Telegram chats.
 */

import { env } from '../../env.js';
import { db } from '../../db/client.js';
import { agentSettings, agentEvents } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

interface SendResult {
  ok: boolean;
  error?: string;
}

async function sendTelegramMessage(chatId: string, text: string, parseMode: 'Markdown' | 'HTML' = 'Markdown'): Promise<SendResult> {
  if (!BOT_TOKEN) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' };

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Telegram API ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Send critical alert to workspace Telegram chat.
 */
export async function sendTelegramAlert(wsId: number, title: string, description: string, severity: string): Promise<SendResult> {
  const [settings] = await db.select().from(agentSettings).where(eq(agentSettings.workspaceId, wsId)).limit(1);
  if (!settings?.telegramChatId || !settings.telegramCritical) {
    return { ok: false, error: 'Telegram not configured or critical alerts disabled' };
  }

  const icon = severity === 'critical' ? '🔴' : severity === 'warning' ? '🟡' : 'ℹ️';
  const text = `${icon} *${title}*\n\n${description}\n\n_Sigma Seller Alert_`;

  return sendTelegramMessage(settings.telegramChatId, text);
}

/**
 * Send morning briefing to workspace Telegram chat.
 */
export async function sendTelegramBriefing(wsId: number, briefingText: string): Promise<SendResult> {
  const [settings] = await db.select().from(agentSettings).where(eq(agentSettings.workspaceId, wsId)).limit(1);
  if (!settings?.telegramChatId || !settings.telegramBriefing) {
    return { ok: false, error: 'Telegram not configured or briefing notifications disabled' };
  }

  const text = `📊 *Утренний брифинг*\n\n${briefingText}\n\n_Sigma Seller AI_`;
  return sendTelegramMessage(settings.telegramChatId, text);
}

/**
 * Send batch of events to Telegram.
 * Used by task monitor to notify about new critical events.
 */
export async function sendTelegramEventBatch(wsId: number, events: Array<{
  title: string;
  severity: string;
  description?: string;
}>): Promise<SendResult> {
  if (events.length === 0) return { ok: true };

  const criticalEvents = events.filter(e => e.severity === 'critical');
  if (criticalEvents.length === 0) return { ok: true };

  const lines = criticalEvents.map(e => {
    const icon = e.severity === 'critical' ? '🔴' : '🟡';
    return `${icon} ${e.title}${e.description ? `\n   ${e.description}` : ''}`;
  });

  const text = `⚠️ *Обнаружено ${criticalEvents.length} критичных событий*\n\n${lines.join('\n\n')}\n\n_Откройте Sigma Seller для подробностей_`;

  return await sendTelegramAlert(wsId, `${criticalEvents.length} критичных алертов`, text, 'critical');
}
