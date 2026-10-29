/**
 * Kanban Assistant API — Phase 6.
 *
 * POST /kanban/:workspaceId/transcribe
 *   Upload audio (multipart "file"), get transcript + auto-extracted tasks.
 *   Requires manager role. Uses OpenAI Whisper + Claude Haiku.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createTasksFromAudio } from '../services/kanbanAssistant/index.js';
import { requireRole } from '../plugins/roleCheck.js';
import { logAgent as logger } from '../lib/logger.js';

const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20 MB (Whisper hard limit 25 MB)

export const kanbanAssistantRoutes: FastifyPluginAsync = async (app) => {
  app.post('/kanban/:workspaceId/transcribe', { preHandler: requireRole('manager') }, async (req, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const { shopId } = z.object({ shopId: z.coerce.number().int().positive().nullable().optional() }).parse(req.query);

    const data = await (req as unknown as { file: () => Promise<{ toBuffer: () => Promise<Buffer>; mimetype: string } | null> }).file();
    if (!data) return reply.code(400).send({ error: 'missing_file', hint: 'Send multipart with "file" field' });
    const buffer = await data.toBuffer();
    if (buffer.length === 0) return reply.code(400).send({ error: 'empty_file' });
    if (buffer.length > MAX_AUDIO_BYTES) return reply.code(413).send({ error: 'file_too_large', maxBytes: MAX_AUDIO_BYTES });

    try {
      const result = await createTasksFromAudio({
        audio: buffer,
        mime: data.mimetype,
        workspaceId,
        shopId: shopId ?? null,
      });
      return { status: 'ok', ...result };
    } catch (err) {
      logger.error({ err, workspaceId }, 'kanban-assistant transcribe failed');
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: 'transcribe_failed', message: msg });
    }
  });
};
