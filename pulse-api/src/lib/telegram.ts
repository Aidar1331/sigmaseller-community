import { env } from '../env.js';
import { BadRequestError } from './errors.js';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import log from './logger.js';

const logger = log.child({ module: 'telegram' });

export async function sendTelegramMessage(text: string, chatId?: string): Promise<string | null> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const target = chatId || env.TELEGRAM_CHAT_ID;
  if (!token || !target) {
    logger.warn('Not configured (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing), skipping message');
    return null;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: target, text, parse_mode: 'HTML' }),
  });

  const textRes = await res.text();
  if (!res.ok) {
    throw new BadRequestError(`Telegram error: ${res.status} ${textRes.slice(0, 200)}`);
  }

  return textRes;
}

export async function sendTelegramDocument(
  filePath: string,
  chatId?: string,
  opts?: { fileName?: string; caption?: string; mime?: string }
): Promise<string | null> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const target = chatId || env.TELEGRAM_CHAT_ID;
  if (!token || !target) {
    logger.warn('Not configured (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing), skipping document');
    return null;
  }

  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  const buffer = await readFile(filePath);
  const fileName = opts?.fileName || basename(filePath);
  const mime = opts?.mime || 'application/pdf';

  const form = new FormData();
  form.append('chat_id', target);
  if (opts?.caption) form.append('caption', opts.caption);
  form.append('document', new Blob([buffer], { type: mime }) as any, fileName);

  const res = await fetch(url, { method: 'POST', body: form });
  const textRes = await res.text();
  if (!res.ok) {
    throw new BadRequestError(`Telegram error: ${res.status} ${textRes.slice(0, 200)}`);
  }

  return textRes;
}
