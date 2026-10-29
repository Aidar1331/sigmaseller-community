'use client';

import { useEffect, useState } from 'react';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { Building2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';

interface Shop {
  shopId: number;
  name: string;
  isActive: boolean;
}

interface ShopSelectorProps {
  workspaceId: number | null;
  onWorkspaceIdChange: (v: number) => void;
  className?: string;
}

export function ShopSelector({
  workspaceId,
  onWorkspaceIdChange,
  className,
}: ShopSelectorProps) {
  const [shops, setShops] = useState<Shop[]>([]);

  useEffect(() => {
    if (!workspaceId || workspaceId <= 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/shops/${workspaceId}`);
        if (!cancelled) setShops(res.rows ?? []);
      } catch (e) {
        console.error('Shop load error:', e);
        if (!cancelled) setShops([]);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  if (shops.length === 0) {
    return (
      <div
        className={cn(
          'flex h-10 items-center rounded-xl',
          'border border-gray-300 bg-white px-3 text-sm text-gray-500',
          className
        )}
      >
        <Building2 className="mr-2 h-4 w-4 text-gray-500" />
        Магазин #{workspaceId}
      </div>
    );
  }

  return (
    <Select
      value={String(workspaceId)}
      onValueChange={(v) => onWorkspaceIdChange(Number(v))}
    >
      <SelectTrigger className={cn('h-10 text-sm', className)}>
        <SelectValue placeholder="Магазин" />
      </SelectTrigger>
      <SelectContent>
        {shops.map((s) => (
          <SelectItem key={s.shopId} value={String(s.shopId)}>
            <span className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-gray-500" />
              {s.name}
              {s.isActive && (
                <span className="ml-auto h-2 w-2 rounded-full bg-emerald-500" />
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
