import { runWithAiWorkspace } from '../../lib/sellerAiContext.js';
import { requireSellerAiKey } from '../sellerAiCredentials.js';
/**
 * Document Hub — RAG pipeline for knowledge base search.
 *
 * Architecture:
 * 1. Upload documents → parse → chunk → embed (text-embedding-3-small via OpenAI compat) → store in document_chunks
 * 2. Query → embed → cosine similarity search → LLM answer with context
 *
 * Supports: PDF, DOCX, XLSX, TXT, MD
 * Vector search via pgvector if available, keyword fallback otherwise.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';
import { env } from '../../env.js';
import { db, pool } from '../../db/client.js';
import { documents, documentChunks, knowledgeEntries } from '../../db/schema.js';
import { logDocHub as logger } from '../../lib/logger.js';
import { eq, and, or, sql, desc, isNull } from 'drizzle-orm';
import { computeCostMicros, recordAiUsage } from '../../services/aiSettings.js';
import { embedTexts, isVoyageEnabled } from './voyage.js';

// ── Types ────────────────────────────────────────

export interface DocumentMeta {
  documentId: number;
  title: string;
  fileName: string | null;
  fileType: string;
  status: string;
  chunkCount: number;
  createdAt: Date;
}

export interface SearchResult {
  chunkId: number;
  documentId: number;
  title: string;
  chunkText: string;
  score: number;
  source: string;
  pageNumber: number | null;
}

export interface RagAnswer {
  answer: string;
  sources: Array<{ documentId: number; title: string; chunkText: string }>;
}

// ── Text Chunking ────────────────────────────────────

const CHUNK_MAX_CHARS = 1500; // ~375 tokens
const CHUNK_OVERLAP_CHARS = 200;

export function chunkText(text: string): { text: string; index: number }[] {
  const chunks: { text: string; index: number }[] = [];
  const sentences = text.split(/(?<=[.!?\n])\s+/);

  let current = '';
  let chunkIndex = 0;

  for (const sentence of sentences) {
    if (current.length + sentence.length > CHUNK_MAX_CHARS && current.length > 0) {
      chunks.push({ text: current.trim(), index: chunkIndex });
      const words = current.split(/\s+/);
      const overlapWords = words.slice(-Math.ceil(CHUNK_OVERLAP_CHARS / 5));
      current = overlapWords.join(' ') + ' ' + sentence;
      chunkIndex++;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }

  if (current.trim()) {
    chunks.push({ text: current.trim(), index: chunkIndex });
  }

  return chunks;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ── Document CRUD ────────────────────────────────

export async function createDocument(
  wsId: number,
  userId: number,
  title: string,
  content: string,
  opts: { fileName?: string; fileType?: string; isKnowledgeBase?: boolean; source?: string; shopId?: number | null } = {}
): Promise<{ documentId: number; chunksCreated: number }> {
return runWithAiWorkspace(wsId, async () => {

  const fileType = opts.fileType ?? 'txt';
  const fileSizeBytes = Buffer.byteLength(content, 'utf-8');
  const isKb = opts.isKnowledgeBase ?? false;
  // shopId === null → explicitly shared across shops; undefined → also shared (default)
  const shopId = opts.shopId ?? null;

  // Insert document record via raw pg pool (avoids Drizzle ORM issues with serial/identity)
  const docResult = await pool.query(
    `INSERT INTO documents (workspace_id, shop_id, uploaded_by, title, file_name, file_type, file_size_bytes, full_text, is_knowledge_base, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'processing')
     RETURNING document_id`,
    [wsId, shopId, userId || null, title, opts.fileName ?? null, fileType, fileSizeBytes, content, isKb]
  );
  const docId = Number(docResult.rows[0]?.document_id);
  if (!docId) throw new Error('Failed to insert document');
  const doc = { documentId: docId };

  // Chunk the text
  const chunks = chunkText(content);

  // Insert chunks via raw pg pool
  if (chunks.length > 0) {
    for (const chunk of chunks) {
      await pool.query(
        `INSERT INTO document_chunks (document_id, workspace_id, shop_id, content, chunk_index, token_count, content_hash, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [doc.documentId, wsId, shopId, chunk.text, chunk.index, Math.ceil(chunk.text.length / 4), sha256(chunk.text), JSON.stringify({ source: opts.source ?? 'upload' })]
      );
    }
  }

  // Generate embeddings via Voyage AI (non-blocking on failure)
  let embeddingsGenerated = false;
  if ((await isVoyageEnabled()) && chunks.length > 0) {
    try {
      const embeddings = await embedTexts(chunks.map(c => c.text), 'document');
      for (let i = 0; i < chunks.length; i++) {
        await db.update(documentChunks)
          .set({ embedding: embeddings[i] })
          .where(and(
            eq(documentChunks.documentId, doc.documentId),
            eq(documentChunks.chunkIndex, chunks[i].index),
          ));
      }
      embeddingsGenerated = true;
      logger.info({ documentId: doc.documentId, chunks: chunks.length }, 'Embeddings generated');
    } catch (err) {
      logger.warn({ err, documentId: doc.documentId }, 'Embedding generation failed, keyword search will be used');
    }
  }

  // Update document status
  await pool.query(
    `UPDATE documents SET status = 'indexed', chunk_count = $1, updated_at = NOW() WHERE document_id = $2`,
    [chunks.length, doc.documentId]
  );

  // Also insert into knowledgeEntries for backward compatibility with feedback pipeline
  if (opts.isKnowledgeBase) {
    for (const chunk of chunks) {
      await db.insert(knowledgeEntries).values({
        workspaceId: wsId,
        scopeType: 'workspace',
        scopeKey: 'document',
        title: chunks.length > 1 ? `${title} (часть ${chunk.index + 1}/${chunks.length})` : title,
        content: chunk.text,
        source: opts.source ?? 'document_hub',
        entryType: 'general',
        tags: ['document'],
      });
    }
  }

  logger.info({ documentId: doc.documentId, chunks: chunks.length }, 'Document indexed');

  return { documentId: doc.documentId, chunksCreated: chunks.length };

});
}

export async function listDocuments(wsId: number): Promise<DocumentMeta[]> {
  const rows = await db.select({
    documentId: documents.documentId,
    title: documents.title,
    fileName: documents.fileName,
    fileType: documents.fileType,
    status: documents.status,
    chunkCount: documents.chunkCount,
    createdAt: documents.createdAt,
  })
    .from(documents)
    .where(and(
      eq(documents.workspaceId, wsId),
      isNull(documents.deletedAt),
    ))
    .orderBy(desc(documents.createdAt))
    .limit(200);

  return rows as DocumentMeta[];
}

export async function deleteDocument(wsId: number, documentId: number): Promise<void> {
  await db.update(documents)
    .set({ deletedAt: new Date() })
    .where(and(
      eq(documents.documentId, documentId),
      eq(documents.workspaceId, wsId),
    ));
}

// ── Search (vector via Voyage + pgvector, keyword fallback) ────

export async function searchDocuments(wsId: number, query: string, limit: number = 5, shopId?: number): Promise<SearchResult[]> {
return runWithAiWorkspace(wsId, async () => {

  // Try vector search first
  if ((await isVoyageEnabled())) {
    try {
      const results = await vectorSearch(wsId, query, limit, shopId);
      if (results.length > 0) return results;
    } catch (err) {
      logger.warn({ err }, 'Vector search failed, falling back to keyword');
    }
  }

  // Fallback: keyword search
  return keywordSearch(wsId, query, limit, shopId);

});
}

async function vectorSearch(wsId: number, query: string, limit: number, shopId?: number): Promise<SearchResult[]> {
  const [queryEmbedding] = await embedTexts([query], 'query');
  const vecStr = `[${queryEmbedding.join(',')}]`;

  const shopFilter = shopId
    ? sql`AND (d.shop_id = ${shopId} OR d.shop_id IS NULL)`
    : sql``;

  const rows = (await db.execute(sql`
    SELECT
      dc.chunk_id AS "chunkId",
      dc.document_id AS "documentId",
      d.title,
      LEFT(dc.content, 500) AS "chunkText",
      (1 - (dc.embedding <=> ${sql.raw(`'${vecStr}'::vector`)})) AS score,
      COALESCE(d.file_name, 'upload') AS source,
      dc.page_number AS "pageNumber"
    FROM document_chunks dc
    INNER JOIN documents d ON dc.document_id = d.document_id
    WHERE dc.workspace_id = ${wsId}
      AND d.deleted_at IS NULL
      AND dc.embedding IS NOT NULL
      ${shopFilter}
    ORDER BY dc.embedding <=> ${sql.raw(`'${vecStr}'::vector`)}
    LIMIT ${limit}
  `)) as unknown as { rows: any[] };

  return rows.rows.map((r: any) => ({
    chunkId: Number(r.chunkId),
    documentId: Number(r.documentId),
    title: r.title ?? 'Без названия',
    chunkText: r.chunkText,
    score: Number(r.score),
    source: r.source,
    pageNumber: r.pageNumber ? Number(r.pageNumber) : null,
  }));
}

function keywordSearch(wsId: number, query: string, limit: number, shopId?: number): Promise<SearchResult[]> {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return Promise.resolve([]);

  const shopConds = shopId
    ? [or(eq(documents.shopId, shopId), isNull(documents.shopId))]
    : [];

  return db.select({
    chunkId: documentChunks.chunkId,
    documentId: documentChunks.documentId,
    content: documentChunks.content,
    chunkIndex: documentChunks.chunkIndex,
    pageNumber: documentChunks.pageNumber,
    title: documents.title,
    fileName: documents.fileName,
  })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.documentId))
    .where(and(
      eq(documentChunks.workspaceId, wsId),
      isNull(documents.deletedAt),
      ...shopConds,
    ))
    .limit(500)
    .then(chunks => {
      const scored = chunks.map(chunk => {
        let score = 0;
        const lowerContent = chunk.content.toLowerCase();
        const lowerTitle = (chunk.title ?? '').toLowerCase();
        for (const word of words) {
          if (lowerTitle.includes(word)) score += 3;
          if (lowerContent.includes(word)) score += 1;
        }
        return {
          chunkId: chunk.chunkId,
          documentId: chunk.documentId,
          title: chunk.title ?? 'Без названия',
          chunkText: chunk.content.slice(0, 500),
          score,
          source: chunk.fileName ?? 'upload',
          pageNumber: chunk.pageNumber,
        };
      });

      const matched = scored
        .filter(e => e.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      // Fallback к «началу документа», если ни одно слово вопроса не нашлось
      // в чанках. Без этого мета-вопросы («какие тут данные?», «что за файл?»)
      // ловят пустой контекст и AI отвечает «не нашёл ничего», хотя в БД
      // лежит индексированный документ. Берём первые N чанков (по позиции)
      // с минимальным score чтобы они прошли по фильтру в ragAnswer.
      if (matched.length === 0 && chunks.length > 0) {
        const heads = chunks
          .sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0))
          .slice(0, Math.min(limit, 3))
          .map(chunk => ({
            chunkId: chunk.chunkId,
            documentId: chunk.documentId,
            title: chunk.title ?? 'Без названия',
            chunkText: chunk.content.slice(0, 500),
            score: 0.1,           // ниже keyword-match, но > 0 для фильтра в ragAnswer
            source: chunk.fileName ?? 'upload',
            pageNumber: chunk.pageNumber,
          }));
        return heads;
      }

      return matched;
    });
}

// ── Legacy search (backward compatibility with existing routes) ────

export async function searchKnowledgeBase(
  wsId: number,
  query: string,
  limit: number = 5,
  shopId?: number,
): Promise<{ entryId: number; title: string; chunkText: string; score: number; source: string }[]> {
  // Try new document_chunks first, fall back to knowledge_entries
  const docResults = await searchDocuments(wsId, query, limit, shopId);

  if (docResults.length > 0) {
    return docResults.map(r => ({
      entryId: r.chunkId,
      title: r.title,
      chunkText: r.chunkText,
      score: r.score,
      source: r.source,
    }));
  }

  // Fallback to legacy knowledgeEntries
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return [];

  const entries = await db.select({
    entryId: knowledgeEntries.entryId,
    title: knowledgeEntries.title,
    content: knowledgeEntries.content,
    priority: knowledgeEntries.priority,
    source: knowledgeEntries.source,
  })
    .from(knowledgeEntries)
    .where(and(
      eq(knowledgeEntries.workspaceId, wsId),
      eq(knowledgeEntries.isActive, true),
    ))
    .limit(100);

  const scored = entries.map(entry => {
    let score = entry.priority ?? 0;
    const lowerTitle = entry.title.toLowerCase();
    const lowerContent = entry.content.toLowerCase();

    for (const word of words) {
      if (lowerTitle.includes(word)) score += 3;
      if (lowerContent.includes(word)) score += 1;
    }

    return {
      entryId: entry.entryId,
      title: entry.title,
      chunkText: entry.content.slice(0, 500),
      score,
      source: entry.source ?? 'manual',
    };
  });

  return scored
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── RAG Answer ────────────────────────────────────────

export async function ragAnswer(wsId: number, question: string): Promise<RagAnswer> {
return runWithAiWorkspace(wsId, async () => {

  // Search for relevant context from both sources
  const results = await searchDocuments(wsId, question, 5);

  if (results.length === 0) {
    // Try legacy KB
    const legacyResults = await searchKnowledgeBase(wsId, question, 5);
    if (legacyResults.length === 0) {
      return {
        answer: 'К сожалению, в базе знаний не найдена информация по вашему запросу. Загрузите документы для получения ответов.',
        sources: [],
      };
    }

    // Use legacy results
    const context = legacyResults.map((r, i) => `[${i + 1}] ${r.title}\n${r.chunkText}`).join('\n\n');
    return generateRagResponse(wsId, question, context, legacyResults.map(r => ({
      documentId: r.entryId,
      title: r.title,
      chunkText: r.chunkText,
    })));
  }

  const context = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.chunkText}`).join('\n\n');

  return generateRagResponse(wsId, question, context, results.map(r => ({
    documentId: r.documentId,
    title: r.title,
    chunkText: r.chunkText,
  })));

});
}

async function generateRagResponse(
  wsId: number,
  question: string,
  context: string,
  sources: RagAnswer['sources']
): Promise<RagAnswer> {
  const client = new Anthropic({ maxRetries: 0, apiKey: (await requireSellerAiKey('anthropic')) });
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    temperature: 0.3,
    messages: [{
      role: 'user',
      content: `Ты — помощник по базе знаний магазина на Wildberries.

КОНТЕКСТ ИЗ БАЗЫ ЗНАНИЙ:
${context}

ВОПРОС: ${question}

Ответь на вопрос, используя ТОЛЬКО информацию из контекста. Если в контексте нет ответа — скажи об этом. Ссылайся на источники: [1], [2] и т.д.`,
    }],
  });

  const textBlock = response.content.find(c => c.type === 'text');
  const answer = textBlock?.type === 'text' ? textBlock.text : 'Не удалось сформировать ответ.';

  // Track usage
  const pt = response.usage?.input_tokens ?? 0;
  const ct = response.usage?.output_tokens ?? 0;
  if (pt + ct > 0) {
    try {
      await recordAiUsage({
        workspaceId: wsId, provider: 'anthropic', model: 'claude-sonnet-4-6',
        promptTokens: pt, completionTokens: ct, totalTokens: pt + ct,
        costMicros: computeCostMicros({ promptTokens: pt, completionTokens: ct, promptPricePer1mMicros: 3_000_000, completionPricePer1mMicros: 15_000_000 }),
        meta: { feature: 'document_hub_rag' },
      });
    } catch (err) { logger.warn({ err }, 'Non-critical error in document hub'); }
  }

  return { answer, sources };
}

// ── Backward-compatible import function ────
export async function importDocument(wsId: number, title: string, content: string, source: string = 'upload'): Promise<number[]> {
return runWithAiWorkspace(wsId, async () => {

  const result = await createDocument(wsId, 0, title, content, { source, isKnowledgeBase: true });
  return [result.documentId];

});
}
