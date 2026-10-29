import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ilike } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { wbCards } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';
import { buildShopFilter } from './pulse/helpers.js';

export const cardsRoutes: FastifyPluginAsync = async (app) => {
  /* ─── Distinct filter values (brands, vendorCodes, subjects) ─── */
  app.get('/cards/:workspaceId/distinct', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({ shopId: z.coerce.number().int().positive().optional() }).parse(req.query);
    const shopId = query.shopId;

    const conditions = [eq(wbCards.workspaceId, params.workspaceId)];
    const shopFilter = buildShopFilter(wbCards.shopId, shopId);
    if (shopFilter) conditions.push(shopFilter);

    const rows = await db
      .select({
        nmId: wbCards.nmId,
        brandName: wbCards.brandName,
        vendorCode: wbCards.vendorCode,
        subjectName: wbCards.subjectName,
      })
      .from(wbCards)
      .where(and(...conditions));

    const nmIds = new Set<number>();
    const brands = new Set<string>();
    const vendorCodes = new Set<string>();
    const subjects = new Set<string>();

    for (const r of rows) {
      if (r.nmId) nmIds.add(r.nmId);
      if (r.brandName) brands.add(r.brandName);
      if (r.vendorCode) vendorCodes.add(r.vendorCode);
      if (r.subjectName) subjects.add(r.subjectName);
    }

    return {
      nmIds: Array.from(nmIds).sort((a, b) => a - b),
      brands: Array.from(brands).sort(),
      vendorCodes: Array.from(vendorCodes).sort(),
      subjects: Array.from(subjects).sort(),
    };
  });

  app.get('/cards/:workspaceId/search', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        q: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);

    const q = (query.q ?? '').trim();
    const limit = query.limit ?? 20;
    const shopId = query.shopId;


    if (!q) return { workspaceId: params.workspaceId, q, rows: [] };

    const nmId = Number.parseInt(q, 10);
    const like = `%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;

    // Build search conditions
    const searchConditions = [
      ilike(wbCards.vendorCode, like),
      ilike(wbCards.title, like),
    ];

    // For numeric input, also search by nmId (exact match for full numbers, or cast to text for partial)
    if (Number.isFinite(nmId) && nmId > 0) {
      // If it looks like a complete nmId (8+ digits), do exact match
      if (q.length >= 8) {
        searchConditions.push(eq(wbCards.nmId, nmId as any));
      }
      // Also search nmId as text for partial matches
      searchConditions.push(sql`CAST(${wbCards.nmId} AS TEXT) LIKE ${like}`);
    }

    const conditions = [
      eq(wbCards.workspaceId, params.workspaceId),
      or(...searchConditions)
    ];
    const shopFilter = buildShopFilter(wbCards.shopId, shopId);
    if (shopFilter) conditions.push(shopFilter);

    const rows = await db
      .select({ nmId: wbCards.nmId, vendorCode: wbCards.vendorCode, title: wbCards.title, mainPhotoUrl: wbCards.mainPhotoUrl })
      .from(wbCards)
      .where(and(...conditions))
      .limit(limit);

    return { workspaceId: params.workspaceId, q, rows };
  });

  // -----------------------------------------------------------------------
  // Card details (for Creative/SEO)
  // -----------------------------------------------------------------------
  app.get('/cards/:workspaceId/:nmId', { preHandler: requireRole('viewer') },async (req, reply) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        nmId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    const query = z.object({ shopId: z.coerce.number().int().positive().optional() }).parse(req.query);
    const shopId = query.shopId;

    const conditions = [
      eq(wbCards.workspaceId, params.workspaceId),
      eq(wbCards.nmId, params.nmId)
    ];
    const shopFilter = buildShopFilter(wbCards.shopId, shopId);
    if (shopFilter) conditions.push(shopFilter);

    const [row] = await db
      .select({
        nmId: wbCards.nmId,
        vendorCode: wbCards.vendorCode,
        title: wbCards.title,
        brandName: wbCards.brandName,
        subjectName: wbCards.subjectName,
        mainPhotoUrl: wbCards.mainPhotoUrl,
        photos: wbCards.photos,
        raw: wbCards.raw,
      })
      .from(wbCards)
      .where(and(...conditions))
      .limit(1);

    if (!row) return reply.code(404).send({ ok: false, error: 'not_found' });

    const photos = Array.isArray(row.photos) ? row.photos : [];
    const photoUrls = photos
      .map((p: any) => p?.big || p?.c516x688 || p?.c246x328 || p?.tm)
      .filter((u: any) => typeof u === 'string');

    const raw: any = row.raw || {};
    const description = raw.description || raw.cardDescription || null;
    const characteristics = raw.characteristics || raw.options || [];

    return {
      ok: true,
      card: {
        nmId: row.nmId,
        vendorCode: row.vendorCode,
        title: row.title,
        brandName: row.brandName,
        subjectName: row.subjectName,
        mainPhotoUrl: row.mainPhotoUrl,
        photoUrls,
        description,
        characteristics,
        raw,
      },
    };
  });
};
