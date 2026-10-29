import { getProviderSettings, computeCostMicros, recordAiUsage } from '../../services/aiSettings.js';

export type LlmMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type LlmJsonResult<T> = {
  data: T;
  raw: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
};

async function getLlmConfig() {
  const settings = await getProviderSettings('llm');
  const apiKey = settings.apiKey;
  const baseUrl = settings.baseUrl || 'https://api.openai.com/v1';
  const model = settings.model || 'gpt-4o-mini';

  if (!apiKey) {
    throw new Error('LLM_API_KEY is not configured');
  }

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    promptPricePer1mMicros: settings.promptPricePer1mMicros ?? 0,
    completionPricePer1mMicros: settings.completionPricePer1mMicros ?? 0,
  };
}

export async function llmChatJson<T>(
  messages: LlmMessage[],
  opts?: { temperature?: number; meta?: { workspaceId?: number; feature?: string; itemType?: string; itemId?: string } }
): Promise<LlmJsonResult<T>> {
  const config = await getLlmConfig();
  const temperature = opts?.temperature ?? 0.2;

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      temperature,
      messages,
      response_format: { type: 'json_object' },
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LLM error ${res.status}: ${text.slice(0, 500)}`);
  }

  let payload: any = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // ignore
  }

  const content = payload?.choices?.[0]?.message?.content ?? text;
  const responseModel = payload?.model ?? config.model;
  const usage = payload?.usage ?? null;

  let data: T;
  try {
    data = JSON.parse(content) as T;
  } catch (err) {
    throw new Error(`LLM returned non-JSON response: ${String(err)}; content=${content.slice(0, 500)}`);
  }

  const promptTokens = Number(usage?.prompt_tokens ?? 0);
  const completionTokens = Number(usage?.completion_tokens ?? 0);
  const totalTokens = Number(usage?.total_tokens ?? promptTokens + completionTokens);

  if (opts?.meta?.workspaceId && (promptTokens || completionTokens || totalTokens)) {
    const costMicros = computeCostMicros({
      promptTokens,
      completionTokens,
      promptPricePer1mMicros: config.promptPricePer1mMicros,
      completionPricePer1mMicros: config.completionPricePer1mMicros,
    });

    try {
      await recordAiUsage({
        workspaceId: opts.meta.workspaceId,
        provider: 'llm',
        model: responseModel,
        promptTokens,
        completionTokens,
        totalTokens,
        costMicros,
        meta: {
          feature: opts.meta.feature,
          itemType: opts.meta.itemType,
          itemId: opts.meta.itemId,
        },
      });
    } catch {
      // ignore usage tracking errors
    }
  }

  return {
    data,
    raw: content,
    model: responseModel,
    usage: { promptTokens, completionTokens, totalTokens },
  };
}
