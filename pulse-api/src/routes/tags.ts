import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
// Note: isNull is already imported
import { z } from 'zod';
import { db } from '../db/client.js';
import { wbCards, wbTagProducts, wbTags } from '../db/schema.js';
import { requireRole } from '../plugins/roleCheck.js';
import { buildShopFilter } from './pulse/helpers.js';

export const tagsRoutes: FastifyPluginAsync = async (app) => {
  // list tags
  app.get('/tags/:workspaceId', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({
      shopId: z.coerce.number().int().positive().optional(),
    }).parse(req.query);

    const conditions: any[] = [eq(wbTags.workspaceId, params.workspaceId)];
    if (query.shopId) {
      // Include both shop-specific AND global (shopId=null) tags
      conditions.push(or(eq(wbTags.shopId, query.shopId), isNull(wbTags.shopId)));
    }

    const rows = await db
      .select({ tagId: wbTags.tagId, shopId: wbTags.shopId, name: wbTags.name, color: wbTags.color, createdAt: wbTags.createdAt })
      .from(wbTags)
      .where(and(...conditions))
      .orderBy(asc(wbTags.name));

    return { workspaceId: params.workspaceId, shopId: query.shopId ?? null, rows };
  });

  // create tag
  app.post('/tags/:workspaceId', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(64),
        color: z.string().max(32).optional(),
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse((req as any).body ?? {});

    const name = body.name.trim();
    const color = body.color?.trim() || null;
    const shopId = body.shopId ?? null;

    // Check for duplicate name within workspace + shop
    const dupConditions: any[] = [eq(wbTags.workspaceId, params.workspaceId), eq(wbTags.name, name)];
    if (shopId) {
      dupConditions.push(eq(wbTags.shopId, shopId));
    } else {
      dupConditions.push(isNull(wbTags.shopId));
    }
    const existing = await db
      .select({ tagId: wbTags.tagId })
      .from(wbTags)
      .where(and(...dupConditions))
      .limit(1);
    if (existing.length > 0) {
      const reply = (req as any).server?.httpErrors?.createError?.(409, 'Имя уже занято, выберите другое');
      if (reply) throw reply;
      throw Object.assign(new Error('Имя уже занято, выберите другое'), { statusCode: 409 });
    }

    const row = await db
      .insert(wbTags)
      .values({ workspaceId: params.workspaceId, shopId, name, color, updatedAt: new Date() })
      .returning({ tagId: wbTags.tagId, shopId: wbTags.shopId, name: wbTags.name, color: wbTags.color });

    return { ok: true, tag: row[0] };
  });

  // delete tag
  app.delete('/tags/:workspaceId/:tagId', { preHandler: requireRole('owner') },async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        tagId: z.coerce.number().int().positive(),
      })
      .parse(req.params);


    await db.delete(wbTags).where(and(eq(wbTags.workspaceId, params.workspaceId), eq(wbTags.tagId, params.tagId)));

    return { ok: true };
  });

  // set tags for a product: replace its tag set
  app.post('/tags/:workspaceId/products/:nmId/set', { preHandler: requireRole('manager') },async (req, reply) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        nmId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const body = z
      .object({
        tagIds: z.array(z.coerce.number().int().positive()),
      })
      .parse((req as any).body ?? {});

    const tagIds = Array.from(new Set(body.tagIds));

    // Validate that all tagIds belong to this workspace
    if (tagIds.length > 0) {
      const validTags = await db
        .select({ tagId: wbTags.tagId })
        .from(wbTags)
        .where(and(eq(wbTags.workspaceId, params.workspaceId), inArray(wbTags.tagId, tagIds)));
      const validIds = new Set(validTags.map((t) => t.tagId));
      const invalidIds = tagIds.filter((id) => !validIds.has(id));
      if (invalidIds.length > 0) {
        return reply.code(400).send({ ok: false, error: 'invalid_tag_ids', invalidIds });
      }
    }

    // remove existing
    await db
      .delete(wbTagProducts)
      .where(and(eq(wbTagProducts.workspaceId, params.workspaceId), eq(wbTagProducts.nmId, params.nmId)));

    // insert new (batch)
    if (tagIds.length > 0) {
      await db
        .insert(wbTagProducts)
        .values(tagIds.map((tagId) => ({ workspaceId: params.workspaceId, nmId: params.nmId, tagId })))
        .onConflictDoNothing();
    }

    return { ok: true };
  });

  // Get tags for products
  app.get('/tags/:workspaceId/products', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        nmIds: z.string(),
        // shopId — ограничивает результат только nmId'ами из этого магазина.
        shopId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);

    let nmIds = query.nmIds
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);

    // Если задан shopId — фильтруем входной список nmId'ов через wb_cards
    // чтобы не отдавать теги для чужих карточек.
    if (query.shopId && nmIds.length) {
      const owned = await db
        .select({ nmId: wbCards.nmId })
        .from(wbCards)
        .where(and(
          eq(wbCards.workspaceId, params.workspaceId),
          eq(wbCards.shopId, query.shopId),
          inArray(wbCards.nmId, nmIds as any),
        ));
      const ownedSet = new Set(owned.map((r) => Number(r.nmId)));
      nmIds = nmIds.filter((n) => ownedSet.has(n));
    }

    const links = await db
      .select({ nmId: wbTagProducts.nmId, tagId: wbTagProducts.tagId })
      .from(wbTagProducts)
      .where(and(eq(wbTagProducts.workspaceId, params.workspaceId), inArray(wbTagProducts.nmId, nmIds as any)));

    const tags = await db
      .select({ tagId: wbTags.tagId, name: wbTags.name, color: wbTags.color })
      .from(wbTags)
      .where(eq(wbTags.workspaceId, params.workspaceId));
    const tagBy = new Map(tags.map((t) => [t.tagId, t] as const));

    const byNm: Record<string, Array<{ tagId: number; name: string; color: string | null }>> = {};
    for (const l of links) {
      const t = tagBy.get(l.tagId);
      if (!t) continue;
      const k = String(l.nmId);
      byNm[k] = byNm[k] ?? [];
      byNm[k].push({ tagId: t.tagId, name: t.name, color: t.color ?? null });
    }

    return { workspaceId: params.workspaceId, byNmId: byNm };
  });

  // Search products with tags (cards + tags)
  app.get('/tags/:workspaceId/products/search', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        q: z.string().optional(),
        tagId: z.coerce.number().int().positive().optional(),
        noTags: z.enum(['1', 'true']).optional(),
        brandName: z.string().optional(),
        subjectName: z.string().optional(),
        // shopId — без него /tags показывал товары всех магазинов вперемешку
        // (главная жалоба юзера). buildShopFilter применяется к wbCards.shopId.
        shopId: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);

    const q = (query.q ?? '').trim();
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;


    // Build conditions array
    const conditions: any[] = [eq(wbCards.workspaceId, params.workspaceId)];
    const shopFilter = buildShopFilter(wbCards.shopId, query.shopId);
    if (shopFilter) conditions.push(shopFilter);

    // Text search
    if (q) {
      const nmId = Number.parseInt(q, 10);
      const like = `%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
      if (Number.isFinite(nmId) && nmId > 0) {
        conditions.push(or(eq(wbCards.nmId, nmId as any), ilike(wbCards.vendorCode, like), ilike(wbCards.title, like)));
      } else {
        conditions.push(or(ilike(wbCards.vendorCode, like), ilike(wbCards.title, like)));
      }
    }

    // Brand filter
    if (query.brandName) {
      const brandLike = `%${query.brandName.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
      conditions.push(ilike(wbCards.brandName, brandLike));
    }

    // Subject (category) filter
    if (query.subjectName) {
      const subjLike = `%${query.subjectName.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
      conditions.push(ilike(wbCards.subjectName, subjLike));
    }

    // Tag filter: only products with this tag
    if (query.tagId) {
      const taggedNmIds = await db
        .select({ nmId: wbTagProducts.nmId })
        .from(wbTagProducts)
        .where(and(eq(wbTagProducts.workspaceId, params.workspaceId), eq(wbTagProducts.tagId, query.tagId)));
      const ids = taggedNmIds.map((r) => r.nmId);
      if (ids.length === 0) return { workspaceId: params.workspaceId, q, rows: [], total: 0 };
      conditions.push(inArray(wbCards.nmId, ids as any));
    }

    // No tags filter
    if (query.noTags === '1' || query.noTags === 'true') {
      const allTaggedNmIds = await db
        .select({ nmId: wbTagProducts.nmId })
        .from(wbTagProducts)
        .where(eq(wbTagProducts.workspaceId, params.workspaceId));
      const taggedIds = [...new Set(allTaggedNmIds.map((r) => r.nmId))];
      if (taggedIds.length > 0) {
        conditions.push(notInArray(wbCards.nmId, taggedIds as any));
      }
    }

    // If no search text and no filters specified (just workspace), require at least one filter or allow "load all"
    const where = and(...conditions);

    // Count total
    const countRes = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wbCards)
      .where(where);
    const total = countRes[0]?.count ?? 0;

    const cards = await db
      .select({ nmId: wbCards.nmId, vendorCode: wbCards.vendorCode, title: wbCards.title, brandName: wbCards.brandName, subjectName: wbCards.subjectName })
      .from(wbCards)
      .where(where)
      .limit(limit)
      .offset(offset);

    const nmIds = cards.map((c) => c.nmId);
    if (nmIds.length === 0) return { workspaceId: params.workspaceId, q, rows: [], total };

    const links = await db
      .select({ nmId: wbTagProducts.nmId, tagId: wbTagProducts.tagId })
      .from(wbTagProducts)
      .where(and(eq(wbTagProducts.workspaceId, params.workspaceId), inArray(wbTagProducts.nmId, nmIds as any)));

    const tags = await db
      .select({ tagId: wbTags.tagId, name: wbTags.name, color: wbTags.color })
      .from(wbTags)
      .where(eq(wbTags.workspaceId, params.workspaceId));
    const tagBy = new Map(tags.map((t) => [t.tagId, t] as const));

    const tagsByNm = new Map<number, Array<{ tagId: number; name: string; color: string | null }>>();
    for (const l of links) {
      const t = tagBy.get(l.tagId);
      if (!t) continue;
      const cur = tagsByNm.get(l.nmId) ?? [];
      cur.push({ tagId: t.tagId, name: t.name, color: t.color ?? null });
      tagsByNm.set(l.nmId, cur);
    }

    return {
      workspaceId: params.workspaceId,
      q,
      total,
      rows: cards.map((c) => ({ ...c, tags: tagsByNm.get(c.nmId) ?? [] })),
    };
  });
};
