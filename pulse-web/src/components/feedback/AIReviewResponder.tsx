'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api';

interface Review {
  itemId: string;
  text: string;
  rating: number;
  productTitle?: string;
  userName?: string;
  createdAt?: string;
  isAnswered: boolean;
}

interface GeneratedResponse {
  itemId: string;
  success: boolean;
  response?: string;
  error?: string;
}

interface AIReviewResponderProps {
  workspaceId: number;
  reviews: Review[];
  onResponsesGenerated?: (responses: GeneratedResponse[]) => void;
}

export function AIReviewResponder({ workspaceId, reviews, onResponsesGenerated }: AIReviewResponderProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [responses, setResponses] = useState<Map<string, GeneratedResponse>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const unansweredReviews = reviews.filter(r => !r.isAnswered);

  const toggleSelect = (itemId: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(itemId)) {
      newSelected.delete(itemId);
    } else {
      newSelected.add(itemId);
    }
    setSelectedIds(newSelected);
  };

  const selectAll = () => {
    if (selectedIds.size === unansweredReviews.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(unansweredReviews.map(r => r.itemId)));
    }
  };

  const generateResponses = async () => {
    if (selectedIds.size === 0) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const result = await apiFetch(`/feedback/${workspaceId}/ai/generate-batch`, {
        method: 'POST',
        body: JSON.stringify({
          itemIds: Array.from(selectedIds),
          itemType: 'review',
          marketplace: 'wb',
          autoSave: true,
        }),
      });
      
      const newResponses = new Map(responses);
      result.results.forEach((r: GeneratedResponse) => {
        newResponses.set(r.itemId, r);
      });
      setResponses(newResponses);
      
      if (onResponsesGenerated) {
        onResponsesGenerated(result.results);
      }
    } catch (err: any) {
      setError(err.message || 'Ошибка при генерации ответов');
    } finally {
      setLoading(false);
    }
  };

  const getRatingColor = (rating: number) => {
    if (rating >= 4) return 'text-green-700';
    if (rating === 3) return 'text-yellow-700';
    return 'text-red-600';
  };

  const getRatingStars = (rating: number) => {
    return '★'.repeat(rating) + '☆'.repeat(5 - rating);
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow">
      <div className="p-4 border-b dark:border-gray-700 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">AI-ответы на отзывы</h3>
          <p className="text-sm text-gray-500">
            {unansweredReviews.length} без ответа • {selectedIds.size} выбрано
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={selectAll}
            className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            {selectedIds.size === unansweredReviews.length ? 'Снять всё' : 'Выбрать всё'}
          </button>
          <button
            onClick={generateResponses}
            disabled={loading || selectedIds.size === 0}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Генерация...
              </>
            ) : (
              <>
                ✨ Сгенерировать ({selectedIds.size})
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 m-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg">
          {error}
        </div>
      )}

      <div className="divide-y dark:divide-gray-700">
        {unansweredReviews.map((review) => {
          const response = responses.get(review.itemId);
          
          return (
            <div
              key={review.itemId}
              className={`p-4 ${selectedIds.has(review.itemId) ? 'bg-blue-50 dark:bg-blue-900/10' : ''}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={selectedIds.has(review.itemId)}
                  onChange={() => toggleSelect(review.itemId)}
                  className="mt-1 h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                />
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-sm font-medium ${getRatingColor(review.rating)}`}>
                      {getRatingStars(review.rating)}
                    </span>
                    {review.userName && (
                      <span className="text-sm text-gray-500">{review.userName}</span>
                    )}
                    {review.createdAt && (
                      <span className="text-sm text-gray-500">
                        {new Date(review.createdAt).toLocaleDateString('ru-RU')}
                      </span>
                    )}
                  </div>
                  
                  {review.productTitle && (
                    <div className="text-sm text-gray-500 mb-1">{review.productTitle}</div>
                  )}
                  
                  <p className="text-gray-700 dark:text-gray-300">{review.text}</p>
                  
                  {response && (
                    <div className={`mt-3 p-3 rounded-lg ${
                      response.success 
                        ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800' 
                        : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
                    }`}>
                      {response.success ? (
                        <>
                          <div className="text-xs text-green-700 dark:text-green-400 mb-1 font-medium">
                            ✓ Ответ сгенерирован
                          </div>
                          <p className="text-sm text-gray-700 dark:text-gray-300">{response.response}</p>
                        </>
                      ) : (
                        <div className="text-sm text-red-600 dark:text-red-400">
                          ✗ Ошибка: {response.error}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        
        {unansweredReviews.length === 0 && (
          <div className="p-8 text-center text-gray-500">
            Все отзывы обработаны 🎉
          </div>
        )}
      </div>
    </div>
  );
}
