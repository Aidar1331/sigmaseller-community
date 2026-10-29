import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { wbCards } from '../../db/schema.js';
import { getWbApiKey as getApiKey, getWbApiKeyByShop } from './wbClient.js';
import { chunk } from '../../lib/chunking.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'cardsSync' });

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function pickMainPhotoUrl(card: any): string | null {
  // WB cards usually have photos in `photos` array with `big`/`c246x328` etc.
  const photos = card?.photos;
  if (!Array.isArray(photos) || photos.length === 0) return null;
  const p0 = photos[0];
  if (typeof p0?.big === 'string') return p0.big;
  if (typeof p0?.c246x328 === 'string') return p0.c246x328;
  if (typeof p0?.c516x688 === 'string') return p0.c516x688;
  return null;
}

async function wbPost(url: string, apiKey: string, body: unknown, attempt = 1): Promise<any> {
  const MAX_ATTEMPTS = 5;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 60_000); // 60s timeout (was 30s)
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    }).finally(() => clearTimeout(t));

    const text = await res.text();
    if (res.status === 429 && attempt <= 8) {
      await sleep(Math.min(60_000, 1000 * 2 ** (attempt - 1)));
      return wbPost(url, apiKey, body, attempt + 1);
    }
    if (!res.ok) throw new Error(`WB POST ${url} failed: ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } catch (err: any) {
    // Retry on network errors (ECONNRESET, ETIMEDOUT, AbortError, fetch failed)
    const code = err?.cause?.code ?? err?.code ?? '';
    const isNetworkErr = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_SOCKET'].includes(code)
      || err?.name === 'AbortError'
      || /fetch failed|socket hang up|ECONNREFUSED/i.test(err?.message ?? '');

    if (isNetworkErr && attempt < MAX_ATTEMPTS) {
      const delay = Math.min(30_000, 2000 * 2 ** (attempt - 1));
      logger.warn({ attempt, maxAttempts: MAX_ATTEMPTS, delayMs: delay, code: code || err?.message }, 'Network error, retrying');
      await sleep(delay);
      return wbPost(url, apiKey, body, attempt + 1);
    }
    throw err;
  }
}

export async function syncWbCardsToDb(opts: { workspaceId: number; shopId?: number; limit?: number } ) {
  const apiKey = await getApiKey(opts.workspaceId, opts.shopId);
  const workspaceId = opts.workspaceId;
  const shopId = opts.shopId ?? null;
  const limit = opts.limit ?? 100;

  const url = 'https://content-api.wildberries.ru/content/v2/get/cards/list';

  let cursor: any = { limit, nmID: 0 };

  logger.info({ workspaceId }, 'Sync WB cards -> DB');

  while (true) {
    const body = {
      settings: {
        cursor,
        filter: {
          withPhoto: 0,
        },
      },
    };

    const resp = await wbPost(url, apiKey, body);
    const cards = resp?.cards ?? resp?.data?.cards;
    const next = resp?.cursor ?? resp?.data?.cursor;

    if (!Array.isArray(cards) || cards.length === 0) break;

    // Prepare rows for batch upsert
    const rows = cards
      .filter(c => typeof (c?.nmID ?? c?.nmId) === 'number')
      .map(c => {
        const nmId = c?.nmID ?? c?.nmId;
        const photos = c?.photos ?? [];
        const mainPhotoUrl = pickMainPhotoUrl(c);

        return {
          workspaceId,
          shopId,
          nmId,
          vendorCode: c?.vendorCode ?? null,
          title: c?.title ?? c?.object ?? c?.imtName ?? null,
          brandName: c?.brand ?? c?.brandName ?? null,
          subjectId: typeof c?.subjectID === 'number' ? c.subjectID : (typeof c?.subjectId === 'number' ? c.subjectId : null),
          subjectName: c?.subjectName ?? null,
          mainPhotoUrl,
          photos,
          raw: c,
          updatedAt: new Date(),
        };
      });

    // Batch upsert in chunks of 100 to avoid memory issues
    const batches = chunk(rows, 100);
    for (const batch of batches) {
      await db
        .insert(wbCards)
        .values(batch)
        .onConflictDoUpdate({
          target: [wbCards.workspaceId, wbCards.nmId],
          set: {
            shopId: sql`excluded.shop_id`,
            vendorCode: sql`excluded.vendor_code`,
            title: sql`excluded.title`,
            brandName: sql`excluded.brand_name`,
            subjectId: sql`excluded.subject_id`,
            subjectName: sql`excluded.subject_name`,
            mainPhotoUrl: sql`excluded.main_photo_url`,
            photos: sql`excluded.photos`,
            raw: sql`excluded.raw`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }

    logger.info({ count: rows.length }, 'Upserted cards');

    if (!next) break;
    cursor = next;

    // stop when cursor indicates end
    if ((cursor?.total ?? 0) === 0 && (cursor?.nmID ?? 0) === 0 && (cursor?.updatedAt ?? undefined) === undefined) {
      break;
    }

    await sleep(250);
  }
}

if (process.env.RUN_AS_SCRIPT === '1') {
  const workspaceIdStr = process.env.WORKSPACE_ID;
  if (!workspaceIdStr) {
    throw new Error('WORKSPACE_ID environment variable is required');
  }
  const workspaceId = Number.parseInt(workspaceIdStr, 10);
  if (isNaN(workspaceId) || workspaceId <= 0) {
    throw new Error(`Invalid WORKSPACE_ID: ${workspaceIdStr}`);
  }
  
  const shopIdStr = process.env.SHOP_ID;
  const shopId = shopIdStr ? Number.parseInt(shopIdStr, 10) : undefined;
  if (shopIdStr && (isNaN(shopId!) || shopId! <= 0)) {
    throw new Error(`Invalid SHOP_ID: ${shopIdStr}`);
  }
  
  syncWbCardsToDb({ workspaceId, shopId }).then(() => {
    logger.info('cardsSync completed successfully');
    setTimeout(() => process.exit(0), 500);
  }).catch((e) => {
    logger.error({ err: e }, 'cardsSync failed');
    setTimeout(() => process.exit(1), 500);
  });
}
