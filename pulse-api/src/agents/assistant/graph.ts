import { runWithAiWorkspace } from '../../lib/sellerAiContext.js';
import { requireSellerAiKey } from '../../services/sellerAiCredentials.js';
/**
 * LangGraph ReAct Agent for Pulse AI Assistant.
 *
 * Architecture:
 *   [user message] → agentNode (LLM) → toolsNode → agentNode → ...
 *                                     ↘ confirmNode → (interrupt) → executeNode
 *
 * Uses Claude Sonnet 4.6 (claude-sonnet-4-6) via @langchain/anthropic.
 * State is persisted via PostgresSaver checkpointer.
 */

import { StateGraph, Annotation, MessagesAnnotation, interrupt, Command } from '@langchain/langgraph';
import { ChatAnthropic } from '@langchain/anthropic';
import { AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { getCheckpointer } from '../checkpointer.js';
import { buildSystemPromptParts, type PromptContext } from './systemPrompt.js';
import { allTools, getToolByName, DANGEROUS_TOOLS } from '../tools/index.js';
import { acquireLock, releaseLock } from '../tools/locks.js';
import { logAgent as logger } from '../../lib/logger.js';
import { checkBalance, deductUsage } from '../../services/aiTokens.js';
import { env } from '../../env.js';

// ── State Definition ───────────────────────────────────────

export const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,

  // Workspace context (injected at conversation start)
  // Use reducer to preserve value across checkpoint restore
  workspaceId: Annotation<number>({
    reducer: (prev, next) => next ?? prev,
    default: () => 0,
  }),
  userId: Annotation<number | null>({
    reducer: (prev, next) => next ?? prev,
    default: () => null,
  }),
  shopId: Annotation<number | null>({
    reducer: (prev, next) => next ?? prev,
    default: () => null,
  }),
  promptContext: Annotation<PromptContext>({
    reducer: (prev, next) => next ?? prev,
    default: () => ({ workspaceName: '', shopNames: [], alertThresholds: undefined, agentSettings: undefined }),
  }),

  // Pending confirmation.
  // Explicit reducer: ONLY overwrite when the update explicitly sets a value
  // (including null). If a node returns a partial state without pendingAction,
  // preserve the previous value — otherwise restoring from a checkpoint where
  // an interrupt is pending and then running any other node would wipe the
  // pending-action context and lose the confirmation flow.
  pendingAction: Annotation<{
    toolName: string;
    toolArgs: Record<string, unknown>;
    toolCallId: string;
    rationale: string;
  } | null>({
    reducer: (prev, next) => (next === undefined ? (prev ?? null) : next),
    default: () => null,
  }),

  // Last user decision captured by confirmNode (resume payload).
  // Kept outside `messages` so the tool_use/tool_result pair from the AI
  // turn and executeNode stays adjacent — Anthropic rejects any interleaving
  // ("tool_use ids were found without tool_result blocks immediately after").
  lastUserDecision: Annotation<string | null>({
    reducer: (prev, next) => (next === undefined ? (prev ?? null) : next),
    default: () => null,
  }),

  // SSE tracking
  sseEventCounter: Annotation<number>,
});

export type AgentStateType = typeof AgentState.State;

// ── LLM Model (singleton) ──────────────────────────────────

let _modelInstance: ChatAnthropic | null = null;

async function getModel(): Promise<ChatAnthropic> {
  return new ChatAnthropic({ model: 'claude-sonnet-4-6', temperature: 0.3, maxTokens: 16384, apiKey: await requireSellerAiKey('anthropic'), maxRetries: 0 });
}

// ── Nodes ──────────────────────────────────────────────────

/**
 * Agent node: calls LLM with tools bound.
 * LLM decides whether to call a tool or respond to user.
 */
async function agentNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
return runWithAiWorkspace(state.workspaceId, async () => {

  // Check AI token balance before calling Claude
  if (state.workspaceId != null && state.workspaceId > 0) {
    const balanceCheck = await checkBalance(state.workspaceId);
    if (!balanceCheck.allowed) {
      const msg = new AIMessage({
        content: `⚠️ Недостаточно средств на AI-балансе. Текущий баланс: ${(balanceCheck.balanceKopecks / 100).toFixed(2)} ₽. Пополните баланс в настройках.`,
      });
      return { messages: [msg] };
    }
  }

  // Multi-Agent v2 — Supervisor pre-route. При ENABLE_MULTI_AGENT=1 и это
  // первый turn (последнее сообщение — user), вызываем LLM-router; если он
  // решил `delegate` на один доменный агент — синтезируем tool_call без
  // захода в основной LLM-hop. Экономия: ~70% токенов на single-domain запросах
  // (роутер 256 токенов вместо полного ассистента 16k).
  //
  // Почему здесь, до (await getModel()).bindTools:
  //   - Роутер НЕ должен влиять на обычный flow при passthrough.
  //   - На continuation turns (после tool_result) роутер пропускаем — иначе
  //     затрём ReAct-цикл.
  if (env.ENABLE_MULTI_AGENT === '1' && state.messages.length > 0) {
    const last = state.messages[state.messages.length - 1];
    const isHumanLast = (last as { _getType?: () => string })._getType?.() === 'human';
    if (isHumanLast) {
      try {
        const { routeToAgent, getToolNameForAgent } = await import('../supervisor/index.js');
        const content = typeof last.content === 'string' ? last.content : '';
        const decision = await routeToAgent(content, {
          workspaceId: state.workspaceId,
          shopId: state.shopId,
          userId: state.userId ?? 0,
        });
        if (decision.kind === 'delegate') {
          const toolName = getToolNameForAgent(decision.call.agentName);
          const tool = toolName ? getToolByName(toolName) : null;
          if (toolName && tool) {
            logger.info(
              { workspaceId: state.workspaceId, agent: decision.call.agentName, tool: toolName },
              'supervisor pre-route → synthetic tool_call (skip main LLM hop)',
            );
            const callId = `router_${Date.now()}`;
            const synthetic = new AIMessage({
              content: '',
              tool_calls: [
                {
                  id: callId,
                  name: toolName,
                  args: {
                    userIntent: decision.call.userIntent || content,
                    detailLevel: decision.call.detailLevel,
                  },
                },
              ],
            });
            return {
              messages: [synthetic],
              sseEventCounter: (state.sseEventCounter ?? 0) + 1,
            };
          }
          logger.warn(
            { agent: decision.call.agentName, toolName },
            'supervisor delegate → tool not found, falling back to main LLM',
          );
        }
      } catch (err) {
        logger.error({ err }, 'supervisor pre-route failed (non-fatal, falling back)');
      }
    }
  }

  const model = (await getModel());
  const modelWithTools = model.bindTools(allTools);

  // Build the system prompt in two parts so Anthropic prompt caching can hit
  // on the static ~16 000-token prefix (Layers 1/2/4/4.5/5 + tool definitions)
  // and skip re-tokenising it on every agentic turn. The dynamic tail carries
  // workspace context, page-summary, current date and (when applicable) the
  // dirigent plan — all of which vary per call and would bust the cache.
  // Cache hits are billed at ~10% of the uncached input-token rate.
  const { cached, dynamic } = buildSystemPromptParts(state.promptContext);
  let dynamicTail = dynamic;

  // Multi-Agent v2 Phase 6 — dirigent (cross-agent planner). If the last user
  // message this turn hits multi-domain heuristics, append a plan brief to
  // the DYNAMIC tail of the system message so plan injection never busts the
  // cacheable prefix. Anthropic rejects multiple system messages, so we keep
  // everything in one SystemMessage with two content blocks.
  if (env.ENABLE_MULTI_AGENT === '1' && state.messages.length > 0) {
    const lastHuman = [...state.messages].reverse().find((m) => (m as { _getType?: () => string })._getType?.() === 'human');
    const content = lastHuman && typeof lastHuman.content === 'string' ? lastHuman.content : null;
    if (content) {
      try {
        const { planMultiAgentFlow, formatPlanForAgent } = await import('../supervisor/dirigent.js');
        const plan = await planMultiAgentFlow(content, state.workspaceId);
        if (plan) {
          dynamicTail += '\n\n' + formatPlanForAgent(plan);
          logger.info({ correlationId: plan.correlationId, steps: plan.steps.length }, 'dirigent plan injected');
        }
      } catch (err) {
        logger.error({ err }, 'dirigent planMultiAgentFlow failed (non-fatal)');
      }
    }
  }

  // Two-block SystemMessage content. `cache_control: { type: 'ephemeral' }`
  // on the first block tells Anthropic to cache everything up to and including
  // that block — which in request ordering is tools + that system prefix.
  // LangChain's _convertMessagesToAnthropicPayload forwards SystemMessage
  // content arrays verbatim into Anthropic's `system` parameter.
  const systemMsg = new SystemMessage({
    content: [
      { type: 'text', text: cached, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: dynamicTail },
    ] as any,
  });
  const messages: BaseMessage[] = [systemMsg, ...state.messages];

  try {
    const response = await modelWithTools.invoke(messages);

    // Deduct AI tokens after successful call.
    //
    // Anthropic prompt-caching token accounting:
    //   usage.input_tokens             — uncached input (billed at 1× rate)
    //   cache_creation_input_tokens    — tokens written to cache (1.25× rate)
    //   cache_read_input_tokens        — tokens served from cache (0.10× rate)
    //
    // LangChain surfaces these on `usage_metadata.input_token_details`. We log
    // them for observability; `deductUsage` still takes plain inputTokens and
    // will be updated in a follow-up to weight cache vs fresh tokens correctly.
    if (state.workspaceId && (response as any).usage_metadata) {
      // IMPORTANT — LangChain-Anthropic billing gotcha.
      //
      // LangChain's `usage_metadata.input_tokens` SUMS Anthropic's raw
      // `input_tokens + cache_read_input_tokens` into one field. This is
      // non-standard: Anthropic's native `usage.input_tokens` is uncached-only.
      // If we bill from LangChain's summed value we charge customers for cache
      // hits at the full 1× rate AND 0.10× again — ~10× over-bill on cached
      // turns. Always read the RAW Anthropic usage from response_metadata.
      const rawUsage = ((response as any).response_metadata?.usage ?? {}) as {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      const lcUsage = (response as any).usage_metadata ?? {};
      const inputTokens = rawUsage.input_tokens ?? lcUsage.input_tokens ?? 0;
      const outputTokens = rawUsage.output_tokens ?? lcUsage.output_tokens ?? 0;
      const cacheRead = rawUsage.cache_read_input_tokens ?? lcUsage.input_token_details?.cache_read ?? 0;
      const cacheCreation = rawUsage.cache_creation_input_tokens ?? lcUsage.input_token_details?.cache_creation ?? 0;
      // (session-26 debug logger removed — cache accounting verified)
      if (inputTokens > 0 || outputTokens > 0) {
        try {
          await deductUsage({
            workspaceId: state.workspaceId,
            userId: state.userId ?? 0,
            inputTokens,
            outputTokens,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheCreation,
            model: 'claude-sonnet-4-6',
            toolsUsed: (response as any).tool_calls?.map((tc: any) => tc.name) ?? [],
          });
          if (cacheRead > 0 || cacheCreation > 0) {
            logger.info(
              { inputTokens, outputTokens, cacheRead, cacheCreation, cacheHitRatio: cacheRead > 0 ? +(cacheRead / (inputTokens + cacheRead)).toFixed(2) : 0 },
              'prompt cache stats',
            );
          }
        } catch (err) {
          logger.error({ err, workspaceId: state.workspaceId }, 'CRITICAL: Failed to deduct AI tokens');
        }
      }
    }

    return {
      messages: [response],
      sseEventCounter: (state.sseEventCounter ?? 0) + 1,
    };
  } catch (err) {
    // LLM provider down or request too large — graceful fallback.
    // Log the underlying error so we can distinguish transient network issues
    // from prompt-length / rate-limit / API-key problems.
    logger.error({
      err,
      workspaceId: state.workspaceId,
      messagesCount: state.messages.length,
      hasMultiAgent: env.ENABLE_MULTI_AGENT === '1',
    }, 'agentNode LLM invoke failed');
    const errorMsg = new AIMessage({
      content: '⚠️ Извините, произошла ошибка при обработке запроса. Попробуйте через несколько секунд.',
    });
    return { messages: [errorMsg] };
  }

});
}

/**
 * Tools node: executes safe (non-dangerous) tool calls.
 */
async function toolsNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
return runWithAiWorkspace(state.workspaceId, async () => {

  const lastMessage = state.messages[state.messages.length - 1];

  if (!isAIMessage(lastMessage) || !lastMessage.tool_calls?.length) {
    return {};
  }

  const results: ToolMessage[] = [];

  for (const toolCall of lastMessage.tool_calls) {
    const tool = getToolByName(toolCall.name);
    if (!tool) {
      results.push(
        new ToolMessage({
          tool_call_id: toolCall.id!,
          content: `Инструмент "${toolCall.name}" не найден.`,
        })
      );
      continue;
    }

    try {
      // Inject workspaceId into all tool calls for security
      if (!state.workspaceId) {
        // Log without sensitive data exposure
        logger.warn({ tool: toolCall.name }, 'Missing workspaceId for tool');
      }

      // Guard: reject tool calls without shopId (prevents querying ALL shops)
      if (!state.shopId) {
        results.push(
          new ToolMessage({
            tool_call_id: toolCall.id!,
            content: JSON.stringify({ error: 'shopId is required. Ask the user to select a shop.' }),
          })
        );
        continue;
      }

      const argsWithContext = {
        ...toolCall.args,
        _workspaceId: state.workspaceId,
        _shopId: state.shopId,
        _userId: state.userId,
      };

      logger.info({ tool: toolCall.name, _shopId: state.shopId, _workspaceId: state.workspaceId }, 'TOOL CALL with context');

      const result = await (tool as any).invoke(argsWithContext);
      results.push(
        new ToolMessage({
          tool_call_id: toolCall.id!,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        })
      );
    } catch (err) {
      results.push(
        new ToolMessage({
          tool_call_id: toolCall.id!,
          content: `Ошибка: ${err instanceof Error ? err.message : String(err)}`,
        })
      );
    }
  }

  return { messages: results };

});
}

/**
 * Confirmation node: pauses execution and asks user for confirmation.
 * Used for dangerous tools (set_price, reply_feedback, etc.)
 */
async function confirmNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const pending = state.pendingAction;
  if (!pending) return {};

  // Interrupt graph execution — waits for user response via Command({ resume })
  const userDecision = interrupt({
    type: 'confirm_action',
    action: pending.toolName,
    args: maskToolArgs(pending.toolArgs),
    rationale: pending.rationale,
    toolCallId: pending.toolCallId,
  });

  // Do NOT add a HumanMessage between the AI's tool_use and executeNode's
  // ToolMessage — Anthropic requires them adjacent. Decision lives in state.
  return { lastUserDecision: String(userDecision) };
}

/**
 * Execute node: runs the confirmed dangerous tool.
 */
async function executeNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  // Decision lives in state (set by confirmNode) — NOT in messages, so we don't
  // break tool_use/tool_result adjacency required by Anthropic.
  const content = state.lastUserDecision ?? '';

  // Guard: pending action MUST exist at this point — otherwise executeNode
  // was reached without a prior confirm (state desync / checkpoint restore edge).
  // Check this FIRST so a stale or ambiguous user message never triggers a
  // no-pending-action tool invoke.
  const pending = state.pendingAction;
  if (!pending) {
    return {
      messages: [new AIMessage({ content: 'Нет действия для выполнения — возможно, предыдущая сессия завершена.' })],
      pendingAction: null,
      lastUserDecision: null,
    };
  }

  const decision = classifyUserDecision(content);

  if (decision === 'cancel' || decision === 'ambiguous') {
    const isNegative = decision === 'cancel';
    return {
      messages: [new AIMessage({ content: isNegative ? 'Действие отменено.' : 'Не распознано подтверждение — действие отменено для безопасности. Чтобы выполнить, ответьте "да" / "подтверждаю".' })],
      pendingAction: null,
      lastUserDecision: null,
    };
  }

  const tool = getToolByName(pending.toolName);
  if (!tool) {
    return {
      messages: [
        new ToolMessage({
          tool_call_id: pending.toolCallId,
          content: 'Инструмент не найден.',
        }),
      ],
      pendingAction: null,
      lastUserDecision: null,
    };
  }

  // Multi-Agent v2 Phase 4 — Supervisor deterministic risk assessment.
  // Runs BEFORE lock acquisition + WB call. Red verdict blocks the action.
  if (env.ENABLE_MULTI_AGENT === '1' && DANGEROUS_TOOLS.has(pending.toolName)) {
    try {
      const { assessRisk } = await import('../supervisor/riskAssessor.js');
      const risk = await assessRisk({
        toolName: pending.toolName,
        toolArgs: pending.toolArgs,
        workspaceId: state.workspaceId,
        userId: state.userId,
      });
      // Escalate yellow → LLM arbitrator (may upgrade to green or downgrade to red)
      let finalRisk = risk;
      if (risk.verdict === 'yellow') {
        const { arbitrateYellow } = await import('../supervisor/llmArbiter.js');
        finalRisk = await arbitrateYellow({
          toolName: pending.toolName,
          toolArgs: pending.toolArgs,
          workspaceId: state.workspaceId,
          userId: state.userId,
        }, risk);
        logger.info({ toolName: pending.toolName, original: 'yellow', arbiter: finalRisk.verdict, reason: finalRisk.reason }, 'supervisor yellow arbitrated');
      }
      if (finalRisk.verdict === 'red') {
        return {
          messages: [
            new ToolMessage({
              tool_call_id: pending.toolCallId,
              content: JSON.stringify({
                status: 'blocked_by_supervisor',
                verdict: 'red',
                rule: finalRisk.rule,
                reason: finalRisk.reason,
                message: `⛔ Действие заблокировано супервайзером: ${finalRisk.reason ?? finalRisk.rule}`,
              }),
            }),
          ],
          pendingAction: null,
          lastUserDecision: null,
        };
      }
    } catch (riskErr) {
      logger.error({ err: riskErr, toolName: pending.toolName }, 'supervisor risk assessment failed (non-fatal, proceeding)');
    }
  }

  // Acquire lock before executing dangerous tool.
  // Key must include identifying resource IDs (nmId/orderId/etc.) so parallel
  // actions on DIFFERENT resources don't collide, and parallel actions on the
  // SAME resource do block each other.
  const lockResource = buildLockResource(pending.toolName, pending.toolArgs);
  const lockAcquired = await acquireLock(state.workspaceId, pending.toolName, lockResource, `agent:${pending.toolCallId}`);
  if (!lockAcquired) {
    return {
      messages: [
        new ToolMessage({
          tool_call_id: pending.toolCallId,
          content: 'Действие уже выполняется другим процессом. Попробуйте позже.',
        }),
      ],
      pendingAction: null,
      lastUserDecision: null,
    };
  }

  try {
    // CRITICAL: pass full auth context (userId + shopId) — assertAgentAuth in
    // every action tool validates both. Omitting either field makes dangerous
    // tools fail with "Agent auth failed: missing userId or workspaceId".
    const result = await (tool as any).invoke({
      ...pending.toolArgs,
      _workspaceId: state.workspaceId,
      _shopId: state.shopId,
      _userId: state.userId,
      _confirmed: true,
    });
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

    // Multi-Agent v2 Phase 0 — schedule V&V checks for successful dangerous actions.
    // Completely no-op when ENABLE_MULTI_AGENT=0 (default). Failure here is advisory:
    // it must never break the original tool response.
    if (env.ENABLE_MULTI_AGENT === '1' && DANGEROUS_TOOLS.has(pending.toolName)) {
      try {
        const parsed = JSON.parse(resultStr) as { actionId?: number; status?: string };
        if (parsed.actionId && parsed.status && parsed.status !== 'error' && parsed.status !== 'locked') {
          const { scheduleVerification } = await import('../../services/agentVerification/index.js');
          await scheduleVerification(parsed.actionId, { toolName: pending.toolName, toolArgs: pending.toolArgs });
        }
      } catch (hookErr) {
        logger.error({ err: hookErr, toolName: pending.toolName }, 'V&V scheduleVerification hook failed (non-fatal)');
      }
    }

    return {
      messages: [
        new ToolMessage({
          tool_call_id: pending.toolCallId,
          content: resultStr,
        }),
      ],
      pendingAction: null,
      lastUserDecision: null,
    };
  } catch (err) {
    return {
      messages: [
        new ToolMessage({
          tool_call_id: pending.toolCallId,
          content: `Ошибка выполнения: ${err instanceof Error ? err.message : String(err)}`,
        }),
      ],
      pendingAction: null,
      lastUserDecision: null,
    };
  } finally {
    await releaseLock(state.workspaceId, pending.toolName, lockResource);
  }
}

// ── Routing ────────────────────────────────────────────────

/**
 * After agentNode: decide whether to route to tools, confirmation, or end.
 */
function routeAfterAgent(state: AgentStateType): string {
  const lastMessage = state.messages[state.messages.length - 1];

  if (!isAIMessage(lastMessage) || !lastMessage.tool_calls?.length) {
    return '__end__';
  }

  // Check if any tool call is dangerous (needs confirmation)
  const hasDangerous = lastMessage.tool_calls.some((tc) =>
    DANGEROUS_TOOLS.has(tc.name)
  );

  if (hasDangerous) {
    // Extract the first dangerous tool call for confirmation
    const dangerous = lastMessage.tool_calls.find((tc) => DANGEROUS_TOOLS.has(tc.name))!;
    // We need to store the pending action in state
    // This is done by returning to a special routing node
    return 'confirm';
  }

  return 'tools';
}

/**
 * Prepare state for confirmation by extracting the dangerous tool call.
 */
async function prepareConfirmNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const lastMessage = state.messages[state.messages.length - 1];

  if (!isAIMessage(lastMessage) || !lastMessage.tool_calls?.length) {
    return {};
  }

  const dangerous = lastMessage.tool_calls.find((tc) => DANGEROUS_TOOLS.has(tc.name));
  if (!dangerous) return {};

  // Extract rationale from the AI message content
  const content = typeof lastMessage.content === 'string' ? lastMessage.content : '';
  let rationale = content || 'Требуется подтверждение действия.';

  // Enrich rationale for action_set_price with the current price+discount block
  // so the user sees what they're changing FROM, not just the new value.
  // Failures here are advisory — they must never block the confirmation prompt.
  if (dangerous.name === 'action_set_price') {
    try {
      const args = dangerous.args as { nmId?: number; newPriceKop?: number; newDiscountPct?: number };
      if (args.nmId && args.newPriceKop && state.workspaceId) {
        const { getCurrentPriceInfo, formatCurrentPriceLine, computeNewFinalKop } = await import('../tools/priceInfo.js');
        const current = await getCurrentPriceInfo(state.workspaceId, state.shopId ?? null, args.nmId);
        const newCalc = computeNewFinalKop(args.newPriceKop, args.newDiscountPct, current?.discountPct ?? null);
        const newBaseRub = Math.round(args.newPriceKop / 100);
        const newFinalRub = Math.round(newCalc.finalKop / 100);
        const currentLine = formatCurrentPriceLine(current);
        const becomeLine = newCalc.discountPctUsed > 0
          ? `Станет: ${newBaseRub} ₽ × −${newCalc.discountPctUsed}% = ${newFinalRub} ₽`
          : `Станет: ${newBaseRub} ₽ (без скидки продавца)`;
        const block = [currentLine, becomeLine].filter(Boolean).join('\n');
        if (block) rationale = `${block}\n\n${rationale}`;
      }
    } catch (err) {
      logger.error({ err, toolName: dangerous.name }, 'price enrichment for confirm failed (non-fatal)');
    }
  }

  return {
    pendingAction: {
      toolName: dangerous.name,
      toolArgs: dangerous.args as Record<string, unknown>,
      toolCallId: dangerous.id!,
      rationale,
    },
  };
}

// ── Graph Assembly ─────────────────────────────────────────

export async function buildAgentGraph() {
  const checkpointer = await getCheckpointer();

  const graph = new StateGraph(AgentState)
    // Nodes
    .addNode('agent', agentNode)
    .addNode('tools', toolsNode)
    .addNode('prepare_confirm', prepareConfirmNode)
    .addNode('confirm', confirmNode)
    .addNode('execute', executeNode)

    // Edges
    .addEdge('__start__', 'agent')
    .addConditionalEdges('agent', routeAfterAgent, {
      tools: 'tools',
      confirm: 'prepare_confirm',
      __end__: '__end__',
    })
    .addEdge('tools', 'agent')       // After safe tools → back to agent
    .addEdge('prepare_confirm', 'confirm')
    .addEdge('confirm', 'execute')     // After user decision → execute or cancel
    .addEdge('execute', 'agent');      // After execution → back to agent for summary

  return graph.compile({ checkpointer });
}

// ── Helpers ────────────────────────────────────────────────

function isAIMessage(msg: BaseMessage): msg is AIMessage {
  return msg._getType() === 'ai';
}

/**
 * Classify the user's resumed decision after an `interrupt()` confirm prompt.
 *
 * Returns:
 *  - 'confirm'  — explicit positive signal (да / подтверждаю / подтверждаю. / yes / ок / выполни / …)
 *  - 'cancel'   — explicit negative signal (нет / отменяю / не надо / stop / …)
 *  - 'ambiguous' — anything else → treated as cancel by executeNode (safe default).
 *
 * \p{L}* after Russian stems allows any conjugation suffix. Without it, the strings
 * sent by /ai/chat/resume ("Подтверждаю." / "Отменяю.") fail the boundary check
 * and every inline-button click gets cancelled.
 */
export type UserDecision = 'confirm' | 'cancel' | 'ambiguous';

const POSITIVE_RE = /(^|\s)(да|yes|ok|ок|окей|подтвержд\p{L}*|confirm|выполн\p{L}*|делай\p{L}*|поехали|запусти\p{L}*|примен\p{L}*|apply|go|давай)(\s|[!,.?]|$)/u;
const NEGATIVE_RE = /(^|\s)(нет|стоп|stop|cancel|отмен\p{L}*|отказ\p{L}*|нельзя|не\s+надо|не\s+выполн\p{L}*|не\s+делай\p{L}*)(\s|[!,.?]|$)/u;

export function classifyUserDecision(raw: string): UserDecision {
  const lower = (raw ?? '').toLowerCase().trim();
  if (!lower) return 'ambiguous';

  const isNegative =
    NEGATIVE_RE.test(lower) ||
    lower === 'no' || lower === 'н' || lower === '/cancel';
  const isPositive =
    POSITIVE_RE.test(lower) ||
    lower === 'y' || lower === 'д' || lower === '+' || lower === '/confirm';

  // Negative wins if both match (safe default for edge cases like "не делай").
  if (isNegative) return 'cancel';
  if (isPositive) return 'confirm';
  return 'ambiguous';
}

/**
 * Mask sensitive tool arguments for the confirmation prompt.
 * Prevents leaking internal API details to the user.
 */
export function maskToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...args };
  // Remove internal keys
  delete masked._workspaceId;
  delete masked._userId;
  delete masked._shopId;
  delete masked._confirmed;

  // Convert prices from kopecks to rubles for display
  if (typeof masked.newPrice === 'number') {
    masked.newPrice = `${(masked.newPrice as number / 100).toFixed(0)} ₽`;
  }
  if (typeof masked.oldPrice === 'number') {
    masked.oldPrice = `${(masked.oldPrice as number / 100).toFixed(0)} ₽`;
  }

  // Truncate free-form text fields that may contain PII or copy-paste from chats
  if (typeof masked.replyText === 'string' && masked.replyText.length > 120) {
    masked.replyText = masked.replyText.slice(0, 120) + '…';
  }
  if (typeof masked.message === 'string' && masked.message.length > 120) {
    masked.message = masked.message.slice(0, 120) + '…';
  }
  // Opaque IDs — show short prefix only so the user recognises the record
  // without leaking full internal/WB identifiers into logs.
  for (const key of ['feedbackId', 'chatId', 'messageId', 'questionId'] as const) {
    const v = masked[key];
    if (typeof v === 'string' && v.length > 10) {
      masked[key] = v.slice(0, 6) + '…' + v.slice(-2);
    }
  }
  // Barcodes — keep last 4 only (like credit-card masking)
  if (typeof masked.barcode === 'string' && masked.barcode.length > 4) {
    masked.barcode = '****' + masked.barcode.slice(-4);
  }

  return masked;
}

/**
 * Build a deterministic lock resource key for a dangerous tool invocation.
 * Keys must be:
 *   - UNIQUE per (tool, target resource) so distinct targets don't block each other.
 *   - STABLE across calls with the same logical target (order of JSON keys etc.).
 *
 * We prefer explicit identifier fields; fall back to a hash of sorted args
 * only if no identifier is present.
 */
export function buildLockResource(toolName: string, args: Record<string, unknown>): string {
  const idFields = ['nmId', 'orderId', 'promotionId', 'feedbackId', 'chatId', 'questionId', 'advertId', 'supplyId'];
  const parts: string[] = [];
  for (const field of idFields) {
    const v = args[field];
    if (v !== undefined && v !== null) {
      parts.push(`${field}=${String(v)}`);
    }
  }
  // Arrays of ids (e.g. nmIds in action_manage_promotion) — sort so ordering
  // doesn't desync the lock key between retries.
  for (const field of ['nmIds', 'orderIds']) {
    const v = args[field];
    if (Array.isArray(v) && v.length > 0) {
      const sorted = [...v].map(String).sort().join(',');
      parts.push(`${field}=[${sorted}]`);
    }
  }
  if (parts.length === 0) {
    // No identifiable target — fall back to a stable JSON projection
    // (sorted keys) so the same logical args produce the same key.
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(args).sort()) {
      if (k.startsWith('_')) continue;
      sorted[k] = args[k];
    }
    parts.push(JSON.stringify(sorted).slice(0, 120));
  }
  return `${toolName}:${parts.join('|')}`;
}
