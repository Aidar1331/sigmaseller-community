/**
 * Tool `action_generate_supply_slip` — генерирует лист приёмки FBO-поставки
 * (A4 PDF с Code-128 штрих-кодами) и прикладывает его в чат.
 *
 * NO confirmation required: локальная операция, не меняет состояние WB.
 *
 * Возвращает специальный payload `{ __attachments: [...], content }`,
 * который aiChat SSE-обработчик превращает в attachment-сообщение
 * (см. routes/aiChat.ts `__attachments` branch).
 */

import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { supplyDocuments, wbSupplies } from '../../db/schema.js';
import { generateSupplySlipPdf } from '../../services/supplySlipPdf.js';
import { logAgent as logger } from '../../lib/logger.js';

export interface ActionGenerateSupplySlipInput {
  /** Внутренний id из wb_supplies (НЕ preorderID/supplyID WB). */
  supplyRowId: number;
  _workspaceId?: number;
  _shopId?: number | null;
}

export async function actionGenerateSupplySlip(input: ActionGenerateSupplySlipInput): Promise<string> {
  const { supplyRowId, _workspaceId } = input;

  if (!_workspaceId) {
    return JSON.stringify({ status: 'error', error: 'workspace_id missing' });
  }

  // Доступ: поставка должна принадлежать workspace'у агента.
  const [supply] = await db
    .select({ id: wbSupplies.id, workspaceId: wbSupplies.workspaceId })
    .from(wbSupplies)
    .where(eq(wbSupplies.id, supplyRowId))
    .limit(1);
  if (!supply || supply.workspaceId !== _workspaceId) {
    return JSON.stringify({ status: 'error', error: 'supply not found in this workspace' });
  }

  try {
    const result = await generateSupplySlipPdf({ supplyRowId });

    // Кэш: последний PDF для этой поставки сохраняем в supply_documents (base64).
    await db.insert(supplyDocuments).values({
      supplyId: supplyRowId as number,
      docType: 'slip',
      fileName: result.fileName,
      fileData: result.pdfBuffer.toString('base64'),
      fileSize: result.sizeBytes,
    });

    const fileUrl = `/api/proxy/agents/${_workspaceId}/supply-slip/${supplyRowId}/file`;
    const { totalSkus, totalQty, preorderId, supplyId, warehouseName } = result.summary;

    const content = [
      '**Лист приёмки готов**',
      '',
      `- Поставка: ${supplyId ?? preorderId ?? supplyRowId}`,
      warehouseName ? `- Склад: ${warehouseName}` : null,
      `- SKU: ${totalSkus}, всего ${totalQty} шт`,
      '',
      'PDF ниже — можно распечатать на A4 для самоприёмки или в ПВЗ.',
    ].filter(Boolean).join('\n');

    logger.info({ supplyRowId, workspaceId: _workspaceId, sizeBytes: result.sizeBytes }, 'supply slip attached to chat');

    return JSON.stringify({
      status: 'ok',
      content,
      __attachments: [{
        url: fileUrl,
        fileName: result.fileName,
        mime: result.mime,
        sizeBytes: result.sizeBytes,
      }],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, supplyRowId, workspaceId: _workspaceId }, 'generate supply slip failed');
    return JSON.stringify({ status: 'error', error: msg });
  }
}
