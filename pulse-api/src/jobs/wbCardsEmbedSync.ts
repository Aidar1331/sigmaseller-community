import { runWithAiWorkspace } from '../lib/sellerAiContext.js';
/**
 * WB Cards Embed Sync Job (2026-05-31)
 *
 * Раз в час (cron) либо on-demand эмбедит карточки товаров — записывает
 * vector(1024) в `wb_cards.embedding` для семантического поиска.
 *
 * Идемпотентность:
 *   - SELECT карточек где embedding IS NULL ИЛИ embedded_at < updated_at
 *   - Партиал-индекс `wb_cards_needs_embed_idx` делает выборку O(touched).
 *   - Если текст embedding'а не изменился — пропускаем API-вызов, только
 *     обновляем embedded_at (дешёво).
 *
 * Стоимость:
 *   - Jina V3: $0.02 / 1M токенов входа. Карточка ~50-150 токенов → ~$0.000004
 *     на карточку. 1400 карточек ≈ $0.005 разовый backfill.
 *
 * Использует существующий `embedTexts` из documentHub/voyage.ts —
 * та же инфраструктура что для документов, не плодим клиентов.
 */

import { and, eq, isNull, lt, or, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { wbCards } from '../db/schema.js';
import { embedTexts, isVoyageEnabled } from '../services/documentHub/voyage.js';
import { buildCardEmbeddingText, shouldSkipReembed, type CardForEmbed } from '../services/wbCardsEmbed/buildText.js';
import { logJobs as logger } from '../lib/logger.js';

/** Сколько карточек обрабатывать за один проход. */
const BATCH_SIZE = 64;
/** Не более N батчей за один cron-вызов (защита от прогона всей БД за раз). */
const MAX_BATCHES_PER_RUN = 50;

interface SyncResult {
  candidates: number;
  embedded: number;
  skipped: number;
  errors: number;
}

/**
 * Главная функция. Может быть вызвана:
 *  - из scheduler (cron каждые 15 мин)
 *  - вручную через scripts/backfill-card-embeddings.ts
 *  - после массового sync wb_cards для свежезагруженных
 */
export async function runWbCardsEmbedSync(opts?: {
  workspaceId?: number;
  maxBatches?: number;
}): Promise<SyncResult> {

  if (!opts?.workspaceId) {
    const { getWorkspacesToProcess } = await import('./workspaceIterator.js');
    const total = { candidates: 0, embedded: 0, skipped: 0, errors: 0 };
    for (const workspaceId of await getWorkspacesToProcess()) {
      const r = await runWbCardsEmbedSync({ ...opts, workspaceId });
      for (const key of ['candidates','embedded','skipped','errors'] as const) total[key] += r[key];
    }
    return total;
  }
  return runWithAiWorkspace(opts.workspaceId, async () => {
  if (!(await isVoyageEnabled())) {
    logger.warn('Embed sync skipped — no JINA_API_KEY / VOYAGE_API_KEY in env');
    return { candidates: 0, embedded: 0, skipped: 0, errors: 0 };
  }

  const maxBatches = opts?.maxBatches ?? MAX_BATCHES_PER_RUN;
  let totalEmbedded = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalCandidates = 0;

  for (let pass = 0; pass < maxBatches; pass++) {
    // Берём пакет карточек которые нуждаются в (ре)эмбединге
    const whereClause = opts?.workspaceId
      ? and(
          eq(wbCards.workspaceId, opts.workspaceId),
          or(
            isNull(wbCards.embedding),
            lt(wbCards.embeddedAt, wbCards.updatedAt),
            isNull(wbCards.embeddedAt),
          ),
        )
      : or(
          isNull(wbCards.embedding),
          lt(wbCards.embeddedAt, wbCards.updatedAt),
          isNull(wbCards.embeddedAt),
        );

    const candidates = await db
      .select({
        workspaceId: wbCards.workspaceId,
        nmId: wbCards.nmId,
        title: wbCards.title,
        brandName: wbCards.brandName,
        subjectName: wbCards.subjectName,
        vendorCode: wbCards.vendorCode,
        raw: wbCards.raw,
        prevEmbeddingText: wbCards.embeddingText,
      })
      .from(wbCards)
      .where(whereClause)
      .limit(BATCH_SIZE);

    if (candidates.length === 0) break;
    totalCandidates += candidates.length;

    // Готовим тексты + помечаем те где можно skip API-вызов
    const toEmbed: { idx: number; text: string }[] = [];
    const skipUpdates: { workspaceId: number; nmId: number }[] = [];
    const generatedTexts: string[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const card: CardForEmbed = {
        nmId: c.nmId,
        title: c.title,
        brandName: c.brandName,
        subjectName: c.subjectName,
        vendorCode: c.vendorCode,
        raw: c.raw as any,
      };
      const text = buildCardEmbeddingText(card);
      generatedTexts.push(text);

      if (!text.trim()) {
        // Совсем пустая карточка — просто помечаем embedded_at чтобы не
        // выбирать снова. embedding остаётся NULL — для пустых карточек
        // RAG-поиск всё равно бессмысленен.
        skipUpdates.push({ workspaceId: c.workspaceId, nmId: c.nmId });
        continue;
      }
      if (shouldSkipReembed(c.prevEmbeddingText, text)) {
        // Текст не изменился — embedding актуален, обновляем только timestamp
        skipUpdates.push({ workspaceId: c.workspaceId, nmId: c.nmId });
        continue;
      }
      toEmbed.push({ idx: i, text });
    }

    // Skip-update: одним запросом обновляем embedded_at для unchanged
    if (skipUpdates.length > 0) {
      // Drizzle не умеет batch update по composite PK — делаем raw SQL
      const tuples = skipUpdates.map((s) => `(${s.workspaceId}, ${s.nmId})`).join(',');
      await db.execute(sql`
        UPDATE wb_cards SET embedded_at = NOW()
        WHERE (workspace_id, nm_id) IN (${sql.raw(tuples)})
      `);
      totalSkipped += skipUpdates.length;
    }

    // Embed: одним батчем в Jina/Voyage
    if (toEmbed.length > 0) {
      try {
        const texts = toEmbed.map((t) => t.text);
        const vectors = await embedTexts(texts, 'document');
        if (vectors.length !== texts.length) {
          throw new Error(`Embed returned ${vectors.length} vectors for ${texts.length} texts`);
        }

        // Записываем каждое embedding отдельным UPDATE — pgvector не имеет
        // массовой формы для composite-PK таблиц, и за раз у нас ≤64 строк,
        // это укладывается в ~50мс на pg.
        for (let j = 0; j < toEmbed.length; j++) {
          const { idx } = toEmbed[j];
          const candidate = candidates[idx];
          const vec = vectors[j];
          // pgvector принимает строку '[v1,v2,...]'
          const vecStr = `[${vec.join(',')}]`;
          await db.execute(sql`
            UPDATE wb_cards
            SET embedding = ${vecStr}::vector,
                embedding_text = ${toEmbed[j].text},
                embedded_at = NOW()
            WHERE workspace_id = ${candidate.workspaceId} AND nm_id = ${candidate.nmId}
          `);
        }
        totalEmbedded += toEmbed.length;
      } catch (err) {
        totalErrors += toEmbed.length;
        logger.error({ err, batchSize: toEmbed.length }, 'Failed to embed batch');
        // продолжаем — следующий проход попробует те же карточки
      }
    }

    logger.debug({
      pass,
      candidates: candidates.length,
      embedded: toEmbed.length,
      skipped: skipUpdates.length,
    }, 'wb_cards embed pass completed');
  }

  logger.info(totalEmbedded > 0 || totalSkipped > 0 ? {
    candidates: totalCandidates,
    embedded: totalEmbedded,
    skipped: totalSkipped,
    errors: totalErrors,
  } : { candidates: 0 }, 'wb_cards embed sync done');

  return {
    candidates: totalCandidates,
    embedded: totalEmbedded,
    skipped: totalSkipped,
    errors: totalErrors,
  };

});
}
