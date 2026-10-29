import { requireSellerAiKey } from '../../services/sellerAiCredentials.js';
/**
 * OpenAI Sora video generation.
 *
 * Sora is async: create a job, poll status, then downloadContent.
 * Used by the AI Studio video pipeline.
 *
 * Env: OPENAI_API_KEY
 */

import OpenAI from 'openai';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'openai-video' });

export type SoraModel = 'sora-2-pro' | 'sora-2';
export type SoraSize = '720x1280' | '1280x720' | '1024x1024' | '1920x1080' | '1080x1920';

export interface VideoGenerationRequest {
  prompt: string;
  model?: SoraModel;
  seconds?: number;       // 4 / 8 / 12 — model-dependent
  size?: SoraSize;
  /** Optional polling override. */
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface VideoGenerationResult {
  videoId: string;
  model: string;
  buffer: Buffer;          // mp4 bytes
  mimeType: string;        // 'video/mp4'
  seconds: number;
  size: string;
}

async function getClient(): Promise<OpenAI> {
  const key = (await requireSellerAiKey('openai'));
  if (!key) throw new Error('OPENAI_API_KEY is not configured');
  return new OpenAI({ maxRetries: 0, apiKey: key });
}

export async function generateVideo(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
  const client = await getClient();
  const model = req.model ?? 'sora-2-pro';
  const seconds = req.seconds ?? 4;
  const size = req.size ?? '1280x720';
  const pollInterval = req.pollIntervalMs ?? 5000;
  const timeoutMs = req.timeoutMs ?? 15 * 60 * 1000; // 15 min

  logger.info({ model, seconds, size }, 'creating Sora video job');

  const job: any = await (client.videos as any).create({
    model,
    prompt: req.prompt,
    seconds: String(seconds),
    size,
  });

  const videoId: string = job?.id;
  if (!videoId) throw new Error('Sora: no video id returned from create()');

  // Poll for completion
  const deadline = Date.now() + timeoutMs;
  let status: string = job?.status ?? 'queued';
  let lastProgress: number | undefined;
  let attempts = 0;
  while (status !== 'completed' && status !== 'succeeded') {
    if (Date.now() > deadline) throw new Error(`Sora: timeout after ${timeoutMs}ms (last status=${status})`);
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      throw new Error(`Sora job ${videoId} ended with status=${status}`);
    }
    await new Promise((r) => setTimeout(r, pollInterval));
    attempts++;
    const fresh: any = await (client.videos as any).retrieve(videoId);
    status = fresh?.status ?? 'unknown';
    const prog = fresh?.progress;
    if (prog !== undefined && prog !== lastProgress) {
      logger.info({ videoId, status, progress: prog, attempt: attempts }, 'Sora polling');
      lastProgress = prog;
    }
  }

  logger.info({ videoId, status, attempts }, 'Sora job complete — downloading');

  // Download content — SDK returns a Response-like object
  const downloaded: any = await (client.videos as any).downloadContent(videoId);
  let buffer: Buffer;
  if (downloaded && typeof downloaded.arrayBuffer === 'function') {
    buffer = Buffer.from(await downloaded.arrayBuffer());
  } else if (downloaded instanceof Buffer) {
    buffer = downloaded;
  } else if (downloaded && typeof downloaded.pipe === 'function') {
    // Readable stream fallback
    const chunks: Buffer[] = [];
    for await (const chunk of downloaded as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    buffer = Buffer.concat(chunks);
  } else {
    throw new Error('Sora: unknown downloadContent shape');
  }

  return { videoId, model, buffer, mimeType: 'video/mp4', seconds, size };
}

// Pricing is a coarse estimate — adjust against OpenAI billing once real usage is measured.
// Sora-2-pro is expected ≈ $0.50/sec for 720p. Use as internal credit calc only.
const COST_PER_SECOND: Record<string, number> = {
  'sora-2-pro': 0.50,
  'sora-2':     0.20,
};

export function estimateVideoCost(model: SoraModel, seconds: number): string {
  const unit = COST_PER_SECOND[model] ?? 0.50;
  return (seconds * unit).toFixed(4);
}
