'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Zap } from 'lucide-react';

interface RateLimitStatus {
  used: number;
  limit: number;
  remaining: number;
  resetsInMinutes: number;
  estimatedKeywordsRemaining: number;
}

export function RateLimitBadge({ workspaceId }: { workspaceId: number }) {
  const { data, isLoading } = useQuery<RateLimitStatus>({
    queryKey: ['seo-rate-limit', workspaceId],
    queryFn: () => apiFetch<RateLimitStatus>(`/seo/${workspaceId}/rate-limit`),
    refetchInterval: 30000,
  });

  if (isLoading || !data) return null;

  const pct = (data.remaining / data.limit) * 100;
  const variant = pct > 50 ? 'success' : pct > 20 ? 'warning' : 'danger';

  return (
    <Badge variant={variant} className="gap-1">
      <Zap className="h-3 w-3" />
      {data.remaining}/{data.limit}
      {data.resetsInMinutes > 0 && (
        <span className="text-xs opacity-70 ml-1">
          ({data.resetsInMinutes}м)
        </span>
      )}
    </Badge>
  );
}
