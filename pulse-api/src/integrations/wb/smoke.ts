import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { getWbApiKey } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'wbSmoke' });

type HttpResult = {
  url: string;
  ok: boolean;
  status: number;
  tookMs: number;
  bodyText?: string;
  json?: unknown;
};

function pickEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function get(url: string, apiKey: string): Promise<HttpResult> {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      // WB APIs use Authorization header with API key (no Bearer)
      Authorization: apiKey,
    },
  });
  const tookMs = Date.now() - t0;
  const bodyText = await res.text();
  const json = safeJsonParse(bodyText);

  return {
    url,
    ok: res.ok,
    status: res.status,
    tookMs,
    bodyText: bodyText.slice(0, 2000),
    json,
  };
}

async function main() {
  const apiKey = await getWbApiKey();

  const endpoints = [
    // Common API
    'https://common-api.wildberries.ru/ping',
    'https://common-api.wildberries.ru/api/v1/seller-info',

    // Content API (tags is a useful primitive for future “товары через теги”)
    'https://content-api.wildberries.ru/content/v2/tags',

    // Advert API (availability depends on key permissions)
    'https://advert-api.wildberries.ru/adv/v1/balance',
  ];

  const results: HttpResult[] = [];
  for (const url of endpoints) {
    try {
      logger.info({ url }, 'GET');
      const r = await get(url, apiKey);
      logger.info({ url, status: r.status, tookMs: r.tookMs, ok: r.ok }, 'Response');
      results.push(r);
    } catch (err: any) {
      results.push({
        url,
        ok: false,
        status: 0,
        tookMs: 0,
        bodyText: String(err?.message ?? err),
      });
    }
  }

  // Redact sensitive bits before writing to disk
  const redacted = results.map((r) => ({
    ...r,
    bodyText: r.bodyText,
    // do not persist full json; it may include identifiers
    json: r.json ? '[omitted]' : undefined,
  }));

  const outPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(outPath, JSON.stringify(redacted, null, 2), 'utf8');
  logger.info({ outPath }, 'Wrote output file');
}

main().catch((e) => {
  logger.error({ err: e }, 'wbSmoke failed');
  process.exitCode = 1;
});
