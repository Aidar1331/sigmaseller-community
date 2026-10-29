import { requireSellerAiKey, optionalSellerAiKey } from '../../services/sellerAiCredentials.js';
// Multi-Agent v2 Phase 6 — LLM arbitrator.
//
// When the deterministic riskAssessor returns 'yellow' (ambiguous/suspicious),
// this arbitrator calls Claude Haiku for a fast sanity check. Returns either
// 'approve' (upgrade yellow→green) or 'block' (downgrade yellow→red with a
// reason). Kept cheap — Haiku 4.5 + small prompt + 200 max tokens.

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { env } from '../../env.js';
import { logAgent as logger } from '../../lib/logger.js';
import type { RiskCheckInput, RiskCheckResult } from './riskAssessor.js';

interface ArbiterVerdict {
  decision: 'approve' | 'block';
  reason: string;
}

const ARBITER_MODEL = 'claude-haiku-4-5-20251001';
const ARBITER_MAX_TOKENS = 200;

// M4: in-memory cache for arbiter verdicts. Same (toolName, args, workspace,
// deterministic-rule) combo within CACHE_TTL_MS reuses the previous verdict
// instead of paying for a fresh Haiku call. A loopy model that triggers the
// same yellow 200× in a session now costs ~1 Haiku call, not 200.
//
// Map is per-process; pulse-workers (where executors live) gets its own copy,
// which is fine — both isolate cache to a single hot path.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const CACHE_MAX_ENTRIES = 200;       // FIFO eviction at this size
const arbiterCache: Map<string, { verdict: RiskCheckResult; expiresAt: number }> = new Map();

function cacheKey(input: RiskCheckInput, det: RiskCheckResult): string {
  // Stable JSON: sort top-level args keys.
  const args = input.toolArgs as Record<string, unknown>;
  const sortedArgs: Record<string, unknown> = {};
  for (const k of Object.keys(args ?? {}).sort()) sortedArgs[k] = args[k];
  const blob = JSON.stringify({
    ws: input.workspaceId,
    tool: input.toolName,
    rule: det.rule ?? null,
    args: sortedArgs,
  });
  return createHash('sha256').update(blob).digest('hex');
}

function cachePut(key: string, verdict: RiskCheckResult): void {
  if (arbiterCache.size >= CACHE_MAX_ENTRIES) {
    // Evict oldest 1/4 — keeps the hot set warm without scanning all entries.
    const evictCount = Math.floor(CACHE_MAX_ENTRIES / 4);
    let i = 0;
    for (const k of arbiterCache.keys()) {
      if (i++ >= evictCount) break;
      arbiterCache.delete(k);
    }
  }
  arbiterCache.set(key, { verdict, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheGet(key: string): RiskCheckResult | null {
  const hit = arbiterCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    arbiterCache.delete(key);
    return null;
  }
  return hit.verdict;
}

export async function arbitrateYellow(
  input: RiskCheckInput,
  deterministic: RiskCheckResult,
): Promise<RiskCheckResult> {
  if (!(await optionalSellerAiKey('anthropic', input.workspaceId))) {
    // No API key → conservative: pass through as yellow (graph treats as execute+warn)
    return deterministic;
  }

  const key = cacheKey(input, deterministic);
  const cached = cacheGet(key);
  if (cached) {
    logger.debug({ key, verdict: cached.verdict }, 'llm arbiter: cache hit');
    return cached;
  }

  try {
    const client = new Anthropic({ apiKey: await requireSellerAiKey('anthropic', input.workspaceId), maxRetries: 0 });
    const prompt = buildArbiterPrompt(input, deterministic);
    const response = await client.messages.create({
      model: ARBITER_MODEL,
      max_tokens: ARBITER_MAX_TOKENS,
      system:
        'Ты — аудитор безопасности действий AI-агента на Wildberries. На входе: спорное действие + причина подозрений. Решай строго: approve (если действие разумно и не угрожает бизнесу) или block (если риск реален). Отвечай строго JSON: {"decision":"approve"|"block","reason":"..."}.',
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');

    const verdict = parseArbiterResponse(text);
    if (!verdict) {
      logger.warn({ text }, 'llm arbiter returned unparseable response, keeping yellow');
      return deterministic;
    }

    const result: RiskCheckResult = verdict.decision === 'approve'
      ? {
          verdict: 'green',
          rule: deterministic.rule,
          reason: `LLM approved yellow: ${verdict.reason}`,
          meta: { ...deterministic.meta, arbiter: verdict, originalVerdict: 'yellow' },
        }
      : {
          verdict: 'red',
          rule: deterministic.rule,
          reason: `LLM blocked: ${verdict.reason}`,
          meta: { ...deterministic.meta, arbiter: verdict, originalVerdict: 'yellow' },
        };
    cachePut(key, result);
    return result;
  } catch (err) {
    logger.error({ err }, 'llm arbiter failed, keeping deterministic yellow');
    return deterministic;
  }
}

function buildArbiterPrompt(input: RiskCheckInput, det: RiskCheckResult): string {
  return `Действие агента: ${input.toolName}
Параметры: ${JSON.stringify(input.toolArgs, null, 2)}
Workspace: ${input.workspaceId}
Детерминистичная проверка: ${det.verdict.toUpperCase()}
Правило: ${det.rule ?? '(не указано)'}
Причина подозрения: ${det.reason ?? '(не указано)'}
Контекст: ${JSON.stringify(det.meta ?? {}, null, 2)}

Оцени риск. approve — если подозрение ложное (например, rate limit при легитимной bulk-операции). block — если риск реален (например, цена в 10× ниже себестоимости).
Отвечай JSON.`;
}

function parseArbiterResponse(text: string): ArbiterVerdict | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as Partial<ArbiterVerdict>;
    if (parsed.decision !== 'approve' && parsed.decision !== 'block') return null;
    return { decision: parsed.decision, reason: String(parsed.reason ?? 'no reason') };
  } catch {
    return null;
  }
}
