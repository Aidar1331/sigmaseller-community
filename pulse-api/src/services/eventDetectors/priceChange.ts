import { and, desc, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { wbEvents, wbOrdersSalesDailyProducts, wbPricesHistory, wbSppWeekly } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import { fetchPublicCard } from '../../integrations/wb/publicCard.js';

const logger = log.child({ module: 'detector:priceChange' });

const THRESHOLD_PCT = 5;
const THRESHOLD_ABS_RUB = 50;
// Для seller-price change (кабинет): отдельные пороги, потому что одно
// и то же изменение цены в кабинете сразу видно по prices_history, без
// "размытия" через средние продажи.
const SELLER_THRESHOLD_PCT = 2;
const SELLER_THRESHOLD_ABS_RUB = 20;
// Для СПП: WB меняет её часто на ±1-2%, ловим только заметные шаги.
const SPP_THRESHOLD_PCT_POINTS = 3; // разница в процентных пунктах (40% → 43%)

interface DetectorResult {
  workspaceId: number;
  comparedPairs: number;
  detected: number;
  inserted: number;
  skippedExisting: number;
  errors: number;
}

function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function priceFingerprint(workspaceId: number, nmId: number, date: string, direction: 'up' | 'down'): string {
  return `pricechange:${workspaceId}:${nmId}:${date}:${direction}`;
}

/**
 * Compare yesterday's vs day-before-yesterday's finished_price_rub for each
 * (workspace, shop, nm) and emit a `price` category event when the change
 * exceeds both the % threshold (5%) AND the absolute threshold (50 ₽).
 *
 * Note: `finished_price_rub` is the average sold-price for that day — it
 * blends seller-set price, SPP and other discounts. So this is a "price
 * signal" detector, not a "seller changed sticker price" detector. The
 * `evidence.note` documents that.
 *
 * @param workspaceId workspace to scan
 * @param compareDate the "today" date — comparison is `compareDate vs compareDate-1`. Defaults to yesterday.
 */
export async function detectPriceChanges(
  workspaceId: number,
  compareDate?: string,
): Promise<DetectorResult> {
  const today = compareDate ?? ymdUtc(new Date(Date.now() - 86400_000));
  const yesterdayDate = new Date(today + 'T00:00:00Z');
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = ymdUtc(yesterdayDate);

  const result: DetectorResult = {
    workspaceId,
    comparedPairs: 0,
    detected: 0,
    inserted: 0,
    skippedExisting: 0,
    errors: 0,
  };

  // CRITICAL: `finished_price_rub` in this table is sum(finishedPrice) over
  // all daily orders, in KOPECKS. NOT the unit price. To get the per-item
  // average sale price (which roughly matches what the seller sees in their
  // WB cabinet), divide by orders_count AND by 100. See schema.ts:656.
  type PriceRow = {
    nmId: number | null;
    shopId: number | null;
    date: string;
    finishedSum: number; // kopecks, summed across all orders that day
    ordersCount: number;
  };
  let rows: PriceRow[];
  try {
    const res = await db.execute<PriceRow>(sql`
      SELECT nm_id AS "nmId",
             shop_id AS "shopId",
             date::text AS "date",
             finished_price_rub AS "finishedSum",
             orders_count AS "ordersCount"
      FROM wb_orders_sales_daily_products
      WHERE workspace_id = ${workspaceId}
        AND date IN (${yesterday}, ${today})
        AND finished_price_rub > 0
        AND orders_count > 0
        AND nm_id IS NOT NULL
    `);
    rows = ((res as any).rows ?? res) as PriceRow[];
  } catch (err) {
    logger.error({ err, workspaceId, today, yesterday }, 'failed to load price data');
    result.errors = 1;
    return result;
  }

  // Group by nm_id
  const byNm = new Map<number, { prev?: PriceRow; curr?: PriceRow }>();
  for (const r of rows) {
    if (!r.nmId) continue;
    const slot = byNm.get(r.nmId) ?? {};
    if (r.date === yesterday) slot.prev = r;
    else if (r.date === today) slot.curr = r;
    byNm.set(r.nmId, slot);
  }

  type CandidatePayload = typeof wbEvents.$inferInsert;
  const candidates: { fingerprint: string; payload: CandidatePayload }[] = [];

  for (const [nmId, { prev, curr }] of byNm.entries()) {
    if (!prev || !curr) continue;
    result.comparedPairs += 1;

    // Per-unit average sale price = sum(finishedPrice kopecks) / ordersCount / 100.
    // Previous version divided only by 100 and got "daily revenue in rubles",
    // which produced 10x+ inflated values that didn't match the WB cabinet.
    const prevOrders = Number(prev.ordersCount) || 0;
    const currOrders = Number(curr.ordersCount) || 0;
    if (prevOrders <= 0 || currOrders <= 0) continue;

    const prevPriceRub = Number(prev.finishedSum) / prevOrders / 100;
    const currPriceRub = Number(curr.finishedSum) / currOrders / 100;
    if (!Number.isFinite(prevPriceRub) || !Number.isFinite(currPriceRub) || prevPriceRub <= 0) continue;

    const deltaRub = currPriceRub - prevPriceRub;
    const deltaPct = (deltaRub / prevPriceRub) * 100;

    if (Math.abs(deltaPct) < THRESHOLD_PCT || Math.abs(deltaRub) < THRESHOLD_ABS_RUB) continue;
    result.detected += 1;

    const direction: 'up' | 'down' = deltaRub > 0 ? 'up' : 'down';
    const severity = Math.abs(deltaPct) >= 15 ? 'warn' : 'info';
    const priority = severity === 'warn' ? 'high' : 'medium';
    const sign = direction === 'up' ? '+' : '−';
    const arrow = direction === 'up' ? '↑' : '↓';
    const title = `${arrow} Цена ${nmId}: ${prevPriceRub.toFixed(0)} → ${currPriceRub.toFixed(0)} ₽ (${sign}${Math.abs(deltaPct).toFixed(1)}%)`;

    candidates.push({
      fingerprint: priceFingerprint(workspaceId, nmId, today, direction),
      payload: {
        workspaceId,
        shopId: curr.shopId ?? prev.shopId ?? null,
        nmId,
        date: today,
        time: null,
        type: severity === 'warn' ? 'alert' : 'log',
        category: 'price',
        severity,
        status: 'open',
        priority,
        title,
        description: `Средняя цена продажи изменилась день-к-дню. Учитывает скидку покупателя (СПП) и промо-скидки.`,
        evidence: {
          source: 'priceChange detector',
          prevDate: yesterday,
          prevPriceRub,
          currDate: today,
          currPriceRub,
          deltaRub: Number(deltaRub.toFixed(2)),
          deltaPct: Number(deltaPct.toFixed(2)),
          direction,
          note: 'finished_price_rub blends seller-set price + SPP/discounts. Stored as KOPECKS in DB, converted to ₽ here.',
        },
        tags: [],
        fingerprint: priceFingerprint(workspaceId, nmId, today, direction),
        source: 'system',
        sourceId: `priceChange:${workspaceId}:${nmId}:${today}`,
      },
    });
  }

  if (candidates.length === 0) return result;

  // Pre-check existing fingerprints
  const fingerprints = candidates.map((c) => c.fingerprint);
  let existing = new Set<string>();
  try {
    const existingRows = await db
      .select({ fingerprint: wbEvents.fingerprint })
      .from(wbEvents)
      .where(and(eq(wbEvents.workspaceId, workspaceId), inArray(wbEvents.fingerprint, fingerprints)));
    existing = new Set(existingRows.map((r) => r.fingerprint).filter((f): f is string => !!f));
  } catch (err) {
    logger.error({ err, workspaceId }, 'failed to pre-check existing fingerprints');
    result.errors = 1;
    return result;
  }

  const toInsert = candidates.filter((c) => !existing.has(c.fingerprint));
  result.skippedExisting = candidates.length - toInsert.length;

  if (toInsert.length === 0) return result;

  try {
    await db.insert(wbEvents).values(toInsert.map((c) => c.payload));
    result.inserted = toInsert.length;
  } catch (err) {
    logger.warn({ err, workspaceId, batchSize: toInsert.length }, 'bulk insert failed, falling back to per-row');
    for (const c of toInsert) {
      try {
        await db.insert(wbEvents).values(c.payload);
        result.inserted += 1;
      } catch (rowErr) {
        const msg = String((rowErr as any)?.message ?? '');
        if (msg.includes('wb_events_fingerprint_uniq') || msg.includes('duplicate key')) {
          result.skippedExisting += 1;
        } else {
          result.errors += 1;
          logger.error({ err: rowErr, fingerprint: c.fingerprint }, 'failed to insert price event');
        }
      }
    }
  }

  return result;
}

/**
 * Run the price-change detector across ALL workspaces. Called from the cron job.
 */
export async function detectPriceChangesAllWorkspaces(): Promise<{
  workspaces: number;
  totalDetected: number;
  totalInserted: number;
  totalErrors: number;
  perWorkspace: DetectorResult[];
}> {
  // Find workspaces that have sales data
  type WsRow = { workspaceId: number };
  const wsRes = await db.execute<WsRow>(sql`
    SELECT DISTINCT workspace_id AS "workspaceId"
    FROM wb_orders_sales_daily_products
    WHERE date >= (CURRENT_DATE - INTERVAL '2 days')::text
  `);
  const wsRows = ((wsRes as any).rows ?? wsRes) as WsRow[];

  let totalDetected = 0;
  let totalInserted = 0;
  let totalErrors = 0;
  const perWorkspace: DetectorResult[] = [];

  for (const { workspaceId } of wsRows) {
    try {
      const r = await detectPriceChanges(workspaceId);
      perWorkspace.push(r);
      totalDetected += r.detected;
      totalInserted += r.inserted;
      totalErrors += r.errors;
    } catch (err) {
      logger.error({ err, workspaceId }, 'detectPriceChanges failed for workspace');
      totalErrors += 1;
    }
  }

  logger.info(
    { workspaces: wsRows.length, totalDetected, totalInserted, totalErrors },
    'priceChange detector tick done',
  );

  return { workspaces: wsRows.length, totalDetected, totalInserted, totalErrors, perWorkspace };
}

// ─────────────────────────────────────────────────────────────────────────
// Seller-price-change detector (база+скидка продавца из wb_prices_history)
// ─────────────────────────────────────────────────────────────────────────

function sellerPriceFingerprint(workspaceId: number, nmId: number, date: string, direction: 'up' | 'down'): string {
  return `sellerprice:${workspaceId}:${nmId}:${date}:${direction}`;
}

/**
 * Сравнить «цену кабинета» (base × (1 - discount/100)) день-к-дню из
 * wb_prices_history и эмитить событие если продавец сам поменял цену.
 * Это отличается от detectPriceChanges (тот ловит изменение средней цены
 * ПРОДАЖ, включая СПП). Здесь чистый seller-side сигнал.
 */
export async function detectSellerPriceChanges(
  workspaceId: number,
  compareDate?: string,
): Promise<DetectorResult> {
  const today = compareDate ?? ymdUtc(new Date());
  const yesterdayDate = new Date(today + 'T00:00:00Z');
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = ymdUtc(yesterdayDate);

  const result: DetectorResult = {
    workspaceId,
    comparedPairs: 0,
    detected: 0,
    inserted: 0,
    skippedExisting: 0,
    errors: 0,
  };

  type Row = { nmId: number; shopId: number | null; date: string; price: number; discount: number | null };
  let rows: Row[];
  try {
    const res = await db.execute<Row>(sql`
      SELECT nm_id AS "nmId",
             shop_id AS "shopId",
             date::date::text AS "date",
             price,
             discount
      FROM wb_prices_history
      WHERE workspace_id = ${workspaceId}
        AND date::date IN (${yesterday}::date, ${today}::date)
        AND price > 0
    `);
    rows = ((res as any).rows ?? res) as Row[];
  } catch (err) {
    logger.error({ err, workspaceId, today, yesterday }, 'failed to load price history');
    result.errors = 1;
    return result;
  }

  const byNm = new Map<number, { prev?: Row; curr?: Row }>();
  for (const r of rows) {
    if (!r.nmId) continue;
    const slot = byNm.get(r.nmId) ?? {};
    if (r.date === yesterday) slot.prev = r;
    else if (r.date === today) slot.curr = r;
    byNm.set(r.nmId, slot);
  }

  // СПП per nm (последнее значение). Для расчёта цены покупателя.
  const sppMap = new Map<number, number>();
  try {
    const sppRes: any = await db.execute(sql`
      SELECT DISTINCT ON (nm_id) nm_id, spp_pct_bp
        FROM wb_spp_weekly
       WHERE workspace_id = ${workspaceId}
       ORDER BY nm_id, date_to DESC
    `);
    for (const r of ((sppRes.rows ?? sppRes) as any[])) {
      sppMap.set(Number(r.nm_id), Number(r.spp_pct_bp) || 0);
    }
  } catch { /* SPP — soft dep, не валим detector */ }

  type CandidatePayload = typeof wbEvents.$inferInsert;
  const candidates: { fingerprint: string; payload: CandidatePayload }[] = [];

  for (const [nmId, { prev, curr }] of byNm.entries()) {
    if (!prev || !curr) continue;
    result.comparedPairs += 1;

    // price хранится в копейках, переводим в рубли. discount — целые %.
    const prevPriceRub = Number(prev.price) / 100;
    const currPriceRub = Number(curr.price) / 100;
    const prevDisc = Number(prev.discount ?? 0);
    const currDisc = Number(curr.discount ?? 0);

    const prevFinalRub = Math.round(prevPriceRub * (100 - prevDisc) / 100);
    const currFinalRub = Math.round(currPriceRub * (100 - currDisc) / 100);
    if (prevFinalRub <= 0) continue;

    const deltaRub = currFinalRub - prevFinalRub;
    const deltaPct = (deltaRub / prevFinalRub) * 100;
    if (Math.abs(deltaPct) < SELLER_THRESHOLD_PCT || Math.abs(deltaRub) < SELLER_THRESHOLD_ABS_RUB) continue;
    result.detected += 1;

    const direction: 'up' | 'down' = deltaRub > 0 ? 'up' : 'down';
    const severity = Math.abs(deltaPct) >= 10 ? 'warn' : 'info';
    const priority = severity === 'warn' ? 'high' : 'medium';
    const arrow = direction === 'up' ? '↑' : '↓';
    const sign = direction === 'up' ? '+' : '−';
    const discChanged = prevDisc !== currDisc;
    // Терминология как в ЛК ВБ:
    //   «Цена до скидки» (прайс-лист продавца) — что было базой
    //   «Цена со скидкой» — после скидки продавца, что получит на счёт
    //   «Цена на сайте» — со СПП, что видит покупатель
    const sppBpHere = sppMap.get(nmId);
    const sppPctHere = sppBpHere && sppBpHere > 0 ? sppBpHere / 100 : 0;
    const prevBuyerHere = sppPctHere > 0 ? Math.round(prevFinalRub * (1 - sppPctHere / 100)) : prevFinalRub;
    let currBuyerHere = sppPctHere > 0 ? Math.round(currFinalRub * (1 - sppPctHere / 100)) : currFinalRub;
    // Точный fetch с витрины WB для текущей цены — это то что реально
    // видит покупатель в карточке. СПП в нашей БД хранится недельным
    // снапшотом и может расходиться с фактом на 1-3 п.п. Если витрина
    // отвечает — оверрайдим расчётную currBuyerHere.
    let livePriceSource: 'site' | 'calc' = 'calc';
    try {
      const pub: any = await fetchPublicCard(nmId);
      if (pub && Number.isFinite(pub.showcasePriceKop) && pub.showcasePriceKop > 0) {
        currBuyerHere = Math.round(pub.showcasePriceKop / 100);
        livePriceSource = 'site';
      }
    } catch { /* fallback — расчёт из СПП в БД */ }
    const title = sppPctHere > 0
      ? `${arrow} ${nmId}: цена на сайте ${prevBuyerHere} → ${currBuyerHere} ₽ (${sign}${Math.abs(deltaPct).toFixed(1)}%)`
      : `${arrow} ${nmId}: цена со скидкой ${prevFinalRub} → ${currFinalRub} ₽ (${sign}${Math.abs(deltaPct).toFixed(1)}%)`;

    candidates.push({
      fingerprint: sellerPriceFingerprint(workspaceId, nmId, today, direction),
      payload: {
        workspaceId,
        shopId: curr.shopId ?? prev.shopId ?? null,
        nmId,
        date: today,
        time: null,
        type: severity === 'warn' ? 'alert' : 'log',
        category: 'price',
        severity,
        status: 'open',
        priority,
        title,
        description: (() => {
          // Описание в порядке убывания (как в ЛК ВБ):
          //   Цена до скидки → Цена со скидкой → Цена на сайте
          const lines: string[] = [];
          lines.push(`Цена до скидки: ${prevPriceRub.toFixed(0)} → ${currPriceRub.toFixed(0)} ₽.`);
          lines.push(`Цена со скидкой ${currDisc}%: ${prevFinalRub} → ${currFinalRub} ₽ — что попадёт на счёт продавцу.`);
          if (sppPctHere > 0) {
            lines.push(`Цена на сайте (со СПП ${sppPctHere.toFixed(0)}%): ${prevBuyerHere} → ${currBuyerHere} ₽ — что видит покупатель.`);
          }
          if (discChanged) {
            lines.push(`Скидка продавца изменилась: ${prevDisc}% → ${currDisc}%.`);
          }
          return lines.join(' ');
        })(),
        evidence: {
          source: 'sellerPrice detector',
          prevDate: yesterday,
          prevPriceRub,
          prevDiscPct: prevDisc,
          prevFinalRub,
          currDate: today,
          currPriceRub,
          currDiscPct: currDisc,
          currFinalRub,
          deltaRub,
          deltaPct: Number(deltaPct.toFixed(2)),
          direction,
        },
        tags: [],
        fingerprint: sellerPriceFingerprint(workspaceId, nmId, today, direction),
        source: 'system',
        sourceId: `sellerPrice:${workspaceId}:${nmId}:${today}`,
      },
    });
  }

  return await insertWithDedup(workspaceId, candidates, result);
}

// ─────────────────────────────────────────────────────────────────────────
// SPP-change detector (СПП из wb_spp_weekly)
// ─────────────────────────────────────────────────────────────────────────

function sppFingerprint(workspaceId: number, nmId: number, dateTo: string, direction: 'up' | 'down'): string {
  return `spp:${workspaceId}:${nmId}:${dateTo}:${direction}`;
}

/**
 * Сравнить SPP последней недели vs предпоследней. WB меняет СПП постоянно,
 * ловим только заметные шаги (≥3 п.п.). Источник: wb_spp_weekly.
 */
export async function detectSppChanges(
  workspaceId: number,
): Promise<DetectorResult> {
  const result: DetectorResult = {
    workspaceId,
    comparedPairs: 0,
    detected: 0,
    inserted: 0,
    skippedExisting: 0,
    errors: 0,
  };

  // Берём для каждого nmId две последние недели подряд. Окно 30 дней
  // достаточное, чтобы поймать активные карточки. Старый sppWeekly не
  // пишет shop_id (NULL), поэтому игнорируем shop в фильтрации, но в
  // payload подтянем shop_id из price_history по тому же nmId.
  type Row = { nmId: number; dateTo: string; sppBp: number; shopId: number | null };
  let rows: Row[];
  try {
    const res = await db.execute<Row>(sql`
      WITH ranked AS (
        SELECT
          nm_id AS "nmId",
          date_to AS "dateTo",
          spp_pct_bp AS "sppBp",
          shop_id AS "shopId",
          ROW_NUMBER() OVER (PARTITION BY nm_id ORDER BY date_to DESC) AS rn
        FROM wb_spp_weekly
        WHERE workspace_id = ${workspaceId}
          AND date_to >= (CURRENT_DATE - INTERVAL '30 days')::text
          AND spp_pct_bp > 0
      )
      SELECT "nmId", "dateTo", "sppBp", "shopId" FROM ranked WHERE rn <= 2
    `);
    rows = ((res as any).rows ?? res) as Row[];
  } catch (err) {
    logger.error({ err, workspaceId }, 'failed to load SPP weekly');
    result.errors = 1;
    return result;
  }

  const byNm = new Map<number, Row[]>();
  for (const r of rows) {
    if (!r.nmId) continue;
    const arr = byNm.get(r.nmId) ?? [];
    arr.push(r);
    byNm.set(r.nmId, arr);
  }

  type CandidatePayload = typeof wbEvents.$inferInsert;
  const candidates: { fingerprint: string; payload: CandidatePayload }[] = [];

  for (const [nmId, arr] of byNm.entries()) {
    if (arr.length < 2) continue;
    // arr[0] — последняя неделя (rn=1), arr[1] — предыдущая (rn=2)
    const curr = arr[0]!;
    const prev = arr[1]!;
    result.comparedPairs += 1;

    const currPct = Number(curr.sppBp) / 100;
    const prevPct = Number(prev.sppBp) / 100;
    const deltaPp = currPct - prevPct;
    if (Math.abs(deltaPp) < SPP_THRESHOLD_PCT_POINTS) continue;
    result.detected += 1;

    const direction: 'up' | 'down' = deltaPp > 0 ? 'up' : 'down';
    const severity = Math.abs(deltaPp) >= 8 ? 'warn' : 'info';
    const priority = severity === 'warn' ? 'high' : 'medium';
    const arrow = direction === 'up' ? '↑' : '↓';
    const sign = direction === 'up' ? '+' : '−';
    const title = `${arrow} СПП ${nmId}: ${prevPct.toFixed(1)}% → ${currPct.toFixed(1)}% (${sign}${Math.abs(deltaPp).toFixed(1)} п.п.)`;

    candidates.push({
      fingerprint: sppFingerprint(workspaceId, nmId, curr.dateTo, direction),
      payload: {
        workspaceId,
        shopId: curr.shopId ?? prev.shopId ?? null,
        nmId,
        date: curr.dateTo,
        time: null,
        type: severity === 'warn' ? 'alert' : 'log',
        category: 'price',
        severity,
        status: 'open',
        priority,
        title,
        description: direction === 'up'
          ? `WB увеличил СПП на ${Math.abs(deltaPp).toFixed(1)} п.п. — витрина дешевле для покупателя, маржа продавца не меняется, но падает выручка к перечислению.`
          : `WB снизил СПП на ${Math.abs(deltaPp).toFixed(1)} п.п. — витринная цена выросла, может упасть конверсия.`,
        evidence: {
          source: 'sppChange detector',
          prevWeekEnd: prev.dateTo,
          prevSppPct: prevPct,
          currWeekEnd: curr.dateTo,
          currSppPct: currPct,
          deltaPp: Number(deltaPp.toFixed(2)),
          direction,
          note: 'SPP усреднена за неделю по wb_spp_weekly (ppvz_spp_prc из реализационного отчёта).',
        },
        tags: [],
        fingerprint: sppFingerprint(workspaceId, nmId, curr.dateTo, direction),
        source: 'system',
        sourceId: `spp:${workspaceId}:${nmId}:${curr.dateTo}`,
      },
    });
  }

  return await insertWithDedup(workspaceId, candidates, result);
}

/**
 * Общий helper для вставки кандидатов с проверкой fingerprint-дубликатов.
 */
async function insertWithDedup(
  workspaceId: number,
  candidates: { fingerprint: string; payload: typeof wbEvents.$inferInsert }[],
  result: DetectorResult,
): Promise<DetectorResult> {
  if (candidates.length === 0) return result;

  const fingerprints = candidates.map((c) => c.fingerprint);
  let existing = new Set<string>();
  try {
    const existingRows = await db
      .select({ fingerprint: wbEvents.fingerprint })
      .from(wbEvents)
      .where(and(eq(wbEvents.workspaceId, workspaceId), inArray(wbEvents.fingerprint, fingerprints)));
    existing = new Set(existingRows.map((r) => r.fingerprint).filter((f): f is string => !!f));
  } catch (err) {
    logger.error({ err, workspaceId }, 'failed to pre-check existing fingerprints');
    result.errors = 1;
    return result;
  }

  const toInsert = candidates.filter((c) => !existing.has(c.fingerprint));
  result.skippedExisting = candidates.length - toInsert.length;
  if (toInsert.length === 0) return result;

  try {
    await db.insert(wbEvents).values(toInsert.map((c) => c.payload));
    result.inserted = toInsert.length;
  } catch (err) {
    logger.warn({ err, workspaceId, batchSize: toInsert.length }, 'bulk insert failed, falling back to per-row');
    for (const c of toInsert) {
      try {
        await db.insert(wbEvents).values(c.payload);
        result.inserted += 1;
      } catch (rowErr) {
        const msg = String((rowErr as any)?.message ?? '');
        if (msg.includes('wb_events_fingerprint_uniq') || msg.includes('duplicate key')) {
          result.skippedExisting += 1;
        } else {
          result.errors += 1;
          logger.error({ err: rowErr, fingerprint: c.fingerprint }, 'failed to insert event');
        }
      }
    }
  }
  return result;
}

/**
 * Run all price-related detectors (sales-based, seller-side, SPP) across
 * all active workspaces. Replaces the old `detectPriceChangesAllWorkspaces`
 * entrypoint in cron — now wraps it together with seller & SPP detectors.
 */
export async function detectAllPriceEventsAllWorkspaces(): Promise<{
  workspaces: number;
  totalInserted: number;
  totalErrors: number;
}> {
  type WsRow = { workspaceId: number };
  const wsRes = await db.execute<WsRow>(sql`
    SELECT DISTINCT workspace_id AS "workspaceId"
    FROM marketplace_shops
    WHERE platform = 'wb' AND is_active = true
  `);
  const wsRows = ((wsRes as any).rows ?? wsRes) as WsRow[];

  let totalInserted = 0;
  let totalErrors = 0;

  for (const { workspaceId } of wsRows) {
    try {
      const a = await detectPriceChanges(workspaceId);
      const b = await detectSellerPriceChanges(workspaceId);
      const c = await detectSppChanges(workspaceId);
      totalInserted += a.inserted + b.inserted + c.inserted;
      totalErrors += a.errors + b.errors + c.errors;
      if (a.inserted + b.inserted + c.inserted > 0) {
        logger.info(
          { workspaceId, sales: a.inserted, seller: b.inserted, spp: c.inserted },
          'price events emitted',
        );
      }
    } catch (err) {
      logger.error({ err, workspaceId }, 'price detectors failed for workspace');
      totalErrors += 1;
    }
  }

  logger.info({ workspaces: wsRows.length, totalInserted, totalErrors }, 'price detectors tick done');
  return { workspaces: wsRows.length, totalInserted, totalErrors };
}
