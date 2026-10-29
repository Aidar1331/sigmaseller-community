import 'dotenv/config';
import { getWbApiKey as getApiKey } from './wbClient.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'funnelLookbackProbe' });

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

async function callFunnel(apiKey: string, nmId: number, start: string, end: string, attempt = 1): Promise<'ok' | 'too_old' | 'other_err'> {
  const url = 'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products/history';
  const body = { selectedPeriod: { start, end }, nmIds: [nmId] };

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30_000);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ac.signal,
  }).finally(() => clearTimeout(t));

  const text = await res.text();

  if (res.status === 429 && attempt <= 8) {
    const waitMs = Math.min(60_000, 1000 * 2 ** (attempt - 1));
    await sleep(waitMs);
    return callFunnel(apiKey, nmId, start, end, attempt + 1);
  }

  if (res.ok) return 'ok';

  if (res.status === 400 && text.includes('excess limit on days')) return 'too_old';

  return 'other_err';
}

async function discoverNmId(apiKey: string, dateFrom: string): Promise<number> {
  const url = `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${encodeURIComponent(dateFrom)}&flag=0`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) throw new Error(`sales list failed: ${res.status}`);
  const arr = await res.json();
  for (const row of Array.isArray(arr) ? arr : []) {
    if (typeof row?.nmId === 'number') return row.nmId;
  }
  throw new Error('Could not discover nmId from sales');
}

async function main() {
  const apiKey = await getApiKey();
  const end = process.env.END_DATE || isoDate(new Date());
  const maxDays = Number.parseInt(process.env.PROBE_MAX_DAYS || '365', 10);

  // pick nmId that definitely exists in recent activity
  const nmId = process.env.NM_ID ? Number(process.env.NM_ID) : await discoverNmId(apiKey, isoDate(addDays(new Date(end + 'T00:00:00Z'), -14)));

  // Binary search: find maximum allowed lookback where start = end - days
  let lo = 0;
  let hi = maxDays;
  let best = 0;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const start = isoDate(addDays(new Date(end + 'T00:00:00Z'), -mid));

    const r = await callFunnel(apiKey, nmId, start, end);
    logger.info({ daysBack: mid, start, result: r }, 'Probe result');

    if (r === 'ok') {
      best = mid;
      lo = mid + 1;
    } else if (r === 'too_old') {
      hi = mid - 1;
    } else {
      // unknown error: back off a bit and narrow conservatively
      await sleep(1500);
      hi = mid - 1;
    }

    await sleep(700);
  }

  const earliest = isoDate(addDays(new Date(end + 'T00:00:00Z'), -best));
  logger.info({ end, nmId, maxAllowedDaysBack: best, earliestAllowedStart: earliest }, 'Probe complete');
}

main().catch((e) => {
  logger.error({ err: e }, 'funnelLookbackProbe failed');
  process.exitCode = 1;
});
