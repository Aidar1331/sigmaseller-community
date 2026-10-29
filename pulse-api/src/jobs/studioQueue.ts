import { runWithAiWorkspace } from '../lib/sellerAiContext.js';
/**
 * Studio AI Queue (BullMQ)
 * Асинхронная обработка AI задач
 */

import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { getRedis } from '../lib/redis.js';
import { db } from '../db/client.js';
import { studioTasks, studioAssets, studioCredits, studioPromptSuggestions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { uploadFile, downloadToBuffer } from '../lib/s3.js';
import { removeBackground, RemoveBgOptions } from '../services/ai/rembg.js';
import { buildPromptFromPreset } from '../services/ai/gemini.js';
import { generateImages as openaiGenerateImages, type OpenAiImageQuality } from '../integrations/ai/openaiImagen.js';
import { generateVideo as openaiGenerateVideo, type SoraModel, type SoraSize } from '../integrations/ai/openaiVideo.js';
import { generateVideo as runwayGenerateVideo, type RunwayModel, type RunwayRatio } from '../integrations/ai/runwayVideo.js';
import { generateImages as runwayGenerateImages, type RunwayImageModel, type RunwayImageRatio, type RunwayImageResolution } from '../integrations/ai/runwayImage.js';
import { calculateOpenAiCostKopecks, chargeWorkspaceKopecks, markupForMediaModel } from '../services/aiTokens.js';
import {
  estimateImageUsd, estimateVideoUsd, videoProviderFor, imageProviderFor,
  type VideoModel, type ImageModel, type OpenAiImageModel,
} from '../services/aiMediaPricing.js';

// ============================================
// QUEUE SETUP
// ============================================

const QUEUE_NAME = 'studio-ai';

let queue: Queue | null = null;
let worker: Worker | null = null;
let queueEvents: QueueEvents | null = null;

/**
 * Получить или создать очередь
 */
export function getStudioQueue(): Queue {
  if (!queue) {
    const connection = getRedis();
    
    queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 1,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          age: 3600, // 1 hour
          count: 100,
        },
        removeOnFail: {
          age: 86400, // 24 hours
        },
      },
    });
  }
  return queue;
}

// ============================================
// JOB TYPES
// ============================================

export interface RemoveBgJobData {
  taskId: string;
  workspaceId: number;
  userId?: number;
  projectId?: number;
  imageUrl: string;
  options?: RemoveBgOptions;
}

export interface GenerateImageJobData {
  taskId: string;
  workspaceId: number;
  userId?: number;
  projectId?: number;
  /** Артикул WB (если генерация привязана к товару) — используется для истории. */
  nmId?: number;
  prompt: string;
  referenceImageUrl?: string;
  /** Legacy gemini-* values accepted and mapped to gpt-image-2 for backward compat. */
  model?: OpenAiImageModel | 'gemini-flash' | 'gemini-pro' | 'gen4_image' | 'gen4_image_turbo' | 'gemini_2.5_flash' | 'gpt_image_2';
  aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
  quality?: OpenAiImageQuality;
  temperature?: number;
  variants?: number;
  presetSettings?: any;
}

export interface GenerateVideoJobData {
  taskId: string;
  workspaceId: number;
  userId?: number;
  projectId?: number;
  /** Артикул WB (если генерация привязана к товару) — используется для истории. */
  nmId?: number;
  prompt: string;
  /** Любая из поддерживаемых видео-моделей: Sora (OpenAI) или Runway (gen4.x, gen3a_turbo, veo3.x, act_two) */
  model?: VideoModel;
  seconds?: number;
  size?: SoraSize | string;
  /** Публичный URL опорного изображения — обязателен для image-to-video и act_two */
  referenceImageUrl?: string;
  /** Для veo3.1 — включить аудио */
  includeAudio?: boolean;
  presetSettings?: any;
}

// ============================================
// ADD JOBS
// ============================================

/**
 * Добавить задачу удаления фона
 */
export async function addRemoveBgJob(data: RemoveBgJobData): Promise<Job> {
  const queue = getStudioQueue();
  return queue.add('remove-background', data, {
    jobId: data.taskId,
  });
}

/**
 * Добавить задачу генерации изображения
 */
export async function addGenerateImageJob(data: GenerateImageJobData): Promise<Job> {
  const queue = getStudioQueue();
  return queue.add('generate-image', data, {
    jobId: data.taskId,
  });
}

/**
 * Добавить задачу генерации видео (Sora)
 */
export async function addGenerateVideoJob(data: GenerateVideoJobData): Promise<Job> {
  const queue = getStudioQueue();
  return queue.add('generate-video', data, {
    jobId: data.taskId,
    // Sora видео долгое — один attempt, 30 мин timeout по умолчанию
    attempts: 1,
  });
}

// ============================================
// WORKER
// ============================================

/**
 * Запустить worker для обработки задач
 */
export function startStudioWorker(): Worker {
  if (worker) return worker;

  const connection = getRedis();

  worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => runWithAiWorkspace(job.data.workspaceId, async () => {
      console.log(`[StudioWorker] Processing job ${job.id} (${job.name})`);

      try {
        switch (job.name) {
          case 'remove-background':
            return await processRemoveBgJob(job);
          case 'generate-image':
            return await processGenerateImageJob(job);
          case 'generate-video':
            return await processGenerateVideoJob(job);
          default:
            throw new Error(`Unknown job type: ${job.name}`);
        }
      } catch (error: any) {
        console.error(`[StudioWorker] Job ${job.id} failed:`, error.message);
        
        // Update task status to failed
        await db.update(studioTasks)
          .set({
            status: 'failed',
            error: error.message,
            completedAt: new Date(),
          })
          .where(eq(studioTasks.taskId, job.data.taskId));

        throw error;
      }
    }),
    {
      connection,
      concurrency: 3, // 3 параллельных задачи
      limiter: {
        max: 10,
        duration: 60000, // Макс 10 задач в минуту
      },
    }
  );

  worker.on('completed', (job) => {
    console.log(`[StudioWorker] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[StudioWorker] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('[StudioWorker] Worker error:', err);
  });

  return worker;
}

// ============================================
// JOB PROCESSORS
// ============================================

/**
 * Обработка удаления фона
 */
async function processRemoveBgJob(job: Job<RemoveBgJobData>) {
  const { taskId, workspaceId, projectId, imageUrl, options } = job.data;

  // Update status
  await db.update(studioTasks)
    .set({ status: 'processing', progress: 10 })
    .where(eq(studioTasks.taskId, taskId));

  // Download image
  await job.updateProgress(20);
  const imageBuffer = await downloadToBuffer(imageUrl);

  // Remove background
  await job.updateProgress(40);
  const resultBuffer = await removeBackground(imageBuffer, options);

  // Upload result
  await job.updateProgress(70);
  const filename = `studio/${workspaceId}/bg-removed-${uuidv4().slice(0, 8)}.png`;
  const url = await uploadFile(resultBuffer, filename, 'image/png');

  // Save asset
  await job.updateProgress(90);
  const [asset] = await db.insert(studioAssets).values({
    workspaceId,
    userId: job.data.userId ?? null,
    projectId: projectId || null,
    type: 'generated',
    name: 'Background Removed',
    url,
    metadata: {
      source: 'rembg',
      model: options?.model || 'birefnet-general-lite',
      originalUrl: imageUrl,
    },
  }).returning();

  // Complete task
  await db.update(studioTasks)
    .set({
      status: 'completed',
      progress: 100,
      output: { url, assetId: asset.assetId },
      completedAt: new Date(),
    })
    .where(eq(studioTasks.taskId, taskId));

  return { url, assetId: asset.assetId };
}

/**
 * Обработка генерации изображения
 */
async function processGenerateImageJob(job: Job<GenerateImageJobData>) {
  const {
    taskId,
    workspaceId,
    projectId,
    prompt,
    referenceImageUrl,
    model,
    aspectRatio = '3:4',
    quality = 'auto',
    variants = 1,
    presetSettings,
  } = job.data;

  await db.update(studioTasks)
    .set({ status: 'processing', progress: 10 })
    .where(eq(studioTasks.taskId, taskId));

  // Legacy mapping: unknown / gemini-flash / gemini-pro → gpt-image-2
  const knownOpenAi: OpenAiImageModel[] = ['gpt-image-2', 'gpt-image-1.5'];
  const knownRunway: RunwayImageModel[] = ['gen4_image', 'gen4_image_turbo', 'gemini_2.5_flash', 'gpt_image_2'];
  let targetModel: ImageModel;
  if ((knownOpenAi as string[]).includes(model as string)) targetModel = model as OpenAiImageModel;
  else if ((knownRunway as string[]).includes(model as string)) targetModel = model as RunwayImageModel;
  else targetModel = 'gpt-image-2';

  const provider = imageProviderFor(targetModel);

  const builtPrompt = presetSettings
    ? buildPromptFromPreset(presetSettings, prompt)
    : prompt;
  // Runway /v1 режет promptText на 1000 символах. Обрезаем с запасом до 980
  // здесь — на случай, если фронтенд (или внешний интегратор) прислал длиннее.
  // Для OpenAI это тоже безопасно: prompt <=1000 точно влезает.
  const finalPrompt = builtPrompt.length > 980 ? builtPrompt.slice(0, 977) + '...' : builtPrompt;

  await job.updateProgress(30);

  let result: { images: { base64: string; mimeType: string }[]; model: string };

  if (provider === 'runway') {
    const resolution: RunwayImageResolution = quality === 'high' ? '1080p' : '720p';
    const runRatio: RunwayImageRatio = (aspectRatio as RunwayImageRatio);
    // Runway обычно отдаёт 1 картинку на вызов — варианты делаем последовательно.
    const collected: { base64: string; mimeType: string }[] = [];
    for (let i = 0; i < variants; i++) {
      const r = await runwayGenerateImages({
        prompt: finalPrompt,
        referenceImageUrl,
        model: targetModel as RunwayImageModel,
        ratio: runRatio,
        resolution,
      });
      collected.push(...r.images);
      await job.updateProgress(30 + Math.round(((i + 1) / variants) * 40));
    }
    result = { images: collected, model: targetModel as string };
  } else {
    result = await openaiGenerateImages({
      prompt: finalPrompt,
      referenceImageUrl,
      model: targetModel as OpenAiImageModel,
      aspectRatio,
      quality,
      numberOfImages: variants,
    });
  }

  // Upload results to S3
  await job.updateProgress(70);
  const results: { url: string; assetId: number }[] = [];

  for (let i = 0; i < result.images.length; i++) {
    const img = result.images[i]!;
    const buf = Buffer.from(img.base64, 'base64');
    const filename = `studio/${workspaceId}/generated-${uuidv4().slice(0, 8)}.png`;
    const url = await uploadFile(buf, filename, img.mimeType);

    const [asset] = await db.insert(studioAssets).values({
      workspaceId,
      userId: job.data.userId ?? null,
      projectId: projectId || null,
      type: 'generated',
      name: `AI Generated: ${prompt.slice(0, 50)}...`,
      url,
      metadata: {
        source: provider,
        kind: 'image',
        model: targetModel,
        prompt: finalPrompt,
        aspectRatio,
        quality,
        fromReferenceImage: !!referenceImageUrl,
      },
    }).returning();

    results.push({ url, assetId: asset.assetId });
    await job.updateProgress(70 + Math.round((i + 1) / result.images.length * 20));
  }

  // Списать стоимость из AI-баланса workspace. Estimate по факту сгенерированных картинок.
  const chargedKopecks = 0; // Provider bills the seller directly.

  await db.update(studioTasks)
    .set({
      status: 'completed',
      progress: 100,
      output: { images: results, chargedKopecks },
      creditsUsed: Math.ceil(chargedKopecks / 100),
      completedAt: new Date(),
    })
    .where(eq(studioTasks.taskId, taskId));

  // Запись в историю промптов — ГАРАНТИРОВАННО, даже при обрыве связи с клиентом.
  // Ошибку логируем и глотаем: это не должно валить успешную генерацию.
  try {
    await db.insert(studioPromptSuggestions).values({
      workspaceId,
      shopId: null,
      nmId: job.data.nmId ?? 0,
      userId: job.data.userId ?? null,
      promptsJson: [{
        kind: 'main_image',
        title: 'Промпт пользователя',
        promptText: finalPrompt,
        targetModel: String(targetModel),
        aspectRatio,
        referenceImageUrl: referenceImageUrl,
        generatedImageUrl: results[0]?.url,
      }] as any,
      productContextJson: { title: '', category: '', photosCount: 0, hasAudit: false } as any,
      modelUsed: String(targetModel),
      label: 'user_generated',
    });
  } catch (err) {
    console.error(`[StudioWorker] failed to record prompt history for task ${taskId}:`, err);
  }

  return { images: results };
}

/**
 * Обработка генерации видео (Sora 2 pro)
 */
async function processGenerateVideoJob(job: Job<GenerateVideoJobData>) {
  const {
    taskId,
    workspaceId,
    projectId,
    prompt,
    model = 'sora-2-pro',
    seconds = 4,
    size = '1280x720',
    referenceImageUrl,
    presetSettings,
  } = job.data;

  await db.update(studioTasks)
    .set({ status: 'processing', progress: 5 })
    .where(eq(studioTasks.taskId, taskId));

  const finalPrompt = presetSettings
    ? buildPromptFromPreset(presetSettings, prompt)
    : prompt;

  await job.updateProgress(10);

  const provider = videoProviderFor(model as VideoModel);

  let result: { buffer: Buffer; mimeType: string; seconds: number; size: string; model: string; videoId?: string; taskId?: string };

  if (provider === 'runway') {
    // Runway — единый endpoint для всех моделей (gen4.x, gen3a_turbo, act_two, veo3, veo3.1*)
    // Ratio теперь в семантическом виде («16:9», …) — конкретные пиксели
    // выбираются в runwayVideo.ts по модели (gen3a vs gen4/veo разные whitelist'ы).
    const ratio: RunwayRatio = /1080x1920|768x1280|9:16/.test(size) ? '9:16'
                               : /1920x1080|1280x720|16:9/.test(size) ? '16:9'
                               : /1024x1024|960x960|1:1/.test(size) ? '1:1'
                               : /1104x832|4:3/.test(size) ? '4:3'
                               : /832x1104|3:4/.test(size) ? '3:4'
                               : /1584x672|ultrawide|21:9/.test(size) ? 'ultrawide'
                               : '16:9';
    const runwayDuration = seconds >= 10 ? 10 : (seconds >= 8 ? 8 : seconds >= 5 ? 5 : 4);
    const r = await runwayGenerateVideo({
      prompt: finalPrompt,
      referenceImageUrl,
      model: model as RunwayModel,
      duration: runwayDuration as 4 | 5 | 8 | 10,
      ratio,
    });
    result = { ...r, videoId: r.taskId };
  } else {
    // Sora (OpenAI) — размер в формате "WxH"
    const r = await openaiGenerateVideo({
      prompt: finalPrompt,
      model: model as SoraModel,
      seconds,
      size: size as SoraSize,
    });
    result = r;
  }

  await job.updateProgress(85);

  const filename = `studio/${workspaceId}/video-${uuidv4().slice(0, 8)}.mp4`;
  const url = await uploadFile(result.buffer, filename, result.mimeType);

  const [asset] = await db.insert(studioAssets).values({
    workspaceId,
    userId: job.data.userId ?? null,
    projectId: projectId || null,
    type: 'generated',
    name: `AI Video: ${prompt.slice(0, 50)}...`,
    url,
    metadata: {
      source: provider,
      kind: 'video',
      model: result.model,
      prompt: finalPrompt,
      seconds: result.seconds,
      size: result.size,
      videoId: result.videoId,
      fromReferenceImage: !!job.data.referenceImageUrl,
    },
  }).returning();

  // Списать стоимость из AI-баланса (факт ≈ estimate — OpenAI не отдаёт точный billing)
  const chargedKopecks = 0; // Provider bills the seller directly.

  await db.update(studioTasks)
    .set({
      status: 'completed',
      progress: 100,
      output: {
        video: { url, assetId: asset.assetId, seconds: result.seconds, size: result.size },
        chargedKopecks,
      },
      creditsUsed: Math.ceil(chargedKopecks / 100),
      completedAt: new Date(),
    })
    .where(eq(studioTasks.taskId, taskId));

  return { video: { url, assetId: asset.assetId } };
}

// ============================================
// CLEANUP
// ============================================

/**
 * Graceful shutdown
 */
export async function closeStudioQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
