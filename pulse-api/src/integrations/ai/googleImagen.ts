/** Google image generation, billed to the current seller. */

import log from '../../lib/logger.js';
import { generateImage } from '../../services/ai/gemini.js';

const logger = log.child({ module: 'google-imagen' });

const MODEL = 'gemini-2.5-flash-image';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface ImageGenerationRequest {
  prompt: string;
  referenceImageBase64?: string;
  referenceImageUrl?: string;
  numberOfImages?: number;
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  negativePrompt?: string;
  style?: 'photo' | 'digital_art' | 'minimalist';
  language?: string;
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

// ─────────────────────────────────────────────────────────────────
// Auth Helper
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// Prompt Builder
//
// Imagen 3 не парсит JSON напрямую — мы используем JSON-шаблон как
// структуру, по которой собираем стабильный текстовый промпт.
// Главное правило: МЫ НИКОГДА НЕ ПРОСИМ МОДЕЛЬ РИСОВАТЬ ТЕКСТ.
// Imagen 3 рендерит кириллицу мусором («ВЛАДЕЙ ПОРЯГДОМ»). Поэтому
// для «инфографики» мы генерируем чистый backplate с пустым местом
// под наложение текста уже на FE/в дизайнере.
// ─────────────────────────────────────────────────────────────────

/**
 * Универсальный negative-prompt — экспортируем, чтобы вызывающая сторона
 * могла его прислать в `generateImages({ negativePrompt: NEGATIVE_PROMPT_NO_TEXT })`.
 */
export const NEGATIVE_PROMPT_NO_TEXT =
  'text, letters, alphabet, words, cyrillic, gibberish text, fake text, ' +
  'random characters, captions, labels, price tags, stickers with text, ' +
  'packaging with text, numbers, watermark, logo, brand name, signature, ' +
  'low quality, blurry, distorted, plastic look, unnatural proportions, ' +
  'extra limbs, deformed product, multiple products, collage';

type GenerationType = 'infographic' | 'lifestyle' | 'product_shot' | 'hero';

function templateFor(type: GenerationType) {
  switch (type) {
    case 'infographic':
      return {
        description: 'Infographic backplate for marketplace product card — clean canvas, NO TEXT',
        environment: 'soft gradient backdrop (light beige to warm white), no props',
        lighting: 'soft studio lighting from top-left at 30 degrees',
        camera: '85mm lens, f/8, slightly elevated 15° angle, deep depth of field',
        composition: 'product placed at left third, 45% of frame, right 55% empty for caption overlays added later in design tool',
        style: 'premium ecommerce infographic backplate, marketplace-ready, clean',
      };
    case 'lifestyle':
      return {
        description: 'Product in real lifestyle scene',
        environment: 'relevant real-life setting (kitchen / car interior / desk / bathroom / closet), 2-3 contextual props without any text',
        lighting: 'natural window light from the left, soft, slightly warm 5200K',
        camera: '50mm lens, f/2.8, 45° angle, shallow depth of field with product in focus',
        composition: 'product placed by rule-of-thirds, 55% of frame, negative space on right for ad copy',
        style: 'natural lifestyle photography, bright and airy',
      };
    case 'hero':
      return {
        description: 'Premium hero product shot with curated environment',
        environment: 'minimalist scene matching niche: marble surface or dark moody studio or nordic wood, 1-2 minimalist props without any text',
        lighting: 'soft key light at 45° plus rim light from behind, 5000K',
        camera: '100mm macro lens, f/4, low-angle hero shot, shallow depth of field',
        composition: 'centered or rule-of-thirds, 60% of frame',
        style: 'premium product hero shot, editorial, photorealistic, 8K',
      };
    case 'product_shot':
    default:
      return {
        description: 'Studio packshot on clean white background',
        environment: 'seamless pure white backdrop (#FFFFFF), matte white tabletop, very soft drop shadow, no props',
        lighting: 'soft studio softbox, 45° key with side fill, even, no harsh highlights, 5500K neutral',
        camera: '85mm lens, f/8, eye-level, medium distance, deep depth of field, fully sharp',
        composition: 'product centered, 70% of frame, symmetrical balance',
        style: 'professional ecommerce catalog photo, 8K, ultra-detailed textures, hyperrealistic',
      };
  }
}

export function buildImagePrompt(
  designerBrief: string,
  productContext: {
    title?: string;
    category?: string;
    brandName?: string;
  },
  options?: {
    type?: GenerationType;
    style?: string;
  }
): string {
  const tpl = templateFor(options?.type ?? 'product_shot');

  const subjectParts: string[] = [];
  if (productContext.title) subjectParts.push(productContext.title);
  if (productContext.category) subjectParts.push(`(${productContext.category})`);
  const subject = subjectParts.join(' ') || 'product';

  // Собираем текстовый промпт. Порядок выбран эмпирически: subject первым,
  // потом сцена, свет, камера, композиция, стиль — так Imagen стабильнее
  // понимает иерархию инструкций.
  const lines: string[] = [
    `${tpl.description}.`,
    `Subject: ${subject}.`,
  ];
  if (productContext.brandName) {
    lines.push(`Brand: ${productContext.brandName} (do NOT render brand name as text).`);
  }
  lines.push(
    `Environment: ${tpl.environment}.`,
    `Lighting: ${tpl.lighting}.`,
    `Camera: ${tpl.camera}.`,
    `Composition: ${tpl.composition}.`,
    `Style: ${tpl.style}.`,
  );

  // Designer brief (если есть) — добавляем как дополнительные требования,
  // но НЕ переопределяем основной шаблон.
  const brief = designerBrief?.trim();
  if (brief) {
    lines.push('', 'Additional designer requirements:', brief);
  }

  // Жёсткие запреты — повторяем явно в промпте, не полагаясь только на
  // negativePrompt параметр. Imagen 3 надёжнее реагирует на дублирование.
  lines.push(
    '',
    'IMPORTANT CONSTRAINTS:',
    '- Do NOT add any text, letters, numbers or captions in the image.',
    '- Do NOT render labels, price tags, stickers or packaging text.',
    '- Do NOT add watermarks or logos.',
    '- Do NOT show humans, body parts or faces.',
    '- Preserve realistic product proportions and materials.',
    '- Single product only — no collage or multiple variants.',
  );

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────
// Main Generation Function
// ─────────────────────────────────────────────────────────────────

export async function generateImages(
  req: ImageGenerationRequest
): Promise<ImageGenerationResult> {
  const images = await generateImage({
    prompt: req.prompt + (req.negativePrompt ? '\nAvoid: ' + req.negativePrompt : ''),
    referenceImage: req.referenceImageBase64 ? Buffer.from(req.referenceImageBase64, 'base64') : undefined,
    numberOfImages: Math.min(4, Math.max(1, req.numberOfImages ?? 1)),
    aspectRatio: req.aspectRatio,
  });
  return { images: images.map(img => ({ base64: img.data.toString('base64'), mimeType: img.mimeType })), model: MODEL, promptUsed: req.prompt };
}

// ─────────────────────────────────────────────────────────────────
// Fetch Reference Image
// ─────────────────────────────────────────────────────────────────

export async function fetchImageAsBase64(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// ─────────────────────────────────────────────────────────────────
// Cost Estimation
// ─────────────────────────────────────────────────────────────────

const IMAGEN_COST_PER_IMAGE = 0.04; // $0.04 per image (approximate)

export function estimateCost(numberOfImages: number): string {
  return (numberOfImages * IMAGEN_COST_PER_IMAGE).toFixed(4);
}
