/**
 * Client for the FBS assembly-slip Docker sidecar.
 *
 * The sidecar (docker/fbs-sidecar) runs Python + reportlab and exposes
 * POST /generate-slip → application/pdf. We pass the list of postings
 * pulled from wb_fbs_shipments, receive PDF bytes back, and send them to
 * the user's Telegram chat via sendTelegramPerUser.
 *
 * The sidecar URL + shared token are expected in env:
 *   FBS_SIDECAR_URL     e.g. http://fbs-sidecar:7001
 *   FBS_SIDECAR_TOKEN   shared secret with docker/fbs-sidecar/app.py
 */

import { env } from '../env.js';
import log from '../lib/logger.js';

const logger = log.child({ module: 'fbsSlip' });

export interface FbsSlipItem {
  name: string;
  vendor_code?: string | null;
  nm_id?: number | null;
  quantity: number;
  barcode?: string | null;
}

export interface FbsSlipPosting {
  posting_number: string;
  supply_id?: string | null;
  shop_name?: string | null;
  items: FbsSlipItem[];
}

export interface GenerateSlipInput {
  postings: FbsSlipPosting[];
  supplyId?: string | null;
  title?: string;
}

export class FbsSidecarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FbsSidecarUnavailableError';
  }
}

/**
 * Generate a PDF assembly slip and return it as a Buffer.
 * Throws FbsSidecarUnavailableError if the sidecar URL/token isn't
 * configured so callers can show a user-friendly message instead of
 * leaking infra details.
 */
export async function generateAssemblySlip(input: GenerateSlipInput): Promise<Buffer> {
  const url = env.FBS_SIDECAR_URL;
  const token = env.FBS_SIDECAR_TOKEN;
  if (!url || !token) {
    throw new FbsSidecarUnavailableError('FBS sidecar not configured');
  }

  const body = {
    postings: input.postings,
    supply_id: input.supplyId ?? null,
    title: input.title ?? 'КОМПЛЕКТОВОЧНЫЙ ЛИСТ FBS',
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000); // 60s cap — sidecar is CPU-bound

  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, '')}/generate-slip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidecar-Token': token,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new FbsSidecarUnavailableError(
      `FBS sidecar unreachable: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.error({ status: res.status, detail: detail.slice(0, 500) }, 'sidecar generate-slip failed');
    throw new Error(`FBS sidecar error ${res.status}: ${detail.slice(0, 200)}`);
  }

  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}
