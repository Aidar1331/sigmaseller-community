/**
 * Supplies Sync Job
 * 
 * Syncs WB FBW supplies for all active workspaces.
 * Runs every 4 hours.
 */

import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workspaces, wbSupplies, wbSupplyItems, marketplaceShops } from '../db/schema.js';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { logJobs as logger } from '../lib/logger.js';

const SYNC_STATUSES = [1, 2, 3, 4, 6]; // Not completed supplies

export async function runSuppliesSyncForWorkspace(
  workspaceId: number,
  shopId?: number,
): Promise<{ synced: number; errors: number }> {
  // Если shopId не задан — итерируем по всем активным WB-shop'ам.
  // Без этого getWbApiKey возьмёт первый попавшийся токен и WB отдаст
  // supplies чужого магазина.
  if (!shopId) {
    const shops = await db
      .select({ shopId: marketplaceShops.shopId })
      .from(marketplaceShops)
      .where(and(
        eq(marketplaceShops.workspaceId, workspaceId),
        eq(marketplaceShops.platform, 'wb'),
        eq(marketplaceShops.isActive, true),
      ));
    let synced = 0, errors = 0;
    for (const s of shops) {
      const r = await runSuppliesSyncForWorkspace(workspaceId, s.shopId);
      synced += r.synced; errors += r.errors;
    }
    return { synced, errors };
  }

  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) {
    logger.info({ workspaceId, shopId }, 'No API key, skipping');
    return { synced: 0, errors: 0 };
  }

  const { WbSuppliesClient } = await import('../integrations/wb/supplies/index.js');
  const client = new WbSuppliesClient(workspaceId, shopId);

  const supplies = await client.getSupplies({ statusIDs: SYNC_STATUSES }, 100, 0);

  let synced = 0;
  let errors = 0;

  for (const supply of supplies) {
    try {
      const supplyData = {
        workspaceId,
        shopId,
        wbSupplyId: supply.supplyID,
        wbPreorderId: supply.preorderID,
        statusId: supply.statusID as number,
        supplyDate: supply.supplyDate?.slice(0, 10) ?? null,
        factDate: supply.factDate ? new Date(supply.factDate) : null,
        syncedAt: new Date(),
        updatedAt: new Date(),
      };

      // Atomic upsert keyed by (workspace_id, shop_id, wb_preorder_id).
      // Replaces the previous SELECT-then-INSERT pattern which had a TOCTOU
      // race window: two concurrent runs (cron + manual refresh, or two
      // workspace iterators) could both miss the row and both INSERT,
      // tripping the legacy `wb_supplies_workspace_wb_uniq` index and
      // crashing the entire workspace's sync run.
      //
      // The matching UNIQUE constraint is added in migration
      // 0116_wb_supplies_workspace_shop_preorder_uniq.sql which the
      // server boots apply via runPendingMigrations.
      const [upserted] = await db
        .insert(wbSupplies)
        .values(supplyData)
        .onConflictDoUpdate({
          target: [wbSupplies.workspaceId, wbSupplies.shopId, wbSupplies.wbPreorderId],
          set: {
            wbSupplyId: supplyData.wbSupplyId,
            statusId: supplyData.statusId,
            supplyDate: supplyData.supplyDate,
            factDate: supplyData.factDate,
            syncedAt: supplyData.syncedAt,
            updatedAt: supplyData.updatedAt,
          },
        })
        .returning({ id: wbSupplies.id });
      const localSupplyId = upserted.id;

      if (supply.statusID >= 3) {
        const id = supply.supplyID ?? supply.preorderID;
        if (id) {
          const goods = await client.getSupplyGoods(id, !supply.supplyID);
          if (goods.length > 0) {
            await db.delete(wbSupplyItems).where(eq(wbSupplyItems.supplyId, localSupplyId));
            await db.insert(wbSupplyItems).values(goods.map(g => ({
              supplyId: localSupplyId,
              barcode: g.barcode,
              vendorCode: g.vendorCode,
              nmId: g.nmID,
              quantity: g.quantity,
              acceptedQuantity: g.acceptedQuantity ?? 0,
              readyForSaleQty: g.readyForSaleQuantity ?? 0,
            })));
          }
        }
      }

      synced++;
    } catch (err) {
      logger.error({ err, preorderID: supply.preorderID }, 'Error syncing supply');
      errors++;
    }
  }

  logger.info({ workspaceId, suppliesCount: supplies.length, synced, errors }, 'Workspace supplies synced');
  return { synced, errors };
}

export async function runSuppliesSync(): Promise<void> {
  logger.info('Starting sync');

  const activeWorkspaces = await db
    .select({ workspaceId: workspaces.workspaceId })
    .from(workspaces);

  if (activeWorkspaces.length === 0) {
    logger.info('No active workspaces');
    return;
  }

  logger.info({ count: activeWorkspaces.length }, 'Found active workspaces');

  let synced = 0;
  let errors = 0;

  for (const { workspaceId } of activeWorkspaces) {
    try {
      const r = await runSuppliesSyncForWorkspace(workspaceId);
      synced += r.synced;
      errors += r.errors;
    } catch (err) {
      logger.error({ err, workspaceId }, 'Error processing workspace');
      errors++;
    }
  }

  logger.info({ synced, errors }, 'Supplies sync completed');
}
