/**
 * Supply slip PDF generator (A4).
 *
 * Генерирует лист приёмки поставки WB: обложку с итогами + таблицу SKU
 * с Code-128 штрих-кодами для считывания на приёмке.
 *
 * Локальная генерация оправдана: WB не отдаёт документы FBO-поставок
 * через API, а ЛК WB сам рисует стикеры на клиенте (JsBarcode) из
 * уже загруженных данных о коробах. У нас ровно те же данные
 * (wb_supplies + wb_supply_items), поэтому наш PDF эквивалентен.
 */

import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { wbSupplies, wbSupplyItems, wbCards } from '../db/schema.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'supplySlipPdf' });

export interface SupplySlipInput {
  /** Внутренний id из wb_supplies (не preorderID/supplyID WB). */
  supplyRowId: number;
}

export interface SupplySlipResult {
  pdfBuffer: Buffer;
  fileName: string;
  mime: 'application/pdf';
  sizeBytes: number;
  summary: {
    preorderId: number | null;
    supplyId: number | null;
    warehouseName: string | null;
    totalSkus: number;
    totalQty: number;
  };
}

async function renderBarcodePng(value: string, widthMm = 45, heightMm = 12): Promise<Buffer> {
  // Code-128 подходит как для EAN-13, так и для произвольных штрих-кодов товара.
  return bwipjs.toBuffer({
    bcid: 'code128',
    text: value,
    scale: 3,
    height: heightMm,
    includetext: true,
    textxalign: 'center',
    paddingwidth: 4,
  });
}

export async function generateSupplySlipPdf({ supplyRowId }: SupplySlipInput): Promise<SupplySlipResult> {
  const [supply] = await db
    .select()
    .from(wbSupplies)
    .where(eq(wbSupplies.id, supplyRowId))
    .limit(1);

  if (!supply) {
    throw new Error(`supply ${supplyRowId} not found`);
  }

  const items = await db
    .select({
      id: wbSupplyItems.id,
      barcode: wbSupplyItems.barcode,
      vendorCode: wbSupplyItems.vendorCode,
      nmId: wbSupplyItems.nmId,
      quantity: wbSupplyItems.quantity,
    })
    .from(wbSupplyItems)
    .where(eq(wbSupplyItems.supplyId, supplyRowId));

  // Подтянем названия товаров из wb_cards для удобства приёмки
  const nmIds = items.map((i) => i.nmId).filter((n): n is number => n != null);
  const titles = new Map<number, string>();
  if (nmIds.length > 0) {
    const cards = await db
      .select({ nmId: wbCards.nmId, title: wbCards.title })
      .from(wbCards)
      .where(and(eq(wbCards.workspaceId, supply.workspaceId)));
    for (const c of cards) {
      if (c.nmId && c.title && nmIds.includes(c.nmId)) titles.set(c.nmId, c.title);
    }
  }

  const totalQty = items.reduce((s, i) => s + (i.quantity || 0), 0);
  const preorderId = supply.wbPreorderId ?? null;
  const supplyId = supply.wbSupplyId ?? null;
  const fileLabel = supplyId ?? preorderId ?? supplyRowId;

  // Генерируем PNG штрих-кодов параллельно (bwip-js — sync но обёрнём)
  const barcodes = await Promise.all(
    items.map(async (it) => ({
      id: it.id,
      png: await renderBarcodePng(it.barcode),
    })),
  );
  const barcodeMap = new Map(barcodes.map((b) => [b.id, b.png]));

  const chunks: Buffer[] = [];
  const doc = new PDFDocument({ size: 'A4', margin: 30, info: { Title: `Лист приёмки #${fileLabel}` } });
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  // Заголовок
  doc.fontSize(18).text(`Лист приёмки поставки`, { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#666')
    .text(
      [
        supplyId ? `Supply ID: ${supplyId}` : null,
        preorderId ? `Preorder ID: ${preorderId}` : null,
        supply.warehouseName ? `Склад: ${supply.warehouseName}` : null,
        supply.supplyDate ? `Дата: ${supply.supplyDate}` : null,
        `SKU: ${items.length} · Всего шт: ${totalQty}`,
      ].filter(Boolean).join('   '),
      { align: 'center' },
    );
  doc.fillColor('#000').moveDown(1);

  // Таблица: № | Штрих-код | Арт. продавца | nmID | Название | Кол-во
  const cols = { num: 25, bc: 140, vc: 90, nm: 75, name: 140, qty: 40 };
  const startX = doc.x;
  let y = doc.y;

  const drawHeader = () => {
    doc.fontSize(9).fillColor('#000');
    doc.rect(startX, y, cols.num + cols.bc + cols.vc + cols.nm + cols.name + cols.qty, 16).fill('#eee').fillColor('#000');
    let x = startX;
    doc.text('№', x + 2, y + 4, { width: cols.num, align: 'center' }); x += cols.num;
    doc.text('Штрих-код', x + 2, y + 4, { width: cols.bc, align: 'center' }); x += cols.bc;
    doc.text('Арт.', x + 2, y + 4, { width: cols.vc, align: 'center' }); x += cols.vc;
    doc.text('nmID', x + 2, y + 4, { width: cols.nm, align: 'center' }); x += cols.nm;
    doc.text('Название', x + 2, y + 4, { width: cols.name, align: 'center' }); x += cols.name;
    doc.text('Шт.', x + 2, y + 4, { width: cols.qty, align: 'center' });
    y += 16;
  };

  drawHeader();

  const rowH = 46;
  items.forEach((it, idx) => {
    if (y + rowH > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeader();
    }
    doc.rect(startX, y, cols.num + cols.bc + cols.vc + cols.nm + cols.name + cols.qty, rowH).stroke('#ddd');
    let x = startX;
    doc.fontSize(10).fillColor('#000');
    doc.text(String(idx + 1), x + 2, y + rowH / 2 - 5, { width: cols.num, align: 'center' });
    x += cols.num;

    const png = barcodeMap.get(it.id);
    if (png) {
      try {
        doc.image(png, x + 2, y + 2, { width: cols.bc - 4, height: rowH - 4 });
      } catch (err) {
        doc.text(it.barcode, x + 2, y + rowH / 2 - 5, { width: cols.bc, align: 'center' });
      }
    } else {
      doc.text(it.barcode, x + 2, y + rowH / 2 - 5, { width: cols.bc, align: 'center' });
    }
    x += cols.bc;
    doc.text(it.vendorCode ?? '', x + 2, y + rowH / 2 - 5, { width: cols.vc, align: 'center' });
    x += cols.vc;
    doc.text(it.nmId ? String(it.nmId) : '', x + 2, y + rowH / 2 - 5, { width: cols.nm, align: 'center' });
    x += cols.nm;
    const title = it.nmId ? (titles.get(it.nmId) ?? '') : '';
    doc.fontSize(8).text(title, x + 2, y + 4, { width: cols.name - 4, height: rowH - 4, ellipsis: true });
    doc.fontSize(10);
    x += cols.name;
    doc.text(String(it.quantity), x + 2, y + rowH / 2 - 5, { width: cols.qty, align: 'center' });
    y += rowH;
  });

  doc.end();
  await done;

  const pdfBuffer = Buffer.concat(chunks);
  const fileName = `supply-slip-${fileLabel}.pdf`;

  logger.info(
    { supplyRowId, preorderId, supplyId, items: items.length, sizeBytes: pdfBuffer.length },
    'supply slip generated',
  );

  return {
    pdfBuffer,
    fileName,
    mime: 'application/pdf',
    sizeBytes: pdfBuffer.length,
    summary: {
      preorderId,
      supplyId,
      warehouseName: supply.warehouseName ?? null,
      totalSkus: items.length,
      totalQty,
    },
  };
}
