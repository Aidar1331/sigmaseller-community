'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { RefreshCw, Play, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';

interface Keyword {
  keywordId: number;
  keyword: string;
  isActive: boolean;
  lastCheckedAt: string | null;
  nmIds: number[];
  latestPositions?: Array<{
    nmId: number;
    position: number | null;
    page: number | null;
    is_promo: boolean;
    checked_at: string;
  }>;
}

interface Props {
  workspaceId: number;
  shopId?: number;
  onKeywordClick?: (keyword: Keyword) => void;
}

export function KeywordTable({ workspaceId, shopId, onKeywordClick }: Props) {
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [checkingKeywordId, setCheckingKeywordId] = useState<number | null>(null);

  // Load keywords on mount
  useState(() => {
    (async () => {
      try {
        const res = await apiFetch<{ keywords: Keyword[] }>(
          `/seo/${workspaceId}/keywords?includeLatest=true${shopId ? `&shopId=${shopId}` : ''}`
        );
        setKeywords(res.keywords ?? []);
      } catch (e) {
        console.error('Failed to load keywords:', e);
      } finally {
        setIsLoading(false);
      }
    })();
  });

  const handleCheck = async (keywordId: number) => {
    setCheckingKeywordId(keywordId);
    try {
      await apiFetch(`/seo/${workspaceId}/keywords/${keywordId}/check-full`, { method: 'POST' });
      // Reload keywords
      const res = await apiFetch<{ keywords: Keyword[] }>(
        `/seo/${workspaceId}/keywords?includeLatest=true${shopId ? `&shopId=${shopId}` : ''}`
      );
      setKeywords(res.keywords ?? []);
    } finally {
      setCheckingKeywordId(null);
    }
  };

  const handleDelete = async (keywordId: number) => {
    if (!confirm('Удалить ключевое слово?')) return;
    await apiFetch(`/seo/${workspaceId}/keywords/${keywordId}`, { method: 'DELETE' });
    setKeywords((prev) => prev.filter((k) => k.keywordId !== keywordId));
  };

  if (isLoading) {
    return <div className="p-4 text-center text-gray-500">Загрузка...</div>;
  }

  if (!keywords.length) {
    return <div className="p-8 text-center text-gray-500">Нет ключевых слов для отслеживания</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="py-2 px-3 text-left font-medium text-gray-500">Ключевое слово</th>
            <th className="py-2 px-3 text-center font-medium text-gray-500">Позиция</th>
            <th className="py-2 px-3 text-center font-medium text-gray-500">Страница</th>
            <th className="py-2 px-3 text-left font-medium text-gray-500">Проверено</th>
            <th className="py-2 px-3 text-right font-medium text-gray-500">Действия</th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((kw) => {
            const latestPos = kw.latestPositions?.[0];
            const position = latestPos?.position;
            const page = latestPos?.page;
            const isPromo = latestPos?.is_promo;

            return (
              <tr
                key={kw.keywordId}
                className="border-b border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors"
                onClick={() => onKeywordClick?.(kw)}
              >
                <td className="py-2 px-3 font-medium">
                  {kw.keyword}
                  {!kw.isActive && (
                    <Badge variant="neutral" size="sm" className="ml-2">неактивно</Badge>
                  )}
                </td>
                <td className="py-2 px-3 text-center">
                  {position !== null && position !== undefined ? (
                    <span className={cn(
                      'font-semibold',
                      position <= 10 && 'text-green-700',
                      position > 10 && position <= 30 && 'text-yellow-700',
                      position > 30 && 'text-red-600'
                    )}>
                      #{position}
                      {isPromo && <Badge variant="neutral" size="sm" className="ml-1">Ad</Badge>}
                    </span>
                  ) : '—'}
                </td>
                <td className="py-2 px-3 text-center">
                  {page !== null && page !== undefined ? page : '—'}
                </td>
                <td className="py-2 px-3 text-gray-500 text-xs">
                  {kw.lastCheckedAt
                    ? new Date(kw.lastCheckedAt).toLocaleString('ru-RU', {
                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                      })
                    : '—'}
                </td>
                <td className="py-2 px-3 text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={(e) => { e.stopPropagation(); handleCheck(kw.keywordId); }}
                      disabled={checkingKeywordId === kw.keywordId}
                    >
                      {checkingKeywordId === kw.keywordId ? (
                        <RefreshCw className="h-4 w-4 animate-spin" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={(e) => { e.stopPropagation(); handleDelete(kw.keywordId); }}
                    >
                      <Trash2 className="h-4 w-4 text-red-400" />
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
