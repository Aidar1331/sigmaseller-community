import { requireSellerAiKey } from '../../services/sellerAiCredentials.js';
/**
 * OpenAI GPT Image integration.
 *
 * Replaces Google Imagen for the AI Studio. Uses OpenAI Image API
 * (images.generate / images.edit). Returns base64 PNG so callers can
 * upload to S3 or store inline.
 *
 * Env: OPENAI_API_KEY
 */

import OpenAI from 'openai';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'openai-imagen' });

export type OpenAiImageModel = 'gpt-image-2' | 'gpt-image-1.5' | 'gpt-image-1' | 'gpt-image-1-mini';
export type OpenAiImageQuality = 'low' | 'medium' | 'high' | 'auto';

export interface ImageGenerationRequest {
  prompt: string;
  /** Base64 (raw) reference image for edits. If present → uses images.edit. */
  referenceImageBase64?: string;
  /** Public URL reference (will be fetched and sent as base64). */
  referenceImageUrl?: string;
  numberOfImages?: number;
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  negativePrompt?: string;
  model?: OpenAiImageModel;
  quality?: OpenAiImageQuality;
}

export interface GeneratedImage {
  base64: string;
  mimeType: string;
}

export interface ImageGenerationResult {
  images: GeneratedImage[];
  model: string;
  promptUsed: string;
}

async function getClient(): Promise<OpenAI> {
  const key = (await requireSellerAiKey('openai'));
  if (!key) throw new Error('OPENAI_API_KEY is not configured');
  return new OpenAI({ maxRetries: 0, apiKey: key });
}

// OpenAI gpt-image поддерживает ТОЛЬКО: 1024x1024, 1024x1536, 1536x1024, auto.
// Все остальные — 400. Мапим «похожие» аспекты на ближайший поддерживаемый.
function mapAspectRatioToSize(ar: ImageGenerationRequest['aspectRatio']): string {
  switch (ar) {
    case '16:9': return '1536x1024'; // горизонталь
    case '9:16': return '1024x1536'; // вертикаль
    case '4:3':  return '1536x1024'; // близко к 16:9 из поддерживаемых
    case '3:4':  return '1024x1536'; // близко к 9:16 (WB-вертикаль)
    case '1:1':
    default:     return '1024x1024';
  }
}

async function fetchUrlAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ref image: ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

export async function generateImages(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const client = await getClient();
  const model = req.model ?? 'gpt-image-2';
  const n = Math.max(1, Math.min(req.numberOfImages ?? 1, 4));
  const size = mapAspectRatioToSize(req.aspectRatio);
  const quality = req.quality ?? 'auto';

  // Append negative prompt to the main prompt — Image API doesn't have a dedicated field.
  const fullPrompt = req.negativePrompt
    ? `${req.prompt}\n\nAvoid: ${req.negativePrompt}`
    : req.prompt;

  logger.info({ model, n, size, quality, hasRef: !!(req.referenceImageBase64 || req.referenceImageUrl) }, 'calling OpenAI Image API');

  let refBase64 = req.referenceImageBase64;
  if (!refBase64 && req.referenceImageUrl) {
    try { refBase64 = await fetchUrlAsBase64(req.referenceImageUrl); }
    catch (e) { logger.warn({ err: String(e) }, 'ref image fetch failed — continuing without'); }
  }

  let data: Array<{ b64_json?: string | null }> = [];

  if (refBase64) {
    // Edit endpoint: image parameter expects a file-like object in the SDK.
    const buf = Buffer.from(refBase64, 'base64');
    const imgFile = await OpenAI.toFile(buf, 'ref.png', { type: 'image/png' });
    const r: any = await client.images.edit({
      model,
      image: imgFile,
      prompt: fullPrompt,
      n,
      size: size as any,
    });
    data = r?.data ?? [];
  } else {
    const r: any = await client.images.generate({
      model,
      prompt: fullPrompt,
      n,
      size: size as any,
      quality: quality as any,
      output_format: 'png',
    });
    data = r?.data ?? [];
  }

  const images: GeneratedImage[] = data
    .filter((d) => d.b64_json)
    .map((d) => ({ base64: d.b64_json!, mimeType: 'image/png' }));

  if (!images.length) throw new Error('OpenAI returned no images');

  logger.info({ count: images.length, model }, 'images generated');

  return { images, model, promptUsed: fullPrompt };
}

// ─── Cost estimation (per чатджпт.txt) ───────────────────────────────
// gpt-image-2 1024x1024: low $0.006, medium $0.053, high $0.211
const COST_TABLE: Record<string, { low: number; medium: number; high: number }> = {
  'gpt-image-2':     { low: 0.006, medium: 0.053, high: 0.211 },
  'gpt-image-1.5':   { low: 0.006, medium: 0.053, high: 0.211 },
  'gpt-image-1':     { low: 0.011, medium: 0.042, high: 0.167 },
  'gpt-image-1-mini':{ low: 0.004, medium: 0.015, high: 0.060 },
};

export function estimateCost(numberOfImages: number, model: OpenAiImageModel = 'gpt-image-2', quality: OpenAiImageQuality = 'medium'): string {
  const q = quality === 'auto' ? 'medium' : quality;
  const unit = COST_TABLE[model]?.[q] ?? 0.053;
  return (numberOfImages * unit).toFixed(4);
}
