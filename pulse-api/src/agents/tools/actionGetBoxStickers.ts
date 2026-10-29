/**
 * Tool `action_get_box_stickers` — скачивает QR-стикеры коробов FBO-поставки с WB
 * и отправляет в чат одним PDF-файлом (580×400 px на короб).
 *
 * NO confirmation required: чтение из WB API, не меняет данные.
 *
 * Поток:
 *  1. Ищем поставку в таблице supplies по wbSupplyId
 *  2. Получаем список trbxIds (из supplyBoxes или WB API)
 *  3. Запрашиваем стикеры у WB API (PNG base64)
 *  4. Генерируем PDF (pdfkit): один стикер = одна страница
 *  5. Сохраняем PDF в supply_documents (docType='box_stickers')
 *  6. Возвращаем __attachments с proxy URL
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import { db } from '../../db/client.js';
import { supplies, supplyBoxes, supplyDocuments } from '../../db/schema.js';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { getSupplyBoxes, getBoxStickers } from '../../integrations/wb/marketplace/client.js';
import { logAgent as logger } from '../../lib/logger.js';

export interface ActionGetBoxStickersInput {
  supplyId: string;         // WB supply ID "WB-GI-XXXXXXX"
  type?: 'png' | 'svg';
  _workspaceId?: number;
  _shopId?: number | null;
}

export async function actionGetBoxStickers(input: ActionGetBoxStickersInput): Promise<string> {
  const { supplyId, type = 'png', _workspaceId, _shopId } = input;
  const wsId = _workspaceId;
  if (!wsId) return JSON.stringify({ status: 'error', error: 'workspace_id missing' });

  // 1. Найти поставку в нашей БД по wbSupplyId
  const [supply] = await db
    .select({ supplyRowId: supplies.supplyId, workspaceId: supplies.workspaceId })
    .from(supplies)
    .where(and(eq(supplies.wbSupplyId, supplyId), eq(supplies.workspaceId, wsId)))
    .limit(1);

  if (!supply) {
    return JSON.stringify({
      status: 'error',
      error: `Поставка ${supplyId} не найдена в базе. Убедитесь что поставка создана через систему и синхронизирована.`,
    });
  }

  const supplyRowId = supply.supplyRowId;

  try {
    const apiKey = await getWbApiKey(wsId, _shopId ?? undefined);
    if (!apiKey) return JSON.stringify({ status: 'error', error: 'WB API ключ не настроен' });

    // 2. Получить trbxIds — сначала из БД, потом из WB API
    const localBoxes = await db
      .select({ wbTrbxId: supplyBoxes.wbTrbxId })
      .from(supplyBoxes)
      .where(and(eq(supplyBoxes.supplyId, supplyRowId), isNotNull(supplyBoxes.wbTrbxId)));

    let trbxIds: string[];

    if (localBoxes.length > 0) {
      trbxIds = localBoxes.map((b) => b.wbTrbxId as string);
    } else {
      const { trbxes } = await getSupplyBoxes(apiKey, supplyId);
      if (!trbxes || trbxes.length === 0) {
        return JSON.stringify({
          status: 'error',
          error: `Для поставки ${supplyId} не найдено коробов. Сначала упакуйте товары в коробы в ЛК WB.`,
        });
      }
      trbxIds = trbxes.map((b) => b.id);
    }

    // 3. Получить стикеры у WB API
    const { stickers } = await getBoxStickers(apiKey, supplyId, trbxIds, type);
    if (!stickers || stickers.length === 0) {
      return JSON.stringify({ status: 'error', error: 'WB не вернул стикеры. Попробуйте позже.' });
    }

    // 4. Генерировать PDF: 580×400 pt на стикер (1 pt ≈ 1 px при 72 dpi)
    const pdf = await buildStickerPdf(stickers);
    const pdfBase64 = pdf.toString('base64');
    const fileName = `stickers-${supplyId}.pdf`;

    // 5. Сохранить в supply_documents
    await db.insert(supplyDocuments).values({
      supplyId: supplyRowId,
      docType: 'box_stickers',
      fileName,
      fileData: pdfBase64,
      fileSize: pdf.length,
    });

    // 6. Вернуть attachment
    const fileUrl = `/api/proxy/agents/${wsId}/box-stickers/${supplyRowId}/file`;

    const content = [
      '**Стикеры коробов готовы**',
      '',
      `- Поставка: ${supplyId}`,
      `- Коробов: ${stickers.length}`,
      '',
      'PDF ниже — распечатайте и наклейте на каждый короб перед отгрузкой.',
    ].join('\n');

    logger.info({ supplyId, supplyRowId, wsId, boxes: stickers.length }, 'box stickers pdf generated');

    return JSON.stringify({
      status: 'ok',
      content,
      __attachments: [{
        url: fileUrl,
        fileName,
        mime: 'application/pdf',
        sizeBytes: pdf.length,
      }],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, supplyId, wsId }, 'get box stickers failed');
    return JSON.stringify({ status: 'error', error: msg });
  }
}

async function buildStickerPdf(stickers: Array<{ barcode: string; file: string }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    // 580×400 pt — размер стикера WB
    const doc = new PDFDocument({ size: [580, 400], margin: 0, autoFirstPage: false });
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    for (const sticker of stickers) {
      doc.addPage();
      try {
        const imgBuf = Buffer.from(sticker.file, 'base64');
        doc.image(imgBuf, 0, 0, { width: 580, height: 400 });
      } catch {
        // Если картинка не читается — добавляем текстовый placeholder
        doc.fontSize(14).fillColor('black').text(
          `Короб: ${sticker.barcode}`,
          20, 180, { width: 540, align: 'center' }
        );
      }
    }

    doc.end();
  });
}
