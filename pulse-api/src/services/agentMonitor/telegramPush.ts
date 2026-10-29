// Multi-Agent v2 Phase 6 — Telegram push for critical Monitor events.
//
// Hooks into logSystemEvent and agentEvent inserts. Sends a short Telegram
// message to the workspace-configured chat when severity === 'critical'.
// Respects agent_settings.telegramChatId and telegramCritical flag.

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentSettings } from '../../db/schema.js';
import { sendTelegramMessage } from '../../integrations/telegram.js';
import { logAgent as logger } from '../../lib/logger.js';

export interface CriticalEventPayload {
  workspaceId: number;
  title: string;
  description?: string | null;
  suggestedAction?: string | null;
  eventType: string;
}

export async function pushCriticalToTelegram(payload: CriticalEventPayload): Promise<void> {
  try {
    const [settings] = await db
      .select({ chatId: agentSettings.telegramChatId, criticalOn: agentSettings.telegramCritical })
      .from(agentSettings)
      .where(eq(agentSettings.workspaceId, payload.workspaceId))
      .limit(1);

    if (!settings?.chatId || !settings.criticalOn) return;

    const lines = [
      `🚨 <b>Sigma Seller — критичное событие</b>`,
      `<b>${escapeHtml(payload.title)}</b>`,
      payload.description ? `\n${escapeHtml(payload.description)}` : '',
      payload.suggestedAction ? `\n<i>Рекомендация:</i> ${escapeHtml(payload.suggestedAction)}` : '',
      `\n<code>event_type: ${payload.eventType}</code>`,
    ].filter(Boolean);

    await sendTelegramMessage(settings.chatId, lines.join('\n'), {
      parseMode: 'HTML',
      buttons: [[
        { text: 'Открыть Sigma Seller', url: 'https://seller.wildberries.ru' },
      ]],
    });
  } catch (err) {
    logger.error({ err, payload }, 'telegram push for critical event failed (non-fatal)');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
