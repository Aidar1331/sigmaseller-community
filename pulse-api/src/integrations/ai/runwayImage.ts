import { requireSellerAiKey } from '../../services/sellerAiCredentials.js';
/**
 * Runway image generation.
 *
 * Runway API v1 image endpoints:
 *   POST /text_to_image     { promptText, model, ratio, resolution? }
 *   GET  /tasks/:id         polling → { status, output: [url], ... }
 *
 * Models:
 *   gen4_image, gen4_image_turbo, gemini_2.5_flash, gpt_image_2
 *
 * `gpt_image_2` — OpenAI GPT Image 2 через Runway API (с 23.04.2026).
 * Используем когда у нас есть только RUNWAY_API_KEY и нет прямого OpenAI key.
 *
 * Env: RUNWAY_API_KEY, RUNWAY_API_BASE (default https://api.dev.runwayml.com/v1),
 *      RUNWAY_API_VERSION (default 2024-11-06)
 */

import log from '../../lib/logger.js';

const logger = log.child({ module: 'runway-image' });

export type RunwayImageModel =
  | 'gen4_image'
  | 'gen4_image_turbo'
  | 'gemini_2.5_flash'
  /** OpenAI GPT Image 2, доступен через Runway API с 23.04.2026.
   *  Поддерживает 30 width:height ratio в 1K/2K/4K + auto resolution. */
  | 'gpt_image_2';
export type RunwayImageRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
export type RunwayImageResolution = '720p' | '1080p';

export interface RunwayImageRequest {
  prompt: string;
  /** Optional reference image for image-to-image (data URL or public URL). */
  referenceImageUrl?: string;
  model?: RunwayImageModel;
  ratio?: RunwayImageRatio;
  resolution?: RunwayImageResolution;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface RunwayGeneratedImage {
  base64: string;
  mimeType: string;
}

export interface RunwayImageResult {
  images: RunwayGeneratedImage[];
  model: string;
  taskId: string;
}

const API_BASE = process.env.RUNWAY_API_BASE || 'https://api.dev.runwayml.com/v1';
const API_VERSION = process.env.RUNWAY_API_VERSION || '2024-11-06';

async function getKey(): Promise<string> {
  const k = (await requireSellerAiKey('runway'));
  if (!k) throw new Error('RUNWAY_API_KEY is not configured');
  return k;
}

/**
 * Превращает reference URL в формат, который Runway гарантированно сможет
 * прочитать. Раньше передавали URL как есть, и для наших же `/storage/*`
 * Runway получал 401 (этот путь требует JWT-cookie). Теперь:
 *   1. data: URI — пропускаем как есть.
 *   2. /storage/* — читаем напрямую с диска (мы на одной машине).
 *   3. Остальное — пробуем анонимный fetch; если ок — оборачиваем в data:.
 * Если не получилось — возвращаем оригинал (Runway даст ту же 401, но
 * хотя бы не упадём на этапе подготовки).
 */
async function toReferenceUri(url: string): Promise<string> {
  if (url.startsWith('data:')) return url;

  // 2. Локальный storage.
  const storageMatch = url.match(/\/storage\/(.+?)(?:\?|$)/);
  if (storageMatch) {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const root = process.env.LOCAL_STORAGE_ROOT
        || path.resolve('/srv/sigmaseller/pulse-api/storage');
      const rel = decodeURIComponent(storageMatch[1] ?? '');
      // Защита от path-traversal.
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
      logger.warn({ url, err: err?.message }, 'Failed to inline local /storage reference, falling back');
    }
  }

  // 3. Любой публичный URL — анонимно тянем и оборачиваем (Runway всё равно
  // сделал бы то же самое, но из РФ к стороннему CDN бывает быстрее с нашей
  // стороны).
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

  // 4. Последняя попытка — пусть Runway сам пробует.
  return url;
}

// Runway /v1 image API: разные модели имеют РАЗНЫЕ whitelist'ы ratio.
// Подтверждено двумя 400-ошибками за одни сутки:
//   gemini_2.5_flash: 1024:1024, 864:1184, 1184:864, 1344:768, 768:1344,
//                     896:1152, 1152:896, 832:1248, 1248:832, 1536:672
//   gen4_image[_turbo]: 1024:1024, 1080:1080, 1168:880, 1360:768,
//                       1440:1080, 1080:1440, 1920:1080, 1080:1920,
//                       1280:720, 720:1280, 720:720, 960:720, 720:960,
//                       1680:720, 2112:912, 1808:768
// Resolution-параметр больше не влияет на allowed values → игнорируем.
function ratioToApi(r: RunwayImageRatio, model: RunwayImageModel, resolution: RunwayImageResolution = '720p'): string {
  // gpt_image_2 — Runway отдаёт собственный whitelist из 30 размеров в 1K/2K/4K
  // тирах. 1024/1536-base не валидны. resolution='720p' → 1K, '1080p' → 2K.
  // (Список взят из 400-ошибки Runway 21.05.2026; держим в коде, чтобы при
  // изменении тиров пользователь сразу увидел ошибку и поправил.)
  if (model === 'gpt_image_2') {
    if (resolution === '1080p') {
      switch (r) {
        case '1:1':  return '2560:2560';
        case '16:9': return '2560:1440';
        case '9:16': return '1440:2560';
        case '4:3':  return '2560:1920';
        case '3:4':  return '1920:2560';
      }
    }
    // 1K tier (дефолт)
    switch (r) {
      case '1:1':  return '1920:1920';
      case '16:9': return '1920:1088';
      case '9:16': return '1088:1920';
      case '4:3':  return '1920:1440';
      case '3:4':  return '1440:1920';
    }
  }
  // gen4_image / gen4_image_turbo — более крупные (1440, 1920)
  if (model === 'gen4_image' || model === 'gen4_image_turbo') {
    switch (r) {
      case '1:1':  return '1024:1024';
      case '16:9': return '1920:1080';
      case '9:16': return '1080:1920';
      case '4:3':  return '1440:1080';
      case '3:4':  return '1080:1440';
    }
  }
  // gemini_2.5_flash (дефолт) — компактные native-размеры
  switch (r) {
    case '1:1':  return '1024:1024';
    case '16:9': return '1344:768';
    case '9:16': return '768:1344';
    case '4:3':  return '1184:864';
    case '3:4':  return '864:1184';
  }
}

export async function generateImages(req: RunwayImageRequest): Promise<RunwayImageResult> {
  const model = req.model ?? 'gen4_image_turbo';
  const ratio: RunwayImageRatio = req.ratio ?? '1:1';
  const resolution: RunwayImageResolution = req.resolution ?? '720p';
  const pollInterval = req.pollIntervalMs ?? 3000;
  const timeoutMs = req.timeoutMs ?? 5 * 60 * 1000;

  // Runway v1 унифицировал endpoint: теперь всегда /text_to_image, а reference
  // передаётся в поле referenceImages: [{ uri }]. Старый /image_to_image даёт 404.
  const endpoint = `${API_BASE}/text_to_image`;

  // Runway промпт hard-limit 1000 chars (проверено 400-ошибкой). Обрезаем на всякий.
  const promptText = req.prompt.length > 990
    ? req.prompt.slice(0, 980) + '…[truncated]'
    : req.prompt;
  if (req.prompt.length > 990) {
    logger.warn({ originalLength: req.prompt.length }, 'Runway prompt truncated to fit 1000-char limit');
  }

  const payload: Record<string, any> = {
    promptText,
    model,
    ratio: ratioToApi(ratio, model, resolution),
  };
  if (req.referenceImageUrl) {
    // tag='product' позволяет ссылаться на референс в промпте через @product.
    // Это сильнее удерживает внешний вид товара, чем просто uri.
    const inlined = await toReferenceUri(req.referenceImageUrl);
    payload.referenceImages = [{ uri: inlined, tag: 'product' }];
  }

  logger.info({ endpoint, model, ratio, resolution }, 'creating Runway image task');

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
    throw new Error(`Runway image create failed: ${createRes.status} ${errText}`);
  }

  const created = await createRes.json() as { id?: string };
  const taskId = created.id;
  if (!taskId) throw new Error('Runway image: no task id');

  // Poll
  const deadline = Date.now() + timeoutMs;
  let status = 'PENDING';
  let outputs: string[] = [];
  while (status !== 'SUCCEEDED') {
    if (Date.now() > deadline) throw new Error(`Runway image timeout (last=${status})`);
    if (status === 'FAILED' || status === 'CANCELLED') throw new Error(`Runway image task ${taskId} status=${status}`);
    await new Promise((r) => setTimeout(r, pollInterval));
    const s = await fetch(`${API_BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${await getKey()}`, 'X-Runway-Version': API_VERSION },
    });
    if (!s.ok) throw new Error(`Runway image status check failed: ${s.status}`);
    const p = await s.json() as { status: string; output?: string[] };
    status = p.status;
    if (p.output) outputs = p.output;
  }

  // Runway returns URL(s), download to base64 for parity with OpenAI
  const images: RunwayGeneratedImage[] = [];
  for (const u of outputs) {
    const dl = await fetch(u);
    if (!dl.ok) continue;
    const buf = Buffer.from(await dl.arrayBuffer());
    images.push({ base64: buf.toString('base64'), mimeType: 'image/png' });
  }

  if (!images.length) throw new Error('Runway image: no output');
  return { images, model, taskId };
}
