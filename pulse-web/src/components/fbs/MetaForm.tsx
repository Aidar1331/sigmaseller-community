'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';

type MetaType = 'sgtin' | 'imei' | 'uin' | 'gtin' | 'expiration' | 'customsDeclaration';

interface MetaFormProps {
  workspaceId: number;
  orderId: number;
  metaType: MetaType;
  shopId?: number;
  onSuccess?: () => void;
  onCancel?: () => void;
  className?: string;
}

const META_CONFIG: Record<MetaType, {
  label: string;
  placeholder: string;
  pattern: string;
  hint: string;
  maxLength: number;
}> = {
  sgtin: {
    label: 'SGTIN (Честный знак)',
    placeholder: '010460123456789021ABC123...',
    pattern: '.{20,150}',
    hint: 'Код маркировки с упаковки товара (DataMatrix)',
    maxLength: 150,
  },
  imei: {
    label: 'IMEI',
    placeholder: '123456789012345',
    pattern: '\\d{15}',
    hint: '15 цифр с корпуса устройства',
    maxLength: 15,
  },
  uin: {
    label: 'УИН',
    placeholder: 'Введите УИН',
    pattern: '.+',
    hint: 'Уникальный идентификационный номер',
    maxLength: 100,
  },
  gtin: {
    label: 'GTIN',
    placeholder: '4607123456789',
    pattern: '\\d{8,14}',
    hint: '8-14 цифр (штрихкод EAN/GTIN)',
    maxLength: 14,
  },
  expiration: {
    label: 'Срок годности',
    placeholder: '31.12.2027',
    pattern: '\\d{2}\\.\\d{2}\\.\\d{4}',
    hint: 'Формат: ДД.ММ.ГГГГ',
    maxLength: 10,
  },
  customsDeclaration: {
    label: 'Номер ГТД',
    placeholder: '10704010/010624/0000302',
    pattern: '.+',
    hint: 'Грузовая таможенная декларация',
    maxLength: 100,
  },
};

export function MetaForm({
  workspaceId,
  orderId,
  metaType,
  shopId,
  onSuccess,
  onCancel,
  className,
}: MetaFormProps) {
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = META_CONFIG[metaType];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const endpoint = metaType === 'customsDeclaration'
        ? `/fbs/${workspaceId}/orders/${orderId}/customs-declaration`
        : `/fbs/${workspaceId}/orders/${orderId}/${metaType}`;

      const body = metaType === 'sgtin'
        ? { sgtins: [value.trim()], shopId }
        : { [metaType]: value.trim(), shopId };

      await apiFetch(endpoint, {
        method: 'PUT',
        body: JSON.stringify(body),
      });

      setValue('');
      onSuccess?.();
    } catch (err: any) {
      setError(err.message || 'Не удалось сохранить');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className={cn('space-y-3', className)}>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {config.label}
        </label>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={config.placeholder}
          pattern={config.pattern}
          maxLength={config.maxLength}
          required
          disabled={loading}
          autoFocus
          className={cn(
            'w-full rounded-lg border px-3 py-2 text-sm',
            'border-gray-300 dark:border-gray-600',
            'bg-white dark:bg-gray-800',
            'text-gray-900 dark:text-gray-100',
            'placeholder:text-gray-400 dark:placeholder:text-gray-500',
            'focus:outline-none focus:ring-2 focus:ring-blue-500',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {config.hint}
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading || !value.trim()}
          className={cn(
            'px-4 py-2 text-sm font-medium rounded-lg',
            'bg-blue-600 text-white',
            'hover:bg-blue-700',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'transition-colors'
          )}
        >
          {loading ? 'Сохранение...' : 'Сохранить'}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className={cn(
              'px-4 py-2 text-sm font-medium rounded-lg',
              'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
              'hover:bg-gray-200 dark:hover:bg-gray-600',
              'disabled:opacity-50',
              'transition-colors'
            )}
          >
            Отмена
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * Inline button to add meta - opens form in modal or inline
 */
interface MetaAddButtonProps {
  metaType: MetaType;
  onClick: () => void;
  className?: string;
}

export function MetaAddButton({ metaType, onClick, className }: MetaAddButtonProps) {
  const config = META_CONFIG[metaType];
  
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded',
        'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
        'hover:bg-blue-100 dark:hover:bg-blue-900/50',
        'transition-colors',
        className
      )}
    >
      + {config.label}
    </button>
  );
}
