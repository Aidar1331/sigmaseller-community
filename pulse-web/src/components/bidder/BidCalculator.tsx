'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api';

interface BidDecision {
  shouldChange: boolean;
  newBid: number;
  reason: string;
  estimatedPosition: number;
  competitorAtTarget?: {
    position: number;
    cpm: number;
  };
}

interface Competitor {
  position: number;
  cpm: number;
  nmId?: number;
}

interface BidCalculatorProps {
  workspaceId: number;
}

export function BidCalculator({ workspaceId }: BidCalculatorProps) {
  const [keyword, setKeyword] = useState('');
  const [currentBid, setCurrentBid] = useState(100);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [targetPosition, setTargetPosition] = useState(5);
  const [minBid, setMinBid] = useState(50);
  const [maxBid, setMaxBid] = useState(5000);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    decision: BidDecision;
    competitors: Competitor[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const calculate = async () => {
    if (!keyword.trim()) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const response = await apiFetch(`/bidder/${workspaceId}/calculate-bid`, {
        method: 'POST',
        body: JSON.stringify({
          keyword,
          currentBid,
          currentPosition,
          targetPosition,
          minBid,
          maxBid,
        }),
      });
      
      if (response.ok) {
        setResult({
          decision: response.decision,
          competitors: response.competitors,
        });
      } else {
        setError(response.error || 'Ошибка расчёта');
      }
    } catch (err: any) {
      setError(err.message || 'Ошибка при расчёте');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold mb-4">Калькулятор ставок</h3>
      
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="col-span-2">
          <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
            Ключевое слово
          </label>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="Например: кроссовки мужские"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-gray-700"
          />
        </div>
        
        <div>
          <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
            Текущая ставка (₽)
          </label>
          <input
            type="number"
            value={currentBid}
            onChange={(e) => setCurrentBid(Number(e.target.value))}
            min={0}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-gray-700"
          />
        </div>
        
        <div>
          <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
            Текущая позиция
          </label>
          <input
            type="number"
            value={currentPosition}
            onChange={(e) => setCurrentPosition(Number(e.target.value))}
            min={0}
            placeholder="0 = неизвестно"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-gray-700"
          />
        </div>
        
        <div>
          <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
            Целевая позиция
          </label>
          <input
            type="number"
            value={targetPosition}
            onChange={(e) => setTargetPosition(Number(e.target.value))}
            min={1}
            max={20}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-gray-700"
          />
        </div>
        
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
              Мин. (₽)
            </label>
            <input
              type="number"
              value={minBid}
              onChange={(e) => setMinBid(Number(e.target.value))}
              min={10}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-gray-700"
            />
          </div>
          <div className="flex-1">
            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
              Макс. (₽)
            </label>
            <input
              type="number"
              value={maxBid}
              onChange={(e) => setMaxBid(Number(e.target.value))}
              max={100000}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-gray-700"
            />
          </div>
        </div>
      </div>
      
      <button
        onClick={calculate}
        disabled={loading || !keyword.trim()}
        className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Расчёт...' : 'Рассчитать оптимальную ставку'}
      </button>

      {error && (
        <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-6 space-y-4">
          {/* Recommendation Card */}
          <div className={`p-4 rounded-lg border-2 ${
            result.decision.shouldChange 
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' 
              : 'border-green-500 bg-green-50 dark:bg-green-900/20'
          }`}>
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium">Рекомендация</span>
              {result.decision.shouldChange ? (
                <span className="px-2 py-1 text-xs bg-blue-100 dark:bg-blue-800 text-blue-700 dark:text-blue-300 rounded">
                  Изменить ставку
                </span>
              ) : (
                <span className="px-2 py-1 text-xs bg-green-100 dark:bg-green-800 text-green-700 dark:text-green-300 rounded">
                  Оставить как есть
                </span>
              )}
            </div>
            
            {result.decision.shouldChange && (
              <div className="flex items-center gap-4 mb-2">
                <div className="text-center">
                  <div className="text-2xl font-bold text-gray-500 line-through">{currentBid}₽</div>
                  <div className="text-xs text-gray-500">Было</div>
                </div>
                <div className="text-2xl text-gray-500">→</div>
                <div className="text-center">
                  <div className="text-3xl font-bold text-blue-600">{result.decision.newBid}₽</div>
                  <div className="text-xs text-gray-500">Рекомендуемая</div>
                </div>
              </div>
            )}
            
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {result.decision.reason}
            </p>
            
            {result.decision.estimatedPosition > 0 && (
              <div className="mt-2 text-sm">
                <span className="text-gray-500">Ожидаемая позиция: </span>
                <span className="font-medium text-blue-600">#{result.decision.estimatedPosition}</span>
              </div>
            )}
          </div>

          {/* Competitors Table */}
          {result.competitors.length > 0 && (
            <div>
              <h4 className="font-medium mb-2">Конкуренты в рекламе</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b dark:border-gray-700">
                      <th className="text-left py-2 px-3">Позиция</th>
                      <th className="text-right py-2 px-3">CPM</th>
                      <th className="text-right py-2 px-3">Нужно для победы</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.competitors.map((c, i) => (
                      <tr 
                        key={i} 
                        className={`border-b dark:border-gray-700/50 ${
                          c.position === targetPosition 
                            ? 'bg-yellow-50 dark:bg-yellow-900/20' 
                            : 'hover:bg-gray-50 dark:hover:bg-gray-700/30'
                        }`}
                      >
                        <td className="py-2 px-3">
                          <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium ${
                            c.position === targetPosition
                              ? 'bg-yellow-200 dark:bg-yellow-800 text-yellow-800 dark:text-yellow-200'
                              : 'bg-gray-100 dark:bg-gray-700 text-gray-600'
                          }`}>
                            {c.position}
                          </span>
                          {c.position === targetPosition && (
                            <span className="ml-2 text-xs text-yellow-700">← Цель</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right font-mono">{c.cpm}₽</td>
                        <td className="py-2 px-3 text-right font-mono text-blue-600">
                          {c.cpm + 1}₽
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
