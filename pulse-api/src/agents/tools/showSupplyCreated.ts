/**
 * Widget tool `show_supply_created` — финальный виджет после создания
 * FBO-поставки. Показывает preorderID, состав, кнопки [Скачать лист
 * приёмки] и [Открыть в ЛК WB].
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { wbSupplies, wbSupplyItems } from '../../db/schema.js';

export interface ShowSupplyCreatedInput {
  /** Внутренний id из wb_supplies. */
  supplyRowId: number;
  _workspaceId?: number;
}

export async function showSupplyCreated(input: ShowSupplyCreatedInput): Promise<string> {
  const { supplyRowId, _workspaceId } = input;
  if (!_workspaceId) return JSON.stringify({ status: 'error', error: 'workspace_id missing' });

  const [supply] = await db
    .select()
    .from(wbSupplies)
    .where(and(eq(wbSupplies.id, supplyRowId), eq(wbSupplies.workspaceId, _workspaceId)))
    .limit(1);
  if (!supply) return JSON.stringify({ status: 'error', error: 'supply not found in workspace' });

  const items = await db
    .select({
      nmId: wbSupplyItems.nmId,
      barcode: wbSupplyItems.barcode,
      vendorCode: wbSupplyItems.vendorCode,
      quantity: wbSupplyItems.quantity,
    })
    .from(wbSupplyItems)
    .where(eq(wbSupplyItems.supplyId, supplyRowId))
    .limit(50);

  const totalQty = items.reduce((s, i) => s + (i.quantity ?? 0), 0);
  const preorderId = supply.wbPreorderId ?? null;
  const supplyId = supply.wbSupplyId ?? null;
  const lkUrl = preorderId
    ? `https://seller.wildberries.ru/supplies-management/all-supplies/supply-detail?preorderId=${preorderId}`
    : supplyId
      ? `https://seller.wildberries.ru/supplies-management/all-supplies/supply-detail?supplyId=${supplyId}`
      : null;

  return JSON.stringify({
    status: 'ok',
    summary: `Поставка создана: ${supplyId ?? preorderId} (${supply.warehouseName ?? 'склад —'}), ${items.length} SKU, ${totalQty} шт.`,
    __widget: 'supply_created',
    props: {
      workspaceId: _workspaceId,
      supplyRowId,
      preorderId,
      supplyId,
      warehouseName: supply.warehouseName,
      supplyDate: supply.supplyDate,
      itemsCount: items.length,
      totalQty,
      items: items.slice(0, 10),
      lkUrl,
    },
  });
}
