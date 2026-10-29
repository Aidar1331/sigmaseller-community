'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Check, X, Loader2, ExternalLink, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

type StatusResponse = {
  linked: boolean;
  tgUsername: string | null;
  linkedAt: string | null;
};

type LinkCodeResponse = {
  code: string;
  startUrl: string | null;
  expiresAt: string;
  botUsername: string | null;
};

/**
 * Telegram binding card — surfaces the existing /telegram/* API as a friendly
 * three-state UI: not-linked → request code → linked. We poll /status every
 * 2s while a code is outstanding so the moment the user presses /start in
 * the bot, the card flips to "Привязано" without a manual refresh.
 *
 * Why polling and not webhooks/SSE: the bot webhook is already wired up
 * server-side. Adding a push channel just for this flow is overkill — the
 * window is bounded (code TTL = 10 min) and traffic is tiny.
 */
export function TelegramLinkCard() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [linkCode, setLinkCode] = useState<LinkCodeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const pollTimer = useRef<NodeJS.Timeout | null>(null);

  const loadStatus = useCallback(async (): Promise<StatusResponse | null> => {
    try {
      const res = (await apiFetch('/telegram/status')) as StatusResponse;
      setStatus(res);
      return res;
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось загрузить статус');
      return null;
    }
  }, []);

  useEffect(() => {
    loadStatus().finally(() => setLoading(false));
  }, [loadStatus]);

  // Poll while we're waiting for the user to press /start in the bot.
  // Clears itself when the binding lands (linked === true) or the code expires.
  useEffect(() => {
    if (!linkCode) return;
    pollTimer.current = setInterval(async () => {
      const next = await loadStatus();
      if (next?.linked) {
        setLinkCode(null);
        if (pollTimer.current) clearInterval(pollTimer.current);
      }
    }, 2000);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [linkCode, loadStatus]);

  // Countdown — visible reminder that the code has a TTL.
  useEffect(() => {
    if (!linkCode) { setSecondsLeft(null); return; }
    const exp = new Date(linkCode.expiresAt).getTime();
    const tick = () => {
      const left = Math.max(0, Math.floor((exp - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) setLinkCode(null);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [linkCode]);

  const requestCode = async () => {
    setError(null);
    setRequesting(true);
    try {
      const res = (await apiFetch('/telegram/link-code', { method: 'POST' })) as LinkCodeResponse;
      setLinkCode(res);
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось получить код');
    } finally {
      setRequesting(false);
    }
  };

  const unlink = async () => {
    if (!confirm('Отвязать Telegram? Вы перестанете получать уведомления.')) return;
    setUnlinking(true);
    setError(null);
    try {
      await apiFetch('/telegram/link', { method: 'DELETE' });
      await loadStatus();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось отвязать');
    } finally {
      setUnlinking(false);
    }
  };

  if (loading) {
    return (
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка...
        </div>
      </Card>
    );
  }

  const linked = status?.linked === true;

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3 mb-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-50 text-sky-600 shrink-0">
          <Send className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-gray-900">Telegram-бот</div>
          <div className="text-xs text-gray-500 mt-0.5">
            Уведомления, ответы на отзывы, AI-чат и алёрты прямо в Telegram.
          </div>
        </div>
      </div>

      {/* Linked state */}
      {linked && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm">
            <Check className="h-4 w-4 text-emerald-600 shrink-0" />
            <div>
              <span className="text-emerald-900">Привязано: </span>
              <span className="font-medium text-emerald-900">
                {status?.tgUsername ? `@${status.tgUsername}` : 'Telegram-аккаунт'}
              </span>
              {status?.linkedAt && (
                <span className="text-emerald-700/70 ml-2">
                  с {new Date(status.linkedAt).toLocaleDateString('ru-RU')}
                </span>
              )}
            </div>
          </div>
          <Button variant="neutral" size="sm" onClick={unlink} loading={unlinking}>
            <X className="h-4 w-4" />
            Отвязать
          </Button>
        </div>
      )}

      {/* Not linked, no code yet */}
      {!linked && !linkCode && (
        <div className="space-y-3">
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-xs text-gray-600 leading-relaxed">
            После привязки бот будет присылать дневной дайджест, критические алёрты
            (нулевые остатки, рост возвратов, отрицательные отзывы) и сможет
            отвечать на вопросы по бизнесу через AI-чат.
          </div>
          <Button variant="primary" onClick={requestCode} loading={requesting}>
            <Send className="h-4 w-4" />
            Привязать Telegram
          </Button>
        </div>
      )}

      {/* Code issued — waiting for user to /start the bot */}
      {!linked && linkCode && (
        <div className="space-y-3">
          <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 space-y-3">
            <div className="text-sm text-sky-900">
              <strong>Шаг 1.</strong> Откройте бота{' '}
              {linkCode.botUsername ? (
                <span className="font-mono">@{linkCode.botUsername}</span>
              ) : 'Telegram'}{' '}
              по кнопке ниже.
            </div>
            <div className="text-sm text-sky-900">
              <strong>Шаг 2.</strong> Нажмите <span className="font-mono bg-white px-1.5 py-0.5 rounded">START</span> в чате с ботом — привязка произойдёт автоматически.
            </div>
            {linkCode.startUrl ? (
              <a
                href={linkCode.startUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium px-4 py-2 transition-colors"
              >
                <ExternalLink className="h-4 w-4" />
                Открыть бота в Telegram
              </a>
            ) : (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                Бот не настроен (нет TELEGRAM_BOT_USERNAME). Используйте код вручную:{' '}
                <span className="font-mono">{linkCode.code}</span>
              </div>
            )}
            <div className="text-xs text-sky-700/80 flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Ждём подтверждения...
              {secondsLeft !== null && (
                <span className="ml-auto">
                  Код действует ещё {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
                </span>
              )}
            </div>
          </div>
          <Button variant="neutral" size="sm" onClick={requestCode} loading={requesting}>
            <RefreshCw className="h-4 w-4" />
            Получить новый код
          </Button>
        </div>
      )}

      {error && (
        <div className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
          {error}
        </div>
      )}
    </Card>
  );
}
