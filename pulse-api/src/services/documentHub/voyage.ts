import { optionalSellerAiKey } from '../sellerAiCredentials.js';
/**
 * Embeddings Client (Jina AI / Voyage AI)
 *
 * Generates vector embeddings for semantic search in the document hub.
 * Supports two providers:
 * - Jina AI (JINA_API_KEY) — works from Russia, jina-embeddings-v3, 1024 dims
 * - Voyage AI (VOYAGE_API_KEY) — voyage-4-lite, 1024 dims
 *
 * Priority: JINA_API_KEY > VOYAGE_API_KEY
 */

import { env } from '../../env.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'embeddings' });

const BATCH_SIZE = 64;

// Provider config
const PROVIDERS = {
  jina: {
    url: 'https://api.jina.ai/v1/embeddings',
    model: 'jina-embeddings-v3',
    dimensions: 1024,
  },
  voyage: {
    url: 'https://api.voyageai.com/v1/embeddings',
    model: 'voyage-4-lite',
    dimensions: 1024,
  },
} as const;

type Provider = keyof typeof PROVIDERS;

async function getProvider(): Promise<{ provider: Provider; apiKey: string } | null> {
const jina = await optionalSellerAiKey('jina');
 if (jina) return { provider: 'jina', apiKey: jina };
 const voyage = await optionalSellerAiKey('voyage');
 return voyage ? { provider: 'voyage', apiKey: voyage } : null;
}

/**
 * Check if any embedding provider is configured.
 */
export async function isVoyageEnabled(): Promise<boolean> {
  return (await getProvider()) !== null;
}

/**
 * Generate embeddings for an array of texts.
 */
export async function embedTexts(
  texts: string[],
  inputType: 'document' | 'query' = 'document',
): Promise<number[][]> {
  const config = await getProvider();
  if (!config) throw new Error('No embedding API key configured (JINA_API_KEY or VOYAGE_API_KEY)');

  if (texts.length === 0) return [];

  const { provider, apiKey } = config;
  const { url, model, dimensions } = PROVIDERS[provider];
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const body: Record<string, unknown> = {
      model,
      input: batch,
    };

    // Provider-specific params
    if (provider === 'jina') {
      body.dimensions = dimensions;
      body.task = inputType === 'query' ? 'retrieval.query' : 'retrieval.passage';
    } else {
      body.input_type = inputType;
      body.truncation = true;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown');
      logger.error({ status: response.status, provider, body: errText.slice(0, 300) }, 'Embedding API error');
      throw new Error(`Embedding API error (${provider}): ${response.status}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
      usage: { total_tokens: number };
    };

    logger.info({
      provider,
      batch: `${i + 1}-${i + batch.length}/${texts.length}`,
      tokens: data.usage?.total_tokens ?? 0,
    }, 'Embeddings generated');

    const sorted = data.data.sort((a, b) => a.index - b.index);
    for (const item of sorted) {
      allEmbeddings.push(item.embedding);
    }
  }

  return allEmbeddings;
}
