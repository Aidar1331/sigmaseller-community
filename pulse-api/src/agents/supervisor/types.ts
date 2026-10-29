// Multi-Agent v2 — Supervisor type definitions (Phase 0 skeleton)

export interface DomainAgent {
  name: string; // 'pricing' | 'reviews' | 'ads' | 'supply' | 'seo' | 'chat' | 'fbs'
  description: string; // used in supervisor LLM prompt to decide routing
  /**
   * Optional tool name override. Defaults to `subagent_<name>`.
   * Exists because некоторые агенты публикуют несколько tools
   * (например, seo → subagent_seo / subagent_seo_keyword_suggestion),
   * и router может захотеть указать конкретный инструмент.
   */
  toolName?: string;
  // Phase 1+ adds: handler fn, system prompt loader, rule scope, etc.
}

export interface RoutingContext {
  workspaceId: number;
  shopId: number | null;
  userId: number;
  // LLM detail level — passed into subagent for effort scaling
  detailLevel?: 'quick' | 'thorough';
}

export interface AgentCall {
  agentName: string;
  userIntent: string; // short description of what supervisor thinks user wants
  detailLevel: 'quick' | 'thorough';
}

export type RoutingDecision =
  | { kind: 'delegate'; call: AgentCall }
  | { kind: 'passthrough' }; // supervisor yields to legacy universal agent
