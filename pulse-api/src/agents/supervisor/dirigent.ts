import { runWithAiWorkspace } from '../../lib/sellerAiContext.js';
import { requireSellerAiKey } from '../../services/sellerAiCredentials.js';
// Multi-Agent v2 Phase 6 — Cross-agent dirigent.
//
// When a user request spans multiple domain agents (e.g. "сделай переоценку
// и обнови ставки рекламы под новые цены"), a single supervisor-delegation
// is not enough. The dirigent plans an ordered sequence of subagent calls,
// each linked by a shared correlation_id, so their execution_runs and
// verification_checks are queryable as one logical flow.
//
// Used from graph.ts when multiple subagents are relevant. Returns a plan
// the main agent executes step by step (no direct execution here — dirigent
// is planning, graph/subagents do the work).

import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../env.js';
import { logAgent as logger } from '../../lib/logger.js';
import { listAgents } from './domainAgentRegistry.js';

export interface DirigentStep {
  agentName: string;
  userIntent: string;
  detailLevel: 'quick' | 'thorough';
  depends_on?: number; // index into plan[] whose output is expected
  rationale: string;
}

export interface DirigentPlan {
  correlationId: string;
  steps: DirigentStep[];
  reasoning: string;
}

const DIRIGENT_MODEL = 'claude-sonnet-4-6';

// Quick heuristic — if the request clearly maps to one domain, skip dirigent.
// Return null when single-agent delegation is sufficient.
export async function planMultiAgentFlow(userMessage: string, workspaceId: number): Promise<DirigentPlan | null> {
return runWithAiWorkspace(workspaceId, async () => {

  const agents = listAgents();
  if (agents.length < 2) return null;

  // Heuristic triggers for multi-agent flows. Any match runs the LLM planner.
  const msg = userMessage.toLowerCase();
  const multiAgentTriggers = [
    /цен[ауые].*реклам/, /реклам.*цен/, // pricing+ads
    /цен[ауые].*поставк/, /поставк.*цен/, // pricing+supply
    /отзыв.*цен/, /цен.*отзыв/, // reviews+pricing
    /seo.*цен/, /цен.*seo/, // seo+pricing
    /комплексн/, /одновременно/, /и\s+.+\s+и\s+/, // explicit multi-op
  ];
  if (!multiAgentTriggers.some((r) => r.test(msg))) return null;

  if (!(await requireSellerAiKey('anthropic'))) {
    logger.warn('dirigent: no ANTHROPIC_API_KEY, skipping');
    return null;
  }

  try {
    const client = new Anthropic({ maxRetries: 0, apiKey: (await requireSellerAiKey('anthropic')) });
    const agentsList = agents.map((a) => `- ${a.name}: ${a.description}`).join('\n');

    const response = await client.messages.create({
      model: DIRIGENT_MODEL,
      max_tokens: 800,
      system: `Ты — дирижёр мульти-агентной команды Sigma Seller. Пользователь просит что-то, затрагивающее несколько доменов. Составь план: последовательность вызовов subagent'ов с depends_on (если нужны результаты предыдущих). Каждый шаг — {agentName, userIntent, detailLevel, depends_on?, rationale}.

Доступные домены:
${agentsList}

Отвечай строго JSON: {"steps": [...], "reasoning": "..."}. Не больше 4 шагов. Если запрос однодоменный — верни {"steps": [], "reasoning": "single-domain, no coordination needed"}.`,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
    const parsed = extractPlanJson(text);
    if (!parsed) {
      logger.warn({ workspaceId, textLen: text.length, textPreview: text.slice(0, 200) }, 'dirigent: could not parse JSON from LLM response');
      return null;
    }
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      logger.info({ workspaceId, reasoning: parsed.reasoning }, 'dirigent: single-domain or empty plan');
      return null;
    }

    // Sanity filter: only keep steps for known agents
    const known = new Set(agents.map((a) => a.name));
    const filtered = parsed.steps.filter((s) => known.has(s.agentName)).slice(0, 4);
    if (filtered.length === 0) {
      logger.warn({ workspaceId, rawSteps: parsed.steps, knownAgents: Array.from(known) }, 'dirigent: all steps rejected as unknown agents');
      return null;
    }

    return {
      correlationId: randomUUID(),
      steps: filtered,
      reasoning: parsed.reasoning ?? '',
    };
  } catch (err) {
    logger.error({ err, workspaceId }, 'dirigent planning failed');
    return null;
  }

});
}

// Extract JSON plan from LLM response. Handles: raw JSON, ```json blocks,
// JSON wrapped in prose, trailing commentary after JSON. Returns null if
// no valid plan-shaped object can be parsed.
function extractPlanJson(text: string): { steps: DirigentStep[]; reasoning: string } | null {
  // 1. Markdown fence: ```json\n{...}\n```
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]) as { steps: DirigentStep[]; reasoning: string };
    } catch {
      // fall through to next strategy
    }
  }

  // 2. Scan for the first balanced {...} block. A greedy /\{[\s\S]*\}/ is too
  //    eager — it grabs commentary after the JSON and breaks JSON.parse.
  const startIdx = text.indexOf('{');
  if (startIdx < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(startIdx, i + 1);
        try {
          return JSON.parse(candidate) as { steps: DirigentStep[]; reasoning: string };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Render a plan as a human-readable brief to drop into the agent's context.
export function formatPlanForAgent(plan: DirigentPlan): string {
  const steps = plan.steps
    .map((s, i) => `${i + 1}. subagent_${s.agentName} (${s.detailLevel}${s.depends_on != null ? `, depends on step ${s.depends_on + 1}` : ''}): ${s.userIntent}`)
    .join('\n');
  return `📋 Multi-agent план (correlation ${plan.correlationId.slice(0, 8)}):
${plan.reasoning}
${steps}

Выполни шаги последовательно через subagent_* tool calls. Передай _correlationId="${plan.correlationId}" в каждый вызов.`;
}
