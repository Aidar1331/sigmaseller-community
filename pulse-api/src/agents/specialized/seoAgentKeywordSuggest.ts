/**
 * SEO Keyword Suggestion Agent.
 *
 * Цель: найти поисковые запросы, по которым твои товары **уже получают
 * клики и заказы** из WB-поиска, но которые **не отслеживаются** в
 * `seo_keywords`. Агент предлагает добавить их на мониторинг позиций.
 *
 * Источник: `wb_search_queries` (Jam-отчёт WB, обновляется searchQueriesSync).
 * Окно: последние 14 дней.
 */

import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { seoKeywords, wbCards, wbSearchQueries } from '../../db/schema.js';

export interface KeywordCandidate {
  keyword: string;
  score: number;
  views: number;
  clicks: number;
  orders: number;
  ctrPct: number;
  avgPosition: number | null;
  relatedNmIds: number[];
  sampleTitle: string | null;
  alreadyTracked: boolean;
  reason: string;
}

export interface KeywordSuggestResult {
  summary: string;
  candidates: KeywordCandidate[];
}

const WINDOW_DAYS = 14;
const MIN_VIEWS = 50;
const MIN_LEN = 2;
const MAX_LEN = 60;
const DEFAULT_LIMIT = 30;

export async function runSeoKeywordSuggest(
  workspaceId: number,
  shopId?: number | null,
  opts: { limit?: number; includeTracked?: boolean } = {},
): Promise<KeywordSuggestResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const sinceDate = new Date(Date.now() - WINDOW_DAYS * 86_400_000);

  // 1. Агрегируем запросы за 14 дней: топ по показам/кликам/заказам
  const conds = [
    eq(wbSearchQueries.workspaceId, workspaceId),
    gte(wbSearchQueries.date, sinceDate),
  ];
  if (shopId != null) conds.push(eq(wbSearchQueries.shopId, shopId));

  const raw = await db
    .select({
      query: wbSearchQueries.query,
      nmId: wbSearchQueries.nmId,
      views: sql<number>`coalesce(sum(${wbSearchQueries.views}), 0)`.mapWith(Number),
      clicks: sql<number>`coalesce(sum(${wbSearchQueries.clicks}), 0)`.mapWith(Number),
      orders: sql<number>`coalesce(sum(${wbSearchQueries.orders}), 0)`.mapWith(Number),
      avgPosition: sql<number | null>`avg(${wbSearchQueries.position})`.mapWith((v) => (v == null ? null : Number(v))),
    })
    .from(wbSearchQueries)
    .where(and(...conds))
    .groupBy(wbSearchQueries.query, wbSearchQueries.nmId);

  if (raw.length === 0) {
    return {
      summary: 'Нет данных о поисковых запросах за последние 14 дней (включи Jam-отчёт WB и запусти search-queries sync).',
      candidates: [],
    };
  }

  // 2. Группируем по keyword → суммарные метрики + список nmId
  type Agg = {
    keyword: string;
    views: number;
    clicks: number;
    orders: number;
    positions: number[];
    nmIds: Set<number>;
  };
  const byKw = new Map<string, Agg>();
  for (const r of raw) {
    const kw = (r.query || '').trim().toLowerCase();
    if (kw.length < MIN_LEN || kw.length > MAX_LEN) continue;
    let a = byKw.get(kw);
    if (!a) {
      a = { keyword: kw, views: 0, clicks: 0, orders: 0, positions: [], nmIds: new Set() };
      byKw.set(kw, a);
    }
    a.views += r.views;
    a.clicks += r.clicks;
    a.orders += r.orders;
    if (r.avgPosition != null && !Number.isNaN(r.avgPosition)) a.positions.push(r.avgPosition);
    if (r.nmId) a.nmIds.add(r.nmId);
  }

  // 3. Отсекаем шум: минимум MIN_VIEWS показов
  const aggList = Array.from(byKw.values()).filter((a) => a.views >= MIN_VIEWS);

  // 4. Помечаем уже отслеживаемые
  const trackedRows = await db
    .select({ keyword: seoKeywords.keyword })
    .from(seoKeywords)
    .where(eq(seoKeywords.workspaceId, workspaceId));
  const tracked = new Set(trackedRows.map((r) => r.keyword.toLowerCase()));

  // 5. Подтянем названия товаров для контекста
  const allNmIds = Array.from(new Set(aggList.flatMap((a) => Array.from(a.nmIds))));
  const titles = new Map<number, string>();
  if (allNmIds.length > 0) {
    const chunks = [];
    for (let i = 0; i < allNmIds.length; i += 500) chunks.push(allNmIds.slice(i, i + 500));
    for (const ch of chunks) {
      const cards = await db
        .select({ nmId: wbCards.nmId, title: wbCards.title })
        .from(wbCards)
        .where(and(eq(wbCards.workspaceId, workspaceId), inArray(wbCards.nmId, ch)));
      for (const c of cards) if (c.title) titles.set(c.nmId, c.title);
    }
  }

  // 6. Скоринг и сортировка
  const scored: KeywordCandidate[] = aggList.map((a) => {
    const ctrPct = a.views > 0 ? (a.clicks / a.views) * 100 : 0;
    const avgPosition = a.positions.length > 0
      ? a.positions.reduce((s, p) => s + p, 0) / a.positions.length
      : null;
    const score = a.clicks * 2 + a.orders * 10 + Math.log(Math.max(1, a.views));
    const sampleNm = Array.from(a.nmIds)[0];
    const sampleTitle = sampleNm ? titles.get(sampleNm) ?? null : null;
    const alreadyTracked = tracked.has(a.keyword);

    const reasonParts: string[] = [];
    if (a.orders > 0) reasonParts.push(`${a.orders} заказ(ов)`);
    if (a.clicks > 0) reasonParts.push(`${a.clicks} клик(ов)`);
    reasonParts.push(`${a.views} показов`);
    if (avgPosition != null) reasonParts.push(`средняя позиция ${Math.round(avgPosition)}`);
    const reason = `За 14 дней: ${reasonParts.join(', ')}. Товаров: ${a.nmIds.size}.`
      + (alreadyTracked ? ' Уже отслеживается.' : '');

    return {
      keyword: a.keyword,
      score,
      views: a.views,
      clicks: a.clicks,
      orders: a.orders,
      ctrPct: Math.round(ctrPct * 10) / 10,
      avgPosition: avgPosition != null ? Math.round(avgPosition) : null,
      relatedNmIds: Array.from(a.nmIds).slice(0, 10),
      sampleTitle,
      alreadyTracked,
      reason,
    };
  });

  // Фильтр: если includeTracked=false (по умолчанию), показываем только неотслеживаемые
  const filtered = opts.includeTracked
    ? scored
    : scored.filter((c) => !c.alreadyTracked);
  filtered.sort((a, b) => b.score - a.score);
  const candidates = filtered.slice(0, limit);

  const total = filtered.length;
  const summary = candidates.length > 0
    ? `Найдено ${total} поисковых запроса с трафиком на ваши карточки, не отслеживаемых в SEO. Топ-${candidates.length} ниже.`
    : 'Все значимые поисковые запросы уже отслеживаются — прогрессивно!';

  return { summary, candidates };
}
