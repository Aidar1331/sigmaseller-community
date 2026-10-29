'use client';

import { memo } from 'react';
import { cn } from '@/lib/cn';
import { Bot, Tag, MessageSquare, Megaphone, Package, Search, MessageCircle, Truck } from 'lucide-react';

export type AgentName = 'pricing' | 'reviews' | 'ads' | 'supply' | 'seo' | 'chat' | 'fbs';

interface AgentMeta {
  label: string;
  icon: typeof Bot;
  color: string;
}

const AGENT_META: Record<AgentName, AgentMeta> = {
  pricing: { label: 'Pricing Agent',  icon: Tag,           color: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' },
  reviews: { label: 'Reviews Agent',  icon: MessageSquare, color: 'bg-amber-500/10   text-amber-700   dark:text-amber-400   border-amber-500/30' },
  ads:     { label: 'Ads Agent',      icon: Megaphone,     color: 'bg-violet-500/10  text-violet-600  dark:text-violet-400  border-violet-500/30' },
  supply:  { label: 'Supply Agent',   icon: Package,       color: 'bg-sky-500/10     text-sky-600     dark:text-sky-400     border-sky-500/30' },
  seo:     { label: 'SEO Agent',      icon: Search,        color: 'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400 border-fuchsia-500/30' },
  chat:    { label: 'Chat Agent',     icon: MessageCircle, color: 'bg-teal-500/10    text-teal-600    dark:text-teal-400    border-teal-500/30' },
  fbs:     { label: 'FBS Agent',      icon: Truck,         color: 'bg-orange-500/10  text-orange-700  dark:text-orange-400  border-orange-500/30' },
};

interface AgentStatusBadgeProps {
  agentName: AgentName | string;
  runId?: string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Badge shown in chat when the supervisor delegates to a specific domain
 * agent. Pulled from subagent_* tool responses (agentName field).
 */
export const AgentStatusBadge = memo(function AgentStatusBadge({
  agentName,
  runId,
  size = 'sm',
  className,
}: AgentStatusBadgeProps) {
  const meta = (AGENT_META as Record<string, AgentMeta | undefined>)[agentName] ?? {
    label: `Agent: ${agentName}`,
    icon: Bot,
    color: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/30',
  };
  const Icon = meta.icon;

  const sizeClasses = size === 'sm' ? 'text-xs px-2 py-0.5 gap-1' : 'text-sm px-2.5 py-1 gap-1.5';
  const iconSize = size === 'sm' ? 12 : 14;

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border font-medium',
        meta.color,
        sizeClasses,
        className,
      )}
      title={runId ? `run ${runId.slice(0, 8)}` : meta.label}
    >
      <Icon size={iconSize} strokeWidth={2.5} />
      <span>{meta.label}</span>
    </span>
  );
});
