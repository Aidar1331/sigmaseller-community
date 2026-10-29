/**
 * WB Partner secret expiry monitor.
 *
 * Раз в день декодирует WB_PARTNER_SERVICE_SECRET (JWT), вычисляет дни
 * до `exp`. Алёртит всем is_admin=true в Telegram, если осталось ≤14 дней —
 * по доке WB новый секрет генерится за 30 дней до истечения, оба валидны
 * параллельно, так что 14 дней — гарантированный «уже пора»-сигнал.
 *
 * Запускается через pg-boss раз в сутки в 09:00 МСК.
 */
import { getQueue } from './queue.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { sendTelegramPerUser } from '../integrations/telegram.js';
import { daysUntilServiceSecretExpiry } from '../integrations/wb/wbClient.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'wbPartnerSecretMonitor' });
const JOB_NAME = 'wb-partner-secret-monitor';

const ALERT_THRESHOLD_DAYS = 14;

async function runCheck(): Promise<void> {
  const daysLeft = daysUntilServiceSecretExpiry();
  if (!Number.isFinite(daysLeft)) {
    logger.warn('WB_PARTNER_SERVICE_SECRET not set or unparseable — skipping');
    return;
  }
  logger.info({ daysLeft }, 'WB partner secret expiry check');
  if (daysLeft > ALERT_THRESHOLD_DAYS) return;

  const admins = await db
    .select({ userId: users.userId })
    .from(users)
    .where(eq(users.isAdmin, true));

  const urgency = daysLeft <= 0 ? '🚨🚨 ИСТЁК' : daysLeft <= 3 ? '🚨 ОСТАЛОСЬ ' + daysLeft + ' дн' : '⚠️ Осталось ' + daysLeft + ' дн';
  const text = [
    '🔑 <b>WB сервисный секрет: внимание</b>',
    '',
    `Статус: ${urgency}`,
    '',
    'Выпустите новый секрет на <a href="https://dev.wildberries.ru/account">dev.wildberries.ru</a> в разделе «Ключи доступа» и обновите <code>WB_PARTNER_SERVICE_SECRET</code> в <code>/etc/sigmaseller/api.env</code>. Старый и новый секрет валидны параллельно — миграция бесшовная.',
  ].join('\n');

  await Promise.allSettled(admins.map((a) => sendTelegramPerUser(a.userId, text)));
}

export async function registerWbPartnerSecretMonitor(): Promise<void> {
  const boss = await getQueue();
  await boss.createQueue(JOB_NAME);
  await boss.schedule(JOB_NAME, '0 9 * * *', {}, { tz: 'Europe/Moscow' });
  await boss.work(JOB_NAME, { localConcurrency: 1 }, async () => {
    try {
      await runCheck();
    } catch (err) {
      logger.error({ err }, 'WB partner secret monitor failed');
      throw err;
    }
  });
  logger.info('registered');
}
