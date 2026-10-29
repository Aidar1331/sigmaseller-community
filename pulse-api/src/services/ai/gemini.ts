import { requireSellerAiKey } from '../sellerAiCredentials.js';
/**
 * Google Gemini Image Generation Service
 */

import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { env } from '../../env.js';

// Lazy init


async function getGenAI(): Promise<GoogleGenerativeAI> {
  return new GoogleGenerativeAI(await requireSellerAiKey('google')); 
}

export interface GenerateImageOptions {
  /** Промпт для генерации */
  prompt: string;
  /** Референс изображение (для image-to-image) */
  referenceImage?: Buffer;
  /** Модель: flash (быстрая) или pro (качественная) */
  model?: 'gemini-flash' | 'gemini-pro';
  /** Соотношение сторон */
  aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
  /** Температура (креативность) 0.0-1.0 */
  temperature?: number;
  /** Количество вариантов (1-4) */
  numberOfImages?: number;
}

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
}

/**
 * Генерация изображения через Gemini
 */
export async function generateImage(options: GenerateImageOptions): Promise<GeneratedImage[]> {
  const {
    prompt,
    referenceImage,
    model = 'gemini-flash',
    aspectRatio = '3:4',
    temperature = 0.8,
    numberOfImages = 1,
  } = options;

  const ai = await getGenAI();
  
  // Выбор модели с поддержкой генерации изображений
  // Примечание: на момент разработки используем экспериментальные модели
  const modelName = model === 'gemini-pro'
    ? 'gemini-2.5-flash-image' // Более качественная
    : 'gemini-2.5-flash-image'; // Быстрая

  const generativeModel = ai.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature,
      // @ts-ignore - experimental image generation config
      responseModalities: ['IMAGE', 'TEXT'],
    },
  });

  // Собираем parts для запроса
  const parts: any[] = [];

  // Добавляем референс если есть
  if (referenceImage) {
    parts.push({
      inlineData: {
        mimeType: 'image/png',
        data: referenceImage.toString('base64'),
      },
    });
    parts.push({
      text: 'Use this image as a style and composition reference. Maintain the product appearance but change the background and setting. ',
    });
  }

  // Формируем промпт с учётом aspect ratio
  const aspectRatioDescriptions: Record<string, string> = {
    '1:1': 'square format (1:1 aspect ratio)',
    '3:4': 'vertical portrait format (3:4 aspect ratio, like a product card)',
    '4:3': 'horizontal landscape format (4:3 aspect ratio)',
    '9:16': 'tall vertical format (9:16 aspect ratio, like a phone screen)',
    '16:9': 'wide cinematic format (16:9 aspect ratio)',
  };

  const fullPrompt = `${prompt}

Generate a high-quality product photography image in ${aspectRatioDescriptions[aspectRatio]}.
Style: Professional e-commerce photography, clean and appealing.
Important: Focus on the product, make it the hero of the image.`;

  parts.push({ text: fullPrompt });

  // Генерируем
  const images: GeneratedImage[] = [];
  
  for (let i = 0; i < numberOfImages; i++) {
    try {
      const result = await generativeModel.generateContent(parts);
      const response = result.response;

      // Извлекаем изображения из ответа
      for (const candidate of response.candidates || []) {
        for (const part of candidate.content?.parts || []) {
          if (part.inlineData?.mimeType?.startsWith('image/')) {
            images.push({
              data: Buffer.from(part.inlineData.data, 'base64'),
              mimeType: part.inlineData.mimeType,
            });
          }
        }
      }
    } catch (error: any) {
      console.error(`[Gemini] Generation ${i + 1} failed:`, error.message);
      // Продолжаем с остальными если один упал
      if (i === 0 && images.length === 0) {
        throw error; // Но если первый упал и нет результатов - бросаем
      }
    }
  }

  if (images.length === 0) {
    throw new Error('No images generated. The model may have refused the request or returned text only.');
  }

  return images;
}

/**
 * Генерация промпта на основе пресета
 */
export function buildPromptFromPreset(preset: {
  camera?: string;
  lighting?: string;
  style?: string;
  pose?: string;
  background?: string;
  prompt_template?: string;
}, productDescription?: string): string {
  // Если есть готовый template
  if (preset.prompt_template) {
    return productDescription 
      ? `${preset.prompt_template} Product: ${productDescription}`
      : preset.prompt_template;
  }

  // Собираем из компонентов
  const parts: string[] = [];

  // Камера
  const cameraDescriptions: Record<string, string> = {
    front: 'Shot from the front, straight-on angle',
    angle_45: 'Shot from a 45-degree angle',
    top_down: 'Top-down flat lay perspective',
    hero_shot: 'Low angle hero shot, looking up at the product',
    isometric: 'Isometric 3D-like perspective',
  };
  if (preset.camera && cameraDescriptions[preset.camera]) {
    parts.push(cameraDescriptions[preset.camera]);
  }

  // Освещение
  const lightingDescriptions: Record<string, string> = {
    studio_3point: 'Professional 3-point studio lighting',
    natural: 'Soft natural daylight',
    soft_diffused: 'Soft diffused lighting with minimal shadows',
    dramatic: 'Dramatic lighting with strong shadows',
    backlight: 'Backlit with rim lighting effect',
  };
  if (preset.lighting && lightingDescriptions[preset.lighting]) {
    parts.push(lightingDescriptions[preset.lighting]);
  }

  // Стиль
  const styleDescriptions: Record<string, string> = {
    professional: 'Professional commercial photography style',
    casual: 'Casual lifestyle photography',
    luxury: 'Luxury premium brand aesthetic',
    minimal: 'Minimalist clean aesthetic',
    fashion: 'Fashion editorial style',
  };
  if (preset.style && styleDescriptions[preset.style]) {
    parts.push(styleDescriptions[preset.style]);
  }

  // Поза (для одежды)
  const poseDescriptions: Record<string, string> = {
    standing: 'Model standing naturally',
    walking: 'Model in walking motion',
    sitting: 'Model seated',
    close_up: 'Close-up detail shot',
  };
  if (preset.pose && poseDescriptions[preset.pose]) {
    parts.push(poseDescriptions[preset.pose]);
  }

  // Фон
  if (preset.background) {
    parts.push(`Background: ${preset.background}`);
  }

  // Продукт
  if (productDescription) {
    parts.push(`Product: ${productDescription}`);
  }

  return parts.join('. ') + '.';
}

/**
 * Оценка стоимости генерации
 */
export function estimateCost(options: GenerateImageOptions): {
  credits: number;
  breakdown: { model: number; variants: number };
} {
  const modelCost = options.model === 'gemini-pro' ? 20 : 10;
  const variants = options.numberOfImages || 1;
  
  return {
    credits: modelCost * variants,
    breakdown: {
      model: modelCost,
      variants,
    },
  };
}
