import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { resolveAiWorkspace } from '../lib/sellerAiContext.js';
import { BadRequestError } from '../lib/errors.js';
import { isWbBillingAuthorized } from './wbBillingPolicy.js';

export const SELLER_AI_PROVIDERS = ['anthropic', 'openai', 'google', 'runway', 'voyage', 'jina', 'web_search'] as const;
export type SellerAiProvider = typeof SELLER_AI_PROVIDERS[number];

export const PROVIDER_INFO: Record<SellerAiProvider, { label: string; features: string; keyUrl: string }> = {
  anthropic: { label: 'Anthropic', features: 'Чат, агенты, отзывы, SEO и отчёты', keyUrl: 'https://console.anthropic.com/settings/keys' },
  openai: { label: 'OpenAI', features: 'Изображения, видео, распознавание речи и текстовые задачи', keyUrl: 'https://platform.openai.com/api-keys' },
  google: { label: 'Google AI', features: 'Генерация изображений Gemini', keyUrl: 'https://aistudio.google.com/api-keys' },
  runway: { label: 'Runway', features: 'Изображения и видео Runway', keyUrl: 'https://dev.runwayml.com/' },
  voyage: { label: 'Voyage AI', features: 'Семантический поиск по документам и товарам', keyUrl: 'https://dashboard.voyageai.com/' },
  jina: { label: 'Jina AI', features: 'Альтернативный поиск по документам', keyUrl: 'https://jina.ai/' },
  web_search: { label: 'Tavily', features: 'Поиск в интернете для ИИ', keyUrl: 'https://app.tavily.com/' },
};

function resultRows(result: unknown): Array<Record<string, any>> {
  return (result as { rows?: Array<Record<string, any>> }).rows ?? result as Array<Record<string, any>>;
}

export async function optionalSellerAiKey(provider: SellerAiProvider, workspaceId?: number): Promise<string | undefined> {
  const id = resolveAiWorkspace(workspaceId);
  const rows = resultRows(await db.execute(sql`
    SELECT encrypted_key FROM workspace_ai_credentials
    WHERE workspace_id = ${id} AND provider = ${provider}
  `));
  if (!rows[0]) return undefined;
  // Bind ciphertext to its tenant/provider; copied database cells are rejected.
  const value = JSON.parse(decrypt(rows[0].encrypted_key));
  if (value.workspaceId !== id || value.provider !== provider || typeof value.key !== 'string') {
    throw new Error('Invalid AI credential binding');
  }
  return value.key;
}

export async function requireSellerAiKey(provider: SellerAiProvider, workspaceId?: number): Promise<string> {
  const key = await optionalSellerAiKey(provider, workspaceId);
  if (!key) throw new BadRequestError(`Подключите свой ключ ${PROVIDER_INFO[provider].label} в разделе «Настройки → ИИ». Сервис не использует ключи владельца сайта.`);
  return key;
}

export async function listSellerAiCredentials(workspaceId: number) {
  resolveAiWorkspace(workspaceId);
  const rows = resultRows(await db.execute(sql`
    SELECT provider, key_suffix, updated_at FROM workspace_ai_credentials WHERE workspace_id = ${workspaceId}
  `));
  return SELLER_AI_PROVIDERS.map(provider => {
    const row = rows.find(r => r.provider === provider);
    return { provider, ...PROVIDER_INFO[provider], configured: Boolean(row), maskedKey: row ? `••••${row.key_suffix}` : null, updatedAt: row?.updated_at ?? null };
  });
}

export async function saveSellerAiCredential(workspaceId: number, provider: SellerAiProvider, key: string) {
  resolveAiWorkspace(workspaceId);
  const encrypted = encrypt(JSON.stringify({ workspaceId, provider, key }));
  await db.execute(sql`
    INSERT INTO workspace_ai_credentials (workspace_id, provider, encrypted_key, key_suffix)
    VALUES (${workspaceId}, ${provider}, ${encrypted}, ${key.slice(-4)})
    ON CONFLICT (workspace_id, provider) DO UPDATE
    SET encrypted_key = EXCLUDED.encrypted_key, key_suffix = EXCLUDED.key_suffix, updated_at = now()
  `);
}

export async function deleteSellerAiCredential(workspaceId: number, provider: SellerAiProvider) {
  resolveAiWorkspace(workspaceId);
  await db.execute(sql`DELETE FROM workspace_ai_credentials WHERE workspace_id = ${workspaceId} AND provider = ${provider}`);
}

/** Community deployments must not retain a billable fallback in SDK defaults. */
export function assertNoPlatformAiKeys(environment: NodeJS.ProcessEnv = process.env) {
  if ((environment.WB_PARTNER_SERVICE_SECRET?.trim() || environment.WB_PARTNER_SECRET_INJECT === '1') && !isWbBillingAuthorized(environment)) {
    throw new Error('WB partner API can bill the operator. Set WB_PARTNER_BILLING_ACCEPTED=1 only when the operator accepts WB charges, or WB_PARTNER_BILLING_VERIFIED_FREE=1 for a confirmed free WB agreement.');
  }
  const forbidden = ['RESEND_API_KEY', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'SENTRY_DSN', 'LANGSMITH_API_KEY', 'LANGCHAIN_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'LLM_API_KEY', 'GOOGLE_AI_KEY', 'GOOGLE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'FAL_KEY', 'RUNWAY_API_KEY', 'VOYAGE_API_KEY', 'JINA_API_KEY', 'WEB_SEARCH_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'];
  const configured = forbidden.filter(name => environment[name]?.trim());
  if (configured.length) throw new Error(`Community edition requires seller-owned AI keys. Remove platform credentials: ${configured.join(', ')}. Values are not logged.`);
}
