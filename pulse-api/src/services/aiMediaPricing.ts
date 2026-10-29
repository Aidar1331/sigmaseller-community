/**
 * Pricing table for AI media generation (OpenAI + Runway).
 *
 * Sources:
 * - OpenAI image: see `апи 2.0/чатджпт.txt`
 * - Runway: docs.runway.com (1 credit = $0.01):
 *     Video per-second credits:
 *       gen4.5 12, gen4_turbo 5, gen4_aleph 15, gen3a_turbo 5,
 *       act_two 5, veo3 40, veo3.1_audio 40, veo3.1_noaudio 20,
 *       veo3.1_fast_audio 15, veo3.1_fast_noaudio 10
 *     Image per-generation credits:
 *       gen4_image 5 (720p) / 8 (1080p), gen4_image_turbo 2, gemini_2.5_flash 5
 *
 * Final user price = ceil_usd_to_cents → × MARKUP × USD_TO_RUB → ceil to whole ruble
 * (see calculateOpenAiCostKopecks in aiTokens.ts).
 */

// ── IMAGE MODELS ─────────────────────────────────────────────────────

export type OpenAiImageModel = 'gpt-image-2' | 'gpt-image-1.5';
export type RunwayImageModel = 'gen4_image' | 'gen4_image_turbo' | 'gemini_2.5_flash' | 'gpt_image_2';
export type ImageModel = OpenAiImageModel | RunwayImageModel;
export type ImageQuality = 'low' | 'medium' | 'high' | 'auto';

const OPENAI_IMAGE_USD_1024: Record<OpenAiImageModel, { low: number; medium: number; high: number }> = {
  'gpt-image-2':   { low: 0.006, medium: 0.053, high: 0.211 },
  'gpt-image-1.5': { low: 0.006, medium: 0.053, high: 0.211 },
};

// Runway images: flat per-generation regardless of variants. Price depends on
// model + target resolution (gen4_image only differentiates 720p vs 1080p).
const RUNWAY_IMAGE_CREDITS: Record<RunwayImageModel, { low: number; medium: number; high: number }> = {
  'gen4_image':       { low: 5, medium: 5, high: 8 },   // 720p=5, 1080p=8
  'gen4_image_turbo': { low: 2, medium: 2, high: 2 },   // flat 2
  'gemini_2.5_flash': { low: 5, medium: 5, high: 5 },   // flat 5
  // GPT Image 2 — Runway changelog обещает tiered pricing по resolution и
  // quality, точных цифр пока не публиковали. Берём консервативно с запасом.
  'gpt_image_2':      { low: 8, medium: 16, high: 32 },
};

const CREDIT_USD = 0.01;

function sizeMultiplier(aspectRatio?: string): number {
  switch (aspectRatio) {
    case '16:9':
    case '9:16':
    case '4:3':
    case '3:4':
      return 1.5;
    case '1:1':
    default:
      return 1;
  }
}

export function estimateImageUsd(params: {
  model: ImageModel;
  quality?: ImageQuality;
  aspectRatio?: string;
  variants: number;
}): number {
  const q = (params.quality ?? 'medium') === 'auto' ? 'medium' : (params.quality ?? 'medium');
  const variants = Math.max(1, params.variants);

  if ((OPENAI_IMAGE_USD_1024 as any)[params.model]) {
    const row = OPENAI_IMAGE_USD_1024[params.model as OpenAiImageModel];
    const unit = row[q as 'low' | 'medium' | 'high'];
    return unit * sizeMultiplier(params.aspectRatio) * variants;
  }

  if ((RUNWAY_IMAGE_CREDITS as any)[params.model]) {
    const row = RUNWAY_IMAGE_CREDITS[params.model as RunwayImageModel];
    const creditsPerImage = row[q as 'low' | 'medium' | 'high'];
    return creditsPerImage * CREDIT_USD * variants;
  }

  // Unknown — fall back to gpt-image-2 medium
  return 0.053 * sizeMultiplier(params.aspectRatio) * variants;
}

export function imageProviderFor(model: ImageModel): 'openai' | 'runway' {
  return model === 'gpt-image-2' || model === 'gpt-image-1.5' ? 'openai' : 'runway';
}

// ── VIDEO MODELS ─────────────────────────────────────────────────────

export type SoraVideoModel = 'sora-2-pro' | 'sora-2';
export type RunwayVideoModel =
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
export type VideoModel = SoraVideoModel | RunwayVideoModel;

// Sora per-second USD base (no Runway credit system)
const SORA_USD_PER_SECOND: Record<SoraVideoModel, number> = {
  'sora-2-pro': 0.50,
  'sora-2':     0.20,
};

// Runway video per-second credits (1 credit = $0.01)
const RUNWAY_VIDEO_CREDITS_PER_SECOND: Record<RunwayVideoModel, number> = {
  'gen4.5':              12,
  'gen4_turbo':           5,
  'gen4_aleph':          15,
  'gen3a_turbo':          5,
  'act_two':              5,
  'veo3':                40,
  'veo3.1_audio':        40,
  'veo3.1_noaudio':      20,
  'veo3.1_fast_audio':   15,
  'veo3.1_fast_noaudio': 10,
};

export function estimateVideoUsd(params: {
  model: VideoModel;
  seconds: number;
  size?: string;
}): number {
  const isHd = params.size ? /1920|1080|3840|2160/.test(params.size) : false;
  // Sora: +50% за 1080p/4K
  if ((SORA_USD_PER_SECOND as any)[params.model] != null) {
    const base = SORA_USD_PER_SECOND[params.model as SoraVideoModel];
    const mul = isHd ? 1.5 : 1.0;
    return base * params.seconds * mul;
  }
  // Runway — per-second credit pricing, размер пока не меняет биллинг.
  const credits = RUNWAY_VIDEO_CREDITS_PER_SECOND[params.model as RunwayVideoModel] ?? 12;
  return credits * CREDIT_USD * params.seconds;
}

export function videoProviderFor(model: VideoModel): 'openai' | 'runway' {
  if (model === 'sora-2' || model === 'sora-2-pro') return 'openai';
  return 'runway';
}

// Flag models that REQUIRE a reference image (image-to-video / video-to-video)
export function requiresReferenceImage(model: VideoModel): boolean {
  return model === 'act_two';
}
