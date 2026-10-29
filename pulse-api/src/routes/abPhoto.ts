import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import { eq, and, gte, lte, desc, asc, sql, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { abPhotoTests, abPhotoPhases, abPhotoMetrics, abPhotoUploads, wbCards } from '../db/schema.js';

/** Fallback для legacy-тестов без shop_id — ищем магазин через wb_cards. */
async function resolveShopIdForCardR(workspaceId: number, nmId: number, testShopId: number | null | undefined): Promise<number | undefined> {
  if (testShopId) return testShopId;
  const [row] = await db
    .select({ shopId: wbCards.shopId })
    .from(wbCards)
    .where(and(eq(wbCards.workspaceId, workspaceId), eq(wbCards.nmId, nmId)))
    .limit(1);
  return row?.shopId ?? undefined;
}
import { computeStatsByVariant, computeStatsByVariants, computeStatsByDay, pickWinner, twoPropZTest, forecastMonthly, ALL_VARIANT_LABELS, type VariantLabel } from '../services/abPhoto.js';
import { isWbMediaSyncEnabled, updateWbCardSlot } from '../integrations/wb/media.js';
import { getCard, safeUpdateCard, type CardUpdatePayload } from '../integrations/wb/content.js';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { requireRole } from '../plugins/roleCheck.js';
import { buildShopFilter } from './pulse/helpers.js';
import { uploadFile } from '../lib/s3.js';
import log from '../lib/logger.js';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';

const logger = log.child({ module: 'abPhoto' });

type ResolvedVariant = {
  label: VariantLabel;
  photos: string[];
  title: string | null;
  description: string | null;
  characteristics: Array<{ id: number; value: string | string[] }>;
};

export type AbTestType = 'photos' | 'title' | 'description' | 'characteristics' | 'mixed';

/**
 * A test exercises exactly one content field. We don't store the type — it
 * is derived from which fields the variants actually populate.
 *
 *   any variant has photos → 'photos'
 *   any variant has title  → 'title'
 *   ... and so on.
 *
 * `'mixed'` is reserved for legacy tests (created before the per-type UI) that
 * have, e.g., both photos and title set across the variant pair.
 */
export function deriveTestType(variants: ResolvedVariant[]): AbTestType {
  const hasPhotos = variants.some((v) => v.photos.length > 0);
  const hasTitle = variants.some((v) => v.title !== null);
  const hasDescription = variants.some((v) => v.description !== null);
  const hasCharcs = variants.some((v) => v.characteristics.length > 0);
  const present = [hasPhotos, hasTitle, hasDescription, hasCharcs].filter(Boolean).length;
  if (present > 1) return 'mixed';
  if (hasPhotos) return 'photos';
  if (hasTitle) return 'title';
  if (hasDescription) return 'description';
  if (hasCharcs) return 'characteristics';
  return 'photos'; // empty test → bucket into photos by default
}

/**
 * Returns the canonical variant list for a test, falling back to the legacy
 * {variantA, variantB} pair when the new `variants` column is empty (i.e.
 * tests created before migration 0128 / before the multi-variant feature).
 *
 * Variants may carry photo URLs and/or content overrides (title, description,
 * characteristics). Photo-only tests still work — extra fields default to null.
 */
function resolveVariants(test: any): ResolvedVariant[] {
  const norm = (x: any, fallbackLabel: VariantLabel): ResolvedVariant => ({
    label: (x?.label as VariantLabel) ?? fallbackLabel,
    photos: Array.isArray(x?.photos) ? x.photos.map((u: any) => String(u)).filter(Boolean) : [],
    title: typeof x?.title === 'string' && x.title.trim() ? x.title : null,
    description: typeof x?.description === 'string' && x.description.trim() ? x.description : null,
    characteristics: Array.isArray(x?.characteristics) ? x.characteristics : [],
  });
  const v = test?.variants;
  if (Array.isArray(v) && v.length > 0) {
    return v.map((x: any, i: number) => norm(x, (['A','B','C','D','E'][i] ?? 'A') as VariantLabel));
  }
  return [
    norm(test?.variantA, 'A'),
    norm(test?.variantB, 'B'),
  ];
}

function toArray(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter(Boolean);
}

function normalizeCharacteristics(v: any): Array<{ id: number; value: string | string[] }> {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => ({
      id: Number(x?.id),
      value: Array.isArray(x?.value)
        ? x.value.map((s: any) => String(s))
        : x?.value != null ? String(x.value) : '',
    }))
    .filter((x) => Number.isFinite(x.id) && x.id > 0);
}

function normalizeVariant(input: any) {
  return {
    label: String(input?.label ?? ''),
    photos: toArray(input?.photos),
    title: typeof input?.title === 'string' && input.title.trim() ? input.title : null,
    description: typeof input?.description === 'string' && input.description.trim() ? input.description : null,
    characteristics: normalizeCharacteristics(input?.characteristics),
    note: input?.note ? String(input.note) : null,
  };
}

/**
 * Push variant content (title/description/characteristics) to WB.
 * No-op if the variant has no content overrides — photo-only tests skip this.
 * Throws on WB API error so the caller can abort rotation.
 */
async function syncVariantContentToWb(
  workspaceId: number,
  nmId: number,
  variant: ResolvedVariant,
  shopId?: number,
): Promise<void> {
  const hasTitle = variant.title != null;
  const hasDescription = variant.description != null;
  const hasCharcs = variant.characteristics.length > 0;
  if (!hasTitle && !hasDescription && !hasCharcs) return;

  const apiKey = await getWbApiKey(workspaceId, shopId);
  const patch: Partial<Omit<CardUpdatePayload, 'nmID' | 'vendorCode'>> = {
    ...(hasTitle ? { title: variant.title! } : {}),
    ...(hasDescription ? { description: variant.description! } : {}),
    ...(hasCharcs ? { characteristics: variant.characteristics } : {}),
  };
  const res = await safeUpdateCard(apiKey, nmId, patch);
  if (res.error) {
    throw new Error(`WB card update failed: ${res.errorText ?? 'unknown error'}`);
  }
}

function getVariantPhotos(test: { variantA: any; variantB: any }, variant: 'A' | 'B'): string[] {
  const src = variant === 'B' ? test.variantB : test.variantA;
  if (!src || !Array.isArray(src.photos)) return [];
  return src.photos.map((x: any) => String(x)).filter(Boolean);
}

// Rotation presets in minutes
const ROTATION_PRESETS = {
  '20min': 20,
  '1hour': 60,
  '6hours': 360,
  '1day': 1440,
  '3days': 4320,
  '7days': 10080,
};

export const abPhotoRoutes: FastifyPluginAsync = async (app) => {
  // Multipart parser for /upload. Without this Fastify returns 415
  // "Unsupported Media Type" on every multipart/form-data request.
  // 10MB matches the per-file limit enforced inside the handler.
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  // ─────────────────────────────────────────────
  // List tests
  // ─────────────────────────────────────────────
  app.get('/ab-photo/:workspaceId', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        status: z.enum(['running', 'paused', 'completed']).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        shopId: z.coerce.number().int().positive().optional(),
        // archived=0 (default) → не показывать архивные.
        // archived=1 → только архивные. archived=all → все.
        archived: z.enum(['0', '1', 'all']).optional().default('0'),
      })
      .parse(req.query);

    const conds: any[] = [eq(abPhotoTests.workspaceId, params.workspaceId)];
    const shopFilter = buildShopFilter(abPhotoTests.shopId, query.shopId);
    if (shopFilter) conds.push(shopFilter);
    if (query.status) conds.push(eq(abPhotoTests.status, query.status));
    if (query.archived === '0') conds.push(sql`${abPhotoTests.archivedAt} IS NULL`);
    else if (query.archived === '1') conds.push(sql`${abPhotoTests.archivedAt} IS NOT NULL`);

    const rows = await db
      .select({
        testId: abPhotoTests.testId,
        nmId: abPhotoTests.nmId,
        name: abPhotoTests.name,
        status: abPhotoTests.status,
        periodDays: abPhotoTests.periodDays,
        rotationMinutes: abPhotoTests.rotationMinutes,
        goal: abPhotoTests.goal,
        currentVariant: abPhotoTests.currentVariant,
        winnerVariant: abPhotoTests.winnerVariant,
        lastRotatedAt: abPhotoTests.lastRotatedAt,
        autoRotate: abPhotoTests.autoRotate,
        startedAt: abPhotoTests.startedAt,
        createdAt: abPhotoTests.createdAt,
        lastSyncError: abPhotoTests.lastSyncError,
        lastSyncErrorAt: abPhotoTests.lastSyncErrorAt,
        variants: abPhotoTests.variants,
        variantA: abPhotoTests.variantA,
        variantB: abPhotoTests.variantB,
        archivedAt: abPhotoTests.archivedAt,
      })
      .from(abPhotoTests)
      .where(and(...conds))
      .orderBy(desc(abPhotoTests.createdAt))
      .limit(query.limit ?? 20);

    // Derive testType per row so the UI can tab-filter without fetching detail.
    // Drop the heavy variants/variantA/B from the response shape to keep the
    // list payload small.
    const enriched = rows.map((r) => {
      const resolved = resolveVariants(r);
      const { variants, variantA, variantB, ...rest } = r as any;
      return {
        ...rest,
        testType: deriveTestType(resolved),
      };
    });

    return { ok: true, workspaceId: params.workspaceId, rows: enriched };
  });

  // ─────────────────────────────────────────────
  // Create test (enhanced)
  // ─────────────────────────────────────────────
  app.post('/ab-photo/:workspaceId', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const variantInputSchema = z.object({
      label: z.enum(['A', 'B', 'C', 'D', 'E']),
      photos: z.array(z.string()).default([]),
      // Content overrides — testing more than just photos. All optional;
      // a variant with only photos works exactly as before.
      title: z.string().max(120).optional(),
      description: z.string().max(5000).optional(),
      characteristics: z
        .array(z.object({
          id: z.coerce.number().int().positive(),
          value: z.union([z.string(), z.array(z.string())]),
        }))
        .optional(),
    });

    const body = z
      .object({
        // shopId привязывает тест к магазину. Без него buildShopFilter в GET
        // /ab-photo?shopId=N не найдёт тест и UI покажет «нет тестов».
        shopId: z.coerce.number().int().positive().optional(),
        nmId: z.coerce.number().int().positive(),
        periodDays: z.coerce.number().int().optional(),
        rotationMinutes: z.coerce.number().int().min(20).optional(), // min 20 minutes
        goal: z.enum(['orders', 'ctr', 'revenue']).optional(),
        // Client-declared test type. Enforced as a hard "one test = one type"
        // contract: any variant carrying fields outside this type is rejected.
        testType: z.enum(['photos', 'title', 'description', 'characteristics']).optional(),
        // Legacy 2-variant fields — supported for clients that haven't migrated
        variantA: z.any().optional(),
        variantB: z.any().optional(),
        // New N-variant array, up to 5 entries A..E. When present, takes
        // precedence over variantA/variantB.
        variants: z.array(variantInputSchema).min(2).max(5).optional(),
        autoRotate: z.boolean().optional(),
        compareAdsSeparately: z.boolean().optional(),
      })
      .parse((req as any).body ?? {});

    // Enforce "one test = one type" — bail out before the duplicate-test check
    // so the caller sees the actual problem (mixed fields) instead of a 409.
    if (body.testType && body.variants) {
      for (const v of body.variants) {
        const present = {
          photos: v.photos.length > 0,
          title: v.title != null && v.title.trim().length > 0,
          description: v.description != null && v.description.trim().length > 0,
          characteristics: (v.characteristics ?? []).length > 0,
        };
        const wrong = (Object.keys(present) as Array<keyof typeof present>)
          .filter((k) => k !== body.testType && present[k]);
        if (wrong.length) {
          return reply.status(400).send({
            error: 'mixed_test_fields',
            message: `Variant ${v.label} has ${wrong.join(', ')} but testType=${body.testType}. One test = one type.`,
          });
        }
      }
    }

    // Check for existing active test on same nmId
    const existing = await db
      .select({ testId: abPhotoTests.testId, status: abPhotoTests.status })
      .from(abPhotoTests)
      .where(
        and(
          eq(abPhotoTests.workspaceId, params.workspaceId),
          eq(abPhotoTests.nmId, body.nmId),
          inArray(abPhotoTests.status, ['running', 'paused'])
        )
      )
      .limit(1);

    if (existing.length > 0) {
      return reply.status(409).send({
        error: 'duplicate_test',
        message: `Already have an active test (ID: ${existing[0].testId}) for nmId ${body.nmId}. Stop it first.`,
        existingTestId: existing[0].testId,
      });
    }

    const periodDays = [3, 7, 14, 30].includes(Number(body.periodDays)) ? Number(body.periodDays) : 7;
    // Дефолт ротации — 12 часов. Это позволяет каждому варианту получить минимум
    // 2 цикла за неделю и набрать выборку. Раньше дефолт был period × 24 × 60
    // (т.е. при тесте 7 дней — 1 ротация за 7 дней, что не давало двух циклов).
    // 2026-05-31: исправлено вместе с понижением cron'а scheduler.ts до 1ч.
    const rotationMinutes = body.rotationMinutes ?? Math.min(periodDays * 24 * 60, 12 * 60);
    const goal = body.goal ?? 'orders';

    // Resolve final variant array. If client sent `variants[]` — use that;
    // otherwise build it from the legacy variantA/variantB so existing UI
    // keeps working without a redeploy.
    const variantsArray = body.variants
      ?? [
        { label: 'A' as const, photos: (body.variantA?.photos as string[] | undefined) ?? [] },
        { label: 'B' as const, photos: (body.variantB?.photos as string[] | undefined) ?? [] },
      ];
    const normalizedVariants = variantsArray.map((v) => normalizeVariant(v));

    // Fallback shopId из query (UI шлёт `?shopId=N` рядом с workspaceId)
    const shopIdQuery = Number((req.query as any)?.shopId);
    const shopId = body.shopId ?? (Number.isFinite(shopIdQuery) && shopIdQuery > 0 ? shopIdQuery : null);

    // Snapshot карточки на момент создания (фото + title + description).
    // При ротации:
    //   • photos → меняем только testPhotoSlot, остальные слоты из snapshot
    //   • title/description → safeUpdateCard подмешает остальные поля
    // Snapshot оригиналов нужен ещё чтобы UI мог показать «было ↔ варианты»
    // и юзер мог откатить к оригиналу после теста.
    let originalPhotos: string[] = [];
    let originalTitle: string | null = null;
    let originalDescription: string | null = null;
    try {
      const resolvedShopIdForSnap = await resolveShopIdForCardR(params.workspaceId, body.nmId, shopId ?? undefined);
      const apiKey = await getWbApiKey(params.workspaceId, resolvedShopIdForSnap);
      const card = await getCard(apiKey, body.nmId);
      if (card) {
        if (Array.isArray(card.photos)) {
          // CardPhoto = { big, hq, c516x688, ... } — WB media/save принимает любой URL,
          // берём `big` как канонический.
          originalPhotos = card.photos.map((p: any) => p?.big ?? p?.hq ?? '').filter(Boolean);
        }
        originalTitle = card.title ?? null;
        originalDescription = card.description ?? null;
      }
    } catch (snapErr: any) {
      logger.warn({ err: snapErr?.message, nmId: body.nmId }, 'Could not snapshot card — test created but rotation may refuse to sync to WB');
    }

    const row = await db
      .insert(abPhotoTests)
      .values({
        workspaceId: params.workspaceId,
        shopId,
        nmId: body.nmId,
        status: 'running',
        periodDays,
        rotationMinutes,
        goal,
        // Legacy mirror — first two variants land in variant_a/variant_b so
        // any read path that hasn't been updated still resolves something
        // sensible. Code reading the test prefers `variants` when non-empty.
        variantA: normalizedVariants[0] ?? normalizeVariant(body.variantA),
        variantB: normalizedVariants[1] ?? normalizeVariant(body.variantB),
        variants: normalizedVariants,
        currentVariant: 'A',
        autoRotate: body.autoRotate ?? true,
        compareAdsSeparately: body.compareAdsSeparately ?? true,
        lastRotatedAt: new Date(),
        startedAt: new Date(),
        updatedAt: new Date(),
        originalPhotos,
        testPhotoSlot: 0,
        originalTitle,
        originalDescription,
      } as any)
      .returning({
        testId: abPhotoTests.testId,
        nmId: abPhotoTests.nmId,
        status: abPhotoTests.status,
        periodDays: abPhotoTests.periodDays,
        rotationMinutes: abPhotoTests.rotationMinutes,
        goal: abPhotoTests.goal,
        currentVariant: abPhotoTests.currentVariant,
        startedAt: abPhotoTests.startedAt,
      });

    const testId = row[0]!.testId;
    await db.insert(abPhotoPhases).values({
      testId,
      variant: 'A',
      startedAt: new Date(),
    });

    return { ok: true, test: row[0] };
  });

  // ─────────────────────────────────────────────
  // Upload photo (multipart) → returns a public URL the client puts straight
  // into a variant's photos[]. WB also fetches by URL, so the file must be
  // publicly accessible (ACL: 'public-read' on S3, or via /storage/* locally).
  // ─────────────────────────────────────────────
  app.post('/ab-photo/:workspaceId/upload', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);

    const data = await (req as any).file();
    if (!data) {
      return reply.code(400).send({ ok: false, error: 'No file uploaded' });
    }

    const ALLOWED_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
    const ALLOWED_MIME = new Set([
      'image/jpeg', 'image/jpg',
      'image/png', 'image/webp',
      'image/heic', 'image/heif',
    ]);
    const rawExt = ((data.filename || '').split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!ALLOWED_EXTS.has(rawExt)) {
      return reply.code(400).send({ ok: false, error: `Unsupported extension. Allowed: ${[...ALLOWED_EXTS].join(', ')}` });
    }
    if (!ALLOWED_MIME.has(data.mimetype)) {
      return reply.code(400).send({ ok: false, error: `Unsupported MIME "${data.mimetype}"` });
    }

    let buffer = await data.toBuffer();

    const MAX_SIZE = 10 * 1024 * 1024; // 10MB
    if (buffer.length > MAX_SIZE) {
      return reply.code(400).send({
        ok: false,
        error: 'File too large',
        message: `Maximum file size is 10MB, got ${Math.round(buffer.length / 1024 / 1024)}MB`,
      });
    }

    // Magic-byte verification — client-set mimetype is not trustworthy.
    const magic = buffer.subarray(0, 12);
    const isJpeg = magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff;
    const isPng = magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47;
    const isWebp = magic[0] === 0x52 && magic[1] === 0x49 && magic[2] === 0x46 && magic[3] === 0x46
      && magic[8] === 0x57 && magic[9] === 0x45 && magic[10] === 0x42 && magic[11] === 0x50;
    const ftyp = buffer.subarray(4, 12).toString('ascii');
    const isHeif = ftyp.startsWith('ftypheic') || ftyp.startsWith('ftypheix')
      || ftyp.startsWith('ftyphevc') || ftyp.startsWith('ftypmif1')
      || ftyp.startsWith('ftypmsf1') || ftyp.startsWith('ftypheis');
    if (!(isJpeg || isPng || isWebp || isHeif)) {
      return reply.code(400).send({ ok: false, error: 'File content does not match a supported image format' });
    }

    let normalisedMime = data.mimetype === 'image/jpg' ? 'image/jpeg' : data.mimetype;
    let storageExt = rawExt === 'jpg' ? 'jpeg' : rawExt;

    // iPhone HEIC → JPEG so the URL renders in <img> and WB can ingest it.
    if (isHeif) {
      buffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
      normalisedMime = 'image/jpeg';
      storageExt = 'jpeg';
    }

    const filename = `ab-photo/${params.workspaceId}/${Date.now()}-${uuidv4()}.${storageExt}`;
    // public-read: A/B variant photos are uploaded specifically so WB and end
    // users can fetch them directly. There is no sensitive data — these end
    // up on a WB card anyway. Without public-read, WB content-API gets a
    // 1-hour signed URL and fails to fetch on later rotations.
    const url = await uploadFile(buffer, filename, normalisedMime, { acl: 'public-read' });

    const [upload] = await db
      .insert(abPhotoUploads)
      .values({
        workspaceId: params.workspaceId,
        variant: 'A', // updated when assigned to a test
        position: 0,
        originalFilename: data.filename,
        storedPath: filename,
        url,
        sizeBytes: buffer.length,
        mimeType: normalisedMime,
      } as any)
      .returning();

    return {
      ok: true,
      upload: {
        uploadId: upload.uploadId,
        filename: data.filename,
        url,
        size: buffer.length,
      },
    };
  });

  // ─────────────────────────────────────────────
  // Assign uploads to test variant
  // ─────────────────────────────────────────────
  app.post('/ab-photo/:workspaceId/:testId/photos', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        testId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const body = z
      .object({
        variant: z.enum(['A', 'B', 'C', 'D', 'E']),
        uploadIds: z.array(z.coerce.number().int()).max(4),
      })
      .parse((req as any).body ?? {});

    // SECURITY: verify the testId belongs to this workspace before any
    // read/write. Without this check, a manager in tenant A could target
    // testId=N belonging to tenant B and overwrite their A/B variant config.
    const [ownTest] = await db
      .select({ testId: abPhotoTests.testId })
      .from(abPhotoTests)
      .where(and(eq(abPhotoTests.testId, params.testId), eq(abPhotoTests.workspaceId, params.workspaceId)))
      .limit(1);
    if (!ownTest) {
      return reply.code(404).send({ ok: false, error: 'test_not_found' });
    }

    // Update uploads with test and variant
    for (let i = 0; i < body.uploadIds.length; i++) {
      await db
        .update(abPhotoUploads)
        .set({
          testId: params.testId,
          variant: body.variant,
          position: i,
        } as any)
        .where(
          and(
            eq(abPhotoUploads.uploadId, body.uploadIds[i]),
            eq(abPhotoUploads.workspaceId, params.workspaceId)
          )
        );
    }

    // Get URLs for the variant (workspaceId in filter prevents leaking foreign
    // uploads if a testId collision ever exposed wrong data).
    const uploads = await db
      .select({ storedPath: abPhotoUploads.storedPath, url: abPhotoUploads.url })
      .from(abPhotoUploads)
      .where(
        and(
          eq(abPhotoUploads.testId, params.testId),
          eq(abPhotoUploads.variant, body.variant),
          eq(abPhotoUploads.workspaceId, params.workspaceId)
        )
      )
      .orderBy(asc(abPhotoUploads.position));

    const photos = uploads.map((u) => u.url || u.storedPath);

    // Update test variants. Write into both the legacy variant_a/variant_b
    // mirror (for A/B only) and the new `variants` array so multi-variant
    // and legacy paths stay consistent.
    const [currentTest] = await db
      .select({ variants: abPhotoTests.variants, variantA: abPhotoTests.variantA, variantB: abPhotoTests.variantB })
      .from(abPhotoTests)
      .where(and(eq(abPhotoTests.testId, params.testId), eq(abPhotoTests.workspaceId, params.workspaceId)))
      .limit(1);

    const existingVariants = resolveVariants(currentTest);
    const updatedVariants = (() => {
      const idx = existingVariants.findIndex((v) => v.label === body.variant);
      const merged = idx >= 0
        ? { ...existingVariants[idx], photos }
        : { label: body.variant, photos, title: null, description: null, characteristics: [] };
      if (idx >= 0) {
        existingVariants[idx] = merged;
        return existingVariants;
      }
      return [...existingVariants, merged];
    })();

    const patch: Record<string, unknown> = {
      variants: updatedVariants,
      updatedAt: new Date(),
    };
    if (body.variant === 'A') {
      const a = updatedVariants[0];
      patch.variantA = { label: 'A', photos: a.photos, title: a.title, description: a.description, characteristics: a.characteristics };
    }
    if (body.variant === 'B') {
      const b = updatedVariants.find((v) => v.label === 'B');
      if (b) patch.variantB = { label: 'B', photos: b.photos, title: b.title, description: b.description, characteristics: b.characteristics };
    }

    await db
      .update(abPhotoTests)
      .set(patch as any)
      .where(and(eq(abPhotoTests.testId, params.testId), eq(abPhotoTests.workspaceId, params.workspaceId)));

    return { ok: true, variant: body.variant, photos };
  });

  // ─────────────────────────────────────────────
  // Update variants in bulk (photos + content). The /photos endpoint above
  // is upload-id based and only touches photos. This one accepts the full
  // resolved variants[] payload so the UI can edit title/description without
  // re-uploading anything.
  // ─────────────────────────────────────────────
  app.put('/ab-photo/:workspaceId/:testId/variants', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive(), testId: z.coerce.number().int().positive() })
      .parse(req.params);

    const body = z
      .object({
        variants: z
          .array(z.object({
            label: z.enum(['A', 'B', 'C', 'D', 'E']),
            photos: z.array(z.string()).default([]),
            title: z.string().max(120).optional(),
            description: z.string().max(5000).optional(),
            characteristics: z
              .array(z.object({
                id: z.coerce.number().int().positive(),
                value: z.union([z.string(), z.array(z.string())]),
              }))
              .optional(),
          }))
          .min(2).max(5),
      })
      .parse((req as any).body ?? {});

    const [ownTest] = await db
      .select({ testId: abPhotoTests.testId })
      .from(abPhotoTests)
      .where(and(eq(abPhotoTests.testId, params.testId), eq(abPhotoTests.workspaceId, params.workspaceId)))
      .limit(1);
    if (!ownTest) return reply.code(404).send({ ok: false, error: 'test_not_found' });

    const normalized = body.variants.map((v) => normalizeVariant(v));
    const a = normalized.find((v) => v.label === 'A');
    const b = normalized.find((v) => v.label === 'B');

    await db
      .update(abPhotoTests)
      .set({
        variants: normalized,
        ...(a ? { variantA: a } : {}),
        ...(b ? { variantB: b } : {}),
        updatedAt: new Date(),
      } as any)
      .where(and(eq(abPhotoTests.testId, params.testId), eq(abPhotoTests.workspaceId, params.workspaceId)));

    return { ok: true, variants: normalized };
  });

  // ─────────────────────────────────────────────
  // Update rotation settings
  // ─────────────────────────────────────────────
  app.patch('/ab-photo/:workspaceId/:testId/settings', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        testId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const body = z
      .object({
        rotationMinutes: z.coerce.number().int().min(20).optional(),
        autoRotate: z.boolean().optional(),
        compareAdsSeparately: z.boolean().optional(),
        goal: z.enum(['orders', 'ctr', 'revenue']).optional(),
        name: z.string().trim().max(120).nullable().optional(),
      })
      .parse((req as any).body ?? {});

    const updates: any = { updatedAt: new Date() };
    if (body.rotationMinutes !== undefined) updates.rotationMinutes = body.rotationMinutes;
    if (body.autoRotate !== undefined) updates.autoRotate = body.autoRotate;
    if (body.compareAdsSeparately !== undefined) updates.compareAdsSeparately = body.compareAdsSeparately;
    if (body.goal !== undefined) updates.goal = body.goal;
    if (body.name !== undefined) updates.name = body.name === '' ? null : body.name;

    await db
      .update(abPhotoTests)
      .set(updates)
      .where(
        and(
          eq(abPhotoTests.testId, params.testId),
          eq(abPhotoTests.workspaceId, params.workspaceId)
        )
      );

    return { ok: true };
  });

  // ─────────────────────────────────────────────
  // Switch variant (manual rotation)
  // ─────────────────────────────────────────────
  app.post('/ab-photo/:workspaceId/:testId/switch', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive(), testId: z.coerce.number().int().positive() })
      .parse(req.params);
    const body = z.object({ variant: z.enum(['A', 'B', 'C', 'D', 'E']) }).parse((req as any).body ?? {});

    const [test] = await db
      .select({
        testId: abPhotoTests.testId,
        shopId: abPhotoTests.shopId,
        nmId: abPhotoTests.nmId,
        status: abPhotoTests.status,
        currentVariant: abPhotoTests.currentVariant,
        variantA: abPhotoTests.variantA,
        variantB: abPhotoTests.variantB,
        variants: abPhotoTests.variants,
      })
      .from(abPhotoTests)
      .where(and(eq(abPhotoTests.testId, params.testId), eq(abPhotoTests.workspaceId, params.workspaceId)))
      .limit(1);

    if (!test) return reply.code(404).send({ ok: false, error: 'not_found' });
    if (test.status !== 'running') return reply.code(409).send({ ok: false, error: 'not_running' });
    if (test.currentVariant === body.variant) {
      return { ok: true, note: 'already_on_variant', variant: body.variant };
    }

    // End current phase
    const [lastPhase] = await db
      .select({ phaseId: abPhotoPhases.phaseId, variant: abPhotoPhases.variant })
      .from(abPhotoPhases)
      .where(eq(abPhotoPhases.testId, params.testId))
      .orderBy(desc(abPhotoPhases.startedAt))
      .limit(1);

    if (lastPhase) {
      await db
        .update(abPhotoPhases)
        .set({ endedAt: new Date() })
        .where(eq(abPhotoPhases.phaseId, lastPhase.phaseId));
    }

    // IMPORTANT: Sync to WB FIRST, then update DB
    // This prevents DB/WB desync if WB API fails.
    // shop_id передаём обязательно — иначе WB-токен будет выбран наугад и
    // нам прилетит 403 «доступ к артикулу запрещён». 2026-05-31.
    if (isWbMediaSyncEnabled()) {
      const variants = resolveVariants(test);
      const target = variants.find((v) => v.label === body.variant);
      if (target) {
        try {
          const resolvedShopId = await resolveShopIdForCardR(params.workspaceId, test.nmId, test.shopId);
          if (target.photos.length) {
            const origPhotos = ((test as any).originalPhotos as string[] | null) ?? [];
            const slot = ((test as any).testPhotoSlot as number | null) ?? 0;
            if (origPhotos.length === 0) {
              throw new Error('Original photos snapshot missing — switch refused to avoid wiping other slots');
            }
            await updateWbCardSlot(params.workspaceId, test.nmId, slot, target.photos[0], origPhotos, resolvedShopId);
          }
          // Push title / description / characteristics if the variant overrides
          // any of them. Photo-only variants short-circuit inside the helper.
          await syncVariantContentToWb(params.workspaceId, test.nmId, target, resolvedShopId);
        } catch (wbErr: any) {
          logger.error({ err: wbErr }, 'WB API error during rotation');
          // Записываем ошибку в БД — UI покажет warning «WB ответил X, обнови токен».
          const msg = wbErr?.message ?? String(wbErr);
          await db
            .update(abPhotoTests)
            .set({ lastSyncError: msg.slice(0, 500), lastSyncErrorAt: new Date() } as any)
            .where(eq(abPhotoTests.testId, params.testId));
          throw new Error(`Failed to sync variant to WB. Rotation aborted. ${msg}`);
        }
      }
    }

    // WB succeeded, now update DB
    await db.insert(abPhotoPhases).values({
      testId: params.testId,
      variant: body.variant,
      startedAt: new Date(),
    });

    await db
      .update(abPhotoTests)
      .set({
        currentVariant: body.variant,
        lastRotatedAt: new Date(),
        updatedAt: new Date(),
        lastSyncError: null,
        lastSyncErrorAt: null,
      } as any)
      .where(eq(abPhotoTests.testId, params.testId));

    return { ok: true, variant: body.variant };
  });

  // ─────────────────────────────────────────────
  // Pause/Resume test
  // ─────────────────────────────────────────────
  app.post('/ab-photo/:workspaceId/:testId/pause', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive(), testId: z.coerce.number().int().positive() })
      .parse(req.params);

    await db
      .update(abPhotoTests)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(
        and(
          eq(abPhotoTests.testId, params.testId),
          eq(abPhotoTests.workspaceId, params.workspaceId)
        )
      );

    return { ok: true, status: 'paused' };
  });

  app.post('/ab-photo/:workspaceId/:testId/resume', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive(), testId: z.coerce.number().int().positive() })
      .parse(req.params);

    await db
      .update(abPhotoTests)
      .set({ status: 'running', updatedAt: new Date() })
      .where(
        and(
          eq(abPhotoTests.testId, params.testId),
          eq(abPhotoTests.workspaceId, params.workspaceId)
        )
      );

    return { ok: true, status: 'running' };
  });

  // ─────────────────────────────────────────────
  // Complete test and compute winner
  // ─────────────────────────────────────────────
  app.post('/ab-photo/:workspaceId/:testId/complete', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive(), testId: z.coerce.number().int().positive() })
      .parse(req.params);

    const [test] = await db
      .select({
        testId: abPhotoTests.testId,
        shopId: abPhotoTests.shopId,
        nmId: abPhotoTests.nmId,
        goal: abPhotoTests.goal,
        compareAdsSeparately: abPhotoTests.compareAdsSeparately,
        variantA: abPhotoTests.variantA,
        variantB: abPhotoTests.variantB,
        variants: abPhotoTests.variants,
      })
      .from(abPhotoTests)
      .where(and(eq(abPhotoTests.testId, params.testId), eq(abPhotoTests.workspaceId, params.workspaceId)))
      .limit(1);

    if (!test) return reply.code(404).send({ ok: false, error: 'not_found' });

    const phases = await db
      .select({ variant: abPhotoPhases.variant, startedAt: abPhotoPhases.startedAt, endedAt: abPhotoPhases.endedAt })
      .from(abPhotoPhases)
      .where(eq(abPhotoPhases.testId, params.testId));

    const variants = resolveVariants(test);
    const labels = variants.map((v) => v.label);
    const statsByVariant = await computeStatsByVariants(params.workspaceId, test.nmId, phases, labels);
    const winner = pickWinner(test.goal, statsByVariant);

    if (isWbMediaSyncEnabled()) {
      const resolvedShopId = await resolveShopIdForCardR(params.workspaceId, test.nmId, test.shopId);
      const origPhotos = ((test as any).originalPhotos as string[] | null) ?? [];
      const slot = ((test as any).testPhotoSlot as number | null) ?? 0;
      const origTitle = (test as any).originalTitle as string | null | undefined;
      const origDescription = (test as any).originalDescription as string | null | undefined;

      if (winner) {
        // Применяем победителя в WB.
        const winnerVariant = variants.find((v) => v.label === winner);
        if (winnerVariant) {
          if (winnerVariant.photos.length) {
            if (origPhotos.length === 0) {
              throw new Error('Original photos snapshot missing — winner apply refused to avoid wiping other slots');
            }
            await updateWbCardSlot(params.workspaceId, test.nmId, slot, winnerVariant.photos[0], origPhotos, resolvedShopId);
          }
          await syncVariantContentToWb(params.workspaceId, test.nmId, winnerVariant, resolvedShopId);
        }
      } else {
        // Победитель не определился (мало данных или ничья) — возвращаем оригинал.
        // Чтобы карточка не осталась с произвольно-последним вариантом, который
        // случайно стоял на момент стоп-команды.
        const apiKey = await getWbApiKey(params.workspaceId, resolvedShopId);
        if (origPhotos.length > 0) {
          // Замена testPhotoSlot на оригинальный URL (origPhotos[slot]).
          await updateWbCardSlot(params.workspaceId, test.nmId, slot, origPhotos[slot] ?? origPhotos[0], origPhotos, resolvedShopId);
        }
        // Возвращаем title/description если они были сохранены.
        const patch: { title?: string; description?: string } = {};
        if (origTitle != null) patch.title = origTitle;
        if (origDescription != null) patch.description = origDescription;
        if (Object.keys(patch).length > 0) {
          const { safeUpdateCard } = await import('../integrations/wb/content.js');
          await safeUpdateCard(apiKey, test.nmId, patch);
        }
      }
    }

    await db
      .update(abPhotoTests)
      .set({
        status: 'completed',
        winnerVariant: winner,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(abPhotoTests.testId, params.testId));

    return { ok: true, winner, stats: statsByVariant };
  });

  // ─────────────────────────────────────────────
  // Get test details + metrics
  // ─────────────────────────────────────────────
  app.get('/ab-photo/:workspaceId/:testId', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive(), testId: z.coerce.number().int().positive() })
      .parse(req.params);

    const [test] = await db
      .select()
      .from(abPhotoTests)
      .where(and(eq(abPhotoTests.testId, params.testId), eq(abPhotoTests.workspaceId, params.workspaceId)))
      .limit(1);

    if (!test) return reply.code(404).send({ ok: false, error: 'not_found' });

    const phases = await db
      .select()
      .from(abPhotoPhases)
      .where(eq(abPhotoPhases.testId, params.testId))
      .orderBy(asc(abPhotoPhases.startedAt));

    const variants = resolveVariants(test);
    const labels = variants.map((v) => v.label);
    const statsByVariant = await computeStatsByVariants(params.workspaceId, test.nmId, phases, labels);

    // Get uploaded photos
    const uploads = await db
      .select()
      .from(abPhotoUploads)
      .where(eq(abPhotoUploads.testId, params.testId))
      .orderBy(asc(abPhotoUploads.variant), asc(abPhotoUploads.position));

    // Calculate time until next rotation
    let nextRotationAt = null;
    if (test.status === 'running' && test.autoRotate && test.lastRotatedAt && test.rotationMinutes) {
      const lastRotated = new Date(test.lastRotatedAt).getTime();
      nextRotationAt = new Date(lastRotated + test.rotationMinutes * 60 * 1000);
    }

    // ─── Winner, forecast, significance for N variants ───
    // Winner per goal across all variants. Significance is winner-vs-best-loser
    // (pairwise z-test) — that's the meaningful comparison; comparing every
    // pair clutters the UI without adding insight.
    const winner = pickWinner(test.goal, statsByVariant);
    const testDays = (() => {
      if (phases.length === 0) return 0;
      const start = new Date(phases[0].startedAt).getTime();
      const last = phases[phases.length - 1];
      const end = new Date(last.endedAt ?? new Date()).getTime();
      return Math.max(1, Math.round((end - start) / 86400000));
    })();
    const forecast: Record<string, ReturnType<typeof forecastMonthly>> = {};
    for (const l of labels) forecast[l] = forecastMonthly(statsByVariant[l], testDays);

    // System winner (CTR) vs real winner (orders) — Sellium-style insight
    const systemWinnerCtr = pickWinner('ctr', statsByVariant);
    const realWinnerOrders = pickWinner('orders', statsByVariant);

    // Pairwise significance: winner vs each other variant on CR1 (orders/views)
    let significance: ReturnType<typeof twoPropZTest> | null = null;
    let pairwiseSignificance: Record<string, ReturnType<typeof twoPropZTest>> = {};
    if (winner) {
      const w = statsByVariant[winner];
      const losers = labels.filter((l) => l !== winner);
      // Best-of-rest comparison for the headline badge
      let bestLoser: string | null = null;
      let bestLoserScore = -1;
      for (const l of losers) {
        const s = statsByVariant[l];
        const cr = s.viewCount > 0 ? s.orderCount / s.viewCount : 0;
        if (cr > bestLoserScore) { bestLoserScore = cr; bestLoser = l; }
      }
      if (bestLoser) {
        const bl = statsByVariant[bestLoser];
        significance = twoPropZTest(w.orderCount, w.viewCount, bl.orderCount, bl.viewCount);
      }
      // Full pairwise for the variant table
      for (const l of losers) {
        const s = statsByVariant[l];
        pairwiseSignificance[l] = twoPropZTest(w.orderCount, w.viewCount, s.orderCount, s.viewCount);
      }
    }

    return {
      ok: true,
      test,
      testType: deriveTestType(variants),
      phases,
      stats: statsByVariant,
      variants,            // normalized [{label, photos, title, description, characteristics}, ...]
      winner,
      systemWinnerCtr,     // who wins by CTR
      realWinnerOrders,    // who wins by orders/conversion
      significance,        // winner vs best loser
      pairwiseSignificance,// winner vs each
      forecast,
      uploads,
      nextRotationAt,
      rotationPresets: ROTATION_PRESETS,
    };
  });

  // ─────────────────────────────────────────────
  // Get detailed metrics
  // ─────────────────────────────────────────────
  app.get('/ab-photo/:workspaceId/:testId/metrics', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive(), testId: z.coerce.number().int().positive() })
      .parse(req.params);

    const query = z
      .object({
        groupBy: z.enum(['day', 'hour']).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .parse(req.query);

    const conds: any[] = [eq(abPhotoMetrics.testId, params.testId)];
    if (query.from) conds.push(gte(abPhotoMetrics.date, query.from));
    if (query.to) conds.push(lte(abPhotoMetrics.date, query.to));

    const metrics = await db
      .select()
      .from(abPhotoMetrics)
      .where(and(...conds))
      .orderBy(asc(abPhotoMetrics.date), asc(abPhotoMetrics.hour));

    // Group by variant
    const byVariant = {
      A: metrics.filter((m) => m.variant === 'A'),
      B: metrics.filter((m) => m.variant === 'B'),
    };

    // Calculate totals
    type VariantTotals = {
      views: number;
      orders: number;
      ordersRub: number;
      adViews: number;
      adClicks: number;
      adOrders: number;
      adSpend: number;
      ctr: number;
      conversion: number;
      avgOrderValue: number;
    };

    const totals: Record<'A' | 'B', VariantTotals> = {
      A: {
        views: byVariant.A.reduce((sum, m) => sum + (m.views ?? 0), 0),
        orders: byVariant.A.reduce((sum, m) => sum + (m.orders ?? 0), 0),
        ordersRub: byVariant.A.reduce((sum, m) => sum + (m.ordersRub ?? 0), 0),
        adViews: byVariant.A.reduce((sum, m) => sum + (m.adViews ?? 0), 0),
        adClicks: byVariant.A.reduce((sum, m) => sum + (m.adClicks ?? 0), 0),
        adOrders: byVariant.A.reduce((sum, m) => sum + (m.adOrders ?? 0), 0),
        adSpend: byVariant.A.reduce((sum, m) => sum + (m.adSpend ?? 0), 0),
        ctr: 0,
        conversion: 0,
        avgOrderValue: 0,
      },
      B: {
        views: byVariant.B.reduce((sum, m) => sum + (m.views ?? 0), 0),
        orders: byVariant.B.reduce((sum, m) => sum + (m.orders ?? 0), 0),
        ordersRub: byVariant.B.reduce((sum, m) => sum + (m.ordersRub ?? 0), 0),
        adViews: byVariant.B.reduce((sum, m) => sum + (m.adViews ?? 0), 0),
        adClicks: byVariant.B.reduce((sum, m) => sum + (m.adClicks ?? 0), 0),
        adOrders: byVariant.B.reduce((sum, m) => sum + (m.adOrders ?? 0), 0),
        adSpend: byVariant.B.reduce((sum, m) => sum + (m.adSpend ?? 0), 0),
        ctr: 0,
        conversion: 0,
        avgOrderValue: 0,
      },
    };

    // Calculate CTR and conversion
    for (const v of ['A', 'B'] as const) {
      const t = totals[v];
      t.ctr = t.adViews > 0 ? (t.adClicks / t.adViews) * 100 : 0;
      t.conversion = t.views > 0 ? (t.orders / t.views) * 100 : 0;
      t.avgOrderValue = t.orders > 0 ? t.ordersRub / t.orders / 100 : 0;
    }

    // Calculate delta
    const delta = {
      orders: totals.A.orders > 0 ? ((totals.B.orders - totals.A.orders) / totals.A.orders) * 100 : 0,
      ordersRub: totals.A.ordersRub > 0 ? ((totals.B.ordersRub - totals.A.ordersRub) / totals.A.ordersRub) * 100 : 0,
      ctr: totals.A.ctr > 0 ? totals.B.ctr - totals.A.ctr : 0,
      conversion: totals.A.conversion > 0 ? totals.B.conversion - totals.A.conversion : 0,
    };

    return {
      ok: true,
      metrics: byVariant,
      totals,
      delta,
    };
  });

  // ─────────────────────────────────────────────
  // Per-day timeline of metrics for chart
  // Возвращает массив [{ date, perVariant: {A: {...}, B: {...}} }]
  // Заказы/выручка/просмотры/корзины делятся пропорционально доле времени
  // активности варианта в каждом дне (та же логика что и в /:testId).
  // ─────────────────────────────────────────────
  app.get('/ab-photo/:workspaceId/:testId/timeline', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive(), testId: z.coerce.number().int().positive() })
      .parse(req.params);
    const query = z
      .object({
        // ±N дней по краям. Дни ДО старта дают baseline (что было у товара до
        // эксперимента); дни ПОСЛЕ конца — продолжение/прогноз. Дефолт 7.
        pad: z.coerce.number().int().min(0).max(60).optional().default(7),
      })
      .parse(req.query);

    const [test] = await db
      .select()
      .from(abPhotoTests)
      .where(and(eq(abPhotoTests.testId, params.testId), eq(abPhotoTests.workspaceId, params.workspaceId)))
      .limit(1);
    if (!test) return { ok: false, error: 'not_found', timeline: [] };

    const phaseRows = await db
      .select({
        variant: abPhotoPhases.variant,
        startedAt: abPhotoPhases.startedAt,
        endedAt: abPhotoPhases.endedAt,
      })
      .from(abPhotoPhases)
      .where(eq(abPhotoPhases.testId, params.testId))
      .orderBy(asc(abPhotoPhases.startedAt));

    const labels = ALL_VARIANT_LABELS.filter((l) => phaseRows.some((p) => (p.variant ?? '').toUpperCase() === l));
    const timeline = await computeStatsByDay(test.workspaceId, test.nmId, phaseRows as any, labels.length ? labels : ['A', 'B']);

    // Определяем «День начала теста» и диапазон отображения.
    // start = первая фаза (если есть), иначе createdAt теста.
    // end   = max(последняя фаза, today)
    // Добавляем ±pad дней по краям и для дней вне фаз тянем baseline-числа
    // товара из funnel (что было у товара В ЭТОТ ДЕНЬ, до/после теста).
    const startMs = phaseRows.length > 0 ? new Date(phaseRows[0].startedAt).getTime() : test.createdAt.getTime();
    const lastPhaseEnd = phaseRows.length > 0
      ? Math.max(...phaseRows.map((p) => (p.endedAt ? new Date(p.endedAt).getTime() : Date.now())))
      : Date.now();
    const endMs = Math.max(lastPhaseEnd, Date.now());
    const dayMs = 24 * 60 * 60 * 1000;
    const rangeStart = new Date(startMs - query.pad * dayMs);
    const rangeEnd = new Date(endMs + query.pad * dayMs);

    function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
    const testStartIso = isoDate(new Date(startMs));

    // Запрашиваем baseline-данные товара за весь диапазон одним запросом —
    // это всё что у нас есть в funnel/orders_sales (без деления на варианты).
    const baselineRows = await db.execute(sql`
      SELECT f.date AS d,
             COALESCE(f.view_count, 0)::int AS views,
             COALESCE(f.add_to_cart_count, 0)::int AS cart,
             COALESCE(os.orders_count, 0)::int AS orders,
             COALESCE(os.orders_rub, 0)::bigint AS orders_rub_kop
      FROM wb_funnel_daily_products f
      FULL OUTER JOIN wb_orders_sales_daily_products os
        ON os.workspace_id = f.workspace_id AND os.nm_id = f.nm_id AND os.date = f.date
      WHERE COALESCE(f.workspace_id, os.workspace_id) = ${test.workspaceId}
        AND COALESCE(f.nm_id, os.nm_id) = ${test.nmId}
        AND COALESCE(f.date, os.date) BETWEEN ${isoDate(rangeStart)} AND ${isoDate(rangeEnd)}
    `);
    const baselineMap = new Map<string, { views: number; cart: number; orders: number; revenueRub: number }>();
    for (const r of (baselineRows.rows ?? []) as any[]) {
      const d = String(r.d);
      baselineMap.set(d, {
        views: Number(r.views ?? 0),
        cart: Number(r.cart ?? 0),
        orders: Number(r.orders ?? 0),
        revenueRub: Math.round(Number(r.orders_rub_kop ?? 0) / 100),
      });
    }

    // Собираем итоговый массив дней.
    const splitDateSet = new Set(timeline.map((r) => r.date));
    const splitByDate = new Map(timeline.map((r) => [r.date, r] as const));

    const rows: any[] = [];
    for (let cursor = new Date(rangeStart); cursor <= rangeEnd; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const d = isoDate(cursor);
      const out: Record<string, any> = { date: d };
      if (splitDateSet.has(d)) {
        const r = splitByDate.get(d)!;
        for (const [v, s] of Object.entries(r.perVariant)) {
          out[v] = {
            views: s.viewCount,
            openCard: s.openCardCount,
            cart: s.cartCount,
            orders: s.orderCount,
            revenueRub: Math.round((s.revenueKopecks ?? 0) / 100),
            adSpendRub: Math.round((s.adSpendKopecks ?? 0) / 100),
          };
        }
      } else {
        // Baseline — день вне периода теста. Числа товара как есть, без вариантов.
        const b = baselineMap.get(d);
        out.baseline = b ?? { views: 0, cart: 0, orders: 0, revenueRub: 0 };
      }
      rows.push(out);
    }

    return { ok: true, timeline: rows, variants: labels, testStart: testStartIso };
  });

  // ─────────────────────────────────────────────
  // Archive test (set archived_at = now)
  // ─────────────────────────────────────────────
  app.post('/ab-photo/:workspaceId/:testId/archive', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive(), testId: z.coerce.number().int().positive() })
      .parse(req.params);

    const res = await db
      .update(abPhotoTests)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(abPhotoTests.testId, params.testId), eq(abPhotoTests.workspaceId, params.workspaceId)))
      .returning({ testId: abPhotoTests.testId });

    if (res.length === 0) return reply.code(404).send({ ok: false, error: 'not_found' });
    return { ok: true };
  });

  // ─────────────────────────────────────────────
  // Unarchive test
  // ─────────────────────────────────────────────
  app.post('/ab-photo/:workspaceId/:testId/unarchive', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive(), testId: z.coerce.number().int().positive() })
      .parse(req.params);

    const res = await db
      .update(abPhotoTests)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(and(eq(abPhotoTests.testId, params.testId), eq(abPhotoTests.workspaceId, params.workspaceId)))
      .returning({ testId: abPhotoTests.testId });

    if (res.length === 0) return reply.code(404).send({ ok: false, error: 'not_found' });
    return { ok: true };
  });

  // ─────────────────────────────────────────────
  // Delete test (cascade phases/metrics/uploads via FK ON DELETE CASCADE)
  // ─────────────────────────────────────────────
  app.delete('/ab-photo/:workspaceId/:testId', { preHandler: requireRole('owner') }, async (req) => {
    const params = z
      .object({ workspaceId: z.coerce.number().int().positive(), testId: z.coerce.number().int().positive() })
      .parse(req.params);

    await db
      .delete(abPhotoTests)
      .where(
        and(
          eq(abPhotoTests.testId, params.testId),
          eq(abPhotoTests.workspaceId, params.workspaceId)
        )
      );

    return { ok: true };
  });
};
