/**
 * Extended Telegram Notifications — 5 notification types for workspace owners.
 *
 * Types:
 * 1. critical_alert — urgent issues (stock OOS, high DRR, margin negative)
 * 2. morning_briefing — daily AI summary
 * 3. acceptance_coeff — warehouse acceptance coefficient changes
 * 4. action_result — result of agent actions (price change, bid change)
 * 5. supply_reminder — supply delivery deadlines
 */

import { sendTelegramMessage } from '../../integrations/telegram.js';
import { db } from '../../db/client.js';
import { notificationSettings, workspaces, workspaceMembers, users } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { log } from '../../lib/logger.js';

type NotificationType = 'critical_alert' | 'morning_briefing' | 'acceptance_coeff' | 'action_result' | 'supply_reminder';

interface NotificationPayload {
  type: NotificationType;
  workspaceId: number;
  title: string;
  body: string;
  severity?: 'critical' | 'warning' | 'info';
  actionUrl?: string;
}

const EMOJI_MAP: Record<NotificationType, string> = {
  critical_alert: '🚨',
  morning_briefing: '☀️',
  acceptance_coeff: '📦',
  action_result: '✅',
  supply_reminder: '🚛',
};

const SEVERITY_EMOJI: Record<string, string> = {
  critical: '🔴',
  warning: '🟡',
  info: '🔵',
};

/**
 * Send a notification to the workspace's configured Telegram chat.
 */
export async function sendWorkspaceNotification(payload: NotificationPayload): Promise<boolean> {
  try {
    // Load notification settings for this workspace
    const [settings] = await db.select()
      .from(notificationSettings)
      .where(eq(notificationSettings.workspaceId, payload.workspaceId))
      .limit(1);

    if (!settings) return false;

    if (!settings.telegramEnabled) return false;
    const telegramChatId = settings.telegramChatId;
    if (!telegramChatId) return false;

    // Map notification types to settings flags
    const typeEnabled: Record<NotificationType, boolean | null | undefined> = {
      critical_alert: settings.notifyAlerts,
      morning_briefing: settings.notifyTasks,
      acceptance_coeff: settings.notifyAlerts,
      action_result: settings.notifyTasks,
      supply_reminder: settings.notifyReminders,
    };
    if (typeEnabled[payload.type] === false) return false;

    // Format message
    const emoji = EMOJI_MAP[payload.type] ?? '📋';
    const sevEmoji = payload.severity ? SEVERITY_EMOJI[payload.severity] ?? '' : '';
    const header = `${emoji} ${sevEmoji} <b>${payload.title}</b>`;
    const text = `${header}\n\n${payload.body}`;

    await sendTelegramMessage(telegramChatId, text, { parseMode: 'HTML' });

    log.info({ type: payload.type, workspaceId: payload.workspaceId }, 'Telegram notification sent');
    return true;
  } catch (err) {
    log.warn({ err, type: payload.type }, 'Failed to send Telegram notification');
    return false;
  }
}

/**
 * Send critical alert (stock OOS, margin negative, etc.)
 */
export async function notifyCriticalAlert(wsId: number, title: string, details: string): Promise<void> {
  await sendWorkspaceNotification({
    type: 'critical_alert',
    workspaceId: wsId,
    title,
    body: details,
    severity: 'critical',
  });
}

/**
 * Send morning briefing summary.
 */
export async function notifyMorningBriefing(wsId: number, summary: string): Promise<void> {
  await sendWorkspaceNotification({
    type: 'morning_briefing',
    workspaceId: wsId,
    title: 'Утренний брифинг',
    body: summary,
  });
}

/**
 * Send acceptance coefficient change alert.
 */
export async function notifyAcceptanceCoeff(wsId: number, warehouseName: string, oldCoeff: number, newCoeff: number): Promise<void> {
  const direction = newCoeff > oldCoeff ? '↑' : '↓';
  await sendWorkspaceNotification({
    type: 'acceptance_coeff',
    workspaceId: wsId,
    title: `Коэффициент приёмки ${direction}`,
    body: `Склад: ${warehouseName}\nБыло: ${oldCoeff}x → Стало: ${newCoeff}x`,
    severity: newCoeff > 3 ? 'warning' : 'info',
  });
}

/**
 * Send action result notification (price change, bid update, etc.)
 */
export async function notifyActionResult(wsId: number, actionType: string, nmId: number, details: string): Promise<void> {
  await sendWorkspaceNotification({
    type: 'action_result',
    workspaceId: wsId,
    title: `Действие выполнено: ${actionType}`,
    body: `Артикул: ${nmId}\n${details}`,
  });
}

/**
 * Send supply delivery reminder.
 */
export async function notifySupplyReminder(wsId: number, supplyId: string, warehouseName: string, deliveryDate: string): Promise<void> {
  await sendWorkspaceNotification({
    type: 'supply_reminder',
    workspaceId: wsId,
    title: 'Напоминание о поставке',
    body: `Поставка: ${supplyId}\nСклад: ${warehouseName}\nДата доставки: ${deliveryDate}`,
    severity: 'info',
  });
}
