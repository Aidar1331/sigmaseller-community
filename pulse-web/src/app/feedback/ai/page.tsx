'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { AIReviewResponder } from '@/components/feedback/AIReviewResponder';
import { Card } from '@/components/ui/Card';
import { useWorkspaceStore } from '@/store/workspace';
import { useShopParam } from '@/hooks/useShopParam';
import { apiFetch } from '@/lib/api';
import { ArrowLeft, Bot, CheckCircle, Clock, MessageSquare } from 'lucide-react';
import Link from 'next/link';

interface Stats {
  totalReviews: number;
  aiDraftsGenerated: number;
  responsesSent: number;
  unansweredReviews: number;
  responseRate: number;
}

interface Review {
  itemId: string;
  text: string;
  rating: number;
  productTitle?: string;
  userName?: string;
  createdAt?: string;
  isAnswered: boolean;
}

export default function AIFeedbackPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const shopParam = useShopParam();
  const [stats, setStats] = useState<Stats | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceId) return;

    const fetchData = async () => {
      setLoading(true);
      try {
        const [statsRes, itemsRes] = await Promise.all([
          apiFetch(`/feedback/${workspaceId}/ai/stats?marketplace=wb${shopParam}`),
          apiFetch(`/feedback/${workspaceId}/items?marketplace=wb&itemType=review&isAnswered=0&limit=50${shopParam}`),
        ]);

        if (statsRes.stats) {
          setStats(statsRes.stats);
        }

        if (itemsRes.items) {
          setReviews(itemsRes.items);
        }
      } catch (err) {
        console.error('Failed to fetch data:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [workspaceId, shopParam]);

  if (!workspaceId) {
    return (
      <AppShell>
        <div className="p-8 text-center text-muted-foreground">
          Выберите магазин для работы с отзывами
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Link
            href="/feedback"
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Bot className="h-7 w-7" />
              AI-ответы на отзывы
            </h1>
            <p className="text-muted-foreground">
              Автоматическая генерация ответов на отзывы с помощью искусственного интеллекта
            </p>
          </div>
        </div>

        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Card className="p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <MessageSquare className="h-4 w-4" />
                Всего отзывов
              </div>
              <div className="text-2xl font-bold">{stats.totalReviews}</div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <Clock className="h-4 w-4" />
                Без ответа
              </div>
              <div className="text-2xl font-bold text-orange-700">{stats.unansweredReviews}</div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <Bot className="h-4 w-4" />
                AI-черновиков
              </div>
              <div className="text-2xl font-bold text-blue-600">{stats.aiDraftsGenerated}</div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <CheckCircle className="h-4 w-4" />
                Отправлено
              </div>
              <div className="text-2xl font-bold text-green-700">{stats.responsesSent}</div>
              <div className="text-xs text-muted-foreground">
                {stats.responseRate}% response rate
              </div>
            </Card>
          </div>
        )}

        {/* AI Responder Component */}
        {loading ? (
          <Card className="p-8 text-center">
            <div className="animate-pulse">Загрузка отзывов...</div>
          </Card>
        ) : (
          <AIReviewResponder
            workspaceId={workspaceId}
            reviews={reviews}
            onResponsesGenerated={(responses) => {
              // Refresh stats after generation
              apiFetch(`/feedback/${workspaceId}/ai/stats?marketplace=wb${shopParam}`)
                .then((res) => {
                  if (res.stats) setStats(res.stats);
                });
            }}
          />
        )}

        {/* Help */}
        <div className="bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg p-4">
          <h3 className="font-medium text-purple-800 dark:text-purple-300 mb-2">🤖 Как это работает</h3>
          <ul className="text-sm text-purple-700 dark:text-purple-400 space-y-1">
            <li>• Выберите отзывы, на которые хотите ответить</li>
            <li>• Нажмите "Сгенерировать" — AI создаст персонализированные ответы</li>
            <li>• Ответы учитывают рейтинг, текст отзыва и информацию о товаре</li>
            <li>• Черновики сохраняются автоматически — можно отредактировать перед отправкой</li>
            <li>• Стоимость: ~0.25₽ за ответ (YandexGPT/OpenAI)</li>
          </ul>
        </div>
      </div>
    </AppShell>
  );
}
