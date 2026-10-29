import { runWithAiWorkspace } from '../../lib/sellerAiContext.js';
import { requireSellerAiKey } from '../sellerAiCredentials.js';
// Multi-Agent v2 Phase 6 — Kanban Assistant.
//
// Pipeline:
//   audio buffer → Whisper (OpenAI) → transcript → Claude Haiku → extracted
//   tasks → wb_events rows (type='task', status='open').
//
// Entry points:
//   transcribeAudio(buffer, mime) — raw Whisper call
//   extractTasksFromText(text) — Claude-based task extractor
//   createTasksFromAudio({audioBuffer, workspaceId, shopId, userId}) — full pipeline
//
// Route wrapper: POST /kanban/:workspaceId/transcribe (see routes/kanbanAssistant.ts).

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../env.js';
import { db } from '../../db/client.js';
import { wbEvents } from '../../db/schema.js';
import { logAgent as logger } from '../../lib/logger.js';

export interface ExtractedTask {
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  tags?: string[];
}

export interface TranscribeResult {
  transcript: string;
  durationSec?: number;
}

export async function transcribeAudio(audio: Buffer, mime: string): Promise<TranscribeResult> {
  if (!(await requireSellerAiKey('openai'))) throw new Error('OPENAI_API_KEY not configured');

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), 'audio' + mimeToExt(mime));
  form.append('model', 'whisper-1');
  form.append('language', 'ru');
  form.append('response_format', 'verbose_json');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${(await requireSellerAiKey('openai'))}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Whisper API ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as { text?: string; duration?: number };
  return { transcript: String(data.text ?? ''), durationSec: data.duration };
}

function mimeToExt(mime: string): string {
  if (mime.includes('mp3')) return '.mp3';
  if (mime.includes('mp4') || mime.includes('m4a')) return '.m4a';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('webm')) return '.webm';
  return '.bin';
}

export async function extractTasksFromText(text: string): Promise<ExtractedTask[]> {
  if (!(await requireSellerAiKey('anthropic'))) return [];
  if (!text.trim()) return [];

  const client = new Anthropic({ maxRetries: 0, apiKey: (await requireSellerAiKey('anthropic')) });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    system:
      'Ты извлекаешь задачи из рабочего транскрипта продавца Wildberries. Верни JSON массив: [{title, description?, priority: "low"|"medium"|"high"|"urgent", tags: ["..."]}]. Не добавляй задачу для фраз-филлеров. Title — короткий (до 80 символов). Description — одно предложение контекста. Priority по фразам: "срочно"/"немедленно" → urgent, "важно" → high, остальное → medium. Tags: ["pricing", "reviews", "ads", "supply", "seo", "chat", "fbs"] — максимум 2 релевантных.',
    messages: [{ role: 'user', content: `Транскрипт:\n"""\n${text}\n"""\n\nВерни только JSON-массив.` }],
  });

  const out = response.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
  const match = out.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]) as ExtractedTask[];
    return Array.isArray(arr) ? arr.filter((t) => t.title && t.title.trim()) : [];
  } catch {
    return [];
  }
}

export async function createTasksFromAudio(params: {
  audio: Buffer;
  mime: string;
  workspaceId: number;
  shopId?: number | null;
}): Promise<{ transcript: string; createdCount: number; taskIds: number[] }> {
return runWithAiWorkspace(params.workspaceId, async () => {

  const { transcript, durationSec } = await transcribeAudio(params.audio, params.mime);
  const tasks = await extractTasksFromText(transcript);

  const today = new Date().toISOString().slice(0, 10);
  const taskIds: number[] = [];

  for (const t of tasks) {
    const inserted = await db.insert(wbEvents).values({
      workspaceId: params.workspaceId,
      shopId: params.shopId ?? null,
      date: today,
      type: 'task',
      category: 'kanban',
      severity: 'info',
      status: 'open',
      priority: t.priority ?? 'medium',
      title: t.title.slice(0, 255),
      description: t.description ?? null,
      evidence: { source: 'kanban_assistant_audio', durationSec: durationSec ?? null },
      tags: t.tags ?? [],
    }).returning({ eventId: wbEvents.eventId });
    if (inserted[0]) taskIds.push(inserted[0].eventId);
  }

  logger.info({ workspaceId: params.workspaceId, transcriptChars: transcript.length, createdCount: taskIds.length }, 'kanban-assistant audio → tasks');
  return { transcript, createdCount: taskIds.length, taskIds };

});
}
