/**
 * Tool `action_add_seo_keywords` — добавить пачку keywords на отслеживание.
 *
 * Не требует confirmation: операция локальная (запись в seo_keywords),
 * дубли отбрасываются (unique constraint на workspace+keyword).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { seoKeywords, seoKeywordProducts } from '../../db/schema.js';
import { logAgent as logger } from '../../lib/logger.js';

export interface ActionAddSeoKeywordsInput {
  keywords: Array<{ keyword: string; nmIds?: number[] }>;
  _workspaceId?: number;
  _shopId?: number | null;
}

const MAX_KEYWORDS_PER_WORKSPACE = 500;
const MAX_PER_BATCH = 50;

export async function actionAddSeoKeywords(input: ActionAddSeoKeywordsInput): Promise<string> {
  const wsId = input._workspaceId;
  if (!wsId) return JSON.stringify({ status: 'error', error: 'workspace_id missing' });

  const batch = (input.keywords ?? []).slice(0, MAX_PER_BATCH);
  if (batch.length === 0) return JSON.stringify({ status: 'error', error: 'no keywords' });

  // Проверим лимит workspace
  const [cnt] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(seoKeywords)
    .where(eq(seoKeywords.workspaceId, wsId));
  const current = cnt?.c ?? 0;
  const room = Math.max(0, MAX_KEYWORDS_PER_WORKSPACE - current);
  if (room === 0) {
    return JSON.stringify({ status: 'error', error: `Достигнут лимит keywords для workspace (${MAX_KEYWORDS_PER_WORKSPACE}).` });
  }

  const toAdd = batch.slice(0, room);

  // Уникализируем внутри input и исключим уже существующие
  const cleaned = Array.from(new Map(toAdd.map((k) => [k.keyword.trim().toLowerCase(), k])).values())
    .filter((k) => k.keyword.trim().length >= 2);

  const keywordsSet = cleaned.map((k) => k.keyword.trim().toLowerCase());
  const existing = keywordsSet.length > 0
    ? await db.select({ keyword: seoKeywords.keyword }).from(seoKeywords).where(and(
        eq(seoKeywords.workspaceId, wsId),
        inArray(seoKeywords.keyword, keywordsSet),
      ))
    : [];
  const existingSet = new Set(existing.map((e) => e.keyword.toLowerCase()));
  const newKeywords = cleaned.filter((k) => !existingSet.has(k.keyword.trim().toLowerCase()));

  if (newKeywords.length === 0) {
    return JSON.stringify({
      status: 'ok',
      added: 0,
      skippedExisting: cleaned.length,
      message: 'Все предложенные слова уже отслеживаются.',
    });
  }

  // Bulk insert вместо цикла: для batch=50 keywords раньше было 50+ separate
  // INSERT'ов (плюс ещё столько же для keyword_products), теперь два запроса.
  let added = 0;
  try {
    const rows = newKeywords.map((k) => ({
      workspaceId: wsId,
      shopId: input._shopId ?? null,
      keyword: k.keyword.trim().toLowerCase(),
    }));
    const inserted = await db.insert(seoKeywords).values(rows).returning({
      keywordId: seoKeywords.keywordId,
      keyword: seoKeywords.keyword,
    });
    added = inserted.length;

    // Связи keyword → nmIds одним батчем.
    const linkRows: { keywordId: number; nmId: number }[] = [];
    const byKeyword = new Map(inserted.map((r) => [r.keyword, r.keywordId]));
    for (const k of newKeywords) {
      const kid = byKeyword.get(k.keyword.trim().toLowerCase());
      if (!kid || !k.nmIds?.length) continue;
      for (const nmId of k.nmIds.slice(0, 50)) {
        linkRows.push({ keywordId: kid, nmId });
      }
    }
    if (linkRows.length > 0) {
      await db.insert(seoKeywordProducts).values(linkRows);
    }
  } catch (err) {
    logger.warn({ err, count: newKeywords.length }, 'bulk insert keywords failed (likely duplicates); fallback to per-row');
    // Fallback: на duplicate-key или подобной коллизии — попадаем в per-row
    // как раньше, чтобы дубли не блокировали остальные строки.
    for (const k of newKeywords) {
      try {
        const [ins] = await db.insert(seoKeywords).values({
          workspaceId: wsId,
          shopId: input._shopId ?? null,
          keyword: k.keyword.trim().toLowerCase(),
        }).returning({ keywordId: seoKeywords.keywordId });
        added++;
        if (k.nmIds?.length && ins) {
          await db.insert(seoKeywordProducts).values(
            k.nmIds.slice(0, 50).map((nmId) => ({ keywordId: ins.keywordId, nmId })),
          );
        }
      } catch { /* duplicate — skip */ }
    }
  }

  logger.info({ wsId, requested: batch.length, added }, 'action_add_seo_keywords done');
  return JSON.stringify({
    status: 'ok',
    added,
    skippedExisting: cleaned.length - newKeywords.length,
    skippedLimit: Math.max(0, batch.length - room),
    message: `Добавлено ${added} новых слов на отслеживание. Позиции начнут отслеживаться с следующего запуска sync (03:00 MSK).`,
  });
}
