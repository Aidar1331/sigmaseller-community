/**
 * Document Hub routes — upload documents (text + files), search, RAG Q&A.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../plugins/roleCheck.js';
import multipart from '@fastify/multipart';
import log from '../lib/logger.js';

const logger = log.child({ module: 'documentHub' });

// ── File parsers ────────────────────────────────

// Decompression-bomb guard. Office docs (xlsx/docx) and PDFs can compress
// 1000:1 — a 50MB upload limit on the wire still admits multi-GB extracted
// text. We cap the extracted text size hard; if a document genuinely needs
// more it should be split client-side.
const MAX_EXTRACTED_TEXT_LEN = 4 * 1024 * 1024; // 4MB of text ~ 1M tokens

function clampExtractedText(text: string, fileType: string): string {
  if (text.length <= MAX_EXTRACTED_TEXT_LEN) return text;
  return text.slice(0, MAX_EXTRACTED_TEXT_LEN) + `\n\n[…extracted ${fileType} truncated to ${MAX_EXTRACTED_TEXT_LEN} chars]`;
}

export async function extractTextFromBuffer(buffer: Buffer, mimeType: string, fileName: string): Promise<{ text: string; fileType: string }> {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';

  // Plain text
  if (['txt', 'md', 'csv'].includes(ext) || mimeType.startsWith('text/')) {
    return { text: clampExtractedText(buffer.toString('utf-8'), ext || 'txt'), fileType: ext || 'txt' };
  }

  // PDF — pdf-parse@2 сменили API: вместо функции теперь класс PDFParse.
  if (ext === 'pdf' || mimeType === 'application/pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return { text: clampExtractedText(result.text ?? '', 'pdf'), fileType: 'pdf' };
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  // DOCX
  if (ext === 'docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return { text: clampExtractedText(result.value, 'docx'), fileType: 'docx' };
  }

  // XLSX — cap per-sheet output and total cell count to prevent decompression
  // bombs. A 50MB compressed XLSX with 100M empty cells expands to >2GB CSV;
  // refuse anything that materially exceeds the text cap.
  if (ext === 'xlsx' || ext === 'xls' || mimeType.includes('spreadsheet')) {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const texts: string[] = [];
    let totalLen = 0;
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const ref = (sheet as any)['!ref'] as string | undefined;
      // Sheet-level cell count guard. A sheet with >1M cells is almost
      // certainly a bomb; legitimate spreadsheets rarely cross this bound.
      if (ref) {
        const range = XLSX.utils.decode_range(ref);
        const cells = (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
        if (cells > 1_000_000) {
          throw new Error(`Sheet "${sheetName}" too large (${cells} cells > 1M cap)`);
        }
      }
      const csv = XLSX.utils.sheet_to_csv(sheet);
      totalLen += csv.length;
      if (totalLen > MAX_EXTRACTED_TEXT_LEN) {
        texts.push(`## ${sheetName}\n[…sheet skipped — extracted text exceeded cap]`);
        break;
      }
      texts.push(`## ${sheetName}\n${csv}`);
    }
    return { text: clampExtractedText(texts.join('\n\n'), 'xlsx'), fileType: 'xlsx' };
  }

  throw new Error(`Неподдерживаемый формат файла: ${ext || mimeType}`);
}

// ── Routes ──────────────────────────────────────

export const documentHubRoutes: FastifyPluginAsync = async (app) => {
  // Register multipart for file uploads (50MB limit)
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  // Upload document (text content — legacy)
  app.post('/document-hub/upload', { preHandler: requireRole('manager') }, async (req) => {
    const q = z.object({
      workspaceId: z.coerce.number().int().positive(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);
    const body = z.object({
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(500000),
      source: z.string().default('upload'),
      fileType: z.string().default('txt'),
      fileName: z.string().optional(),
      isKnowledgeBase: z.boolean().default(false),
      // Body shopId overrides query shopId (explicit per-document scope).
      // null in body = explicitly shared (overrides any query shopId auto-injected by frontend).
      shopId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
    }).parse(req.body);

    const shopId = body.shopId !== undefined ? body.shopId : (q.shopId ?? null);

    const { createDocument } = await import('../services/documentHub/index.js');
    const result = await createDocument(q.workspaceId, (req as any).userId ?? 0, body.title, body.content, {
      source: body.source,
      fileType: body.fileType,
      fileName: body.fileName,
      isKnowledgeBase: body.isKnowledgeBase,
      shopId,
    });

    return result;
  });

  // Upload file (multipart — PDF, DOCX, XLSX, TXT, MD)
  app.post('/document-hub/upload-file', { preHandler: requireRole('manager') }, async (req, reply) => {
    const q = z.object({
      workspaceId: z.coerce.number().int().positive(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);
    const wsId = q.workspaceId;
    const shopId = q.shopId ?? null;
    const userId = (req as any).user?.userId ?? 0;

    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: 'Файл не прикреплён' });
    }

    const buffer = await file.toBuffer();
    const fileName = file.filename;
    const mimeType = file.mimetype;

    if (buffer.length === 0) {
      return reply.code(400).send({ error: 'Пустой файл' });
    }

    logger.info({ fileName, mimeType, size: buffer.length }, 'File upload received');

    // Extract text from file
    let text: string;
    let fileType: string;
    try {
      const parsed = await extractTextFromBuffer(buffer, mimeType, fileName);
      text = parsed.text;
      fileType = parsed.fileType;
    } catch (err: any) {
      return reply.code(400).send({ error: err.message || 'Не удалось извлечь текст из файла' });
    }

    if (!text.trim()) {
      return reply.code(400).send({ error: 'Файл не содержит текста' });
    }

    // Use filename without extension as title
    const title = fileName.replace(/\.[^.]+$/, '') || 'Документ';

    const { createDocument } = await import('../services/documentHub/index.js');
    const result = await createDocument(wsId, userId, title, text, {
      source: 'file_upload',
      fileType,
      fileName,
      isKnowledgeBase: true,
      shopId,
    });

    return { ...result, fileName, fileType, textLength: text.length };
  });

  // List documents
  app.get('/document-hub/documents', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);

    const { listDocuments } = await import('../services/documentHub/index.js');
    const docs = await listDocuments(wsId);

    return { documents: docs };
  });

  // Delete document (soft)
  app.delete('/document-hub/documents/:documentId', { preHandler: requireRole('manager') }, async (req) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const { documentId } = z.object({ documentId: z.coerce.number().int().positive() }).parse(req.params);

    const { deleteDocument } = await import('../services/documentHub/index.js');
    await deleteDocument(wsId, documentId);

    return { ok: true };
  });

  // Search knowledge base (paginated)
  app.get('/document-hub/search', { preHandler: requireRole('viewer') }, async (req) => {
    const q = z.object({
      workspaceId: z.coerce.number().int().positive(),
      shopId: z.coerce.number().int().positive().optional(),
      query: z.string().min(1).max(500),
      limit: z.coerce.number().int().min(1).max(50).optional().default(5),
      offset: z.coerce.number().int().min(0).optional().default(0),
    }).parse(req.query);

    const { searchKnowledgeBase } = await import('../services/documentHub/index.js');
    const allResults = await searchKnowledgeBase(q.workspaceId, q.query, q.offset + q.limit, q.shopId);
    const paged = allResults.slice(q.offset, q.offset + q.limit);

    return { results: paged, total: allResults.length, offset: q.offset, limit: q.limit };
  });

  // RAG Q&A
  app.post('/document-hub/ask', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const body = z.object({
      question: z.string().min(1).max(2000),
    }).parse(req.body);

    const { ragAnswer } = await import('../services/documentHub/index.js');
    const result = await ragAnswer(wsId, body.question);

    return result;
  });
};
