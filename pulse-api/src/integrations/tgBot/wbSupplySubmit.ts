/**
 * Submit a local supply_drafts row to the real Wildberries Supplies API
 * (rev 27c).
 *
 * Flow:
 *   1. Look up the draft + its single item from PG.
 *   2. Resolve the WB barcode for the nm_id (from wb_cards.barcodes JSONB).
 *   3. Pick a warehouse — most recently used by this workspace, else the
 *      first active one from WB.
 *   4. POST /api/v1/supplies  → preorderID.
 *   5. PUT  /api/v1/supplies/{id}/goods  → set the barcode+qty.
 *   6. Update supply_drafts.status='pending' + wb_preorder_id + warehouse.
 *
 * Returns a structured result so the caller can render either a success
 * card with the preorderID or a friendly error message without crashing.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { getWbApiKey } from '../wb/wbClient.js';
import { createSupply, setSupplyGoods, getWarehouses } from '../wb/supplies/client.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'tgBot/wbSupplySubmit' });

export type SubmitOutcome =
  | { ok: true; preorderID: number; warehouseName: string }
  | { ok: false; reason: 'no_draft' | 'no_barcode' | 'no_warehouse' | 'wb_error'; detail?: string };

interface DraftRow {
  draft_id: number;
  workspace_id: number;
  shop_id: number | null;
  status: string;
  nm_id: number;
  title: string;
  quantity: number;
}

async function loadDraft(draftId: number): Promise<DraftRow | null> {
  const rows = await db.execute(sql`
    SELECT d.draft_id::int AS draft_id,
           d.workspace_id::int AS workspace_id,
           d.shop_id::int AS shop_id,
           d.status,
           i.nm_id::bigint AS nm_id,
           i.title,
           i.quantity::int AS quantity
      FROM supply_drafts d
      JOIN supply_draft_items i ON i.draft_id = d.draft_id
     WHERE d.draft_id = ${draftId}
     LIMIT 1;
  `);
  const r = rows.rows[0] as any;
  return r ? {
    draft_id: Number(r.draft_id),
    workspace_id: Number(r.workspace_id),
    shop_id: r.shop_id != null ? Number(r.shop_id) : null,
    status: String(r.status),
    nm_id: Number(r.nm_id),
    title: String(r.title),
    quantity: Number(r.quantity),
  } : null;
}

/**
 * Resolve a usable barcode for an nm_id from our cached card payload.
 * wb_cards.sizes is a JSONB array; each size has a skus array of barcodes.
 * We take the first barcode of the first size — for items with one variant
 * this is correct; for multi-size items the user can edit in the kabinet.
 */
async function resolveBarcode(workspaceId: number, nmId: number): Promise<string | null> {
  const rows = await db.execute(sql`
    SELECT sizes
      FROM wb_cards
     WHERE workspace_id = ${workspaceId} AND nm_id = ${nmId}
     LIMIT 1;
  `);
  const r = rows.rows[0] as any;
  if (!r?.sizes) return null;
  const sizes = Array.isArray(r.sizes) ? r.sizes : [];
  for (const s of sizes) {
    const skus = Array.isArray(s?.skus) ? s.skus : [];
    if (skus.length > 0 && typeof skus[0] === 'string') return skus[0];
  }
  return null;
}

/**
 * Pick a warehouse: prefer the most recently used one by this workspace
 * (from wb_supplies). Fall back to the first active WB warehouse if we
 * have no history yet.
 */
async function pickWarehouse(workspaceId: number, apiKey: string): Promise<{ id: number; name: string } | null> {
  const recent = await db.execute(sql`
    SELECT warehouse_id::int AS id, warehouse_name AS name
      FROM wb_supplies
     WHERE workspace_id = ${workspaceId}
       AND warehouse_id IS NOT NULL
     ORDER BY created_at DESC NULLS LAST
     LIMIT 1;
  `);
  const r = recent.rows[0] as any;
  if (r?.id) return { id: Number(r.id), name: String(r.name ?? '#' + r.id) };

  // No history — ask WB for the active list.
  try {
    const list = await getWarehouses(apiKey);
    const active = (list ?? []).filter((w) => w.isActive);
    if (active.length === 0) return null;
    return { id: active[0].ID, name: active[0].name };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'getWarehouses failed');
    return null;
  }
}

export async function submitDraftToWb(draftId: number): Promise<SubmitOutcome> {
  const draft = await loadDraft(draftId);
  if (!draft) return { ok: false, reason: 'no_draft' };
  if (draft.shop_id == null) return { ok: false, reason: 'no_draft', detail: 'shop_id missing' };
  if (draft.status !== 'draft') {
    return { ok: false, reason: 'no_draft', detail: `already ${draft.status}` };
  }

  const apiKey = await getWbApiKey(draft.workspace_id, draft.shop_id);
  if (!apiKey) return { ok: false, reason: 'no_draft', detail: 'no API key' };

  const barcode = await resolveBarcode(draft.workspace_id, draft.nm_id);
  if (!barcode) {
    return {
      ok: false,
      reason: 'no_barcode',
      detail: `артикул ${draft.nm_id} ещё не синхронизирован — обнови карточку.`,
    };
  }

  const wh = await pickWarehouse(draft.workspace_id, apiKey);
  if (!wh) {
    return {
      ok: false,
      reason: 'no_warehouse',
      detail: 'не нашёл доступного склада WB.',
    };
  }

  let preorderID: number;
  try {
    const created = await createSupply(apiKey, {
      warehouseID: wh.id,
      deliveryType: 'box',
      cargoType: 'standard',
      name: `SigmaSeller draft #${draft.draft_id}`,
    });
    preorderID = created.preorderID;
  } catch (err) {
    const msg = (err as Error).message || 'unknown';
    logger.warn({ err: msg, draftId, warehouseID: wh.id }, 'createSupply failed');
    return { ok: false, reason: 'wb_error', detail: trimErr(msg) };
  }

  try {
    await setSupplyGoods(apiKey, preorderID, [{ barcode, quantity: draft.quantity }]);
  } catch (err) {
    const msg = (err as Error).message || 'unknown';
    logger.warn({ err: msg, draftId, preorderID }, 'setSupplyGoods failed');
    return { ok: false, reason: 'wb_error', detail: `preorder ${preorderID} создан, но товары не привязаны: ${trimErr(msg)}` };
  }

  await db.execute(sql`
    UPDATE supply_drafts
       SET status = 'pending',
           wb_preorder_id = ${preorderID},
           warehouse_id = ${wh.id},
           warehouse_name = ${wh.name},
           updated_at = NOW()
     WHERE draft_id = ${draftId};
  `).catch((err) => logger.warn({ err: (err as Error).message }, 'update draft status failed'));

  return { ok: true, preorderID, warehouseName: wh.name };
}

function trimErr(msg: string): string {
  const clean = msg.replace(/\s+/g, ' ').trim();
  return clean.length > 120 ? clean.slice(0, 119) + '…' : clean;
}
