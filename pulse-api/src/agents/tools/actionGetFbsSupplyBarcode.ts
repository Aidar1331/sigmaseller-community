/**
 * Tool `action_get_fbs_supply_barcode` — возвращает штрихкод FBS-поставки
 * в формате base64 PDF (или PNG/SVG). Этот штрихкод сканируется водителем
 * при отгрузке на ПВЗ/склад.
 *
 * Безопасно: read-only операция, не требует подтверждения.
 */

import { db } from '../../db/client.js';
import { wbFbsSupplies } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { getSupplyBarcode } from '../../integrations/wb/marketplace/client.js';
import { log } from '../../lib/logger.js';

const logger = log.child({ module: 'actionGetFbsSupplyBarcode' });

export interface ActionGetFbsSupplyBarcodeArgs {
  fbsSupplyPk?: number;
  wbSupplyId?: string;
  /** Формат штрихкода: pdf (default) | png | svg. */
  format?: 'pdf' | 'png' | 'svg';
  _workspaceId?: number;
  _shopId?: number;
}

export async function actionGetFbsSupplyBarcode(
  args: ActionGetFbsSupplyBarcodeArgs,
): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  if (!shopId) return JSON.stringify({ error: 'shopId required' });
  if (!args.fbsSupplyPk && !args.wbSupplyId) {
    return JSON.stringify({ error: 'fbsSupplyPk or wbSupplyId required' });
  }

  let resolvedSupplyId = args.wbSupplyId;
  if (!resolvedSupplyId && args.fbsSupplyPk) {
    const [row] = await db
      .select({
        wbSupplyId: wbFbsSupplies.wbSupplyId,
        workspaceId: wbFbsSupplies.workspaceId,
      })
      .from(wbFbsSupplies)
      .where(eq(wbFbsSupplies.id, args.fbsSupplyPk))
      .limit(1);
    if (!row) return JSON.stringify({ error: `FBS supply pk=${args.fbsSupplyPk} not found` });
    if (Number(row.workspaceId) !== wsId) {
      return JSON.stringify({ error: 'FBS supply belongs to a different workspace' });
    }
    resolvedSupplyId = row.wbSupplyId;
  }
  if (!resolvedSupplyId) return JSON.stringify({ error: 'wbSupplyId unresolved' });

  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    const format = args.format ?? 'pdf';
    const result = await getSupplyBarcode(apiKey, resolvedSupplyId, format);

    return JSON.stringify({
      status: 'success',
      wbSupplyId: resolvedSupplyId,
      format,
      fileBase64: result.file,
      message: `📦 Штрихкод FBS-поставки ${resolvedSupplyId} получен (формат ${format}). Распечатай и приложи к коробке.`,
    });
  } catch (err: any) {
    logger.error(
      { err: err.message, wsId, shopId, wbSupplyId: resolvedSupplyId },
      'actionGetFbsSupplyBarcode failed',
    );
    return JSON.stringify({
      status: 'failed',
      error: err.message || 'Ошибка получения штрихкода',
    });
  }
}
