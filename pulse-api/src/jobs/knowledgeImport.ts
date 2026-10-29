/**
 * Knowledge Import Job
 * 
 * Extracts knowledge from historical feedback responses
 * and populates the knowledge base for AI-assisted replies.
 */

import { db } from '../db/client.js';
import { eq, and, isNotNull, desc, sql, ne, inArray } from 'drizzle-orm';
import { marketplaceFeedbackItems, knowledgeEntries, workspaces, wbCards } from '../db/schema.js';
import { extractKnowledgeFromFeedback } from '../integrations/ai/feedbacks.js';
import { logJobs as logger } from '../lib/logger.js';

type Config = {
  enabled: boolean;
  batchSize: number;
  maxPerWorkspace: number;
};

export function getKnowledgeImportConfig(): Config {
  const enabled = (process.env.ENABLE_KNOWLEDGE_IMPORT ?? '') === '1';
  const batchSize = Number.parseInt(process.env.KNOWLEDGE_IMPORT_BATCH_SIZE || '50', 10);
  const maxPerWorkspace = Number.parseInt(process.env.KNOWLEDGE_IMPORT_MAX_PER_WORKSPACE || '200', 10);
  return { enabled, batchSize, maxPerWorkspace };
}

/**
 * Import knowledge from answered feedbacks for a workspace
 */
async function importKnowledgeForWorkspace(workspaceId: number, maxItems: number): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  // Get answered feedbacks that haven't been processed
  // We track processed items by checking if knowledge exists for that itemId
  const existingKnowledge = await db
    .select({ scopeKey: knowledgeEntries.scopeKey })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.workspaceId, workspaceId),
        eq(knowledgeEntries.source, 'ai_extracted')
      )
    );

  const processedIds = new Set(existingKnowledge.map((k) => k.scopeKey));

  // Get answered feedbacks
  const feedbacks = await db
    .select({
      itemId: marketplaceFeedbackItems.itemId,
      nmId: marketplaceFeedbackItems.nmId,
      text: marketplaceFeedbackItems.text,
      answerText: marketplaceFeedbackItems.answerText,
      productTitle: marketplaceFeedbackItems.productTitle,
      rating: marketplaceFeedbackItems.rating,
    })
    .from(marketplaceFeedbackItems)
    .where(
      and(
        eq(marketplaceFeedbackItems.workspaceId, workspaceId),
        eq(marketplaceFeedbackItems.isAnswered, true),
        isNotNull(marketplaceFeedbackItems.answerText)
      )
    )
    .orderBy(desc(marketplaceFeedbackItems.answeredAt))
    .limit(maxItems);

  for (const feedback of feedbacks) {
    // Skip if already processed
    if (processedIds.has(feedback.itemId)) {
      skipped++;
      continue;
    }

    // Skip if no meaningful text
    if (!feedback.text || !feedback.answerText || feedback.answerText.length < 20) {
      skipped++;
      continue;
    }

    try {
      const result = await extractKnowledgeFromFeedback({
        feedbackText: feedback.text,
        responseText: feedback.answerText,
        productTitle: feedback.productTitle,
        rating: feedback.rating,
        workspaceId,
      });

      // Save extracted knowledge entries
      for (const entry of result.entries) {
        await db.insert(knowledgeEntries).values({
          workspaceId,
          scopeType: feedback.nmId ? 'product' : 'company',
          scopeKey: feedback.nmId ? String(feedback.nmId) : 'global',
          entryType: entry.entryType,
          title: entry.title,
          content: entry.content,
          source: 'ai_extracted',
          tags: [feedback.itemId], // Track source itemId
          priority: entry.entryType === 'complaint_solution' ? 10 : 0,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any);

        imported++;
      }

      // Mark as processed by adding a marker entry
      if (result.entries.length === 0) {
        // Add a marker so we don't reprocess
        await db.insert(knowledgeEntries).values({
          workspaceId,
          scopeType: 'processed_marker',
          scopeKey: feedback.itemId,
          entryType: 'general',
          title: '_processed',
          content: '_',
          source: 'ai_extracted',
          isActive: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any);
      }
    } catch (e) {
      logger.error({ err: e, itemId: feedback.itemId }, 'failed to extract from feedback');
      skipped++;
    }

    // Rate limit to avoid hammering the LLM
    await sleep(1000);
  }

  return { imported, skipped };
}

/**
 * Aggregate and deduplicate knowledge entries
 */
async function deduplicateKnowledge(workspaceId: number): Promise<number> {
  // Find duplicate titles within the same scope
  const duplicates = await db
    .select({
      title: knowledgeEntries.title,
      scopeType: knowledgeEntries.scopeType,
      scopeKey: knowledgeEntries.scopeKey,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.workspaceId, workspaceId),
        eq(knowledgeEntries.isActive, true)
      )
    )
    .groupBy(knowledgeEntries.title, knowledgeEntries.scopeType, knowledgeEntries.scopeKey)
    .having(sql`count(*) > 1`);

  let removed = 0;

  for (const dup of duplicates) {
    // Keep the first entry, deactivate the rest
    const entries = await db
      .select({ entryId: knowledgeEntries.entryId })
      .from(knowledgeEntries)
      .where(
        and(
          eq(knowledgeEntries.workspaceId, workspaceId),
          eq(knowledgeEntries.title, dup.title),
          eq(knowledgeEntries.scopeType, dup.scopeType),
          eq(knowledgeEntries.scopeKey, dup.scopeKey),
          eq(knowledgeEntries.isActive, true)
        )
      )
      .orderBy(knowledgeEntries.createdAt)
      .limit(100);

    if (entries.length > 1) {
      // Deactivate all but the first
      const toDeactivate = entries.slice(1).map((e) => e.entryId);
      await db
        .update(knowledgeEntries)
        .set({ isActive: false, updatedAt: new Date() })
        .where(inArray(knowledgeEntries.entryId, toDeactivate));
      removed += toDeactivate.length;
    }
  }

  return removed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run the knowledge import job
 */
export async function runKnowledgeImport(): Promise<void> {
  const cfg = getKnowledgeImportConfig();
  if (!cfg.enabled) {
    logger.info('knowledgeImport disabled');
    return;
  }

  logger.info('knowledgeImport starting');

  // Get all workspaces
  const workspaceList = await db
    .select({ workspaceId: workspaces.workspaceId })
    .from(workspaces)
    .limit(100);

  let totalImported = 0;
  let totalSkipped = 0;
  let totalDeduplicated = 0;

  for (const ws of workspaceList) {
    try {
      const { imported, skipped } = await importKnowledgeForWorkspace(ws.workspaceId, cfg.maxPerWorkspace);
      totalImported += imported;
      totalSkipped += skipped;

      // Deduplicate after import
      const removed = await deduplicateKnowledge(ws.workspaceId);
      totalDeduplicated += removed;

      if (imported > 0 || removed > 0) {
        logger.info({ workspaceId: ws.workspaceId, imported, skipped, deduplicated: removed }, 'knowledgeImport workspace done');
      }
    } catch (e) {
      logger.error({ err: e, workspaceId: ws.workspaceId }, 'knowledgeImport failed for workspace');
    }
  }

  logger.info({ totalImported, totalSkipped, totalDeduplicated }, 'knowledgeImport completed');
}

/**
 * Manual trigger for a specific workspace
 */
export async function importKnowledgeForWorkspaceManual(workspaceId: number): Promise<{ imported: number; skipped: number; deduplicated: number }> {
  const cfg = getKnowledgeImportConfig();
  const { imported, skipped } = await importKnowledgeForWorkspace(workspaceId, cfg.maxPerWorkspace);
  const deduplicated = await deduplicateKnowledge(workspaceId);
  return { imported, skipped, deduplicated };
}
