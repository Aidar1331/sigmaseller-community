import { db } from '../db/client.js';
import { eq, and, lte, isNotNull } from 'drizzle-orm';
import { wbEvents, notificationSettings, workspaceMembers } from '../db/schema.js';
import { sendTelegramMessage } from '../integrations/telegram.js';
import { logJobs as logger } from '../lib/logger.js';

// Wrapper for sending notifications
async function sendTelegramNotification(opts: { chatId: string; text: string; parseMode?: string; buttons?: any[][] }) {
  return sendTelegramMessage(opts.chatId, opts.text, { parseMode: opts.parseMode, buttons: opts.buttons });
}

type Config = {
  enabled: boolean;
  intervalMinutes: number;
};

export function getReminderSenderConfig(): Config {
  const enabled = (process.env.ENABLE_REMINDER_SENDER ?? '') === '1';
  const intervalMinutes = Number.parseInt(process.env.REMINDER_SENDER_INTERVAL_MINUTES || '5', 10);
  return { enabled, intervalMinutes };
}

function isInQuietHours(now: Date, quietStart: string | null, quietEnd: string | null, timezone: string): boolean {
  if (!quietStart || !quietEnd) return false;

  try {
    // Convert current time to user's timezone
    let hour: number;
    let minute: number;
    
    if (timezone && timezone !== 'UTC') {
      // Use Intl to get time in user's timezone
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      });
      const parts = formatter.formatToParts(now);
      hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
      minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    } else {
      // Fallback to UTC
      hour = now.getUTCHours();
      minute = now.getUTCMinutes();
    }
    
    const currentTime = hour * 60 + minute;

    const [startH, startM] = quietStart.split(':').map(Number);
    const [endH, endM] = quietEnd.split(':').map(Number);
    const startTime = startH * 60 + startM;
    const endTime = endH * 60 + endM;

    if (startTime < endTime) {
      // Same day range (e.g., 09:00 - 17:00)
      return currentTime >= startTime && currentTime <= endTime;
    } else {
      // Overnight range (e.g., 22:00 - 08:00)
      return currentTime >= startTime || currentTime <= endTime;
    }
  } catch (e) {
    logger.warn({ err: e }, 'isInQuietHours error');
    return false;
  }
}

function formatEventForTelegram(event: any): string {
  const typeEmoji: Record<string, string> = {
    task: '📋',
    alert: '🔔',
    reminder: '⏰',
    log: '📝',
    note: '📌',
  };

  const priorityEmoji: Record<string, string> = {
    urgent: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🟢',
  };

  const emoji = typeEmoji[event.type] || '📌';
  const priority = event.priority ? priorityEmoji[event.priority] || '' : '';

  let text = `${emoji} ${priority} <b>${escapeHtml(event.title)}</b>\n`;

  if (event.description) {
    text += `\n${escapeHtml(event.description.slice(0, 500))}`;
    if (event.description.length > 500) text += '...';
    text += '\n';
  }

  if (event.dueAt) {
    const due = new Date(event.dueAt);
    text += `\n⏳ Дедлайн: ${due.toLocaleString('ru-RU')}`;
  }

  return text;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function sendPendingReminders(): Promise<{ sent: number; skipped: number }> {
  const cfg = getReminderSenderConfig();
  if (!cfg.enabled) return { sent: 0, skipped: 0 };

  const now = new Date();

  // Find events with pending reminders
  const events = await db
    .select({
      eventId: wbEvents.eventId,
      workspaceId: wbEvents.workspaceId,
      type: wbEvents.type,
      title: wbEvents.title,
      description: wbEvents.description,
      priority: wbEvents.priority,
      dueAt: wbEvents.dueAt,
      assigneeId: wbEvents.assigneeId,
    })
    .from(wbEvents)
    .where(
      and(
        isNotNull(wbEvents.reminderAt),
        lte(wbEvents.reminderAt, now),
        eq(wbEvents.reminderSent, false)
      )
    )
    .limit(100);

  let sent = 0;
  let skipped = 0;

  for (const event of events) {
    // Get notification settings for workspace members
    const members = await db
      .select({
        userId: workspaceMembers.userId,
      })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, event.workspaceId));

    let eventSent = false;

    for (const member of members) {
      // Skip if not assignee (when event has assignee)
      if (event.assigneeId && event.assigneeId !== member.userId) continue;

      // Get notification settings
      const [settings] = await db
        .select()
        .from(notificationSettings)
        .where(
          and(
            eq(notificationSettings.workspaceId, event.workspaceId),
            eq(notificationSettings.userId, member.userId)
          )
        )
        .limit(1);

      if (!settings?.telegramEnabled || !settings.telegramChatId) continue;

      // Check if reminders are enabled
      if (!settings.notifyReminders && event.type === 'reminder') continue;
      if (!settings.notifyTasks && event.type === 'task') continue;
      if (!settings.notifyAlerts && event.type === 'alert') continue;

      // Check quiet hours
      if (isInQuietHours(now, settings.quietHoursStart, settings.quietHoursEnd, settings.timezone ?? 'Europe/Moscow')) {
        skipped++;
        continue;
      }

      // Send notification
      try {
        const text = formatEventForTelegram(event);
        await sendTelegramNotification({
          chatId: settings.telegramChatId,
          text,
          parseMode: 'HTML',
          buttons: [
            [
              { text: '✅ Готово', callback_data: `event_done:${event.eventId}` },
              { text: '⏰ +1ч', callback_data: `event_snooze:${event.eventId}:60` },
            ],
          ],
        });
        eventSent = true;
      } catch (e) {
        logger.error({ err: e, telegramChatId: settings.telegramChatId }, 'failed to send reminder');
      }
    }

    // Mark reminder as sent and handle recurring events
    if (eventSent) {
      // Check if event is recurring (need to fetch full event)
      const [fullEvent] = await db
        .select({ recurrence: wbEvents.recurrence, date: wbEvents.date, reminderMinutesBefore: wbEvents.reminderMinutesBefore })
        .from(wbEvents)
        .where(eq(wbEvents.eventId, event.eventId))
        .limit(1);

      const recurrence = fullEvent?.recurrence as { type: string; interval: number; endDate?: string } | null;

      if (recurrence && recurrence.type) {
        // Calculate next occurrence
        const currentDate = new Date(fullEvent.date + 'T00:00:00Z');
        const interval = recurrence.interval || 1;
        
        switch (recurrence.type) {
          case 'daily':
            currentDate.setUTCDate(currentDate.getUTCDate() + interval);
            break;
          case 'weekly':
            currentDate.setUTCDate(currentDate.getUTCDate() + interval * 7);
            break;
          case 'monthly':
            currentDate.setUTCMonth(currentDate.getUTCMonth() + interval);
            break;
        }

        const endDate = recurrence.endDate ? new Date(recurrence.endDate) : null;
        const nextDate = currentDate.toISOString().slice(0, 10);

        // If next occurrence is before end date, schedule next reminder
        if (!endDate || currentDate <= endDate) {
          const nextReminderAt = new Date(currentDate);
          if (fullEvent.reminderMinutesBefore) {
            nextReminderAt.setMinutes(nextReminderAt.getMinutes() - fullEvent.reminderMinutesBefore);
          }

          await db
            .update(wbEvents)
            .set({ 
              date: nextDate,
              reminderAt: nextReminderAt,
              reminderSent: false, // Reset for next occurrence
              updatedAt: new Date(),
            })
            .where(eq(wbEvents.eventId, event.eventId));
        } else {
          // No more occurrences, mark as sent
          await db
            .update(wbEvents)
            .set({ reminderSent: true, updatedAt: new Date() })
            .where(eq(wbEvents.eventId, event.eventId));
        }
      } else {
        // Non-recurring event, just mark as sent
        await db
          .update(wbEvents)
          .set({ reminderSent: true, updatedAt: new Date() })
          .where(eq(wbEvents.eventId, event.eventId));
      }
      sent++;
    }
  }

  if (sent > 0 || skipped > 0) {
    logger.info({ sent, skipped }, 'reminderSender completed');
  }

  return { sent, skipped };
}

export function startReminderSenderLoop(): void {
  const cfg = getReminderSenderConfig();
  if (!cfg.enabled) return;

  const initialDelayMs = 10_000;
  const intervalMs = cfg.intervalMinutes * 60_000;

  logger.info({ intervalMinutes: cfg.intervalMinutes }, 'reminderSender enabled');

  setTimeout(() => {
    sendPendingReminders().catch((e) => {
      logger.error({ err: e }, 'reminderSender boot run failed');
    });
  }, initialDelayMs);

  setInterval(() => {
    sendPendingReminders().catch((e) => {
      logger.error({ err: e }, 'reminderSender scheduled run failed');
    });
  }, intervalMs);
}

/** Simple wrapper for scheduler */
export async function runReminderSender(): Promise<void> {
  await sendPendingReminders();
}
