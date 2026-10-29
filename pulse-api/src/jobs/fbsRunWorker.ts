import { getQueue, JOB_FBS_RUN } from './queue.js';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { fbsRuns, fbsDocuments, fbsSchedules, marketplaceShops } from '../db/schema.js';
import { env } from '../env.js';
import { safeDecrypt } from '../lib/crypto.js';
import { logJobs as logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// FBS Run Worker
// ---------------------------------------------------------------------------

export async function registerFbsRunWorker(): Promise<void> {
  const boss = await getQueue();
  await boss.createQueue(JOB_FBS_RUN);

  await boss.work(JOB_FBS_RUN, { localConcurrency: 1 }, async (jobs) => {
    const job = jobs[0];
    const { runId, workspaceId, shopId } = job.data as {
      runId: string;
      workspaceId: number;
      shopId?: number | null;
    };

    await db
      .update(fbsRuns)
      .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
      .where(eq(fbsRuns.runId, runId));

    // Load shops for workspace
    const shopWhere = [
      eq(marketplaceShops.workspaceId, workspaceId),
      eq(marketplaceShops.isActive, true),
    ];
    if (shopId) shopWhere.push(eq(marketplaceShops.shopId, shopId));

    const shops = await db
      .select({
        shopId: marketplaceShops.shopId,
        platform: marketplaceShops.platform,
        name: marketplaceShops.name,
        apiKey: marketplaceShops.apiKey,
        clientId: marketplaceShops.clientId,
        wbDeliveryType: marketplaceShops.wbDeliveryType,
      })
      .from(marketplaceShops)
      .where(and(...shopWhere));

    if (!shops.length) {
      await db
        .update(fbsRuns)
        .set({
          status: 'failed',
          errorText: 'No active shops found for workspace',
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(fbsRuns.runId, runId));
      return;
    }

    const { mkdirSync, writeFileSync } = await import('node:fs');
    const outputDir = `${process.env.SPAWN_LOG_DIR ?? "out"}/fbs/${runId}`;
    mkdirSync(outputDir, { recursive: true });

    const insertedDocs: Array<{ fileName?: string | null; filePath?: string | null; mime?: string | null }> = [];
    const errors: string[] = [];

    for (const shop of shops) {
      const decryptedApiKey = safeDecrypt(shop.apiKey ?? '');
      if (!decryptedApiKey) {
        errors.push(`Shop ${shop.name}: failed to decrypt API key`);
        continue;
      }

      try {
        if (shop.platform === 'wb') {
          const docs = await processWbFbs(shop, decryptedApiKey, outputDir, runId);
          insertedDocs.push(...docs);
        } else if (shop.platform === 'ozon') {
          const docs = await processOzonFbs(shop, decryptedApiKey, shop.clientId ?? '', outputDir, runId);
          insertedDocs.push(...docs);
        } else if (shop.platform === 'yandex_market') {
          const docs = await processYandexFbs(shop, decryptedApiKey, shop.clientId ?? '', outputDir, runId);
          insertedDocs.push(...docs);
        }
      } catch (e: any) {
        errors.push(`Shop ${shop.name} (${shop.platform}): ${String(e?.message ?? e)}`);
      }
    }

    const ok = errors.length === 0 || insertedDocs.length > 0;
    const errorText = errors.length > 0 ? errors.join('; ') : null;

    await db
      .update(fbsRuns)
      .set({
        status: ok ? 'success' : 'failed',
        errorText: ok ? null : errorText,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(fbsRuns.runId, runId));

    // Telegram notification
    await sendTelegramNotification(runId, ok, errorText, insertedDocs);
  });
}

// ---------------------------------------------------------------------------
// WB FBS Processing
// ---------------------------------------------------------------------------

async function processWbFbs(
  shop: { shopId: number; name: string },
  apiKey: string,
  outputDir: string,
  runId: string,
): Promise<Array<{ fileName: string; filePath: string; mime: string }>> {
  const {
    getNewOrders,
    getOrderStickers,
  } = await import('../integrations/wb/marketplace/client.js');

  const docs: Array<{ fileName: string; filePath: string; mime: string }> = [];
  const { writeFileSync } = await import('node:fs');

  // Get new orders
  const { orders } = await getNewOrders(apiKey);

  if (orders.length === 0) {
    logger.info({ shop: shop.name }, 'WB shop: no new orders');
    return docs;
  }

  logger.info({ shop: shop.name, orderCount: orders.length }, 'WB shop: new orders found');

  // Get stickers for all orders (batch, max 100)
  const orderIds = orders.map((o) => o.id);
  const chunks: number[][] = [];
  for (let i = 0; i < orderIds.length; i += 100) {
    chunks.push(orderIds.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    try {
      const resp = await getOrderStickers(apiKey, chunk, { type: 'pdf' });

      for (const sticker of resp.stickers ?? []) {
        const fileName = `wb-sticker-${sticker.orderId}.pdf`;
        const filePath = `${outputDir}/${fileName}`;

        // sticker.file is base64-encoded PDF
        const buffer = Buffer.from(sticker.file, 'base64');
        writeFileSync(filePath, buffer);

        // Insert into DB
        await db.insert(fbsDocuments).values({
          runId,
          filePath,
          fileName,
          mime: 'application/pdf',
          sizeBytes: buffer.length,
          createdAt: new Date(),
        });

        docs.push({ fileName, filePath, mime: 'application/pdf' });
      }
    } catch (e: any) {
      logger.error({ err: e }, 'WB stickers error');
    }
  }

  // Create combined stickers PDF summary
  if (docs.length > 0) {
    const summaryFileName = `wb-orders-summary-${shop.shopId}.txt`;
    const summaryPath = `${outputDir}/${summaryFileName}`;
    const summaryContent = orders
      .map((o) => `Order ${o.id}: ${o.article} (nmId: ${o.nmId}) - ${o.skus.join(', ')}`)
      .join('\n');

    writeFileSync(summaryPath, summaryContent, 'utf-8');

    await db.insert(fbsDocuments).values({
      runId,
      filePath: summaryPath,
      fileName: summaryFileName,
      mime: 'text/plain',
      sizeBytes: Buffer.byteLength(summaryContent),
      createdAt: new Date(),
    });

    docs.push({ fileName: summaryFileName, filePath: summaryPath, mime: 'text/plain' });
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Ozon FBS Processing (placeholder)
// ---------------------------------------------------------------------------

async function processOzonFbs(
  shop: { shopId: number; name: string },
  apiKey: string,
  clientId: string,
  outputDir: string,
  runId: string,
): Promise<Array<{ fileName: string; filePath: string; mime: string }>> {
  // TODO: Implement Ozon Seller API integration
  // POST /v3/posting/fbs/unfulfilled/list - get unfulfilled orders
  // POST /v3/posting/fbs/act/create - create shipping act
  // POST /v3/posting/fbs/package-label - get package labels
  logger.info({ shop: shop.name }, 'Ozon shop: integration not yet implemented');
  return [];
}

// ---------------------------------------------------------------------------
// Yandex Market FBS Processing (placeholder)
// ---------------------------------------------------------------------------

async function processYandexFbs(
  shop: { shopId: number; name: string },
  apiKey: string,
  campaignId: string,
  outputDir: string,
  runId: string,
): Promise<Array<{ fileName: string; filePath: string; mime: string }>> {
  // TODO: Implement Yandex Market API integration
  // GET /campaigns/{campaignId}/orders - get orders
  // GET /campaigns/{campaignId}/orders/{orderId}/delivery/shipments/{shipmentId}/labels - get labels
  logger.info({ shop: shop.name }, 'Yandex Market shop: integration not yet implemented');
  return [];
}

// ---------------------------------------------------------------------------
// Telegram Notification
// ---------------------------------------------------------------------------

async function sendTelegramNotification(
  runId: string,
  ok: boolean,
  errorText: string | null,
  insertedDocs: Array<{ fileName?: string | null; filePath?: string | null; mime?: string | null }>,
): Promise<void> {
  try {
    const { sendTelegramMessage, sendTelegramDocument } = await import('../lib/telegram.js');

    const [run] = await db
      .select({
        runId: fbsRuns.runId,
        workspaceId: fbsRuns.workspaceId,
        scheduleId: fbsRuns.scheduleId,
        shopId: fbsRuns.shopId,
        status: fbsRuns.status,
        errorText: fbsRuns.errorText,
        telegramChatId: fbsRuns.telegramChatId,
      })
      .from(fbsRuns)
      .where(eq(fbsRuns.runId, runId))
      .limit(1);

    let chatId = run?.telegramChatId || null;

    if (!chatId && run?.scheduleId) {
      const [sched] = await db
        .select({
          telegramChatId: fbsSchedules.telegramChatId,
          telegramEnabled: fbsSchedules.telegramEnabled,
        })
        .from(fbsSchedules)
        .where(
          and(
            eq(fbsSchedules.scheduleId, run.scheduleId),
            eq(fbsSchedules.workspaceId, run.workspaceId),
          ),
        )
        .limit(1);
      if (sched?.telegramEnabled && sched.telegramChatId) {
        chatId = sched.telegramChatId;
      }
    }

    if (chatId) {
      const statusLine = ok ? '✅ Успешно' : `❌ Ошибка: ${errorText ?? 'unknown'}`;
      const docsLine = insertedDocs.length ? `Документы: ${insertedDocs.length}` : 'Документы: 0';
      await sendTelegramMessage(`📦 <b>FBS‑отгрузки</b>\n${statusLine}\n${docsLine}`, chatId);

      // Send documents (if any, limit to 10)
      const docsToSend = insertedDocs.slice(0, 10);
      for (const d of docsToSend) {
        if (!d.filePath) continue;
        try {
          await sendTelegramDocument(d.filePath, chatId, {
            fileName: d.fileName || undefined,
          });
        } catch {
          // ignore per-document errors
        }
      }
    }
  } catch {
    // ignore telegram errors
  }
}
