// Multi-Agent v2 — Supervisor public API.
//
// routeToAgent — LLM-роутер поверх зарегистрированных доменных агентов
// (domainAgentRegistry). При ENABLE_MULTI_AGENT=0 всегда возвращает
// `passthrough` и не ходит в LLM.
//
// Безопасный fallback: если LLM упал / вернул мусор / агент не найден —
// тоже passthrough. Главный ассистент справится сам.

import { requireSellerAiKey } from '../../services/sellerAiCredentials.js';
import { ChatAnthropic } from '@langchain/anthropic';
import { listAgents, getAgent } from './domainAgentRegistry.js';
import { buildSupervisorPrompt } from './supervisorPrompt.js';
import type { RoutingContext, RoutingDecision } from './types.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'supervisor.router' });

async function getRouterModel(workspaceId: number): Promise<ChatAnthropic> {
  return new ChatAnthropic({ model: 'claude-sonnet-4-6', temperature: 0, maxTokens: 256, apiKey: await requireSellerAiKey('anthropic', workspaceId), maxRetries: 0 });
}

function tryParseDecision(raw: string): RoutingDecision | null {
  // LLM иногда добавляет ```json ... ``` — снимем.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    if (obj.kind === 'passthrough') return { kind: 'passthrough' };
    if (obj.kind === 'delegate' && typeof obj.agentName === 'string') {
      const detail = obj.detailLevel === 'thorough' ? 'thorough' : 'quick';
      const userIntent = typeof obj.userIntent === 'string' ? obj.userIntent : '';
      return {
        kind: 'delegate',
        call: { agentName: obj.agentName, userIntent, detailLevel: detail },
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function routeToAgent(
  userMessage: string,
  ctx: RoutingContext,
): Promise<RoutingDecision> {
  const agents = listAgents();
  if (agents.length === 0) return { kind: 'passthrough' };

  // Триггерить LLM-роутер только если включён multi-agent режим.
  if (process.env.ENABLE_MULTI_AGENT !== '1') return { kind: 'passthrough' };

  // Лёгкий гейт: очень короткие реплики (подтверждения, привет) — passthrough.
  const trimmed = userMessage.trim();
  if (trimmed.length < 12) return { kind: 'passthrough' };

  const agentListLines = agents.map((a) => `${a.name}: ${a.description}`);
  const systemPrompt = buildSupervisorPrompt(agentListLines);

  try {
    const res = await (await getRouterModel(ctx.workspaceId)).invoke([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
          `Контекст: workspaceId=${ctx.workspaceId}, shopId=${ctx.shopId ?? 'null'}.\n` +
          `Сообщение пользователя:\n"""${trimmed}"""`,
      },
    ]);
    const text = typeof res.content === 'string'
      ? res.content
      : Array.isArray(res.content)
        ? res.content.map((c) => (typeof c === 'string' ? c : 'text' in c ? c.text : '')).join('')
        : '';
    const parsed = tryParseDecision(text);
    if (!parsed) {
      logger.warn({ workspaceId: ctx.workspaceId, raw: text.slice(0, 120) }, 'router: cannot parse LLM output');
      return { kind: 'passthrough' };
    }
    if (parsed.kind === 'delegate' && !getAgent(parsed.call.agentName)) {
      logger.warn({ agentName: parsed.call.agentName }, 'router: unknown agent → passthrough');
      return { kind: 'passthrough' };
    }
    logger.info(
      { workspaceId: ctx.workspaceId, kind: parsed.kind, agent: parsed.kind === 'delegate' ? parsed.call.agentName : null },
      'router decision',
    );
    return parsed;
  } catch (err) {
    logger.warn({ err }, 'router LLM failed → passthrough');
    return { kind: 'passthrough' };
  }
}

export { listAgents, registerAgent, getAgent, getToolNameForAgent } from './domainAgentRegistry.js';
export { SUPERVISOR_SYSTEM_PROMPT, buildSupervisorPrompt } from './supervisorPrompt.js';
export type { DomainAgent, AgentCall, RoutingContext, RoutingDecision } from './types.js';
