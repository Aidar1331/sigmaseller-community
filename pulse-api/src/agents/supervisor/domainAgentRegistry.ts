// Multi-Agent v2 — registry of available domain agents.

import type { DomainAgent } from './types.js';

const registry = new Map<string, DomainAgent>();

export function registerAgent(agent: DomainAgent): void {
  registry.set(agent.name, agent);
}

export function getAgent(name: string): DomainAgent | undefined {
  return registry.get(name);
}

export function listAgents(): DomainAgent[] {
  return Array.from(registry.values());
}

/**
 * Маппинг agentName → имя subagent_* tool.
 * По умолчанию `subagent_<name>`; если у агента задан `toolName` — используется он.
 * Возвращает null если агент не зарегистрирован.
 */
export function getToolNameForAgent(agentName: string): string | null {
  const a = registry.get(agentName);
  if (!a) return null;
  return a.toolName ?? `subagent_${agentName}`;
}

// Preregister Phase 1 MVP agents so LLM-router видит их на старте.
// Tools с такими же именами должны существовать в agents/tools/index.ts
// и быть зарегистрированы при ENABLE_MULTI_AGENT=1.
registerAgent({
  name: 'supply',
  description:
    'Планирование поставок FBO: анализ остатков + скорости продаж, рекомендации qty и срочности. Создание поставок, мастер-виджет, лист приёмки (PDF).',
});
registerAgent({
  name: 'seo',
  description:
    'Мониторинг позиций товаров в поисковой выдаче WB: алерты падений/роста. Предложение новых keywords на отслеживание (mining wb_search_queries).',
});
registerAgent({
  name: 'pricing',
  description:
    'Рекомендации по ценам: маржа, ROCE, сценарии повышения/снижения. LLM-summary с учётом конкурентов и guardrails.',
});
registerAgent({
  name: 'ads',
  description:
    'Реклама: ДРР, ставки, кампании. Управление и анализ рекламных кампаний.',
});
registerAgent({
  name: 'reviews',
  description:
    'Отзывы и вопросы покупателей: классификация, подбор ответа, auto-reply.',
});
