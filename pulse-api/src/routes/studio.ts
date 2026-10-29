/**
 * Visual Studio API Routes
 * Canvas editor, AI generation, assets management
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import { db } from '../db/client.js';
import {
  studioProjects,
  studioAssets,
  studioPresets,
  studioCredits,
  studioTasks,
  studioPromptSuggestions,
  wbCards, // was wbCards
} from '../db/schema.js';
import { eq, and, desc, like, sql, or } from 'drizzle-orm';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import { uploadFile, deleteFile, downloadToBuffer, resolveStorageUrl } from '../lib/s3.js';
import { addRemoveBgJob, addGenerateImageJob, addGenerateVideoJob } from '../jobs/studioQueue.js';
import { requireRole } from '../plugins/roleCheck.js';
import { buildShopFilter } from './pulse/helpers.js';
import { getBalance, calculateOpenAiCostKopecks, markupForMediaModel } from '../services/aiTokens.js';
import { aiSingleRateLimit, aiVideoRateLimit } from '../lib/expensiveRouteLimits.js';
import { estimateImageUsd, estimateVideoUsd } from '../services/aiMediaPricing.js';

// ============================================
// TYPES
// ============================================

interface ProjectBody {
  name: string;
  type?: 'image' | 'infographic' | 'rich_content' | 'animation';
  nmId?: number;
  canvasData?: object;
  thumbnail?: string;
  /** Привязка к магазину — иначе GET ?shopId=N не покажет проект обратно. */
  shopId?: number;
}

interface GenerateBody {
  prompt: string;
  referenceImageUrl?: string;
  /** Legacy gemini-* accepted and mapped to gpt-image-2 server-side. */
  model?:
    | 'gpt-image-2' | 'gpt-image-1.5'
    | 'gen4_image' | 'gen4_image_turbo' | 'gemini_2.5_flash'
    | 'gemini-flash' | 'gemini-pro';
  aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
  variants?: 1 | 2 | 4 | 8;
  quality?: 'low' | 'medium' | 'high' | 'auto';
  temperature?: number;
  presetId?: number;
  projectId?: number;
  /** Артикул WB — пишется в историю промптов на completed. */
  nmId?: number;
}

interface GenerateVideoBody {
  prompt: string;
  model?:
    | 'sora-2-pro' | 'sora-2'
    | 'gen4.5' | 'gen4_turbo' | 'gen4_aleph'
    | 'gen3a_turbo' | 'act_two'
    | 'veo3'
    | 'veo3.1_audio' | 'veo3.1_noaudio'
    | 'veo3.1_fast_audio' | 'veo3.1_fast_noaudio';
  seconds?: number;
  size?: '720x1280' | '1280x720' | '1024x1024' | '1920x1080' | '1080x1920' | '1280x768' | '768x1280';
  /** Обязательно для act_two, опционально для image-to-video */
  referenceImageUrl?: string;
  projectId?: number;
  presetId?: number;
}

interface PresetBody {
  name: string;
  category?: string;
  settings: {
    camera?: string;
    lighting?: string;
    style?: string;
    pose?: string;
    background?: string;
    model?: string;
    temperature?: number;
    prompt_template?: string;
  };
  isDefault?: boolean;
}

// ============================================
// CREDITS CONFIG
// ============================================

// Pricing теперь живёт в services/aiMediaPricing.ts + aiTokens.calculateOpenAiCostKopecks.
// Оставлен только бесплатный remove_bg (self-hosted), остальное снимается из AI-баланса в рублях.
const LOCAL_FREE: Record<string, number> = {
  'remove_bg': 0,
};

// ============================================
// HELPER FUNCTIONS
// ============================================

function getWorkspaceId(req: FastifyRequest): number {
  const query = req.query as Record<string, string>;
  const workspaceId = query.workspaceId || query.workspace_id;
  if (!workspaceId) {
    throw new Error('workspaceId is required');
  }
  return Number(workspaceId);
}

// ============================================
// PLUGIN
// ============================================

export async function studioRoutes(app: FastifyInstance) {
  // Multipart parser для опорных фото/референсов и uploaded studio assets. Без этого Fastify возвращает 415 на любой `multipart/form-data` запрос (это и было причиной «Unsupported Media Type» при загрузке опорного изображения).
  await app.register(multipart, { limits: { fileSize: 32 * 1024 * 1024 } });

  // ------------------------------------------
  // PROJECTS
  // ------------------------------------------

  // List projects
  app.get('/studio/projects', { preHandler: requireRole('viewer') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(req);
    const { type, status, limit = '50', offset = '0', shopId: shopIdStr } = req.query as Record<string, string>;
    const shopIdNum = Number(shopIdStr);
    const shopId = Number.isFinite(shopIdNum) && shopIdNum > 0 ? shopIdNum : undefined;

    const conditions = [eq(studioProjects.workspaceId, workspaceId)];

    // shopId фильтр — иначе проекты из других магазинов утекают в текущий.
    const shopFilter = buildShopFilter(studioProjects.shopId, shopId);
    if (shopFilter) conditions.push(shopFilter);

    if (type) {
      conditions.push(eq(studioProjects.type, type));
    }
    if (status) {
      conditions.push(eq(studioProjects.status, status));
    }

    const projects = await db
      .select()
      .from(studioProjects)
      .where(and(...conditions))
      .orderBy(desc(studioProjects.updatedAt))
      .limit(Number(limit))
      .offset(Number(offset));

    // Re-sign thumbnail URLs — same 1h-presigned issue as studioAssets.
    const signed = await Promise.all(projects.map(async (p) => ({
      ...p,
      thumbnail: p.thumbnail ? ((await resolveStorageUrl(p.thumbnail)) ?? p.thumbnail) : p.thumbnail,
    })));

    return { projects: signed };
  });

  // Create project
  app.post('/studio/projects', { preHandler: requireRole('manager') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(req);
    const body = req.body as ProjectBody;
    const shopIdQuery = Number((req.query as any)?.shopId);
    const shopId = body.shopId ?? (Number.isFinite(shopIdQuery) && shopIdQuery > 0 ? shopIdQuery : null);

    const [project] = await db
      .insert(studioProjects)
      .values({
        workspaceId,
        shopId,
        name: body.name,
        type: body.type || 'image',
        nmId: body.nmId,
        canvasData: body.canvasData,
        thumbnail: body.thumbnail,
      })
      .returning();

    return { project };
  });

  // Get project
  app.get('/studio/projects/:projectId', { preHandler: requireRole('viewer') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { projectId } = req.params as { projectId: string };
    const workspaceId = getWorkspaceId(req);

    const [project] = await db
      .select()
      .from(studioProjects)
      .where(and(
        eq(studioProjects.projectId, Number(projectId)),
        eq(studioProjects.workspaceId, workspaceId)
      ));

    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    return { project };
  });

  // Update project
  app.put('/studio/projects/:projectId', { preHandler: requireRole('manager') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { projectId } = req.params as { projectId: string };
    const workspaceId = getWorkspaceId(req);
    const body = req.body as Partial<ProjectBody> & { status?: string };

    const [project] = await db
      .update(studioProjects)
      .set({
        ...body,
        updatedAt: new Date(),
      })
      .where(and(
        eq(studioProjects.projectId, Number(projectId)),
        eq(studioProjects.workspaceId, workspaceId)
      ))
      .returning();

    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    return { project };
  });

  // Delete project
  app.delete('/studio/projects/:projectId', { preHandler: requireRole('manager') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { projectId } = req.params as { projectId: string };
    const workspaceId = getWorkspaceId(req);

    await db
      .delete(studioProjects)
      .where(and(
        eq(studioProjects.projectId, Number(projectId)),
        eq(studioProjects.workspaceId, workspaceId)
      ));

    return { success: true };
  });

  // Duplicate project
  app.post('/studio/projects/:projectId/duplicate', { preHandler: requireRole('manager') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { projectId } = req.params as { projectId: string };
    const workspaceId = getWorkspaceId(req);

    const [original] = await db
      .select()
      .from(studioProjects)
      .where(and(
        eq(studioProjects.projectId, Number(projectId)),
        eq(studioProjects.workspaceId, workspaceId)
      ));

    if (!original) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const [duplicate] = await db
      .insert(studioProjects)
      .values({
        workspaceId,
        name: `${original.name} (копия)`,
        type: original.type,
        nmId: original.nmId,
        canvasData: original.canvasData,
        status: 'draft',
      })
      .returning();

    return { project: duplicate };
  });

  // ------------------------------------------
  // ASSETS
  // ------------------------------------------

  // List assets — per-user library by default (scope=mine). Pass scope=workspace to get all.
  app.get('/studio/assets', { preHandler: requireRole('viewer') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(req);
    const { type, projectId, limit = '100', scope = 'mine', kind } = req.query as Record<string, string>;
    const userId = (req as any).user?.userId as number | undefined;

    const conditions = [eq(studioAssets.workspaceId, workspaceId)];

    if (scope === 'mine' && userId) {
      conditions.push(eq(studioAssets.userId, userId));
    }
    if (type) conditions.push(eq(studioAssets.type, type));
    if (projectId) conditions.push(eq(studioAssets.projectId, Number(projectId)));

    const assets = await db
      .select()
      .from(studioAssets)
      .where(and(...conditions))
      .orderBy(desc(studioAssets.createdAt))
      .limit(Math.min(500, Number(limit)));

    // Optional filter by metadata.kind (image|video) post-query.
    const filtered = kind
      ? assets.filter((a) => (a.metadata as any)?.kind === kind)
      : assets;

    // Stored URLs are 1h-presigned at upload time; re-sign on read so the
    // grid never shows broken images after the first hour.
    const signed = await Promise.all(filtered.map(async (a) => ({
      ...a,
      url: (await resolveStorageUrl(a.url)) ?? a.url,
    })));

    return { assets: signed };
  });

  // Upload asset (multipart)
  app.post('/studio/assets/upload', { preHandler: requireRole('manager') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(req);
    const { projectId, type = 'image' } = req.query as Record<string, string>;

    const data = await req.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file provided' });
    }

    let buffer = await data.toBuffer();

    // Validate extension against an explicit whitelist. The original code took
    // `data.filename.split('.').pop()` verbatim — letting a buyer name a file
    // `shell.jpg.php` resolve to a `.php` extension. Reject anything outside
    // the supported image set.
    const ALLOWED_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif']);
    const ALLOWED_MIME = new Set([
      'image/jpeg',
      'image/jpg', // non-standard, sent by some Edge/old-Safari clients — normalised below
      'image/png',
      'image/webp',
      'image/gif',
      'image/heic',
      'image/heif',
    ]);
    const rawExt = (data.filename.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!ALLOWED_EXTS.has(rawExt)) {
      return reply.status(400).send({ error: `Unsupported file extension. Allowed: ${[...ALLOWED_EXTS].join(', ')}` });
    }
    if (!ALLOWED_MIME.has(data.mimetype)) {
      return reply.status(400).send({ error: `Unsupported MIME type "${data.mimetype}". Allowed: ${[...ALLOWED_MIME].join(', ')}` });
    }
    // Normalise non-standard image/jpg to canonical image/jpeg so downstream
    // S3 metadata and renderers see one MIME for JPEG.
    let normalisedMime = data.mimetype === 'image/jpg' ? 'image/jpeg' : data.mimetype;
    let storageExt = rawExt === 'jpg' ? 'jpeg' : rawExt;

    // Verify the actual content matches the declared MIME by inspecting magic
    // bytes — `data.mimetype` is set by the client and cannot be trusted.
    // Header signatures: JPEG FFD8FF, PNG 89504E47, GIF 474946, WEBP RIFF....WEBP,
    // HEIC/HEIF ftyp box at offset 4 ("ftypheic"/"ftypmif1"/"ftypheix"/"ftypmsf1").
    const magic = buffer.subarray(0, 12);
    const isJpeg = magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff;
    const isPng = magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47;
    const isGif = magic[0] === 0x47 && magic[1] === 0x49 && magic[2] === 0x46;
    const isWebp = magic[0] === 0x52 && magic[1] === 0x49 && magic[2] === 0x46 && magic[3] === 0x46
      && magic[8] === 0x57 && magic[9] === 0x45 && magic[10] === 0x42 && magic[11] === 0x50;
    const ftyp = buffer.subarray(4, 12).toString('ascii');
    const isHeif = ftyp.startsWith('ftypheic') || ftyp.startsWith('ftypheix')
      || ftyp.startsWith('ftyphevc') || ftyp.startsWith('ftypmif1')
      || ftyp.startsWith('ftypmsf1') || ftyp.startsWith('ftypheis');
    if (!(isJpeg || isPng || isGif || isWebp || isHeif)) {
      return reply.status(400).send({ error: 'File content does not match a supported image format' });
    }

    // HEIC/HEIF — iPhone default. Browsers won't render it, S3-served URLs
    // would silently 404 in <img>. Transcode to JPEG before storage so the
    // rest of the pipeline sees a portable image.
    if (isHeif) {
      buffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
      normalisedMime = 'image/jpeg';
      storageExt = 'jpeg';
    }

    // UUID-only filename — never echo any part of the user-supplied filename
    // into the storage key. The uuid + timestamp make collisions astronomically
    // unlikely while keeping the path predictable for support.
    const filename = `studio/${workspaceId}/${Date.now()}-${uuidv4()}.${storageExt}`;

    const url = await uploadFile(buffer, filename, normalisedMime);

    const userId = (req as any).user?.userId as number | undefined;
    const shopIdQuery = Number((req.query as any)?.shopId);
    const assetShopId = Number.isFinite(shopIdQuery) && shopIdQuery > 0 ? shopIdQuery : null;
    const [asset] = await db
      .insert(studioAssets)
      .values({
        workspaceId,
        shopId: assetShopId,
        userId: userId ?? null,
        projectId: projectId ? Number(projectId) : null,
        type,
        name: data.filename,
        url,
        metadata: {
          mimeType: normalisedMime,
          fileSize: buffer.length,
          kind: type === 'generated' ? undefined : 'upload',
        },
      })
      .returning();

    return { asset };
  });

  // Delete asset
  app.delete('/studio/assets/:assetId', { preHandler: requireRole('manager') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { assetId } = req.params as { assetId: string };
    const workspaceId = getWorkspaceId(req);

    const [asset] = await db
      .select()
      .from(studioAssets)
      .where(and(
        eq(studioAssets.assetId, Number(assetId)),
        eq(studioAssets.workspaceId, workspaceId)
      ));

    if (asset) {
      // Try to delete from S3. With forcePathStyle the URL is `/<bucket>/<key>`
      // so `pathname.slice(1)` previously included the bucket prefix and the
      // DeleteObjectCommand looked for `<bucket>/<key>` — leaking the actual
      // file. Strip the bucket prefix to recover the real S3 key.
      try {
        const urlObj = new URL(asset.url);
        let key = urlObj.pathname.replace(/^\/+/, '');
        const bucket = process.env.S3_BUCKET || 'pulse-studio';
        if (key.startsWith(bucket + '/')) {
          key = key.slice(bucket.length + 1);
        }
        await deleteFile(decodeURIComponent(key));
      } catch (e) {
        // Ignore S3 errors, continue with DB deletion
        console.warn('[Studio] Failed to delete S3 file:', asset.url);
      }

      await db
        .delete(studioAssets)
        .where(eq(studioAssets.assetId, Number(assetId)));
    }

    return { success: true };
  });

  // Get products with photos (from WB catalog)
  app.get('/studio/products', { preHandler: requireRole('viewer') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(req);
    const { search, limit = '50', offset = '0' } = req.query as Record<string, string>;

    const conditions = [eq(wbCards.workspaceId, workspaceId)];

    if (search) {
      conditions.push(
        or(
          like(wbCards.subjectName, `%${search}%`),
          like(wbCards.vendorCode, `%${search}%`),
          like(wbCards.brandName, `%${search}%`)
        )!
      );
    }

    const products = await db
      .select({
        nmId: wbCards.nmId,
        name: wbCards.subjectName,
        brand: wbCards.brandName,
        photos: wbCards.photos,
        vendorCode: wbCards.vendorCode,
      })
      .from(wbCards)
      .where(and(...conditions))
      .limit(Number(limit))
      .offset(Number(offset));

    return { products };
  });

  // ------------------------------------------
  // AI OPERATIONS
  // ------------------------------------------

  // Remove background
  app.post('/studio/ai/remove-background', { preHandler: requireRole('manager') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(req);
    const { projectId, shopId: rawShopId } = req.query as Record<string, string>;
    const shopId = rawShopId ? Number(rawShopId) : null;
    const { imageUrl, model = 'birefnet-general-lite', alphaMatting = false } = req.body as {
      imageUrl: string;
      model?: string;
      alphaMatting?: boolean;
    };

    const taskId = uuidv4();

    // Create task record
    await db.insert(studioTasks).values({
      taskId,
      workspaceId,
      shopId: shopId && shopId > 0 ? shopId : null,
      projectId: projectId ? Number(projectId) : null,
      type: 'remove_bg',
      status: 'pending',
      input: { imageUrl, model, alphaMatting },
      creditsUsed: 0, // Free
    });

    // Add to queue
    try {
      await addRemoveBgJob({
        taskId,
        workspaceId,
        projectId: projectId ? Number(projectId) : undefined,
        imageUrl,
        options: { model: model as any, alphaMatting },
      });
    } catch (e: any) {
      // Queue not available - mark as failed
      await db.update(studioTasks)
        .set({ status: 'failed', error: `Queue error: ${e.message}`, completedAt: new Date() })
        .where(eq(studioTasks.taskId, taskId));
      
      return reply.status(503).send({
        error: 'AI service temporarily unavailable',
        taskId,
      });
    }

    return {
      taskId,
      status: 'processing',
      creditsUsed: 0, // Free
      estimatedTime: 10,
    };
  });

  // Live cost estimate (UI показывает стоимость до нажатия «Сгенерировать»)
  app.post('/studio/ai/estimate', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const body = req.body as any;
    if (!body?.kind) return reply.status(400).send({ error: 'kind required' });
    try {
      const modelForEstimate = body.kind === 'image'
        ? (body.model || 'gpt-image-2')
        : (body.model || 'sora-2-pro');
      const usd = body.kind === 'image'
        ? estimateImageUsd({
            model: modelForEstimate,
            quality: body.quality,
            aspectRatio: body.aspectRatio,
            variants: Math.max(1, Math.min(body.variants ?? 1, 8)),
          })
        : estimateVideoUsd({
            model: modelForEstimate,
            seconds: Math.max(1, Math.min(body.seconds ?? 4, 20)),
            size: body.size,
          });
      const { costRub, costUsdRoundedUp } = calculateOpenAiCostKopecks(usd, markupForMediaModel(modelForEstimate));
      return { rub: costRub, usd: costUsdRoundedUp };
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  // Suggest prompts — генерирует готовые промпты для товара (Артикул-first).
  // Работает БЕЗ аудита — аудит опционально обогащает контекст.
  app.post('/studio/ai/suggest-prompts', {
    preHandler: requireRole('viewer'),
    config: aiSingleRateLimit,
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(req);
    const body = z.object({
      nmId: z.coerce.number().int().positive(),
      auditId: z.coerce.number().int().positive().optional(),
      shopId: z.coerce.number().int().positive().optional(),
      count: z.coerce.number().int().min(3).max(15).optional(),
      kinds: z.array(z.string()).optional(),
      forceFresh: z.boolean().optional(),
    }).parse(req.body);

    try {
      const userId = (req as any).user?.userId as number | undefined;
      const { suggestPromptsForProduct } = await import('../services/promptSuggester.js');
      const result = await suggestPromptsForProduct({
        workspaceId,
        nmId: body.nmId,
        shopId: body.shopId ?? null,
        auditId: body.auditId ?? null,
        userId: userId ?? null,
        count: body.count,
        kinds: body.kinds,
        forceFresh: body.forceFresh,
      });
      return { ok: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'suggestion failed';
      req.log.error({ err, nmId: body.nmId }, 'suggest-prompts failed');
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // История сохранённых генераций промптов.
  // Если nmId указан — для конкретного товара, иначе — все по workspace (до 100).
  app.get('/studio/ai/suggest-prompts/history', { preHandler: requireRole('viewer') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(req);
    const query = z.object({
      nmId: z.coerce.number().int().positive().optional(),
      shopId: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).parse(req.query);

    try {
      const { getPromptHistoryForProduct } = await import('../services/promptSuggester.js');
      const rows = await getPromptHistoryForProduct({
        workspaceId,
        nmId: query.nmId ?? null,
        shopId: query.shopId ?? null,
        limit: query.limit ?? (query.nmId ? 10 : 50),
      });
      return { ok: true, rows };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'history failed';
      req.log.error({ err, nmId: query.nmId }, 'suggest-prompts history failed');
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // Сохранить использованный промпт в историю (вызывается фронтендом после генерации).
  app.post('/studio/ai/prompt-history/record', { preHandler: requireRole('viewer') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(req);
    const userId = (req as any).user?.userId as number | undefined;
    const body = z.object({
      prompt: z.string().min(1).max(4000),
      model: z.string().default('gemini_2.5_flash'),
      kind: z.string().default('image'),
      nmId: z.coerce.number().int().nonnegative().optional(),
      shopId: z.coerce.number().int().positive().optional(),
      aspectRatio: z.string().optional(),
      referenceImageUrl: z.string().optional(),
    }).parse(req.body);

    try {
      const prompt: any = {
        kind: body.kind === 'video' ? 'video_demo' : 'main_image',
        title: 'Промпт пользователя',
        promptText: body.prompt,
        targetModel: body.model,
        aspectRatio: body.aspectRatio,
        referenceImageUrl: body.referenceImageUrl,
      };
      await db.insert(studioPromptSuggestions).values({
        workspaceId,
        shopId: body.shopId ?? null,
        nmId: body.nmId ?? 0,
        userId: userId ?? null,
        promptsJson: [prompt],
        productContextJson: { title: '', category: '', photosCount: 0, hasAudit: false },
        modelUsed: body.model,
        label: 'user_generated',
      });
      return { ok: true };
    } catch (err) {
      req.log.error({ err }, 'prompt-history record failed');
      return reply.code(500).send({ ok: false, error: 'record failed' });
    }
  });

  // Generate image — списание из общего AI-баланса workspace (в рублях).
  app.post('/studio/ai/generate', {
    preHandler: requireRole('manager'),
    config: aiSingleRateLimit,
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(req);
    const userId = (req as any).user?.userId as number | undefined;
    const { projectId, shopId: rawShopId } = req.query as Record<string, string>;
    const shopId = rawShopId ? Number(rawShopId) : null;
    const body = req.body as GenerateBody;

    // Legacy gemini-* → gpt-image-2
    const legacyMap: Record<string, string> = { 'gemini-flash': 'gpt-image-2', 'gemini-pro': 'gpt-image-2' };
    const modelKey = (legacyMap[body.model || ''] || body.model || 'gpt-image-2') as any;
    const variants = body.variants || 1;

    // Estimate cost in USD → convert to kopecks with markup, ceiling to whole rubles.
    const estUsd = estimateImageUsd({
      model: modelKey,
      quality: body.quality,
      aspectRatio: body.aspectRatio,
      variants,
    });
    const { costKopecks, costRub, costUsdRoundedUp } = calculateOpenAiCostKopecks(estUsd, markupForMediaModel(modelKey));

    // Pre-check AI balance (shared with Claude chat)
    const { balanceKopecks } = await getBalance(workspaceId);
    

    const taskId = uuidv4();

    await db.insert(studioTasks).values({
      taskId,
      workspaceId,
      shopId: shopId && shopId > 0 ? shopId : null,
      projectId: projectId ? Number(projectId) : null,
      type: 'generate',
      status: 'pending',
      input: {
        ...body,
        _estimatedCost: { usd: costUsdRoundedUp, kopecks: costKopecks, rub: costRub, actorUserId: userId },
      },
      creditsUsed: 0,
    });

    try {
      await addGenerateImageJob({
        taskId,
        workspaceId,
        userId,
        projectId: projectId ? Number(projectId) : undefined,
        nmId: body.nmId,
        prompt: body.prompt,
        referenceImageUrl: body.referenceImageUrl,
        model: modelKey,
        aspectRatio: body.aspectRatio,
        quality: body.quality,
        temperature: body.temperature,
        variants: body.variants,
      });
    } catch (e: any) {
      await db.update(studioTasks)
        .set({ status: 'failed', error: `Queue error: ${e.message}`, completedAt: new Date() })
        .where(eq(studioTasks.taskId, taskId));
      return reply.status(503).send({ error: 'AI service temporarily unavailable', taskId });
    }

    return {
      taskId,
      status: 'processing',
      model: modelKey,
      estimatedCostRub: costRub,
      estimatedCostUsd: costUsdRoundedUp,
      balanceRub: Math.floor(balanceKopecks / 100),
      estimatedTime: 20,
    };
  });

  // ------------------------------------------
  // AI GENERATION — VIDEO (Sora)
  // ------------------------------------------
  app.post('/studio/ai/generate-video', {
    preHandler: requireRole('manager'),
    config: aiVideoRateLimit,
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(req);
    const userId = (req as any).user?.userId as number | undefined;
    const { projectId } = req.query as Record<string, string>;
    const body = req.body as GenerateVideoBody;

    if (!body?.prompt) {
      return reply.status(400).send({ error: 'prompt is required' });
    }

    const model = body.model || 'sora-2-pro';
    const seconds = Math.max(1, Math.min(body.seconds ?? 4, 20));
    const size = body.size || '1280x720';

    const estUsd = estimateVideoUsd({ model, seconds, size });
    const { costKopecks, costRub, costUsdRoundedUp } = calculateOpenAiCostKopecks(estUsd, markupForMediaModel(model));

    const { balanceKopecks } = await getBalance(workspaceId);
    

    const taskId = uuidv4();

    await db.insert(studioTasks).values({
      taskId,
      workspaceId,
      projectId: projectId ? Number(projectId) : null,
      type: 'generate',
      status: 'pending',
      input: {
        ...body,
        kind: 'video',
        model,
        seconds,
        size,
        _estimatedCost: { usd: costUsdRoundedUp, kopecks: costKopecks, rub: costRub, actorUserId: userId },
      },
      creditsUsed: 0,
    });

    try {
      await addGenerateVideoJob({
        taskId,
        workspaceId,
        userId,
        projectId: projectId ? Number(projectId) : undefined,
        prompt: body.prompt,
        model,
        seconds,
        size,
        referenceImageUrl: body.referenceImageUrl,
      });
    } catch (e: any) {
      await db.update(studioTasks)
        .set({ status: 'failed', error: `Queue error: ${e.message}`, completedAt: new Date() })
        .where(eq(studioTasks.taskId, taskId));
      return reply.status(503).send({ error: 'AI service temporarily unavailable', taskId });
    }

    return {
      taskId,
      status: 'processing',
      model,
      seconds,
      size,
      estimatedCostRub: costRub,
      estimatedCostUsd: costUsdRoundedUp,
      balanceRub: Math.floor(balanceKopecks / 100),
      estimatedTime: Math.max(60, seconds * 30),
    };
  });

  // Get task status
  app.get('/studio/ai/task/:taskId', { preHandler: requireRole('viewer') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = req.params as { taskId: string };
    const workspaceId = getWorkspaceId(req);

    const [task] = await db
      .select()
      .from(studioTasks)
      .where(and(
        eq(studioTasks.taskId, taskId),
        eq(studioTasks.workspaceId, workspaceId)
      ));

    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    // Re-sign URLs inside output.images[] / output.video so a polling client
    // that picks up a completed task >1h after generation still sees images.
    const rawOutput = task.output as { images?: Array<Record<string, any>>; video?: Record<string, any> } | null;
    let output: any = rawOutput;
    if (rawOutput && typeof rawOutput === 'object') {
      const next: any = { ...rawOutput };
      if (Array.isArray(rawOutput.images)) {
        next.images = await Promise.all(rawOutput.images.map(async (img) => ({
          ...img,
          url: img?.url ? ((await resolveStorageUrl(img.url)) ?? img.url) : img?.url,
        })));
      }
      if (rawOutput.video && typeof rawOutput.video === 'object') {
        const v = rawOutput.video as Record<string, any>;
        next.video = { ...v, url: v.url ? ((await resolveStorageUrl(v.url)) ?? v.url) : v.url };
      }
      output = next;
    }

    return {
      taskId: task.taskId,
      type: task.type,
      status: task.status,
      progress: task.progress,
      output,
      error: task.error,
      creditsUsed: task.creditsUsed,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
    };
  });

  // ------------------------------------------
  // PRESETS
  // ------------------------------------------

  // List presets (system + workspace)
  app.get('/studio/presets', { preHandler: requireRole('viewer') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(req);
    const { category } = req.query as Record<string, string>;

    // Get system presets + workspace-specific presets
    const baseFilter = or(
      eq(studioPresets.isSystem, true),
      eq(studioPresets.workspaceId, workspaceId)
    );
    const whereClause = category
      ? and(baseFilter, eq(studioPresets.category, category))
      : baseFilter;

    const presets = await db
      .select()
      .from(studioPresets)
      .where(whereClause)
      .orderBy(
        desc(studioPresets.isSystem),
        desc(studioPresets.isDefault),
        studioPresets.name
      );

    return { presets };
  });

  // Create preset
  app.post('/studio/presets', { preHandler: requireRole('manager') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(req);
    const body = req.body as PresetBody;

    const [preset] = await db
      .insert(studioPresets)
      .values({
        workspaceId,
        name: body.name,
        category: body.category,
        settings: body.settings,
        isDefault: body.isDefault || false,
        isSystem: false,
      })
      .returning();

    return { preset };
  });

  // Update preset
  app.put('/studio/presets/:presetId', { preHandler: requireRole('manager') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { presetId } = req.params as { presetId: string };
    const workspaceId = getWorkspaceId(req);
    const body = req.body as Partial<PresetBody>;

    // Can't edit system presets
    const [preset] = await db
      .update(studioPresets)
      .set({
        ...body,
        updatedAt: new Date(),
      })
      .where(and(
        eq(studioPresets.presetId, Number(presetId)),
        eq(studioPresets.workspaceId, workspaceId),
        eq(studioPresets.isSystem, false)
      ))
      .returning();

    if (!preset) {
      return reply.status(404).send({ error: 'Preset not found or cannot be modified' });
    }

    return { preset };
  });

  // Delete preset
  app.delete('/studio/presets/:presetId', { preHandler: requireRole('manager') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { presetId } = req.params as { presetId: string };
    const workspaceId = getWorkspaceId(req);

    // Can't delete system presets
    await db
      .delete(studioPresets)
      .where(and(
        eq(studioPresets.presetId, Number(presetId)),
        eq(studioPresets.workspaceId, workspaceId),
        eq(studioPresets.isSystem, false)
      ));

    return { success: true };
  });

  // ------------------------------------------
  // CREDITS
  // ------------------------------------------

  // Get balance — proxies общий AI-кошелёк (тот же, что использует чат-агент).
  // Кредиты больше не отдельные: возвращаем остаток в рублях (округление вниз,
  // чтобы не обещать пользователю лишнего).
  app.get('/studio/credits/balance', { preHandler: requireRole('viewer') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(req);
    const b = await getBalance(workspaceId);
    const balanceRub = Math.floor(b.balanceKopecks / 100);
    return {
      // legacy shape — UI читает field `balance`
      balance: balanceRub,
      balanceRub,
      balanceKopecks: b.balanceKopecks,
      totalSpentKopecks: b.totalSpentKopecks,
      totalSpentRub: Math.ceil(b.totalSpentKopecks / 100),
      unit: 'RUB',
    };
  });

  // Get history
  app.get('/studio/credits/history', { preHandler: requireRole('viewer') }, async (req: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(req);
    const { limit = '50', offset = '0' } = req.query as Record<string, string>;

    const history = await db
      .select()
      .from(studioCredits)
      .where(eq(studioCredits.workspaceId, workspaceId))
      .orderBy(desc(studioCredits.createdAt))
      .limit(Number(limit))
      .offset(Number(offset));

    return { history };
  });
}
