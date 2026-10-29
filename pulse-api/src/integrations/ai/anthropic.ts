import { requireSellerAiKey } from '../../services/sellerAiCredentials.js';
/**
 * Anthropic Claude integration for Pulse.
 * Uses Claude Sonnet 4.6 (claude-sonnet-4-6) for feedback responses and analysis.
 *
 * NOTE: Uses node:https directly instead of Anthropic SDK for API calls
 * because Node.js 22 undici/fetch has socket issues on Windows with Fastify.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { env } from '../../env.js';
import { computeCostMicros, recordAiUsage } from '../../services/aiSettings.js';
import { deductUsage, getWorkspaceOwnerId } from '../../services/aiTokens.js';

async function resolveAnthropicKey(): Promise<string> {
  return requireSellerAiKey('anthropic');
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'url'; url: string } | { type: 'base64'; media_type: string; data: string } };

export type LlmMessage = { role: 'system' | 'user' | 'assistant'; content: string | ContentBlock[] };

export type LlmJsonResult<T> = {
  data: T;
  raw: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
};

// Claude Sonnet 4 pricing (per 1M tokens in micros = $1 = 1,000,000 micros)
const SONNET_PROMPT_PRICE_PER_1M_MICROS = 3_000_000; // $3/1M input
const SONNET_COMPLETION_PRICE_PER_1M_MICROS = 15_000_000; // $15/1M output

/**
 * Make an HTTPS POST request to Anthropic API using node:https.
 * This bypasses the Anthropic SDK and Node.js undici which cause socket issues on Windows.
 */
async function anthropicHttpsPost(body: object): Promise<Anthropic.Message> {
  const client = new Anthropic({ apiKey: await requireSellerAiKey('anthropic'), timeout: 600_000, maxRetries: 0 });
  return await client.messages.create(body as Anthropic.MessageCreateParamsNonStreaming);
}

function parseJsonFromClaude<T>(content: string): T {
  let jsonStr = content.trim();
  jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '').trim();
  if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) {
    const match = jsonStr.match(/(\{[\s\S]*\})/);
    if (match) jsonStr = match[1];
  }

  try {
    return JSON.parse(jsonStr) as T;
  } catch (firstErr) {
    // Attempt to repair truncated JSON (e.g. from max_tokens cutoff)
    const repaired = repairTruncatedJson(jsonStr);
    if (repaired !== jsonStr) {
      try {
        return JSON.parse(repaired) as T;
      } catch { /* fall through to original error */ }
    }
    throw firstErr;
  }
}

/**
 * Attempt to close unclosed brackets/braces in truncated JSON.
 * Handles the common case where Claude hits max_tokens mid-response.
 */
function repairTruncatedJson(json: string): string {
  let s = json;

  // Walk the string once, tracking quote/bracket state. Everything AFTER the
  // last "clean" point (outside of string, depth ≥ 1, and not immediately
  // after a `:` or `,` with a value we started but didn't finish) is cut —
  // this is more robust than the earlier regex approach which failed on
  // `stop_reason: max_tokens` mid-string-value like:
  //   "description": "...very long unterminated
  let inString = false;
  let escaped = false;
  let lastCleanIdx = -1;
  const depthStack: string[] = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') {
      depthStack.push(ch);
    } else if (ch === '}' || ch === ']') {
      depthStack.pop();
    }
    // Consider position "clean" when we're outside a string at a structural
    // char (end of value). This way when we trim the tail the structure is
    // intact up to the last complete key/value.
    if (!inString && (ch === ',' || ch === '}' || ch === ']')) {
      lastCleanIdx = i;
    }
  }

  // If we ended inside an open string, rewind to the last clean structural
  // char and drop the half-written key/value.
  if (inString && lastCleanIdx > -1) {
    s = s.slice(0, lastCleanIdx + 1);
    // Remove trailing comma — we'll close here.
    s = s.replace(/,\s*$/, '');
  } else {
    // Not in a string — still cut incomplete trailing key/value pairs like
    //   "key": 12 or "key": ["a"
    // by trimming back to the nearest clean marker.
    s = s.replace(/,\s*"[^"]*$/, '');
    s = s.replace(/:\s*"[^"]*$/, ': ""');
    s = s.replace(/:\s*(-?\d*\.?\d*)\s*$/, ': 0');
    s = s.replace(/,\s*$/, '');
  }

  // Re-count unclosed brackets on the trimmed string.
  let braces = 0;
  let brackets = 0;
  inString = false;
  escaped = false;
  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }

  while (brackets > 0) { s += ']'; brackets--; }
  while (braces > 0) { s += '}'; braces--; }

  return s;
}

async function trackUsage(
  response: Anthropic.Message,
  model: string,
  meta?: {
    workspaceId?: number;
    /** When true and workspaceId is set, also deducts from workspace's AI
     *  balance. Default false — opt-in so existing call sites (aiChat,
     *  assistant graph) that already deduct manually don't double-charge. */
    charge?: boolean;
    /** Explicit billing subject. If omitted but charge=true, we fall back to
     *  the workspace owner. */
    userId?: number;
    feature?: string;
    itemType?: string;
    itemId?: string;
  },
) {
  const promptTokens = response.usage?.input_tokens ?? 0;
  const completionTokens = response.usage?.output_tokens ?? 0;
  // Anthropic's response.usage may include cache hits / writes — these are
  // billed at 0.10× / 1.25× input rate, not the full 1×. Pass through so
  // deductUsage charges the user accurately.
  const cacheReadTokens = (response.usage as any)?.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = (response.usage as any)?.cache_creation_input_tokens ?? 0;
  const totalTokens = promptTokens + completionTokens;

  if (meta?.workspaceId && totalTokens > 0) {
    const costMicros = computeCostMicros({
      promptTokens,
      completionTokens,
      promptPricePer1mMicros: SONNET_PROMPT_PRICE_PER_1M_MICROS,
      completionPricePer1mMicros: SONNET_COMPLETION_PRICE_PER_1M_MICROS,
    });
    try {
      await recordAiUsage({
        workspaceId: meta.workspaceId,
        provider: 'anthropic',
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        costMicros,
        meta: { feature: meta.feature, itemType: meta.itemType, itemId: meta.itemId },
      });
    } catch { /* ignore usage tracking errors */ }

    // Opt-in auto-deduct. Closes the historical billing holes (creative
    // audit, agent tools, prompt suggester) where token telemetry was logged
    // but balance never moved. Existing manual-deduct call sites (aiChat,
    // assistant/graph.ts) leave charge unset → behaviour unchanged.
    if (meta.charge) {
      try {
        const userId = meta.userId ?? await getWorkspaceOwnerId(meta.workspaceId);
        if (userId) {
          await deductUsage({
            workspaceId: meta.workspaceId,
            userId,
            inputTokens: promptTokens,
            outputTokens: completionTokens,
            cacheReadTokens,
            cacheCreationTokens,
            model,
            toolsUsed: meta.feature ? [meta.feature] : undefined,
          });
        }
      } catch (err) {
        // Anthropic call already happened — don't surface the deduct failure
        // to the caller, but log loud so we notice an insolvent workspace or
        // a misconfigured owner lookup.
        console.error('[trackUsage] auto-deduct failed', { workspaceId: meta.workspaceId, feature: meta.feature, err: String(err) });
      }
    }
  }
  return { promptTokens, completionTokens, totalTokens };
}

export async function claudeChatJson<T>(
  messages: LlmMessage[],
  opts?: {
    temperature?: number;
    model?: string;
    maxTokens?: number;
    meta?: { workspaceId?: number; userId?: number; charge?: boolean; feature?: string; itemType?: string; itemId?: string };
  }
): Promise<LlmJsonResult<T>> {
  const model = opts?.model ?? 'claude-sonnet-4-6';
  const temperature = opts?.temperature ?? 0.2;
  // Opus 4.7+ (включая 4.8) удалили temperature/top_p/top_k — отправка 400.
  // Helpers выше игнорят пользовательский temperature на этих моделях, чтобы
  // call-site'ы не приходилось переделывать вручную.
  const isOpus47Plus = /^claude-opus-4-([7-9]|\d{2,})/.test(model);

  const systemMsg = messages.find((m) => m.role === 'system')?.content ?? '';
  const userMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  // Switched from custom spawn+https.request to the official Anthropic SDK.
  // The previous implementation drove a child-Node script over tmp-files and
  // died with `socket hang up` on long text audits (≥120 s responses). The
  // SDK reads the HTTP stream in-process, keeps TCP alive correctly, and has
  // built-in retry on 5xx / network errors. Large creative-audit Stage 1
  // text runs now complete instead of erroring the whole audit pipeline.
  const apiKey = await resolveAnthropicKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const client = new Anthropic({ apiKey, timeout: 600_000, maxRetries: 0 });

  let response!: Anthropic.Message;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // STREAMING is what kept blowing up Stage 1 audits: Anthropic silently
      // closes non-streaming connections on long responses ("other side
      // closed" / "socket hang up" after 2-4 min). Using messages.stream()
      // with .finalMessage() reads the SSE stream incrementally — TCP stays
      // open via chunked-transfer and we get the same Message shape at the
      // end. Tested on Stage 1 text audits that previously failed after 161-
      // 205 seconds.
      const streamParams: any = {
        model,
        max_tokens: opts?.maxTokens ?? 16384,
        system: systemMsg as string,
        messages: userMessages as any,
      };
      if (!isOpus47Plus) streamParams.temperature = temperature;
      const stream = client.messages.stream(streamParams);
      response = (await stream.finalMessage()) as Anthropic.Message;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const errStr = String((err as Error).message);
      const isRetryable =
        errStr.includes('socket') ||
        errStr.includes('ECONNRESET') ||
        errStr.includes('ETIMEDOUT') ||
        errStr.includes('fetch failed') ||
        errStr.includes('timeout');
      if (!isRetryable || attempt === 2) throw err;
      const delay = 5000 * (attempt + 1);
      console.warn(`[claudeChatJson] Attempt ${attempt + 1} failed: ${errStr.slice(0, 100)}, retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  if (lastErr) throw lastErr;

  const textBlock = response.content.find((c) => c.type === 'text');
  const content = textBlock?.type === 'text' ? textBlock.text : '';

  if ((response as any).stop_reason === 'max_tokens') {
    console.warn(`[claudeChatJson] Response truncated (max_tokens). Feature: ${opts?.meta?.feature}. Output length: ${content.length} chars.`);
  }

  let data: T;
  try {
    data = parseJsonFromClaude<T>(content);
  } catch (err) {
    throw new Error(`Claude returned non-JSON response: ${String(err)}; stop_reason=${(response as any).stop_reason}; content=${content.slice(0, 500)}`);
  }

  const usage = await trackUsage(response, model, opts?.meta);

  return {
    data,
    raw: content,
    model: response.model,
    usage,
  };
}

/**
 * Claude Vision/Multimodal JSON call — supports image content blocks.
 * Falls back to text-only claudeChatJson on error.
 */
export async function claudeVisionJson<T>(
  messages: LlmMessage[],
  opts?: {
    temperature?: number;
    model?: string;
    maxTokens?: number;
    meta?: { workspaceId?: number; userId?: number; charge?: boolean; feature?: string; itemType?: string; itemId?: string };
  }
): Promise<LlmJsonResult<T>> {
  const model = opts?.model ?? 'claude-sonnet-4-6';
  const temperature = opts?.temperature ?? 0.3;
  const maxTokens = opts?.maxTokens ?? 16384;
  const isOpus47Plus = /^claude-opus-4-([7-9]|\d{2,})/.test(model);

  const systemMsg = messages.find((m) => m.role === 'system');
  const systemContent = typeof systemMsg?.content === 'string' ? systemMsg.content : '';

  const ALLOWED_IMAGE_MEDIA = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
  type AllowedMedia = (typeof ALLOWED_IMAGE_MEDIA)[number];
  const normalizeMedia = (m: string): AllowedMedia =>
    (ALLOWED_IMAGE_MEDIA as readonly string[]).includes(m) ? (m as AllowedMedia) : 'image/jpeg';

  const userMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: typeof m.content === 'string'
        ? m.content
        : m.content.map((block) => {
            if (block.type === 'text') return { type: 'text' as const, text: block.text };
            if (block.type === 'image') {
              const src = block.source;
              if (src.type === 'url') {
                return { type: 'image' as const, source: { type: 'url' as const, url: src.url } };
              }
              return {
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: normalizeMedia(src.media_type),
                  data: src.data,
                },
              };
            }
            return block;
          }),
    }));

  // Vision API uses SDK because it needs multimodal content types
  // If SDK fails, the caller (creativeAuditV3) handles fallback to text-only
  const apiKey = await resolveAnthropicKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  // Vision + max_tokens=32 768 can take 3-5 minutes on a card with many
  // photos. Previous 120 s timeout caused `socket hang up` mid-stream.
  // Bump to 10 min and add one retry on transient network errors.
  const client = new Anthropic({ maxRetries: 0, apiKey, timeout: 600_000 });

  // Non-streaming response only — tell TS so .content/.model are typed.
  type MessageRes = import('@anthropic-ai/sdk').Anthropic.Messages.Message;
  let response: MessageRes | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Stream for the same reason as claudeChatJson — vision responses
      // with 7 photos × 32k max_tokens routinely took 4-6 min and closed
      // on non-streaming connections.
      const visionParams: any = {
        model,
        max_tokens: maxTokens,
        system: systemContent,
        messages: userMessages,
      };
      if (!isOpus47Plus) visionParams.temperature = temperature;
      const stream = client.messages.stream(visionParams);
      response = (await stream.finalMessage()) as MessageRes;
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      const s = String((err as Error)?.message ?? err);
      const retryable =
        s.includes('socket hang up') ||
        s.includes('ECONNRESET') ||
        s.includes('ETIMEDOUT') ||
        s.includes('fetch failed');
      if (!retryable || attempt === 1) throw err;
      const delay = 5000 * (attempt + 1);
      console.warn(`[claudeVisionJson] attempt ${attempt + 1} failed (${s.slice(0, 100)}), retrying in ${delay}ms…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  if (lastErr) throw lastErr;

  const textBlock = response!.content.find((c) => c.type === 'text') as { type: 'text'; text: string } | undefined;
  const content = textBlock?.text ?? '';

  let data: T;
  try {
    data = parseJsonFromClaude<T>(content);
  } catch (err) {
    throw new Error(`Claude Vision returned non-JSON: ${String(err)}; content=${content.slice(0, 500)}`);
  }

  const usage = await trackUsage(response!, model, opts?.meta);

  return {
    data,
    raw: content,
    model: response!.model,
    usage,
  };
}

// Re-export for cost calculation
export function computeCostUsd(promptTokens: number, completionTokens: number): number {
  return (promptTokens * 3 + completionTokens * 15) / 1_000_000;
}
