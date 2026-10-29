import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { syncWbFbsShipmentsDailyProducts } from '../integrations/wb/fbsShipments.js';
import { requireRole } from '../plugins/roleCheck.js';
import {
  generateAssemblySlip,
  FbsSidecarUnavailableError,
  type FbsSlipPosting,
} from '../services/fbsSlip.js';
import { sendTelegramPerUserDocument } from '../integrations/telegram.js';
import { BadRequestError, UnauthorizedError } from '../lib/errors.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'fbsRoutes' });

export const fbsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/fbs/:workspaceId/shipments/sync', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        start: z.string(),
        end: z.string(),
      })
      .parse((req as any).body ?? {});

    const res = await syncWbFbsShipmentsDailyProducts({ workspaceId: params.workspaceId, start: body.start, end: body.end });
    return { ok: true, ...res };
  });

  /**
   * POST /fbs/:workspaceId/assembly-slip
   * Generate an assembly-slip PDF via the Python sidecar (docker/fbs-sidecar)
   * and send it to the current user's linked Telegram chat.
   *
   * Body: { postings: [...], supplyId?, sendToTelegram?: boolean }
   *   - postings carry the goods list as resolved by the frontend /fbs page
   *     (normally from WB FBS orders + local COGS catalogue).
   *   - sendToTelegram=true (default) pushes the PDF document; false returns
   *     the PDF in the response body for manual download.
   */
  app.post('/fbs/:workspaceId/assembly-slip', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        postings: z
          .array(
            z.object({
              posting_number: z.string().min(1),
              supply_id: z.string().nullable().optional(),
              shop_name: z.string().nullable().optional(),
              items: z
                .array(
                  z.object({
                    name: z.string().min(1),
                    vendor_code: z.string().nullable().optional(),
                    nm_id: z.number().int().positive().nullable().optional(),
                    quantity: z.number().int().positive(),
                    barcode: z.string().nullable().optional(),
                  }),
                )
                .min(1),
            }),
          )
          .min(1)
          .max(500), // hard cap so a huge payload can't melt the sidecar
        supplyId: z.string().nullable().optional(),
        sendToTelegram: z.boolean().optional().default(true),
      })
      .parse((req as any).body ?? {});

    const user = (req as any).user;
    if (!user?.userId) throw new UnauthorizedError('Not authenticated');

    let pdf: Buffer;
    try {
      pdf = await generateAssemblySlip({
        postings: body.postings as FbsSlipPosting[],
        supplyId: body.supplyId ?? undefined,
      });
    } catch (err) {
      if (err instanceof FbsSidecarUnavailableError) {
        throw new BadRequestError(
          'Сервис генерации сборочных листов временно недоступен. Попробуйте позже.',
        );
      }
      throw err;
    }

    if (body.sendToTelegram) {
      const fileName = `fbs-slip-${body.supplyId ?? 'manual'}-${Date.now()}.pdf`;
      const sent = await sendTelegramPerUserDocument(
        user.userId,
        pdf,
        fileName,
        `📦 Сборочный лист FBS (${body.postings.length} заказ(ов))`,
      );
      if (!sent) {
        logger.info({ userId: user.userId, workspaceId: params.workspaceId }, 'telegram not linked, PDF returned inline');
        reply.type('application/pdf').header('Content-Disposition', `attachment; filename="${fileName}"`);
        return reply.send(pdf);
      }
      return { ok: true, delivered: 'telegram', bytes: pdf.length };
    }

    const fileName = `fbs-slip-${body.supplyId ?? 'manual'}-${Date.now()}.pdf`;
    reply.type('application/pdf').header('Content-Disposition', `attachment; filename="${fileName}"`);
    return reply.send(pdf);
  });
};
