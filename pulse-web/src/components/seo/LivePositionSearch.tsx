'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api';
import { NmIdLink } from '@/components/ui/NmIdLink';

interface ProductPosition {
  nmId: number;
  position: number;
  page: number;
  positionOnPage: number;
  isPromo: boolean;
  brand: string;
  name: string;
  price: number;
  rating: number;
  feedbacks: number;
}

interface LivePositionSearchProps {
  workspaceId: number;
  defaultNmIds?: number[];
}

export function LivePositionSearch({ workspaceId, defaultNmIds = [] }: LivePositionSearchProps) {
  const [keyword, setKeyword] = useState('');
  const [nmIdsInput, setNmIdsInput] = useState(defaultNmIds.join(', '));
  const [loading, setLoading] = useState(false);
  const [positions, setPositions] = useState<ProductPosition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastSearch, setLastSearch] = useState<{ keyword: string; checkedAt: string } | null>(null);

  const handleSearch = async () => {
    if (!keyword.trim()) return;
    
    const nmIds = nmIdsInput
      .split(/[,\s]+/)
      .map(s => parseInt(s.trim()))
      .filter(n => !isNaN(n) && n > 0);
    
    if (nmIds.length === 0) {
      setError('Укажите хотя бы один артикул');
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
      const result = await apiFetch(`/seo/${workspaceId}/live-search`, {
        method: 'POST',
        body: JSON.stringify({
          keyword,
          nmIds,
          maxPages: 20,
        }),
      });
      
      setPositions(result.positions || []);
      setLastSearch({
        keyword: result.keyword,
        checkedAt: result.checkedAt,
      });
    } catch (err: any) {
      setError(err.message || 'Ошибка при поиске');
    } finally {
      setLoading(false);
    }
  };

  const getPositionColor = (position: number) => {
    if (position === -1) return 'bg-gray-200 dark:bg-gray-700 text-gray-500';
    if (position <= 10) return 'bg-green-100 dark:bg-green-900/30 text-green-700';
    if (position <= 50) return 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700';
    if (position <= 100) return 'bg-orange-100 dark:bg-orange-900/30 text-orange-700';
    return 'bg-red-100 dark:bg-red-900/30 text-red-700';
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold mb-4">Поиск позиций товаров</h3>
      
      <div className="space-y-3 mb-4">
        <div>
          <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
            Ключевое слово
          </label>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Например: кроссовки мужские"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700"
          />
        </div>
        
        <div>
          <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
            Артикулы (через запятую)
          </label>
          <input
            type="text"
            value={nmIdsInput}
            onChange={(e) => setNmIdsInput(e.target.value)}
            placeholder="123456789, 987654321"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700"
          />
        </div>
        
        <button
          onClick={handleSearch}
          disabled={loading || !keyword.trim()}
          className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Поиск...' : 'Найти позиции'}
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg mb-4">
          {error}
        </div>
      )}

      {lastSearch && (
        <div className="text-sm text-gray-500 mb-4">
          Запрос: <span className="font-medium">{lastSearch.keyword}</span>
          <span className="mx-2">•</span>
          {new Date(lastSearch.checkedAt).toLocaleString('ru-RU')}
        </div>
      )}

      {positions.length > 0 && (
        <div className="space-y-3">
          {positions.map((p) => (
            <div
              key={p.nmId}
              className="flex items-center justify-between p-3 border dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/30"
            >
              <div className="flex items-center gap-3">
                <div className={`flex items-center justify-center w-12 h-12 rounded-lg font-bold ${getPositionColor(p.position)}`}>
                  {p.position === -1 ? '—' : p.position}
                </div>
                <div>
                  <div className="font-medium">
                    <NmIdLink nmId={p.nmId} className="text-blue-600 hover:underline" />
                    {p.isPromo && (
                      <span className="ml-2 px-1.5 py-0.5 text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-600 rounded">
                        Реклама
                      </span>
                    )}
                  </div>
                  {p.name && (
                    <div className="text-sm text-gray-500 truncate max-w-md">
                      {p.brand && <span className="font-medium">{p.brand}</span>}
                      {p.brand && p.name && ' • '}
                      {p.name}
                    </div>
                  )}
                </div>
              </div>
              
              <div className="text-right text-sm">
                {p.position > 0 && (
                  <>
                    <div className="text-gray-600 dark:text-gray-400">
                      Страница {p.page}, позиция {p.positionOnPage}
                    </div>
                    {p.rating > 0 && (
                      <div className="text-gray-500">
                        ★ {p.rating.toFixed(1)} • {p.feedbacks} отзывов
                      </div>
                    )}
                  </>
                )}
                {p.position === -1 && (
                  <div className="text-gray-500">Не найден в топ-2000</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
