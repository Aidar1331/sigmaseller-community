import { requireSellerAiKey } from '../../services/sellerAiCredentials.js';
/**
 * Runway Gen-3 video integration.
 *
 * Runway API v1 (https://api.dev.runwayml.com/v1):
 *   POST /image_to_video  { promptImage, promptText, model, duration, ratio }
 *   POST /text_to_video   { promptText, model, duration, ratio }   ← если доступен в tier
 *   GET  /tasks/:id       { status, output: [url], failure }
 *
 * Models:
 *   - 'gen3a'       — Gen-3 Alpha (качественный)
 *   - 'gen3a_turbo' — Gen-3 Alpha Turbo (дешевле, быстрее)
 *
 * Env: RUNWAY_API_KEY
 *
 * NB: Runway ключ требует верификации организации (gen3a) и payment
 * method. Если ключа нет — вызов падает с понятной ошибкой.
 */

import log from '../../lib/logger.js';

const logger = log.child({ module: 'runway-video' });

export type RunwayModel =
  | 'gen4.5'
  | 'gen4_turbo'
  | 'gen4_aleph'
  | 'gen3a_turbo'
  | 'act_two'
  | 'veo3'
  | 'veo3.1_audio'
  | 'veo3.1_noaudio'
  | 'veo3.1_fast_audio'
  | 'veo3.1_fast_noaudio';
/**
 * Runway video API имеет РАЗНЫЕ whitelist'ы ratio по поколению моделей:
 *   gen3a_turbo:           1280:768, 768:1280, 1024:1024, 1920:1080, 1080:1920
 *   gen4 / veo* (актуально 2026-05-27 по 400-ошибке):
 *                          1280:720, 720:1280, 1104:832, 832:1104, 960:960, 1584:672
 *
 * До 2026-05-27 код жёстко слал 1280:768 на Veo → 400. Теперь ratio
 * выбирается по модели (см. ratioToApi).
 */
export type RunwayRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | 'ultrawide';
export type RunwayDuration = 4 | 5 | 8 | 10;

export interface RunwayVideoRequest {
  prompt: string;
  /** Опорное изображение (для image-to-video и act_two обязательно). Data URL или публичный URL. */
  referenceImageUrl?: string;
  model?: RunwayModel;
  duration?: RunwayDuration;
  ratio?: RunwayRatio;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface RunwayVideoResult {
  taskId: string;
  model: string;
  buffer: Buffer;
  mimeType: string;
  seconds: number;
  size: string;
}

const API_BASE = process.env.RUNWAY_API_BASE || 'https://api.dev.runwayml.com/v1';
const API_VERSION = process.env.RUNWAY_API_VERSION || '2024-11-06';

async function getKey(): Promise<string> {
  const k = (await requireSellerAiKey('runway'));
  if (!k) throw new Error('RUNWAY_API_KEY is not configured');
  return k;
}

// Models that require a reference image (act_two = performance transfer over ref)
const IMAGE_REQUIRED: RunwayModel[] = ['act_two'];

// Map veo3.1_audio / veo3.1_noaudio / veo3.1_fast_* to actual API model name + includeAudio flag.
function resolveApiModel(m: RunwayModel): { apiModel: string; includeAudio?: boolean } {
  switch (m) {
    case 'veo3.1_audio':        return { apiModel: 'veo3.1', includeAudio: true };
    case 'veo3.1_noaudio':      return { apiModel: 'veo3.1', includeAudio: false };
    case 'veo3.1_fast_audio':   return { apiModel: 'veo3.1_fast', includeAudio: true };
    case 'veo3.1_fast_noaudio': return { apiModel: 'veo3.1_fast', includeAudio: false };
    default:                    return { apiModel: m };
  }
}

/** Маппинг пользовательского ratio на пиксельное значение для каждой модели.
 * Веб/UI работает в категориях «16:9», «9:16», и т.д. — а Runway требует
 * конкретные пары пикселей, разные по поколениям моделей. */
function ratioToApi(r: RunwayRatio, model: RunwayModel): string {
  // gen3a_turbo (старый whitelist)
  if (model === 'gen3a_turbo') {
    switch (r) {
      case '16:9':      return '1280:768';
      case '9:16':      return '768:1280';
      case '1:1':       return '1024:1024';
      case '4:3':       return '1024:1024'; // gen3 не даёт 4:3, ближайшее
      case '3:4':       return '1024:1024';
      case 'ultrawide': return '1920:1080';
    }
  }
  // gen4 / veo3* / act_two (новый whitelist 2026-05)
  switch (r) {
    case '16:9':      return '1280:720';
    case '9:16':      return '720:1280';
    case '1:1':       return '960:960';
    case '4:3':       return '1104:832';
    case '3:4':       return '832:1104';
    case 'ultrawide': return '1584:672';
  }
}

/** Инлайнит локальные /storage/* в data: URI чтобы Runway не получил 401
 * при попытке скачать защищённый эндпоинт. Зеркалит логику из
 * runwayImage.ts:toReferenceUri. До 2026-05-27 видео-flow это не делал →
 * все image-to-video с локальной картинкой падали с 400 "Failed to fetch
 * asset 401". */
async function toReferenceUri(url: string): Promise<string> {
  if (url.startsWith('data:')) return url;

  const storageMatch = url.match(/\/storage\/(.+?)(?:\?|$)/);
  if (storageMatch) {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const root = process.env.LOCAL_STORAGE_ROOT
        || path.resolve('/srv/sigmaseller/pulse-api/storage');
      const rel = decodeURIComponent(storageMatch[1] ?? '');
      if (rel.includes('..') || rel.startsWith('/')) throw new Error('unsafe storage path');
      const abs = path.resolve(path.join(root, rel));
      if (!abs.startsWith(path.resolve(root) + path.sep)) throw new Error('storage path escape');
      const buf = await fs.readFile(abs);
      const ext = rel.split('.').pop()?.toLowerCase() ?? '';
      const mime =
        ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
        ext === 'webp' ? 'image/webp' :
        ext === 'gif' ? 'image/gif' :
        'image/png';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (err: any) {
      logger.warn({ url, err: err?.message }, 'failed to inline /storage reference for video, falling back');
    }
  }

  try {
    const r = await fetch(url);
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      const mime = r.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
      return `data:${mime};base64,${buf.toString('base64')}`;
    }
  } catch {
    // ignore
  }

  return url;
}

export async function generateVideo(req: RunwayVideoRequest): Promise<RunwayVideoResult> {
  const model = req.model ?? 'gen4_turbo';
  const duration: RunwayDuration = (req.duration ?? 5) as RunwayDuration;
  const ratio: RunwayRatio = req.ratio ?? '16:9';
  const pollInterval = req.pollIntervalMs ?? 5000;
  const timeoutMs = req.timeoutMs ?? 15 * 60 * 1000;
  const { apiModel, includeAudio } = resolveApiModel(model);

  if (IMAGE_REQUIRED.includes(model) && !req.referenceImageUrl) {
    throw new Error(`Runway model ${model} requires a reference image`);
  }

  const endpoint = req.referenceImageUrl
    ? `${API_BASE}/image_to_video`
    : `${API_BASE}/text_to_video`;

  const payload: Record<string, any> = {
    promptText: req.prompt,
    model: apiModel,
    duration,
    ratio: ratioToApi(ratio, model),
  };
  if (req.referenceImageUrl) {
    // Инлайним /storage/* в data:URI — Runway не может скачать наш приватный
    // эндпоинт (требует JWT-cookie) и до фикса возвращал 400 "Received HTTP
    // response code 401". См. toReferenceUri.
    payload.promptImage = await toReferenceUri(req.referenceImageUrl);
  }
  if (includeAudio !== undefined) payload.includeAudio = includeAudio;

  logger.info({ endpoint, model, apiModel, duration, ratio, includeAudio }, 'creating Runway task');

  const createRes = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await getKey()}`,
      'X-Runway-Version': API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Runway create failed: ${createRes.status} ${errText}`);
  }

  const created = await createRes.json() as { id?: string };
  const taskId = created.id;
  if (!taskId) throw new Error('Runway: no task id returned');

  // Poll
  const deadline = Date.now() + timeoutMs;
  let status = 'PENDING';
  let outputs: string[] = [];
  let attempts = 0;
  while (status !== 'SUCCEEDED') {
    if (Date.now() > deadline) throw new Error(`Runway: timeout after ${timeoutMs}ms (last=${status})`);
    if (status === 'FAILED' || status === 'CANCELLED') throw new Error(`Runway task ${taskId} status=${status}`);
    await new Promise((r) => setTimeout(r, pollInterval));
    attempts++;
    const statusRes = await fetch(`${API_BASE}/tasks/${taskId}`, {
      headers: {
        Authorization: `Bearer ${await getKey()}`,
        'X-Runway-Version': API_VERSION,
      },
    });
    if (!statusRes.ok) throw new Error(`Runway status check failed: ${statusRes.status}`);
    const payload = await statusRes.json() as { status: string; output?: string[]; failure?: string };
    status = payload.status;
    if (payload.output) outputs = payload.output;
    if (attempts % 4 === 0) logger.info({ taskId, status, attempts }, 'Runway polling');
  }

  const url = outputs[0];
  if (!url) throw new Error('Runway: no output URL in completed task');

  // Download the mp4
  const dl = await fetch(url);
  if (!dl.ok) throw new Error(`Runway: download failed ${dl.status}`);
  const buffer = Buffer.from(await dl.arrayBuffer());

  const apiRatio = ratioToApi(ratio, model);
  return {
    taskId,
    model,
    buffer,
    mimeType: 'video/mp4',
    seconds: duration,
    size: apiRatio.replace(':', 'x'),
  };
}
