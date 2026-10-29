/** Community edition: external email delivery is disabled. */

import { env } from '../env.js';
import log from './logger.js';

const logger = log.child({ module: 'email' });



const FROM_EMAIL = env.EMAIL_FROM || 'Sigma Seller <noreply@example.com>';

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/** Deliberately performs no external delivery. */
export async function sendEmail(options: SendEmailOptions): Promise<{ ok: boolean; id?: string; error?: string }> {
  // No provider call and no logging of recipients, tokens or email contents.
  return { ok: false, error: 'EMAIL_DISABLED_USE_RECOVERY_CODE' };
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<{ ok: boolean; error?: string }> {
  return sendEmail({
    to: email,
    subject: 'Сброс пароля — Sigma Seller',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #4F46E5; margin: 0;">Sigma Seller</h1>
  </div>
  
  <h2 style="color: #1F2937;">Сброс пароля</h2>
  
  <p>Вы запросили сброс пароля для вашего аккаунта. Нажмите на кнопку ниже, чтобы установить новый пароль:</p>
  
  <div style="text-align: center; margin: 30px 0;">
    <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(to right, #4F46E5, #6366F1); color: white; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600;">
      Сбросить пароль
    </a>
  </div>
  
  <p style="color: #6B7280; font-size: 14px;">
    Если кнопка не работает, скопируйте эту ссылку в браузер:<br>
    <a href="${resetUrl}" style="color: #4F46E5; word-break: break-all;">${resetUrl}</a>
  </p>
  
  <p style="color: #6B7280; font-size: 14px;">
    ⏰ Ссылка действительна 1 час.
  </p>
  
  <p style="color: #6B7280; font-size: 14px;">
    Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо.
  </p>
  
  <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 30px 0;">
  
  <p style="color: #9CA3AF; font-size: 12px; text-align: center;">
    © ${new Date().getFullYear()} Sigma Seller. Все права защищены.
  </p>
</body>
</html>
    `.trim(),
  });
}

/**
 * Send email address verification link. The raw token goes into the
 * link; only the SHA-256 hash is persisted in `users.email_verify_token`,
 * matching the password-reset flow.
 */
export async function sendVerificationEmail(email: string, verifyUrl: string): Promise<{ ok: boolean; error?: string }> {
  return sendEmail({
    to: email,
    subject: 'Подтвердите email — Sigma Seller',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #4F46E5; margin: 0;">Sigma Seller</h1>
  </div>

  <h2 style="color: #1F2937;">Подтверждение email</h2>

  <p>Нажмите на кнопку ниже, чтобы подтвердить ваш email и разблокировать оплату подписки.</p>

  <div style="text-align: center; margin: 30px 0;">
    <a href="${verifyUrl}" style="display: inline-block; background: linear-gradient(to right, #4F46E5, #6366F1); color: white; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600;">
      Подтвердить email
    </a>
  </div>

  <p style="color: #6B7280; font-size: 14px;">
    Если кнопка не работает, скопируйте эту ссылку:<br>
    <a href="${verifyUrl}" style="color: #4F46E5; word-break: break-all;">${verifyUrl}</a>
  </p>

  <p style="color: #6B7280; font-size: 14px;">⏰ Ссылка действительна 24 часа.</p>

  <p style="color: #6B7280; font-size: 14px;">
    Если вы не регистрировались на Sigma Seller, проигнорируйте это письмо.
  </p>

  <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 30px 0;">

  <p style="color: #9CA3AF; font-size: 12px; text-align: center;">
    © ${new Date().getFullYear()} Sigma Seller. Все права защищены.
  </p>
</body>
</html>
    `.trim(),
  });
}

/**
 * Send welcome email after registration
 */
export async function sendWelcomeEmail(email: string, workspaceName: string): Promise<{ ok: boolean; error?: string }> {
  return sendEmail({
    to: email,
    subject: 'Добро пожаловать в Sigma Seller! 🚀',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #4F46E5; margin: 0;">Sigma Seller</h1>
  </div>
  
  <h2 style="color: #1F2937;">Добро пожаловать! 🎉</h2>
  
  <p>Ваш workspace <strong>"${workspaceName}"</strong> успешно создан.</p>
  
  <h3 style="color: #1F2937;">Что дальше?</h3>
  
  <ol style="color: #4B5563;">
    <li><strong>Подключите магазин WB</strong> — добавьте API ключ в настройках</li>
    <li><strong>Дождитесь синхронизации</strong> — данные появятся через 5-10 минут</li>
    <li><strong>Изучайте аналитику</strong> — продажи, финансы, остатки и многое другое</li>
  </ol>
  
  <div style="background: #F3F4F6; border-radius: 8px; padding: 16px; margin: 20px 0;">
    <p style="margin: 0; color: #4B5563;">
      💡 <strong>Совет:</strong> Начните с вкладки "Рука на пульсе" — там общая картина по вашему бизнесу.
    </p>
  </div>
  
  <p>Если у вас возникнут вопросы, пишите в поддержку или используйте AI-ассистента прямо в сервисе.</p>
  
  <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 30px 0;">
  
  <p style="color: #9CA3AF; font-size: 12px; text-align: center;">
    © ${new Date().getFullYear()} Sigma Seller. Все права защищены.
  </p>
</body>
</html>
    `.trim(),
  });
}
