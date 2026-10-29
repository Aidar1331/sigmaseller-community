/**
 * Creative Image Generation Service
 *
 * Generates product images from audit designer briefs using Google Imagen 3.
 * Supports uploading to WB and creating A/B tests.
 */

import { db } from '../db/client.js';
import { eq, and, desc } from 'drizzle-orm';
import {
  creativeImageGenerations,
  creativeAuditRunsFinal,
  wbCards,
  abPhotoTests,
  abPhotoPhases,
  wbEvents,
} from '../db/schema.js';
import {
  generateImages,
  buildImagePrompt,
  fetchImageAsBase64,
  estimateCost,
  NEGATIVE_PROMPT_NO_TEXT,
  type ImageGenerationResult,
} from '../integrations/ai/googleImagen.js';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { addCardMedia } from '../integrations/wb/content.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'creative-image-gen' });

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface GenerateImageRequest {
  workspaceId: number;
  auditId?: number;
  nmId: number;
  briefIndex?: number;
  customPrompt?: string;
  generationType: 'infographic' | 'lifestyle' | 'product_shot' | 'animation';
  numberOfImages?: number;
}

export interface GenerateImageResponse {
  generationId: number;
  images: Array<{ preview: string }>; // base64 truncated for preview
  status: string;
  costUsd: string;
}

export interface SelectImageRequest {
  workspaceId: number;
  generationId: number;
  imageIndex: number;
}

export interface UploadToWbRequest {
  workspaceId: number;
  shopId?: number;
  generationId: number;
  photoNumber: number; // Position in WB gallery (1-based)
}

export interface CreateABTestRequest {
  workspaceId: number;
  generationId: number;
  periodDays?: number;
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function truncateBase64ForPreview(base64: string, maxChars: number = 100): string {
  return base64.slice(0, maxChars) + '...';
}

// ─────────────────────────────────────────────────────────────────
// Generate Image from Audit Brief
// ─────────────────────────────────────────────────────────────────

export async function generateImageFromBrief(
  req: GenerateImageRequest
): Promise<GenerateImageResponse> {
  const { workspaceId, auditId, nmId, briefIndex, customPrompt, generationType, numberOfImages } = req;

  logger.info({ workspaceId, nmId, generationType }, 'Starting image generation');

  // 1. Load card data for context
  const [card] = await db
    .select({
      title: wbCards.title,
      brandName: wbCards.brandName,
      subjectName: wbCards.subjectName,
      mainPhotoUrl: wbCards.mainPhotoUrl,
    })
    .from(wbCards)
    .where(and(eq(wbCards.workspaceId, workspaceId), eq(wbCards.nmId, nmId)))
    .limit(1);

  if (!card) {
    throw new Error(`Card not found: nmId=${nmId}`);
  }

  // 2. Build prompt
  let prompt: string;
  let designerBrief: string | null = null;

  if (customPrompt) {
    prompt = customPrompt;
  } else if (auditId !== undefined) {
    // Load designer brief from audit
    const [audit] = await db
      .select({ finalJson: creativeAuditRunsFinal.finalJson })
      .from(creativeAuditRunsFinal)
      .where(
        and(
          eq(creativeAuditRunsFinal.id, auditId),
          eq(creativeAuditRunsFinal.workspaceId, workspaceId)
        )
      )
      .limit(1);

    if (!audit) {
      throw new Error(`Audit not found: ${auditId}`);
    }

    const finalJson = audit.finalJson as any;

    // Extract designer brief based on type and index
    if (generationType === 'infographic') {
      const briefs = finalJson?.roleTasks?.designer ?? [];
      designerBrief = briefs[briefIndex ?? 0]?.brief ?? briefs[briefIndex ?? 0]?.task ?? 'Create product infographic';
    } else if (finalJson?.photos?.firstImage?.designerBrief) {
      designerBrief = finalJson.photos.firstImage.designerBrief;
    } else if (finalJson?.photos?.gallery?.missingFrames?.[briefIndex ?? 0]) {
      designerBrief = finalJson.photos.gallery.missingFrames[briefIndex ?? 0].designerBrief ?? 
                      finalJson.photos.gallery.missingFrames[briefIndex ?? 0].description;
    } else {
      designerBrief = 'Create professional product photo with clean background';
    }

    prompt = buildImagePrompt(
      designerBrief ?? 'Create professional product photo with clean background',
      {
        title: card.title ?? undefined,
        category: card.subjectName ?? undefined,
        brandName: card.brandName ?? undefined,
      },
      { type: generationType === 'animation' ? 'product_shot' : generationType }
    );
  } else {
    throw new Error('Either auditId or customPrompt is required');
  }

  // 3. Fetch reference image if available
  let referenceImageBase64: string | undefined;
  if (card.mainPhotoUrl) {
    try {
      referenceImageBase64 = await fetchImageAsBase64(card.mainPhotoUrl);
      logger.info({ nmId }, 'Fetched reference image');
    } catch (err) {
      logger.warn({ err, nmId }, 'Failed to fetch reference image, proceeding without');
    }
  }

  // 4. Create generation record (pending)
  const [gen] = await db
    .insert(creativeImageGenerations)
    .values({
      workspaceId,
      auditId: auditId ?? null,
      nmId,
      prompt,
      referencePhotoUrl: card.mainPhotoUrl ?? null,
      designerBrief,
      generationType,
      status: 'generating',
      generatedImages: [],
    })
    .returning({ generationId: creativeImageGenerations.generationId });

  const generationId = gen.generationId;

  try {
    // 5. Call Imagen API. NEGATIVE_PROMPT_NO_TEXT — централизованный список
    // запретов: текст, кириллица, цифры, watermarks. Без этого Imagen 3
    // упорно рисует мусорные буквы поверх товара.
    const result = await generateImages({
      prompt,
      referenceImageBase64,
      numberOfImages: numberOfImages ?? 3,
      aspectRatio: '1:1',
      negativePrompt: NEGATIVE_PROMPT_NO_TEXT,
    });

    // 6. Update generation record with results
    const cost = estimateCost(result.images.length);

    await db
      .update(creativeImageGenerations)
      .set({
        status: 'completed',
        generatedImages: result.images,
        costUsd: cost,
      })
      .where(eq(creativeImageGenerations.generationId, generationId));

    logger.info({ generationId, imageCount: result.images.length, cost }, 'Image generation completed');

    return {
      generationId,
      images: result.images.map((img) => ({
        preview: truncateBase64ForPreview(img.base64, 200),
      })),
      status: 'completed',
      costUsd: cost,
    };
  } catch (err: any) {
    // Update status to failed
    await db
      .update(creativeImageGenerations)
      .set({
        status: 'failed',
        errorMessage: err.message,
      })
      .where(eq(creativeImageGenerations.generationId, generationId));

    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────
// Select Image
// ─────────────────────────────────────────────────────────────────

export async function selectImage(req: SelectImageRequest): Promise<{ ok: boolean }> {
  const { workspaceId, generationId, imageIndex } = req;

  const [gen] = await db
    .select({ generatedImages: creativeImageGenerations.generatedImages })
    .from(creativeImageGenerations)
    .where(
      and(
        eq(creativeImageGenerations.generationId, generationId),
        eq(creativeImageGenerations.workspaceId, workspaceId)
      )
    )
    .limit(1);

  if (!gen) {
    throw new Error(`Generation not found: ${generationId}`);
  }

  const images = gen.generatedImages as any[];
  if (imageIndex < 0 || imageIndex >= images.length) {
    throw new Error(`Invalid image index: ${imageIndex}`);
  }

  await db
    .update(creativeImageGenerations)
    .set({ selectedIndex: imageIndex })
    .where(eq(creativeImageGenerations.generationId, generationId));

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────
// Upload to WB
// ─────────────────────────────────────────────────────────────────

export async function uploadToWb(req: UploadToWbRequest): Promise<{ ok: boolean; uploaded: boolean }> {
  const { workspaceId, shopId, generationId, photoNumber } = req;

  // 1. Load generation
  const [gen] = await db
    .select()
    .from(creativeImageGenerations)
    .where(
      and(
        eq(creativeImageGenerations.generationId, generationId),
        eq(creativeImageGenerations.workspaceId, workspaceId)
      )
    )
    .limit(1);

  if (!gen) {
    throw new Error(`Generation not found: ${generationId}`);
  }

  if (gen.selectedIndex === null) {
    throw new Error('No image selected');
  }

  const images = gen.generatedImages as Array<{ base64: string; mimeType: string }>;
  const selectedImage = images[gen.selectedIndex];

  if (!selectedImage) {
    throw new Error('Selected image not found');
  }

  // 2. Upload to WB
  const apiKey = await getWbApiKey(workspaceId, shopId);
  const nmId = Number(gen.nmId);

  const result = await addCardMedia(apiKey, nmId, selectedImage.base64, photoNumber);

  if (result.error) {
    throw new Error(`WB API error: ${result.errorText ?? 'Unknown error'}`);
  }

  // 3. Update generation record
  await db
    .update(creativeImageGenerations)
    .set({
      status: 'uploaded',
      uploadedToWb: true,
      uploadedPhotoNumber: photoNumber,
    })
    .where(eq(creativeImageGenerations.generationId, generationId));

  // 4. Log event
  await db.insert(wbEvents).values({
    workspaceId,
    nmId,
    date: isoDate(new Date()),
    type: 'log',
    category: 'creative_audit',
    title: `AI-фото загружено в WB (позиция ${photoNumber})`,
    source: 'agent',
    sourceId: String(generationId),
    status: 'resolved',
  });

  logger.info({ generationId, nmId, photoNumber }, 'Image uploaded to WB');

  return { ok: true, uploaded: true };
}

// ─────────────────────────────────────────────────────────────────
// Create A/B Test with Generated Image
// ─────────────────────────────────────────────────────────────────

export async function createABTestFromGeneration(
  req: CreateABTestRequest
): Promise<{ testId: number }> {
  const { workspaceId, generationId, periodDays } = req;

  // 1. Load generation
  const [gen] = await db
    .select()
    .from(creativeImageGenerations)
    .where(
      and(
        eq(creativeImageGenerations.generationId, generationId),
        eq(creativeImageGenerations.workspaceId, workspaceId)
      )
    )
    .limit(1);

  if (!gen) {
    throw new Error(`Generation not found: ${generationId}`);
  }

  if (gen.selectedIndex === null) {
    throw new Error('No image selected');
  }

  const images = gen.generatedImages as Array<{ base64: string; mimeType: string }>;
  const selectedImage = images[gen.selectedIndex];

  if (!selectedImage) {
    throw new Error('Selected image not found');
  }

  const nmId = Number(gen.nmId);

  // 2. Get current main photo URL
  const [card] = await db
    .select({ photos: wbCards.photos })
    .from(wbCards)
    .where(and(eq(wbCards.workspaceId, workspaceId), eq(wbCards.nmId, nmId)))
    .limit(1);

  const currentPhotos = (card?.photos ?? []) as string[];
  const currentMainPhoto = currentPhotos[0] ?? '';

  // 3. Create A/B test
  const [test] = await db
    .insert(abPhotoTests)
    .values({
      workspaceId,
      nmId,
      status: 'running',
      periodDays: periodDays ?? 7,
      rotationMinutes: (periodDays ?? 7) * 24 * 60,
      goal: 'ctr',
      variantA: {
        label: 'Текущее фото',
        photos: currentMainPhoto ? [currentMainPhoto] : [],
      },
      variantB: {
        label: 'AI-генерация',
        photos: [], // Will store base64 reference
        note: `Generation ID: ${generationId}`,
      },
      currentVariant: 'A',
      autoRotate: true,
      lastRotatedAt: new Date(),
      startedAt: new Date(),
      updatedAt: new Date(),
    } as any)
    .returning({ testId: abPhotoTests.testId });

  const testId = test.testId;

  // 4. Create initial phase
  await db.insert(abPhotoPhases).values({
    testId,
    variant: 'A',
    startedAt: new Date(),
  });

  // 5. Update generation record
  await db
    .update(creativeImageGenerations)
    .set({ abTestId: testId })
    .where(eq(creativeImageGenerations.generationId, generationId));

  // 6. Log event
  await db.insert(wbEvents).values({
    workspaceId,
    nmId,
    date: isoDate(new Date()),
    type: 'log',
    category: 'ab_test',
    title: `A/B тест создан: текущее vs AI-фото`,
    source: 'agent',
    sourceId: String(testId),
    status: 'open',
  });

  logger.info({ testId, generationId, nmId }, 'A/B test created from generation');

  return { testId };
}

// ─────────────────────────────────────────────────────────────────
// List Generations
// ─────────────────────────────────────────────────────────────────

export async function listGenerations(
  workspaceId: number,
  status?: string,
  limit: number = 50
) {
  const conditions = [eq(creativeImageGenerations.workspaceId, workspaceId)];

  if (status) {
    conditions.push(eq(creativeImageGenerations.status, status));
  }

  const rows = await db
    .select({
      generationId: creativeImageGenerations.generationId,
      nmId: creativeImageGenerations.nmId,
      generationType: creativeImageGenerations.generationType,
      status: creativeImageGenerations.status,
      selectedIndex: creativeImageGenerations.selectedIndex,
      uploadedToWb: creativeImageGenerations.uploadedToWb,
      abTestId: creativeImageGenerations.abTestId,
      costUsd: creativeImageGenerations.costUsd,
      createdAt: creativeImageGenerations.createdAt,
    })
    .from(creativeImageGenerations)
    .where(and(...conditions))
    .orderBy(desc(creativeImageGenerations.createdAt))
    .limit(limit);

  return rows;
}

// ─────────────────────────────────────────────────────────────────
// Get Full Generation (with images)
// ─────────────────────────────────────────────────────────────────

export async function getGeneration(workspaceId: number, generationId: number) {
  const [gen] = await db
    .select()
    .from(creativeImageGenerations)
    .where(
      and(
        eq(creativeImageGenerations.generationId, generationId),
        eq(creativeImageGenerations.workspaceId, workspaceId)
      )
    )
    .limit(1);

  return gen ?? null;
}
