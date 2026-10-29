/**
 * AI Review Responder Service
 * Generates intelligent responses to customer reviews using LLM
 * Based on ai-wildberries-review-responder patterns
 */

import { requireSellerAiKey } from './sellerAiCredentials.js';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';
import { log as logger } from '../lib/logger.js';

interface Review {
  id: string;
  text: string;
  rating: number;
  productName?: string;
  userName?: string;
  hasPhoto?: boolean;
  hasVideo?: boolean;
  createdAt?: string;
}

interface GeneratedResponse {
  reviewId: string;
  response: string;
  tone: 'positive' | 'neutral' | 'apologetic';
  confidence: number;
}

interface AISettings {
  provider: 'openai' | 'yandex' | 'anthropic';
  apiKey: string;
  model: string;
  baseUrl?: string;
  tone?: 'formal' | 'friendly' | 'professional';
  language?: 'ru' | 'en';
  maxTokens?: number;
  brandName?: string;
  customInstructions?: string;
}

const DEFAULT_PROMPTS = {
  system: `Ты — профессиональный менеджер по работе с клиентами. Твоя задача — писать ответы на отзывы покупателей на маркетплейсе.

Правила:
1. Всегда благодари за отзыв
2. Если отзыв положительный (4-5 звёзд) — выражай радость, что товар понравился
3. Если отзыв нейтральный (3 звезды) — благодари за обратную связь, предложи помощь
4. Если отзыв негативный (1-2 звезды) — извинись, предложи решение, попроси связаться
5. Упоминай название товара если оно известно
6. Если есть фото/видео — отметь это (например: "Спасибо за фото!")
7. Пиши кратко и по делу (2-4 предложения)
8. Не используй эмодзи (или минимум)
9. Обращайся на "Вы"`,

  positive: `Напиши ответ на положительный отзыв ({{rating}} звёзд).
Отзыв: "{{text}}"
{{#productName}}Товар: {{productName}}{{/productName}}
{{#hasPhoto}}К отзыву приложено фото.{{/hasPhoto}}
{{#hasVideo}}К отзыву приложено видео.{{/hasVideo}}`,

  neutral: `Напиши ответ на нейтральный отзыв ({{rating}} звезды).
Отзыв: "{{text}}"
{{#productName}}Товар: {{productName}}{{/productName}}
{{#hasPhoto}}К отзыву приложено фото.{{/hasPhoto}}`,

  negative: `Напиши ответ на негативный отзыв ({{rating}} звезда/звезды).
Отзыв: "{{text}}"
{{#productName}}Товар: {{productName}}{{/productName}}
Важно: извинись, предложи помощь, попроси связаться для решения проблемы.`,
};

function selectPromptTemplate(rating: number): string {
  if (rating >= 4) return DEFAULT_PROMPTS.positive;
  if (rating === 3) return DEFAULT_PROMPTS.neutral;
  return DEFAULT_PROMPTS.negative;
}

function renderTemplate(template: string, data: Record<string, any>): string {
  let result = template;
  
  // Handle conditionals {{#key}}...{{/key}}
  result = result.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, content) => {
    return data[key] ? content : '';
  });
  
  // Handle variables {{key}}
  result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return data[key] !== undefined ? String(data[key]) : '';
  });
  
  return result.trim();
}

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  settings: AISettings
): Promise<string> {
  const baseUrl = 'https://api.openai.com/v1';
  
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${await requireSellerAiKey('openai')}`,
    },
    body: JSON.stringify({
      model: settings.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: settings.maxTokens || 300,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() || '';
}

async function callYandexGPT(
  systemPrompt: string,
  userPrompt: string,
  settings: AISettings
): Promise<string> { throw new Error('Этот устаревший провайдер отключён. Подключите Anthropic или OpenAI в настройках ИИ магазина.'); }

async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
  settings: AISettings
): Promise<string> {
  const client = new Anthropic({ apiKey: await requireSellerAiKey('anthropic'), maxRetries: 0 });

  const message = await client.messages.create({
    model: settings.model || 'claude-sonnet-4-6',
    max_tokens: settings.maxTokens || 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textBlock = message.content.find((c) => c.type === 'text');
  return textBlock?.type === 'text' ? textBlock.text.trim() : '';
}

export async function generateReviewResponse(
  review: Review,
  settings: AISettings
): Promise<GeneratedResponse> {
  // Build system prompt
  let systemPrompt = DEFAULT_PROMPTS.system;
  
  if (settings.brandName) {
    systemPrompt += `\nИмя бренда/магазина: ${settings.brandName}`;
  }
  
  if (settings.customInstructions) {
    systemPrompt += `\n\nДополнительные инструкции:\n${settings.customInstructions}`;
  }

  // Select and render user prompt
  const template = selectPromptTemplate(review.rating);
  const userPrompt = renderTemplate(template, {
    rating: review.rating,
    text: review.text,
    productName: review.productName,
    hasPhoto: review.hasPhoto,
    hasVideo: review.hasVideo,
    userName: review.userName,
  });

  // Call appropriate LLM
  let responseText: string;
  
  try {
    switch (settings.provider) {
      case 'yandex':
        responseText = await callYandexGPT(systemPrompt, userPrompt, settings);
        break;
      case 'anthropic':
        responseText = await callAnthropic(systemPrompt, userPrompt, settings);
        break;
      case 'openai':
      default:
        responseText = await callOpenAI(systemPrompt, userPrompt, settings);
    }
  } catch (error) {
    logger.error({ err: error }, 'Error generating AI review response');
    throw error;
  }

  // Replace [имя] placeholder with actual user name
  if (review.userName) {
    responseText = responseText.replace(/\[имя\]/gi, review.userName);
  } else {
    // Remove placeholder if no name available
    responseText = responseText.replace(/\[имя\]/gi, '');
  }

  // Determine tone based on rating
  let tone: 'positive' | 'neutral' | 'apologetic';
  if (review.rating >= 4) tone = 'positive';
  else if (review.rating === 3) tone = 'neutral';
  else tone = 'apologetic';

  return {
    reviewId: review.id,
    response: responseText,
    tone,
    confidence: 0.85, // Could be improved with actual confidence scoring
  };
}

export async function generateBatchResponses(
  reviews: Review[],
  settings: AISettings,
  options: { concurrency?: number; delayMs?: number } = {}
): Promise<GeneratedResponse[]> {
  const { concurrency = 3, delayMs = 500 } = options;
  const results: GeneratedResponse[] = [];
  
  // Process in batches
  for (let i = 0; i < reviews.length; i += concurrency) {
    const batch = reviews.slice(i, i + concurrency);
    
    const batchResults = await Promise.all(
      batch.map(review => 
        generateReviewResponse(review, settings).catch(err => ({
          reviewId: review.id,
          response: '',
          tone: 'neutral' as const,
          confidence: 0,
          error: err.message,
        }))
      )
    );
    
    results.push(...batchResults);
    
    // Delay between batches
    if (i + concurrency < reviews.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  return results;
}

// Export types
export type { Review, GeneratedResponse, AISettings };
