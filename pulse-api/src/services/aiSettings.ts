import { requireSellerAiKey, optionalSellerAiKey } from './sellerAiCredentials.js';
import { env } from '../env.js';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSettings, aiProviderSettings, aiUsageEvents } from '../db/schema.js';

export type AiProvider = 'llm' | 'web_search';

export type ProviderSettings = {
  provider: AiProvider;
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  promptPricePer1mMicros?: number | null;
  completionPricePer1mMicros?: number | null;
};

const usdToMicros = (value?: number | null) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 1_000_000);
};

const microsToUsd = (value?: number | null) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value / 1_000_000;
};

function maskKey(key?: string | null): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 6) return '*'.repeat(trimmed.length);
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-4)}`;
}

/**
 * Whitelist of allowed LLM/web-search baseUrl hosts.
 *
 * The DB-backed `aiProviderSettings.baseUrl` is editable through the admin UI.
 * Without validation, anyone with admin access (or a SQL injection that lands
 * an UPDATE) could redirect every Anthropic/OpenAI call to an attacker-controlled
 * proxy and exfiltrate the API key plus the full prompt/response stream.
 *
 * Allow only well-known LLM endpoints + a small list of approved RU proxies
 * (since OpenAI blocks Russian IPs and the project may need a passthrough).
 * Hosts are matched as exact equality OR domain-suffix (so `eu.api.openai.com`
 * still resolves under `api.openai.com`).
 */
const ALLOWED_LLM_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  // Approved RU proxies for OpenAI (block by RU IP). Add new ones explicitly.
  'api.vsegpt.ru',
  'api.proxyapi.ru',
  'bothub.chat',
];

const ALLOWED_WEB_SEARCH_HOSTS = [
  'api.tavily.com',
  'api.exa.ai',
  'api.search.brave.com',
];

function validateBaseUrl(url: string | null | undefined, provider: AiProvider): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  let host: string;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new Error('protocol must be http(s)');
    }
    host = u.hostname.toLowerCase();
  } catch {
    throw new Error(`Invalid baseUrl for provider "${provider}": ${trimmed}`);
  }
  const allowed = provider === 'llm' ? ALLOWED_LLM_HOSTS : ALLOWED_WEB_SEARCH_HOSTS;
  const ok = allowed.some((h) => host === h || host.endsWith('.' + h));
  if (!ok) {
    throw new Error(`baseUrl host "${host}" is not in the allowlist for provider "${provider}". Allowed: ${allowed.join(', ')}`);
  }
  return trimmed;
}

export async function getProviderSettings(provider: AiProvider): Promise<ProviderSettings> {
  if (provider === 'llm') return { provider, apiKey: await requireSellerAiKey('openai'), baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', promptPricePer1mMicros: 0, completionPricePer1mMicros: 0 };
  return { provider, apiKey: await optionalSellerAiKey('web_search'), baseUrl: 'https://api.tavily.com/search' };
}

export async function listProviderSettingsForAdmin() {
  return { providers: [], billingMode: 'seller', note: 'Ключи настраивает владелец магазина в разделе ИИ.' };
}

export async function upsertProviderSettings(input: Array<{
  provider: AiProvider;
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  promptPricePer1mUsd?: number | null;
  completionPricePer1mUsd?: number | null;
}>) {
  throw new Error('Общие ключи ИИ отключены. Используйте настройки ИИ конкретного магазина.');
}

export async function recordAiUsage(input: {
  workspaceId: number;
  provider: string;
  model?: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costMicros: number;
  meta?: Record<string, any>;
}) {
  await db.insert(aiUsageEvents).values({
    workspaceId: input.workspaceId,
    provider: input.provider,
    model: input.model ?? null,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    totalTokens: input.totalTokens,
    costMicros: input.costMicros,
    meta: input.meta ?? {},
    createdAt: new Date(),
  });
}

export function computeCostMicros(input: {
  promptTokens: number;
  completionTokens: number;
  promptPricePer1mMicros?: number | null;
  completionPricePer1mMicros?: number | null;
}) {
  const promptPrice = input.promptPricePer1mMicros ?? 0;
  const completionPrice = input.completionPricePer1mMicros ?? 0;
  const promptCost = (input.promptTokens * promptPrice) / 1_000_000;
  const completionCost = (input.completionTokens * completionPrice) / 1_000_000;
  return Math.round(promptCost + completionCost);
}

/**
 * Check whether the workspace is within its daily AI token budget.
 * Returns true if usage is within budget (or no budget is set), false if over.
 */
export async function checkTokenBudget(wsId: number): Promise<boolean> {
  try {
    const [settings] = await db.select({ max: agentSettings.agentMaxTokensPerDay })
      .from(agentSettings).where(eq(agentSettings.workspaceId, wsId)).limit(1);
    const maxTokens = settings?.max ?? 1_000_000; // 1M default

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [usage] = await db.select({
      total: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)`
    }).from(aiUsageEvents).where(and(
      eq(aiUsageEvents.workspaceId, wsId),
      gte(aiUsageEvents.createdAt, todayStart),
    ));

    return (usage?.total ?? 0) < maxTokens;
  } catch {
    return true; // Allow on error
  }
}
