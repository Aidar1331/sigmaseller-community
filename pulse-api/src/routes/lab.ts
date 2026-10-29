/**
 * Лаборатория корреляций — REST API.
 *
 * Shop-isolation invariant: every endpoint REQUIRES shopId in query. We never
 * fall back to workspace-wide aggregation — different shops have different
 * product mixes and correlating them together produces spurious signals.
 * If a workspace has multiple shops, the UI must pick one.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../plugins/roleCheck.js';
import { log as rootLog } from '../lib/logger.js';
import {
  METRICS,
  DEFAULT_MATRIX_METRICS,
  type MetricKey,
} from '../services/lab/metrics.js';
// MetricKey уже импортирован выше — best-combo использует его.
import { advisePeriod, countDays } from '../services/lab/periodAdvisor.js';
import { buildMetricSeries } from '../services/lab/buildMetricSeries.js';
import { runPair } from '../services/lab/runPair.js';
import { runMatrix } from '../services/lab/runMatrix.js';
import { rankInsights } from '../services/lab/insightEngine.js';
import { priceElasticity } from '../lib/stat/elasticity.js';
import { alignPair } from '../lib/stat/series.js';
import { HYPOTHESES } from '../services/lab/hypothesisRegistry.js';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

const log = rootLog.child({ module: 'lab' }); // lab routes registered

// ---------------------------------------------------------------------------
// Shared validators
// ---------------------------------------------------------------------------

const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];

const baseQuery = z.object({
  shopId: z.coerce.number().int().positive({ message: 'shopId is REQUIRED and must be positive' }),
  nmId: z.coerce.bigint().positive().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD'),
});

const metricEnum = z.enum(METRIC_KEYS as [MetricKey, ...MetricKey[]]);

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const labRoutes: FastifyPluginAsync = async (app) => {
  // --- 1. Hypothesis registry (static) -------------------------------------
  app.get('/lab/hypotheses', { preHandler: requireRole('viewer') }, async () => {
    return {
      ok: true,
      hypotheses: HYPOTHESES.map(h => ({
        id: h.id,
        category: h.category,
        priority: h.priority,
        metricsPair: h.metricsPair,
        resolution: h.resolution,
        expectedSign: h.expectedSign,
        hypothesis: h.hypothesis,
        noiseRisk: h.noiseRisk,
        mvpEnabled: h.mvpEnabled,
      })),
    };
  });

  app.get('/lab/metrics', { preHandler: requireRole('viewer') }, async () => {
    return { ok: true, metrics: Object.values(METRICS) };
  });

  // --- 2. Period advice -----------------------------------------------------
  app.get('/lab/:workspaceId/period-advice', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const q = z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(req.query);
    const n = countDays(q.from, q.to);
    const advice = advisePeriod(n);
    return { ok: true, workspaceId, ...advice };
  });

  // --- 3. Pair analysis -----------------------------------------------------
  // Возвращает базовый RunPair + опционально массив точек scatter + параметры
  // линии регрессии для PriceImpactChart виджета.
  app.get('/lab/:workspaceId/pair', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const q = baseQuery.extend({
      x: metricEnum,
      y: metricEnum,
      excludeHolidays: z.coerce.boolean().optional(),
      withLag: z.coerce.boolean().optional(),
      withScatter: z.coerce.boolean().optional(),
    }).parse(req.query);

    const res = await runPair({
      workspaceId,
      shopId: q.shopId,
      nmId: q.nmId ?? null,
      dateFrom: q.from,
      dateTo: q.to,
      x: q.x,
      y: q.y,
      excludeHolidays: q.excludeHolidays ?? true,
      withLag: q.withLag ?? true,
    });

    let scatter: Array<{ x: number; y: number; date: string }> | null = null;
    let regression: { slope: number; intercept: number } | null = null;
    if (q.withScatter) {
      const [xs, ys] = await Promise.all([
        buildMetricSeries({
          workspaceId, shopId: q.shopId, nmId: q.nmId ?? null,
          dateFrom: q.from, dateTo: q.to, metric: q.x,
        }),
        buildMetricSeries({
          workspaceId, shopId: q.shopId, nmId: q.nmId ?? null,
          dateFrom: q.from, dateTo: q.to, metric: q.y,
        }),
      ]);
      const pts: Array<{ x: number; y: number; date: string }> = [];
      for (let i = 0; i < xs.values.length; i++) {
        const xv = xs.values[i];
        const yv = ys.values[i];
        if (xv == null || yv == null || !Number.isFinite(xv) || !Number.isFinite(yv)) continue;
        pts.push({ x: xv as number, y: yv as number, date: xs.dates[i] });
      }
      scatter = pts;
      // OLS линия y = a + b*x
      if (pts.length >= 3) {
        const n = pts.length;
        const mx = pts.reduce((s, p) => s + p.x, 0) / n;
        const my = pts.reduce((s, p) => s + p.y, 0) / n;
        let num = 0, den = 0;
        for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
        if (den > 1e-12) {
          const slope = num / den;
          regression = { slope, intercept: my - slope * mx };
        }
      }
    }

    return { ok: true, workspaceId, ...res, scatter, regression };
  });

  // --- 3b. Lag profile --------------------------------------------------
  // Для AdsDelayChart / ProductTimeline отдельный lightweight endpoint.
  app.get('/lab/:workspaceId/lag', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const q = baseQuery.extend({
      x: metricEnum,
      y: metricEnum,
      maxLag: z.coerce.number().int().min(3).max(21).optional(),
      excludeHolidays: z.coerce.boolean().optional(),
    }).parse(req.query);

    const res = await runPair({
      workspaceId,
      shopId: q.shopId,
      nmId: q.nmId ?? null,
      dateFrom: q.from,
      dateTo: q.to,
      x: q.x,
      y: q.y,
      excludeHolidays: q.excludeHolidays ?? true,
      withLag: true,
    });
    return {
      ok: true,
      workspaceId,
      lag: res.lag,
      n: res.n,
      sparsity: res.sparsity.verdict,
    };
  });

  // --- 4. N×N matrix --------------------------------------------------------
  app.get('/lab/:workspaceId/matrix', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const q = baseQuery.extend({
      metrics: z.string().optional(), // csv
      excludeHolidays: z.coerce.boolean().optional(),
      fdrQ: z.coerce.number().min(0.01).max(0.5).optional(),
    }).parse(req.query);

    const metrics = q.metrics
      ? q.metrics.split(',').map(s => s.trim()).filter(Boolean) as MetricKey[]
      : DEFAULT_MATRIX_METRICS;

    // Fail fast on unknown metric keys — cleaner error than inside SQL
    for (const m of metrics) {
      if (!(m in METRICS)) {
        return reply.code(400).send({ ok: false, error: `Unknown metric: ${m}` });
      }
    }

    const res = await runMatrix({
      workspaceId,
      shopId: q.shopId,
      nmId: q.nmId ?? null,
      dateFrom: q.from,
      dateTo: q.to,
      metrics,
      excludeHolidays: q.excludeHolidays ?? true,
      fdrQ: q.fdrQ ?? 0.1,
    });

    return { ok: true, workspaceId, ...res };
  });

  // --- 5. Elasticity --------------------------------------------------------
  app.get('/lab/:workspaceId/elasticity', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const q = baseQuery.parse(req.query);

    // Elasticity is meaningful only at nmId level (shop aggregate hides the
    // price-quantity relationship under category mix-effects).
    if (q.nmId == null) {
      return reply.code(400).send({ ok: false, error: 'nmId is required for elasticity (shop aggregates dilute the price-quantity signal)' });
    }

    const priceSeries = await buildMetricSeries({
      workspaceId, shopId: q.shopId, nmId: q.nmId,
      dateFrom: q.from, dateTo: q.to, metric: 'finishedPriceRub',
    });
    const qtySeries = await buildMetricSeries({
      workspaceId, shopId: q.shopId, nmId: q.nmId,
      dateFrom: q.from, dateTo: q.to, metric: 'ordersCount',
    });

    // Align to drop NULL days on either side
    const aligned = alignPair(priceSeries.values, qtySeries.values);
    const rep = priceElasticity(aligned.x, aligned.y);

    return {
      ok: true,
      workspaceId,
      shopId: q.shopId,
      nmId: q.nmId.toString(),
      dateFrom: q.from,
      dateTo: q.to,
      elasticity: rep,
    };
  });

  // --- 6. Insights ----------------------------------------------------------
  app.get('/lab/:workspaceId/insights', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const q = baseQuery.extend({
      metrics: z.string().optional(),
      excludeHolidays: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(30).optional(),
    }).parse(req.query);

    const metrics = q.metrics
      ? q.metrics.split(',').map(s => s.trim()).filter(Boolean) as MetricKey[]
      : DEFAULT_MATRIX_METRICS;

    // Approach: run pair analysis for every hypothesis-relevant pair among
    // the requested metrics. The registry tells us which pairs carry a
    // business interpretation; others are covered by the matrix endpoint.
    const pairSet = new Set<string>();
    const pairs: Array<[MetricKey, MetricKey]> = [];
    for (const h of HYPOTHESES) {
      if (!h.mvpEnabled) continue;
      const [a, b] = h.metricsPair;
      if (!metrics.includes(a) || !metrics.includes(b)) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (pairSet.has(key)) continue;
      pairSet.add(key);
      pairs.push([a, b]);
    }

    if (pairs.length === 0) {
      return { ok: true, workspaceId, critical: [], growthPoints: [], falseAlarms: [] };
    }

    const pairResults = await Promise.all(
      pairs.map(([x, y]) => runPair({
        workspaceId,
        shopId: q.shopId,
        nmId: q.nmId ?? null,
        dateFrom: q.from,
        dateTo: q.to,
        x, y,
        excludeHolidays: q.excludeHolidays ?? true,
        withLag: true,
      }).catch(err => {
        log.warn({ err: err.message, x, y }, 'runPair failed; skipping');
        return null;
      })),
    );

    const ranked = rankInsights(pairResults.filter(r => r != null) as Awaited<ReturnType<typeof runPair>>[]);
    const limit = q.limit ?? 20;
    return {
      ok: true,
      workspaceId,
      critical: ranked.filter(i => i.category === 'critical').slice(0, limit),
      growthPoints: ranked.filter(i => i.category === 'growth_point').slice(0, limit),
      falseAlarms: ranked.filter(i => i.category === 'false_alarm').slice(0, limit),
      totalPairsEvaluated: pairs.length,
    };
  });
  // --- 7. Product timeline --------------------------------------------------
  // Ключевые моменты истории товара: change-points по заказам + атрибуция
  // событий из v_product_events (смена фото/цены/характеристик).
  app.get('/lab/:workspaceId/timeline', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const q = baseQuery.parse(req.query);
    if (q.nmId == null) {
      return reply.code(400).send({ ok: false, error: 'nmId обязателен для истории товара' });
    }
    let eventRows: Array<Record<string, unknown>> = [];
    try {
      const res = await db.execute(sql`
        SELECT ts, event_type, source, diff_summary
        FROM v_product_events
        WHERE workspace_id = ${workspaceId}
          AND shop_id      = ${q.shopId}
          AND nm_id        = ${q.nmId!.toString()}::bigint
          AND ts::date BETWEEN ${q.from}::date AND ${q.to}::date
        ORDER BY ts DESC
        LIMIT 200
      `);
      eventRows = res.rows as Array<Record<string, unknown>>;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'v_product_events query failed (migration 0119 not applied?)');
    }

    // Change-points по ordersCount — простая эвристика на mean-shift
    const ordersSeries = await buildMetricSeries({
      workspaceId, shopId: q.shopId, nmId: q.nmId, dateFrom: q.from, dateTo: q.to, metric: 'ordersCount',
    });
    const points = simpleChangePoints(ordersSeries.dates, ordersSeries.values);

    return {
      ok: true,
      workspaceId,
      events: eventRows.map(r => ({
        ts: r.ts,
        type: r.event_type,
        source: r.source,
        summary: r.diff_summary,
      })),
      changePoints: points,
    };
  });

  // --- 8. Price sensitivity (human-friendly elasticity) --------------------
  app.get('/lab/:workspaceId/price-sensitivity', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const q = baseQuery.parse(req.query);
    if (q.nmId == null) {
      return reply.code(400).send({ ok: false, error: 'nmId обязателен для анализа чувствительности' });
    }
    const priceSeries = await buildMetricSeries({
      workspaceId, shopId: q.shopId, nmId: q.nmId,
      dateFrom: q.from, dateTo: q.to, metric: 'finishedPriceRub',
    });
    const qtySeries = await buildMetricSeries({
      workspaceId, shopId: q.shopId, nmId: q.nmId,
      dateFrom: q.from, dateTo: q.to, metric: 'ordersCount',
    });
    const aligned = alignPair(priceSeries.values, qtySeries.values);
    const rep = priceElasticity(aligned.x, aligned.y);

    // Маппим технический E в человеческий градиент 0..3
    // -0.5 → «низкая», -1 → «умеренная», -1.5+ → «высокая», >0 → «парадокс»
    let bucket: 'none' | 'low' | 'moderate' | 'high' | 'paradox' | 'insufficient' = 'insufficient';
    if (rep.status === 'ok') {
      if (rep.E > 0.1) bucket = 'paradox';
      else if (rep.E > -0.3) bucket = 'none';
      else if (rep.E > -0.9) bucket = 'low';
      else if (rep.E > -1.3) bucket = 'moderate';
      else bucket = 'high';
    }
    const humanText = rep.status === 'ok'
      ? `При снижении цены на 10% заказы изменятся примерно на ${(rep.E * -10).toFixed(0)}%`
      : 'Недостаточно данных для оценки чувствительности.';

    return {
      ok: true,
      workspaceId,
      bucket,
      humanText,
      // Для тех кому нужны цифры (AI-агент) — отдаём E и CI, UI их не показывает
      details: rep.status === 'ok' ? {
        elasticityValue: rep.E,
        ci95: rep.ci95,
        r2: rep.r2,
        n: rep.n,
      } : null,
      status: rep.status,
    };
  });

  // --- 8b. Card snapshots around a date ------------------------------------
  // Возвращает последние 2 снапшота товара до указанной даты включительно —
  // для diff-view в Канбане (CardChangeTimelineWidget).
  app.get('/lab/:workspaceId/card-snapshots', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const q = baseQuery.parse(req.query);
    if (q.nmId == null) {
      return reply.code(400).send({ ok: false, error: 'nmId обязателен' });
    }
    try {
      const res = await db.execute(sql`
        SELECT snapshot_date::text, title, description, brand, photos
        FROM wb_card_snapshots
        WHERE workspace_id = ${workspaceId}
          AND shop_id      = ${q.shopId}
          AND nm_id        = ${q.nmId!.toString()}::bigint
          AND snapshot_date <= ${q.to}::date
        ORDER BY snapshot_date DESC
        LIMIT 2
      `);
      return { ok: true, snapshots: res.rows };
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'card-snapshots query failed (migration 0118 not applied?)');
      return { ok: true, snapshots: [] };
    }
  });

  // --- 8c. Best combo (лучшие дни товара по выручке + контекст метрик) -----
  // Берёт топ-5 дней по salesRub за период и собирает на эти даты комплект
  // ключевых метрик. Помогает пользователю увидеть «при каком ДРР, цене и
  // CTR товар приносил максимум».
  app.get('/lab/:workspaceId/best-combo', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { workspaceId } = z.object({
      workspaceId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const q = baseQuery.parse(req.query);
    if (q.nmId == null) {
      return reply.code(400).send({ ok: false, error: 'nmId обязателен для лучшей комбинации' });
    }

    const metricsToFetch: MetricKey[] = [
      'ordersCount', 'salesRub', 'finishedPriceRub',
      'ctrPercent', 'crPercent',
      'advSpendRub', 'drrPercent',
      'stockQty',
    ];
    const series = await Promise.all(
      metricsToFetch.map(m => buildMetricSeries({
        workspaceId, shopId: q.shopId, nmId: q.nmId!,
        dateFrom: q.from, dateTo: q.to, metric: m,
      })),
    );

    type Row = { date: string } & Partial<Record<MetricKey, number | null>>;
    const byDate = new Map<string, Row>();
    series.forEach((s, idx) => {
      const key = metricsToFetch[idx];
      s.dates.forEach((d, i) => {
        let row = byDate.get(d);
        if (!row) { row = { date: d }; byDate.set(d, row); }
        row[key] = s.values[i];
      });
    });

    const allRows = Array.from(byDate.values());
    const sortedBySales = [...allRows]
      .filter(r => Number.isFinite(r.salesRub) && (r.salesRub ?? 0) > 0)
      .sort((a, b) => (b.salesRub ?? 0) - (a.salesRub ?? 0));
    const topDays = sortedBySales.slice(0, 5);

    if (topDays.length === 0) {
      return { ok: true, workspaceId, days: [], successFormula: [], commentary: 'За период нет дней с продажами для составления лучшей комбинации.' };
    }

    // === successFormula: Q25/Q50/Q75 в корзине топ-30% дней по продажам ===
    const bucketSize = Math.max(3, Math.floor(sortedBySales.length * 0.3));
    const topBucket = sortedBySales.slice(0, bucketSize);
    const quantile = (sorted: number[], q: number): number => {
      if (sorted.length === 0) return NaN;
      const pos = (sorted.length - 1) * q;
      const lo = Math.floor(pos);
      const hi = Math.ceil(pos);
      if (lo === hi) return sorted[lo];
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    };
    const formulaMetrics: MetricKey[] = ['finishedPriceRub', 'drrPercent', 'ctrPercent', 'advSpendRub', 'stockQty'];
    const successFormula = formulaMetrics.map(metric => {
      const vals = topBucket
        .map(d => d[metric])
        .filter((v): v is number => Number.isFinite(v as number)) as number[];
      if (vals.length < 3) return null;
      const sorted = [...vals].sort((a, b) => a - b);
      const p25 = quantile(sorted, 0.25);
      const p50 = quantile(sorted, 0.5);
      const p75 = quantile(sorted, 0.75);
      const iqrPct = Math.abs(p50) > 1e-9 ? (p75 - p25) / Math.abs(p50) : 0;
      const label: 'stable' | 'range' = iqrPct < 0.05 ? 'stable' : 'range';
      return { metric, p25, p50, p75, iqrPct, label, n: vals.length };
    }).filter((v): v is NonNullable<typeof v> => v !== null);

    // Средние значения для сравнения «лучшие дни vs среднее по периоду»
    const avg = (key: MetricKey): number | null => {
      const vals = allRows
        .map(r => r[key])
        .filter((v): v is number => Number.isFinite(v as number)) as number[];
      if (vals.length === 0) return null;
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    };
    const avgs = Object.fromEntries(metricsToFetch.map(m => [m, avg(m)])) as Record<MetricKey, number | null>;

    // Комментарий: лучшие дни «средняя цена» и «средний ДРР»
    const topPrices = topDays.map(d => d.finishedPriceRub).filter((v): v is number => Number.isFinite(v as number)) as number[];
    const topDrr = topDays.map(d => d.drrPercent).filter((v): v is number => Number.isFinite(v as number)) as number[];
    const avgTopPrice = topPrices.length ? topPrices.reduce((s, v) => s + v, 0) / topPrices.length : null;
    const avgTopDrr = topDrr.length ? topDrr.reduce((s, v) => s + v, 0) / topDrr.length : null;

    const commentary = buildBestComboCommentary({
      avgTopPrice, avgPrice: avgs.finishedPriceRub,
      avgTopDrr, avgDrr: avgs.drrPercent,
    });

    return {
      ok: true,
      workspaceId,
      days: topDays,
      averagesOverPeriod: avgs,
      successFormula,
      commentary,
    };
  });

  // --- 9. Admin: force snapshot now ----------------------------------------
  app.post('/admin/wb/snapshot-now', { preHandler: requireRole('manager') }, async (req) => {
    const body = z.object({
      workspaceId: z.coerce.number().int().positive().optional(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse((req as { body?: unknown }).body ?? {});
    const { runWbCardSnapshot } = await import('../jobs/wbCardSnapshotDaily.js');
    const res = await runWbCardSnapshot({
      workspaceIds: body.workspaceId != null ? [body.workspaceId] : null,
      shopId: body.shopId ?? null,
    });
    return { ok: true, ...res };
  });

  // --- 9b. Admin: backfill card-change events ------------------------------
  // Прогоняет уже накопленные wb_card_snapshots с непустым changes_from_prev
  // и публикует их в wb_events. Идемпотентно (fingerprint guard в INSERT).
  app.post('/admin/wb/backfill-card-events', { preHandler: requireRole('manager') }, async (req) => {
    const body = z.object({
      workspaceId: z.coerce.number().int().positive().optional(),
      shopId: z.coerce.number().int().positive().optional(),
    }).parse((req as { body?: unknown }).body ?? {});
    const { backfillCardEvents } = await import('../jobs/wbCardSnapshotDaily.js');
    const res = await backfillCardEvents({
      workspaceId: body.workspaceId ?? null,
      shopId: body.shopId ?? null,
    });
    return { ok: true, ...res };
  });
};

function buildBestComboCommentary(args: {
  avgTopPrice: number | null;
  avgPrice: number | null;
  avgTopDrr: number | null;
  avgDrr: number | null;
}): string[] {
  const tips: string[] = [];
  if (args.avgTopPrice != null && args.avgPrice != null && args.avgPrice > 0) {
    const delta = ((args.avgTopPrice - args.avgPrice) / args.avgPrice) * 100;
    if (Math.abs(delta) >= 3) {
      const direction = delta > 0 ? 'выше' : 'ниже';
      tips.push(
        `В лучшие дни цена была ${direction} среднего на ${Math.abs(delta).toFixed(0)}% ` +
        `(${args.avgTopPrice.toFixed(0)}₽ против ${args.avgPrice.toFixed(0)}₽). ` +
        (delta < 0
          ? 'Снижение цены работает — попробуйте удержать этот уровень дольше.'
          : 'Цена не мешала продажам — повышение не критично.'),
      );
    } else {
      tips.push('В лучшие дни цена была близка к среднему — драйвер не в цене.');
    }
  }
  if (args.avgTopDrr != null && args.avgDrr != null && args.avgDrr > 0) {
    const delta = args.avgTopDrr - args.avgDrr;
    if (args.avgTopDrr < 15 && args.avgDrr > 20) {
      tips.push('В лучшие дни ДРР держался ниже среднего — окупаемая реклама совпадала с ростом продаж.');
    } else if (delta > 5) {
      tips.push('В лучшие дни ДРР был выше среднего — продажи росли вместе с агрессивным рекламным бюджетом.');
    } else if (delta < -5) {
      tips.push('В лучшие дни ДРР был заметно ниже — рост продаж шёл органически, не из рекламы.');
    }
  }
  if (tips.length === 0) {
    tips.push('Сравните выделенные дни по другим метрикам в таблице — возможно, секрет в CTR или остатках.');
  }
  return tips;
}

// Simple mean-shift change-point detector (without BIC penalty — достаточен для MVP
// UI timeline; AI-агент получает более полный через PELT в v2).
function simpleChangePoints(
  dates: string[],
  values: Array<number | null>,
): Array<{ date: string; meanBefore: number; meanAfter: number; deltaPct: number }> {
  const nums: Array<{ d: string; v: number }> = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) nums.push({ d: dates[i], v: v as number });
  }
  if (nums.length < 14) return [];
  const out: Array<{ date: string; meanBefore: number; meanAfter: number; deltaPct: number }> = [];
  const window = 7;
  for (let i = window; i < nums.length - window; i++) {
    const before = nums.slice(i - window, i).reduce((s, p) => s + p.v, 0) / window;
    const after = nums.slice(i, i + window).reduce((s, p) => s + p.v, 0) / window;
    if (before < 1e-9) continue;
    const delta = (after - before) / before;
    if (Math.abs(delta) >= 0.25) {
      out.push({
        date: nums[i].d,
        meanBefore: Math.round(before * 100) / 100,
        meanAfter: Math.round(after * 100) / 100,
        deltaPct: Math.round(delta * 100),
      });
      i += window; // чтобы не дублировать соседние точки
    }
  }
  return out;
}

export default labRoutes;
