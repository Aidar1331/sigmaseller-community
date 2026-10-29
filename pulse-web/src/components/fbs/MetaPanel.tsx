'use client';

import { useState } from 'react';
import { MetaBadge } from './MetaBadge';
import { MetaForm } from './MetaForm';
import { cn } from '@/lib/cn';

type MetaType = 'sgtin' | 'imei' | 'uin' | 'gtin' | 'expiration' | 'customsDeclaration';

interface MetaPanelProps {
  workspaceId: number;
  orderId: number;
  shopId?: number;
  requiredMeta?: string[];
  filledMeta?: string[];
  onUpdate?: () => void;
  className?: string;
}

const META_LABELS: Record<string, string> = {
  sgtin: 'Честный знак',
  imei: 'IMEI',
  uin: 'УИН',
  gtin: 'GTIN',
  expiration: 'Срок годности',
  customsDeclaration: 'ГТД',
};

export function MetaPanel({
  workspaceId,
  orderId,
  shopId,
  requiredMeta,
  filledMeta,
  onUpdate,
  className,
}: MetaPanelProps) {
  const [activeForm, setActiveForm] = useState<MetaType | null>(null);

  if (!requiredMeta?.length) return null;

  const filled = new Set(filledMeta ?? []);
  const missing = requiredMeta.filter((m) => !filled.has(m)) as MetaType[];

  const handleSuccess = () => {
    setActiveForm(null);
    onUpdate?.();
  };

  return (
    <div className={cn('space-y-3', className)}>
      {/* Status badge */}
      <div className="flex items-center gap-2">
        <MetaBadge requiredMeta={requiredMeta} filledMeta={filledMeta} showLabels />
      </div>

      {/* Missing meta buttons */}
      {missing.length > 0 && !activeForm && (
        <div className="flex flex-wrap gap-2">
          {missing.map((metaType) => (
            <button
              key={metaType}
              onClick={() => setActiveForm(metaType)}
              className={cn(
                'inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-lg',
                'bg-amber-50 text-amber-700 border border-amber-200',
                'dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800',
                'hover:bg-amber-100 dark:hover:bg-amber-900/30',
                'transition-colors'
              )}
            >
              + {META_LABELS[metaType] || metaType}
            </button>
          ))}
        </div>
      )}

      {/* Active form */}
      {activeForm && (
        <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <MetaForm
            workspaceId={workspaceId}
            orderId={orderId}
            shopId={shopId}
            metaType={activeForm}
            onSuccess={handleSuccess}
            onCancel={() => setActiveForm(null)}
          />
        </div>
      )}

      {/* Filled meta display */}
      {filledMeta && filledMeta.length > 0 && (
        <div className="text-xs text-gray-500 dark:text-gray-400">
          Заполнено: {filledMeta.map(m => META_LABELS[m] || m).join(', ')}
        </div>
      )}
    </div>
  );
}

/**
 * Compact inline version for order rows
 */
export function MetaPanelInline({
  workspaceId,
  orderId,
  shopId,
  requiredMeta,
  filledMeta,
  onUpdate,
}: Omit<MetaPanelProps, 'className'>) {
  const [showForm, setShowForm] = useState(false);
  const [activeType, setActiveType] = useState<MetaType | null>(null);

  if (!requiredMeta?.length) return null;

  const filled = new Set(filledMeta ?? []);
  const missing = requiredMeta.filter((m) => !filled.has(m)) as MetaType[];

  if (missing.length === 0) {
    return <MetaBadge requiredMeta={requiredMeta} filledMeta={filledMeta} />;
  }

  const handleClick = (type: MetaType) => {
    setActiveType(type);
    setShowForm(true);
  };

  const handleSuccess = () => {
    setShowForm(false);
    setActiveType(null);
    onUpdate?.();
  };

  if (showForm && activeType) {
    return (
      <div className="min-w-[280px]">
        <MetaForm
          workspaceId={workspaceId}
          orderId={orderId}
          shopId={shopId}
          metaType={activeType}
          onSuccess={handleSuccess}
          onCancel={() => setShowForm(false)}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <MetaBadge requiredMeta={requiredMeta} filledMeta={filledMeta} />
      {missing.slice(0, 2).map((type) => (
        <button
          key={type}
          onClick={() => handleClick(type)}
          className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400"
        >
          +{META_LABELS[type]}
        </button>
      ))}
      {missing.length > 2 && (
        <span className="text-xs text-gray-500">+{missing.length - 2}</span>
      )}
    </div>
  );
}
