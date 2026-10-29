import type { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { marketplaceShops } from '../db/schema.js';
import { safeDecrypt } from '../lib/crypto.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { requireRole } from '../plugins/roleCheck.js';
import {
  getNewOrders,
  getOrders,
  getOrderStickers,
  getOrderStatuses,
  confirmOrder,
  cancelOrder,
  createSupply,
  addOrderToSupply,
  getSupplyOrders,
  closeSupply,
  getSupplyBarcode,
  getSupplyBoxes,
  createSupplyBoxes,
  addOrdersToBox,
  removeOrderFromBox,
  deleteSupplyBox,
  getBoxStickers,
  type StickerType,
} from '../integrations/wb/marketplace/client.js';
import {
  getOrdersMeta,
  setSgtin,
  setImei,
  setUin,
  setGtin,
  setExpiration,
  setCustomsDeclaration,
  deleteMeta,
  validateSgtin,
  validateImei,
  validateExpiration,
  validateGtin,
  getFilledMetaKeys,
  type MetaKey,
} from '../integrations/wb/fbsMeta.js';
import {
  getPasses,
  createPass,
  updatePass,
  deletePass,
  validatePassData,
} from '../integrations/wb/passes.js';

// ---------------------------------------------------------------------------
// FBS Orders Routes (WB Marketplace API)
// ---------------------------------------------------------------------------

export const fbsOrdersRoutes: FastifyPluginAsync = async (app) => {
  // -------------------------------------------------------------------------
  // Get new orders (WB only for now)
  // -------------------------------------------------------------------------
  app.get('/fbs/:workspaceId/orders/new', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({ shopId: z.coerce.number().int().optional() }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);

    const { orders } = await getNewOrders(apiKey);
    return { ok: true, orders };
  });

  // -------------------------------------------------------------------------
  // Get orders with pagination
  // -------------------------------------------------------------------------
  app.get('/fbs/:workspaceId/orders', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z
      .object({
        shopId: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(100),
        next: z.coerce.number().int().default(0),
        dateFrom: z.coerce.number().int().optional(),
        dateTo: z.coerce.number().int().optional(),
      })
      .parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);

    const result = await getOrders(apiKey, query.limit, query.next, query.dateFrom, query.dateTo);
    return { ok: true, ...result };
  });

  // -------------------------------------------------------------------------
  // Get stickers for orders (supports ZPL for thermal printers)
  // -------------------------------------------------------------------------
  app.post('/fbs/:workspaceId/orders/stickers', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        shopId: z.coerce.number().int().optional(),
        orderIds: z.array(z.coerce.number().int()).min(1).max(100),
        type: z.enum(['png', 'svg', 'zplv', 'zplh', 'pdf']).default('png'),
        width: z.coerce.number().int().refine((v) => v === 40 || v === 58).default(58),
        height: z.coerce.number().int().refine((v) => v === 40 || v === 30).default(40),
      })
      .parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);

    const result = await getOrderStickers(apiKey, body.orderIds, {
      type: body.type as StickerType,
      width: body.width as 40 | 58,
      height: body.height as 40 | 30,
    });
    return { ok: true, ...result };
  });

  // -------------------------------------------------------------------------
  // Get batch order statuses
  // -------------------------------------------------------------------------
  app.post('/fbs/:workspaceId/orders/statuses', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        shopId: z.coerce.number().int().optional(),
        orderIds: z.array(z.coerce.number().int()).min(1).max(1000),
      })
      .parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    const result = await getOrderStatuses(apiKey, body.orderIds);
    return { ok: true, ...result };
  });

  // -------------------------------------------------------------------------
  // Confirm order (mark as assembled)
  // -------------------------------------------------------------------------
  app.post('/fbs/:workspaceId/orders/:orderId/confirm', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        orderId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    const body = z.object({ shopId: z.coerce.number().int().optional() }).parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);

    await confirmOrder(apiKey, params.orderId);
    return { ok: true, orderId: params.orderId, status: 'confirmed' };
  });

  // -------------------------------------------------------------------------
  // Cancel order
  // -------------------------------------------------------------------------
  app.post('/fbs/:workspaceId/orders/:orderId/cancel', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        orderId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    const body = z.object({ shopId: z.coerce.number().int().optional() }).parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);

    await cancelOrder(apiKey, params.orderId);
    return { ok: true, orderId: params.orderId, status: 'cancelled' };
  });

  // -------------------------------------------------------------------------
  // Create supply
  // -------------------------------------------------------------------------
  app.post('/fbs/:workspaceId/supplies', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        shopId: z.coerce.number().int().optional(),
        name: z.string().optional(),
      })
      .parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);

    const result = await createSupply(apiKey, body.name);
    return { ok: true, supply: result };
  });

  // -------------------------------------------------------------------------
  // Add order to supply
  // -------------------------------------------------------------------------
  app.post('/fbs/:workspaceId/supplies/:supplyId/orders/:orderId', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        supplyId: z.string().min(1),
        orderId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    const body = z.object({ shopId: z.coerce.number().int().optional() }).parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);

    await addOrderToSupply(apiKey, params.supplyId, params.orderId);
    return { ok: true, supplyId: params.supplyId, orderId: params.orderId };
  });

  // -------------------------------------------------------------------------
  // Get orders in supply
  // -------------------------------------------------------------------------
  app.get('/fbs/:workspaceId/supplies/:supplyId/orders', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        supplyId: z.string().min(1),
      })
      .parse(req.params);
    const query = z.object({ shopId: z.coerce.number().int().optional() }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);

    const result = await getSupplyOrders(apiKey, params.supplyId);
    return { ok: true, supplyId: params.supplyId, ...result };
  });

  // -------------------------------------------------------------------------
  // Close supply (send for delivery)
  // -------------------------------------------------------------------------
  app.post('/fbs/:workspaceId/supplies/:supplyId/close', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        supplyId: z.string().min(1),
      })
      .parse(req.params);
    const body = z.object({ shopId: z.coerce.number().int().optional() }).parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);

    await closeSupply(apiKey, params.supplyId);
    return { ok: true, supplyId: params.supplyId, status: 'closed' };
  });

  // -------------------------------------------------------------------------
  // Get supply barcode
  // -------------------------------------------------------------------------
  app.get('/fbs/:workspaceId/supplies/:supplyId/barcode', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        supplyId: z.string().min(1),
      })
      .parse(req.params);
    const query = z
      .object({
        shopId: z.coerce.number().int().optional(),
        type: z.enum(['png', 'svg', 'pdf']).default('pdf'),
      })
      .parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);

    const result = await getSupplyBarcode(apiKey, params.supplyId, query.type);
    return { ok: true, supplyId: params.supplyId, ...result };
  });
  // =========================================================================
  // SUPPLY BOXES (Короба)
  // =========================================================================

  // -------------------------------------------------------------------------
  // Get boxes in supply
  // -------------------------------------------------------------------------
  app.get('/fbs/:workspaceId/supplies/:supplyId/trbx', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      supplyId: z.string().min(1),
    }).parse(req.params);
    const query = z.object({ shopId: z.coerce.number().int().optional() }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    const result = await getSupplyBoxes(apiKey, params.supplyId);
    return { ok: true, supplyId: params.supplyId, ...result };
  });

  // -------------------------------------------------------------------------
  // Create boxes in supply
  // -------------------------------------------------------------------------
  app.post('/fbs/:workspaceId/supplies/:supplyId/trbx', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      supplyId: z.string().min(1),
    }).parse(req.params);
    const body = z.object({
      shopId: z.coerce.number().int().optional(),
      quantity: z.coerce.number().int().min(1).max(100),
    }).parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    const result = await createSupplyBoxes(apiKey, params.supplyId, body.quantity);
    return { ok: true, supplyId: params.supplyId, ...result };
  });

  // -------------------------------------------------------------------------
  // Add orders to box
  // -------------------------------------------------------------------------
  app.patch('/fbs/:workspaceId/supplies/:supplyId/trbx/:trbxId', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      supplyId: z.string().min(1),
      trbxId: z.string().min(1),
    }).parse(req.params);
    const body = z.object({
      shopId: z.coerce.number().int().optional(),
      orderIds: z.array(z.coerce.number().int()).min(1),
    }).parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    await addOrdersToBox(apiKey, params.supplyId, params.trbxId, body.orderIds);
    return { ok: true, supplyId: params.supplyId, trbxId: params.trbxId, orderIds: body.orderIds };
  });

  // -------------------------------------------------------------------------
  // Remove order from box
  // -------------------------------------------------------------------------
  app.delete('/fbs/:workspaceId/supplies/:supplyId/trbx/:trbxId/orders/:orderId', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      supplyId: z.string().min(1),
      trbxId: z.string().min(1),
      orderId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const query = z.object({ shopId: z.coerce.number().int().optional() }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    await removeOrderFromBox(apiKey, params.supplyId, params.trbxId, params.orderId);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Delete empty box
  // -------------------------------------------------------------------------
  app.delete('/fbs/:workspaceId/supplies/:supplyId/trbx/:trbxId', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      supplyId: z.string().min(1),
      trbxId: z.string().min(1),
    }).parse(req.params);
    const query = z.object({ shopId: z.coerce.number().int().optional() }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    await deleteSupplyBox(apiKey, params.supplyId, params.trbxId);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Get box stickers
  // -------------------------------------------------------------------------
  app.post('/fbs/:workspaceId/supplies/:supplyId/trbx/stickers', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      supplyId: z.string().min(1),
    }).parse(req.params);
    const body = z.object({
      shopId: z.coerce.number().int().optional(),
      trbxIds: z.array(z.string().min(1)).min(1),
      type: z.enum(['png', 'svg', 'zplv', 'zplh', 'pdf']).default('png'),
    }).parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    const result = await getBoxStickers(apiKey, params.supplyId, body.trbxIds, body.type as StickerType);
    return { ok: true, ...result };
  });

  // =========================================================================
  // MARKING / META ROUTES
  // =========================================================================

  // -------------------------------------------------------------------------
  // Get orders meta (batch)
  // -------------------------------------------------------------------------
  app.post('/fbs/:workspaceId/orders/meta', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        shopId: z.coerce.number().int().optional(),
        orderIds: z.array(z.coerce.number().int()).min(1).max(100),
      })
      .parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    const result = await getOrdersMeta(apiKey, body.orderIds);
    return { ok: true, ...result };
  });

  // -------------------------------------------------------------------------
  // Set SGTIN (Честный знак)
  // -------------------------------------------------------------------------
  app.put('/fbs/:workspaceId/orders/:orderId/sgtin', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        orderId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    const body = z
      .object({
        shopId: z.coerce.number().int().optional(),
        sgtins: z.array(z.string().min(20).max(150)).min(1).max(24),
      })
      .parse((req as any).body ?? {});

    // Validate all SGTINs
    const invalidSgtins = body.sgtins.filter(s => !validateSgtin(s));
    if (invalidSgtins.length > 0) {
      throw new BadRequestError(`Invalid SGTIN format: ${invalidSgtins.slice(0, 3).join(', ')}${invalidSgtins.length > 3 ? '...' : ''}`);
    }

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    await setSgtin(apiKey, params.orderId, body.sgtins);
    return { ok: true, orderId: params.orderId, sgtins: body.sgtins };
  });

  // -------------------------------------------------------------------------
  // Set IMEI
  // -------------------------------------------------------------------------
  app.put('/fbs/:workspaceId/orders/:orderId/imei', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        orderId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    const body = z
      .object({
        shopId: z.coerce.number().int().optional(),
        imei: z.string().length(15),
      })
      .parse((req as any).body ?? {});

    if (!validateImei(body.imei)) {
      throw new BadRequestError('Invalid IMEI (must be 15 digits with valid Luhn checksum)');
    }

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    await setImei(apiKey, params.orderId, body.imei);
    return { ok: true, orderId: params.orderId, imei: body.imei };
  });

  // -------------------------------------------------------------------------
  // Set УИН
  // -------------------------------------------------------------------------
  app.put('/fbs/:workspaceId/orders/:orderId/uin', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        orderId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    const body = z
      .object({
        shopId: z.coerce.number().int().optional(),
        uin: z.string().min(1).max(100),
      })
      .parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    await setUin(apiKey, params.orderId, body.uin);
    return { ok: true, orderId: params.orderId, uin: body.uin };
  });

  // -------------------------------------------------------------------------
  // Set GTIN (Беларусь)
  // -------------------------------------------------------------------------
  app.put('/fbs/:workspaceId/orders/:orderId/gtin', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        orderId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    const body = z
      .object({
        shopId: z.coerce.number().int().optional(),
        gtin: z.string().min(8).max(14),
      })
      .parse((req as any).body ?? {});

    if (!validateGtin(body.gtin)) {
      throw new BadRequestError('Invalid GTIN (must be 8, 12, 13, or 14 digits)');
    }

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    await setGtin(apiKey, params.orderId, body.gtin);
    return { ok: true, orderId: params.orderId, gtin: body.gtin };
  });

  // -------------------------------------------------------------------------
  // Set Expiration (срок годности)
  // -------------------------------------------------------------------------
  app.put('/fbs/:workspaceId/orders/:orderId/expiration', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        orderId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    const body = z
      .object({
        shopId: z.coerce.number().int().optional(),
        expiration: z.string().regex(/^\d{2}\.\d{2}\.\d{4}$/, 'Format: DD.MM.YYYY'),
      })
      .parse((req as any).body ?? {});

    if (!validateExpiration(body.expiration)) {
      throw new BadRequestError('Invalid expiration date (must be DD.MM.YYYY and in the future)');
    }

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    await setExpiration(apiKey, params.orderId, body.expiration);
    return { ok: true, orderId: params.orderId, expiration: body.expiration };
  });

  // -------------------------------------------------------------------------
  // Set Customs Declaration (ГТД)
  // -------------------------------------------------------------------------
  app.put('/fbs/:workspaceId/orders/:orderId/customs-declaration', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        orderId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    const body = z
      .object({
        shopId: z.coerce.number().int().optional(),
        customsDeclaration: z.string().min(1).max(100),
      })
      .parse((req as any).body ?? {});

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', body.shopId);
    await setCustomsDeclaration(apiKey, params.orderId, body.customsDeclaration);
    return { ok: true, orderId: params.orderId, customsDeclaration: body.customsDeclaration };
  });

  // -------------------------------------------------------------------------
  // Delete meta
  // -------------------------------------------------------------------------
  app.delete('/fbs/:workspaceId/orders/:orderId/meta', { preHandler: requireRole('manager') }, async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        orderId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    const query = z
      .object({
        shopId: z.coerce.number().int().optional(),
        key: z.enum(['imei', 'uin', 'gtin', 'sgtin', 'customsDeclaration']),
      })
      .parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    await deleteMeta(apiKey, params.orderId, query.key);
    return { ok: true, orderId: params.orderId, deletedKey: query.key };
  });

  // -------------------------------------------------------------------------
  // Validate supply meta (check all orders have required marking)
  // -------------------------------------------------------------------------
  app.get('/fbs/:workspaceId/supplies/:supplyId/validate-meta', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      supplyId: z.string().min(1),
    }).parse(req.params);
    const query = z.object({ shopId: z.coerce.number().int().optional() }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);

    // Get orders in supply
    const { orders } = await getSupplyOrders(apiKey, params.supplyId);
    
    if (!orders?.length) {
      return { ok: true, valid: true, missingMeta: [] };
    }

    // Filter orders that require meta
    const ordersWithRequiredMeta = orders.filter((o: any) => o.requiredMeta?.length > 0);
    
    if (ordersWithRequiredMeta.length === 0) {
      return { ok: true, valid: true, missingMeta: [] };
    }

    // Get current meta for those orders
    const orderIds = ordersWithRequiredMeta.map((o: any) => o.id);
    const { orders: metaOrders } = await getOrdersMeta(apiKey, orderIds);
    const metaMap = new Map(metaOrders.map((m) => [m.id, m.meta]));

    // Check each order
    const missingMeta: Array<{ orderId: number; missing: string[] }> = [];

    for (const order of ordersWithRequiredMeta) {
      const meta = metaMap.get(order.id);
      const filled = meta ? getFilledMetaKeys(meta) : [];
      const missing = (order.requiredMeta as string[]).filter((r: string) => !filled.includes(r as MetaKey));

      if (missing.length > 0) {
        missingMeta.push({ orderId: order.id, missing });
      }
    }

    return {
      ok: true,
      valid: missingMeta.length === 0,
      missingMeta,
      totalOrders: orders.length,
      ordersRequiringMeta: ordersWithRequiredMeta.length,
    };
  });

  // =========================================================================
  // PASSES (Пропуска на склады)
  // =========================================================================

  // -------------------------------------------------------------------------
  // Get passes
  // -------------------------------------------------------------------------
  app.get('/fbs/:workspaceId/passes', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({ shopId: z.coerce.number().int().optional() }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    const passes = await getPasses(apiKey);
    return { ok: true, passes };
  });

  // -------------------------------------------------------------------------
  // Create pass (⚠️ 1 request per 10 minutes!)
  // -------------------------------------------------------------------------
  app.post('/fbs/:workspaceId/passes', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      shopId: z.coerce.number().int().optional(),
      firstName: z.string().min(2).max(50),
      lastName: z.string().min(2).max(50),
      carModel: z.string().min(1).max(100),
      carNumber: z.string().min(1).max(20),
      officeId: z.coerce.number().int().positive(),
    }).parse((req as any).body ?? {});

    const { shopId, ...passData } = body;
    
    // Validate
    const validation = validatePassData(passData);
    if (!validation.valid) {
      throw new BadRequestError(validation.error || 'Invalid pass data');
    }

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', shopId);
    const result = await createPass(apiKey, passData);
    return { ok: true, ...result };
  });

  // -------------------------------------------------------------------------
  // Update pass
  // -------------------------------------------------------------------------
  app.put('/fbs/:workspaceId/passes/:passId', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      passId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const body = z.object({
      shopId: z.coerce.number().int().optional(),
      firstName: z.string().min(2).max(50),
      lastName: z.string().min(2).max(50),
      carModel: z.string().min(1).max(100),
      carNumber: z.string().min(1).max(20),
      officeId: z.coerce.number().int().positive(),
    }).parse((req as any).body ?? {});

    const { shopId, ...passData } = body;
    
    const validation = validatePassData(passData);
    if (!validation.valid) {
      throw new BadRequestError(validation.error || 'Invalid pass data');
    }

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', shopId);
    await updatePass(apiKey, params.passId, passData);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Delete pass
  // -------------------------------------------------------------------------
  app.delete('/fbs/:workspaceId/passes/:passId', { preHandler: requireRole('manager') }, async (req) => {
    const params = z.object({
      workspaceId: z.coerce.number().int().positive(),
      passId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const query = z.object({ shopId: z.coerce.number().int().optional() }).parse(req.query);

    const apiKey = await getShopApiKey(params.workspaceId, 'wb', query.shopId);
    await deletePass(apiKey, params.passId);
    return { ok: true };
  });
};

// ---------------------------------------------------------------------------
// Helper: Get API key for shop
// ---------------------------------------------------------------------------

async function getShopApiKey(
  workspaceId: number,
  platform: 'wb' | 'ozon' | 'yandex_market',
  shopId?: number,
): Promise<string> {
  const where = [
    eq(marketplaceShops.workspaceId, workspaceId),
    eq(marketplaceShops.platform, platform),
    eq(marketplaceShops.isActive, true),
  ];

  if (shopId) {
    where.push(eq(marketplaceShops.shopId, shopId));
  }

  const [shop] = await db
    .select({ apiKey: marketplaceShops.apiKey, name: marketplaceShops.name })
    .from(marketplaceShops)
    .where(and(...where))
    .limit(1);

  if (!shop?.apiKey) {
    throw new NotFoundError(`No active ${platform.toUpperCase()} shop found for workspace`);
  }

  const decrypted = safeDecrypt(shop.apiKey);
  if (!decrypted) {
    throw new BadRequestError('Failed to decrypt API key');
  }

  return decrypted;
}
