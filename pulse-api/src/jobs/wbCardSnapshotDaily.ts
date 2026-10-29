/**
 * wb-card-snapshot-daily — ночной job полных снимков карточек WB.
 *
 * Контракт (plan §3 Gap-4, §5):
 *   1. Для каждого активного shop тянем `POST /content/v2/get/cards/list`.
 *   2. На каждый nmId пишем полный снимок в `wb_card_snapshots` (UPSERT по
 *      unique-index (ws, shop, nm, snapshot_date)) — повторный прогон за те
 *      же сутки просто перезаписывает строку, без дублей.
 *   3. Вычисляем `changes_from_prev` сравнением с вчерашним снимком по
 *      ключевым полям. На каждое изменение типа > 0 — также создаём запись
 *      в `wb_events` (Календарь Событий / Канбан), идемпотентно по
 *      `fingerprint`.
 *   4. Дедуп с Sigma Seller: если за последние 6 часов было `agent_actions`
 *      для того же nm_id с подходящим tool_name — событие не создаётся
 *      (Sigma-запись авторитетнее, там есть user_id).
 */

import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '../db/client.js';
import { getWbApiKey } from '../integrations/wb/wbClient.js';
import { logJobs as logger } from '../lib/logger.js';
import { registerJob, JOBS } from './scheduler.js';
import { buildCardChangeDetails } from '../services/eventDetectors/cardChangeDetails.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WbCard {
  nmID: number;
  title?: string;
  description?: string;
  brand?: string;
  subjectID?: number;
  vendorCode?: string;
  photos?: Array<Record<string, unknown>>;
  video?: string;
  characteristics?: Array<{ id: number; name?: string; value: unknown }>;
  sizes?: unknown;
  dimensions?: unknown;
  tags?: unknown;
  updatedAt?: string;
}

type ChangeType =
  | 'title_change'
  | 'description_change'
  | 'brand_change'
  | 'subject_change'
  | 'photo_change'
  | 'video_change'
  | 'characteristics_change'
  | 'sizes_change'
  | 'dimensions_change';

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface SnapshotRunArgs {
  workspaceIds?: number[] | null; // null = все активные
  shopId?: number | null;         // только один shop (для админ-триггера)
  dateOverride?: string | null;   // YYYY-MM-DD (для тестов)
}

export async function runWbCardSnapshot(args: SnapshotRunArgs = {}): Promise<{
  shops: number;
  products: number;
  diffs: number;
  eventsCreated: number;
}> {
  const date = args.dateOverride ?? new Date().toISOString().slice(0, 10);
  const shops = await listActiveShops(args.workspaceIds ?? null, args.shopId ?? null);

  let total = 0, diffs = 0, events = 0;

  for (const s of shops) {
    try {
      const result = await snapshotOneShop(s.workspaceId, s.shopId, date);
      total += result.products;
      diffs += result.diffs;
      events += result.eventsCreated;
      logger.info({
        workspaceId: s.workspaceId, shopId: s.shopId,
        products: result.products, diffs: result.diffs, events: result.eventsCreated,
      }, 'wb-card-snapshot done for shop');
    } catch (err) {
      logger.error({ err, workspaceId: s.workspaceId, shopId: s.shopId }, 'wb-card-snapshot failed for shop');
    }
  }

  return { shops: shops.length, products: total, diffs, eventsCreated: events };
}

// ---------------------------------------------------------------------------
// Shop-level snapshot
// ---------------------------------------------------------------------------

async function snapshotOneShop(workspaceId: number, shopId: number, date: string): Promise<{
  products: number;
  diffs: number;
  eventsCreated: number;
}> {
  const apiKey = await getWbApiKey(workspaceId, shopId);
  if (!apiKey) {
    logger.warn({ workspaceId, shopId }, 'no WB API key; skipping snapshot');
    return { products: 0, diffs: 0, eventsCreated: 0 };
  }

  const cards = await fetchAllCards(apiKey);
  if (cards.length === 0) return { products: 0, diffs: 0, eventsCreated: 0 };

  const prevMap = await loadPreviousSnapshots(workspaceId, shopId, cards.map(c => c.nmID), date);

  let productsUpserted = 0;
  let diffs = 0;
  let eventsCreated = 0;

  for (const card of cards) {
    const nmId = card.nmID;
    const prev = prevMap.get(nmId);
    const changes = prev ? diffCard(prev, card) : null;
    const changesJson = changes ?? null;
    const summary = changes && changes.length > 0 ? humanSummary(changes, prev, card) : null;

    // wb_cards параллельно — это «горячая» таблица с актуальными названиями/
    // фото, на неё опирается весь UI (Рука на пульсе, чаты, отзывы).
    // До этого она наполнялась только initialSync'ом → отставала на N дней
    // если шоп подключён давно. Теперь refresh-ится при каждом snapshot.
    const photoBig: string | null = (() => {
      const p0 = (card.photos as any[] | undefined)?.[0];
      if (!p0) return null;
      if (typeof p0?.big === 'string') return p0.big;
      if (typeof p0?.c246x328 === 'string') return p0.c246x328;
      return null;
    })();
    await db.execute(sql`
      INSERT INTO wb_cards
        (workspace_id, shop_id, nm_id, vendor_code, title, brand_name,
         subject_id, subject_name, main_photo_url, photos, raw, updated_at)
      VALUES (
        ${workspaceId}, ${shopId}, ${nmId},
        ${card.vendorCode ?? null}, ${card.title ?? null}, ${card.brand ?? null},
        ${card.subjectID ?? null}, ${(card as any).subjectName ?? null},
        ${photoBig},
        ${JSON.stringify(card.photos ?? [])}::jsonb,
        ${JSON.stringify(card)}::jsonb,
        now()
      )
      ON CONFLICT (workspace_id, nm_id) DO UPDATE SET
        shop_id = EXCLUDED.shop_id,
        vendor_code = EXCLUDED.vendor_code,
        title = EXCLUDED.title,
        brand_name = EXCLUDED.brand_name,
        subject_id = EXCLUDED.subject_id,
        subject_name = EXCLUDED.subject_name,
        main_photo_url = EXCLUDED.main_photo_url,
        photos = EXCLUDED.photos,
        raw = EXCLUDED.raw,
        updated_at = EXCLUDED.updated_at
    `);

    await db.execute(sql`
      INSERT INTO wb_card_snapshots
        (workspace_id, shop_id, nm_id, snapshot_date, source, wb_updated_at,
         title, description, brand, subject_id, vendor_code,
         photos, video, characteristics, sizes, dimensions, tags,
         raw_card, changes_from_prev, changes_summary)
      VALUES (
        ${workspaceId}, ${shopId}, ${nmId}, ${date}::date, 'wb_api_poll',
        ${card.updatedAt ?? null},
        ${card.title ?? null}, ${card.description ?? null}, ${card.brand ?? null},
        ${card.subjectID ?? null}, ${card.vendorCode ?? null},
        ${JSON.stringify(card.photos ?? [])}::jsonb,
        ${card.video ?? null},
        ${JSON.stringify(card.characteristics ?? [])}::jsonb,
        ${JSON.stringify(card.sizes ?? null)}::jsonb,
        ${JSON.stringify(card.dimensions ?? null)}::jsonb,
        ${JSON.stringify(card.tags ?? null)}::jsonb,
        ${JSON.stringify(card)}::jsonb,
        ${changesJson ? JSON.stringify(changesJson) : null}::jsonb,
        ${summary}
      )
      ON CONFLICT (workspace_id, shop_id, nm_id, snapshot_date) DO UPDATE SET
        captured_at       = EXCLUDED.captured_at,
        wb_updated_at     = EXCLUDED.wb_updated_at,
        title             = EXCLUDED.title,
        description       = EXCLUDED.description,
        brand             = EXCLUDED.brand,
        subject_id        = EXCLUDED.subject_id,
        vendor_code       = EXCLUDED.vendor_code,
        photos            = EXCLUDED.photos,
        video             = EXCLUDED.video,
        characteristics   = EXCLUDED.characteristics,
        sizes             = EXCLUDED.sizes,
        dimensions        = EXCLUDED.dimensions,
        tags              = EXCLUDED.tags,
        raw_card          = EXCLUDED.raw_card,
        changes_from_prev = EXCLUDED.changes_from_prev,
        changes_summary   = EXCLUDED.changes_summary
    `);

    productsUpserted++;

    if (changes && changes.length > 0) {
      diffs++;
      const details = prev ? buildCardChangeDetails(prev, card, changes) : undefined;
      const ok = await maybeEmitKanbanEvent({
        workspaceId, shopId, nmId, date,
        changes, summary: summary!,
        details,
      });
      if (ok) eventsCreated++;
    }
  }

  return { products: productsUpserted, diffs, eventsCreated };
}

// ---------------------------------------------------------------------------
// WB API fetch with cursor pagination
// ---------------------------------------------------------------------------

async function fetchAllCards(apiKey: string): Promise<WbCard[]> {
  const url = 'https://content-api.wildberries.ru/content/v2/get/cards/list';
  const out: WbCard[] = [];
  let cursor: { limit: number; nmID?: number; updatedAt?: string } = { limit: 100 };

  for (let page = 0; page < 200; page++) { // hard cap 20 000 карточек
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { cursor, filter: { withPhoto: 0 } } }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`WB cards/list ${res.status}: ${txt.slice(0, 200)}`);
    }
    const json = await res.json() as { cards?: WbCard[]; cursor?: { total?: number; nmID?: number; updatedAt?: string } };
    const cards = json.cards ?? [];
    out.push(...cards);
    const nextCursor = json.cursor;
    if (!nextCursor || (cards.length < cursor.limit)) break;
    cursor = {
      limit: 100,
      nmID: nextCursor.nmID,
      updatedAt: nextCursor.updatedAt,
    };
    await sleep(1100); // 1 req/sec rate-limit safety margin
  }

  return out;
}

// ---------------------------------------------------------------------------
// Diff logic — compare previous snapshot against fresh card
// ---------------------------------------------------------------------------

interface PrevSnapshotRow {
  title: string | null;
  description: string | null;
  brand: string | null;
  subject_id: number | null;
  photos: unknown;
  video: string | null;
  characteristics: unknown;
  sizes: unknown;
  dimensions: unknown;
}

function diffCard(prev: PrevSnapshotRow, next: WbCard): ChangeType[] {
  const out: ChangeType[] = [];
  if ((prev.title ?? '') !== (next.title ?? '')) out.push('title_change');
  if ((prev.description ?? '') !== (next.description ?? '')) out.push('description_change');
  if ((prev.brand ?? '') !== (next.brand ?? '')) out.push('brand_change');
  if ((prev.subject_id ?? null) !== (next.subjectID ?? null)) out.push('subject_change');
  if (!sameArray(prev.photos, next.photos)) out.push('photo_change');
  if ((prev.video ?? '') !== (next.video ?? '')) out.push('video_change');
  if (!sameJson(prev.characteristics, next.characteristics)) out.push('characteristics_change');
  if (!sameJson(prev.sizes, next.sizes)) out.push('sizes_change');
  if (!sameJson(prev.dimensions, next.dimensions)) out.push('dimensions_change');
  return out;
}

function sameArray(a: unknown, b: unknown): boolean {
  // Photos compared by concatenated URLs (order-sensitive).
  const serialize = (v: unknown): string => {
    if (!Array.isArray(v)) return '';
    return v.map(x => {
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        return (o.big as string) ?? (o.c516x688 as string) ?? (o.c246x328 as string) ?? JSON.stringify(o);
      }
      return String(x);
    }).join('|');
  };
  return serialize(a) === serialize(b);
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalStringify(a ?? null) === canonicalStringify(b ?? null);
}

/**
 * Order-insensitive JSON stringify. WB API returns characteristics/sizes/
 * dimensions with unstable key order (and arrays sometimes reorder), which
 * made the naive `JSON.stringify` diff fire every night even when nothing
 * actually changed. Сортируем ключи объектов и массивы элементов (по `id`
 * для характеристик, иначе по их собственному canonical-строкою) перед
 * сериализацией.
 */
function canonicalStringify(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);

  if (Array.isArray(v)) {
    const items = v.map(canonicalStringify);
    // Если все элементы — объекты с числовым `id`, сортируем по нему (это case
    // для characteristics: [{id, name, value}, ...]). Иначе — лексикографически.
    const hasNumericIds = v.length > 0 && v.every(
      (x) => x && typeof x === 'object' && typeof (x as Record<string, unknown>).id === 'number'
    );
    if (hasNumericIds) {
      const paired = v.map((x, i) => ({ id: (x as { id: number }).id, str: items[i] }));
      paired.sort((a, b) => a.id - b.id);
      return '[' + paired.map((p) => p.str).join(',') + ']';
    }
    items.sort();
    return '[' + items.join(',') + ']';
  }

  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

function humanSummary(changes: ChangeType[], prev: PrevSnapshotRow | undefined, next: WbCard): string {
  const parts: string[] = [];
  for (const c of changes) {
    switch (c) {
      case 'title_change':
        parts.push(`Заголовок: «${(prev?.title ?? '').slice(0, 40)}» → «${(next.title ?? '').slice(0, 40)}»`);
        break;
      case 'description_change':
        parts.push('Описание изменено');
        break;
      case 'photo_change': {
        const prevCount = Array.isArray(prev?.photos) ? (prev!.photos as unknown[]).length : 0;
        const nextCount = next.photos?.length ?? 0;
        parts.push(prevCount !== nextCount ? `Фото: ${prevCount} → ${nextCount}` : 'Фото заменены');
        break;
      }
      case 'characteristics_change':
        parts.push('Характеристики обновлены');
        break;
      case 'sizes_change':
        parts.push('Размеры/варианты изменены');
        break;
      case 'dimensions_change':
        parts.push('Габариты/вес изменены');
        break;
      case 'brand_change':
        parts.push(`Бренд: «${prev?.brand ?? '—'}» → «${next.brand ?? '—'}»`);
        break;
      case 'subject_change':
        parts.push('Категория изменена');
        break;
      case 'video_change':
        parts.push(next.video ? 'Видео добавлено/изменено' : 'Видео удалено');
        break;
    }
  }
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Load previous snapshots (the latest snapshot strictly before today)
// ---------------------------------------------------------------------------

async function loadPreviousSnapshots(
  workspaceId: number, shopId: number, nmIds: number[], today: string,
): Promise<Map<number, PrevSnapshotRow>> {
  if (nmIds.length === 0) return new Map();
  const idList = sql.join(nmIds.map(n => sql`${n}`), sql`, `);
  const res = await db.execute(sql`
    SELECT DISTINCT ON (nm_id)
      nm_id, title, description, brand, subject_id,
      photos, video, characteristics, sizes, dimensions
    FROM wb_card_snapshots
    WHERE workspace_id = ${workspaceId}
      AND shop_id      = ${shopId}
      AND nm_id        IN (${idList})
      AND snapshot_date < ${today}::date
    ORDER BY nm_id, snapshot_date DESC
  `);
  const map = new Map<number, PrevSnapshotRow>();
  for (const row of res.rows as unknown as Array<PrevSnapshotRow & { nm_id: number }>) {
    map.set(Number(row.nm_id), row);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Kanban event emission with dedup against agent_actions
// ---------------------------------------------------------------------------

interface KanbanEmitArgs {
  workspaceId: number;
  shopId: number;
  nmId: number;
  date: string;
  changes: ChangeType[];
  summary: string;
  details?: import('../services/eventDetectors/cardChangeDetails.js').CardChangeDetails;
}

async function maybeEmitKanbanEvent(args: KanbanEmitArgs): Promise<boolean> {
  // Дедуп: если за ±6ч до даты снапшота было действие через Sigma для того же nm_id,
  // мы НЕ создаём ночное событие — Sigma уже записал своё с более точным моментом.
  //
  // В agent_actions нет колонок nm_id/tool_name — nmId лежит в payload (jsonb),
  // а тип хранится в action_type. Без явного payload->nmId матчинга было бы
  // 100% падение запроса.
  const dedup = await db.execute(sql`
    SELECT 1 FROM agent_actions
    WHERE workspace_id = ${args.workspaceId}
      AND shop_id      = ${args.shopId}
      AND (payload->>'nmId')::bigint = ${args.nmId}
      AND created_at BETWEEN (${args.date}::date - interval '18 hours')
                         AND (${args.date}::date + interval '6 hours')
      AND action_type IN ('update_card', 'update_characteristics', 'set_price', 'manage_promotion')
    LIMIT 1
  `);
  if ((dedup.rows as unknown[]).length > 0) return false;

  const severity = args.changes.length >= 4 || args.changes.includes('subject_change') || args.changes.includes('brand_change')
    ? 'significant'
    : args.changes.length >= 2 ? 'moderate' : 'minor';
  const type = severity === 'significant' ? 'alert' : 'log';
  const fingerprint = createHash('sha1')
    .update(`${args.nmId}|${args.date}|${[...args.changes].sort().join(',')}`)
    .digest('hex');

  const iconMap: Record<ChangeType, string> = {
    title_change: '📝',
    description_change: '📄',
    brand_change: '🏷',
    subject_change: '🗂',
    photo_change: '📸',
    video_change: '🎬',
    characteristics_change: '🧩',
    sizes_change: '📏',
    dimensions_change: '📐',
  };
  // Берём ОДИН эмоджи по самому значимому изменению + список через запятую.
  // Раньше клеили все эмодзи подряд — выглядело как набор иероглифов.
  const labelMap: Record<ChangeType, string> = {
    title_change: 'заголовок',
    description_change: 'описание',
    brand_change: 'бренд',
    subject_change: 'категория',
    photo_change: 'фото',
    video_change: 'видео',
    characteristics_change: 'характеристики',
    sizes_change: 'размеры',
    dimensions_change: 'габариты',
  };
  // Приоритет «значимости» для иконки заголовка
  const priority: ChangeType[] = [
    'subject_change', 'brand_change', 'title_change', 'description_change',
    'photo_change', 'video_change', 'characteristics_change', 'sizes_change', 'dimensions_change',
  ];
  const primary = priority.find(p => args.changes.includes(p)) ?? args.changes[0];
  const mainIcon = iconMap[primary] ?? '🔄';
  const changeList = args.changes.map(c => labelMap[c]).join(', ');

  const suggestedAction = deriveSuggestion(args.changes);

  try {
    await db.execute(sql`
      INSERT INTO wb_events
        (workspace_id, shop_id, nm_id, date, type, category, severity, status,
         fingerprint, trigger_rule, title, description, widget_type, suggested_action, evidence, source)
      VALUES (
        ${args.workspaceId}, ${args.shopId}, ${args.nmId}, ${args.date},
        ${type}, 'card_change', ${severity}, 'open',
        ${fingerprint}, 'wb_card_snapshot_diff',
        ${`${mainIcon} ${args.nmId}: обновлены ${changeList}`},
        ${args.summary},
        'card_change_timeline',
        ${suggestedAction},
        ${JSON.stringify({ changes: args.changes, date: args.date, details: args.details ?? null })}::jsonb,
        'wb_card_snapshot'
      )
      ON CONFLICT (workspace_id, fingerprint) WHERE fingerprint IS NOT NULL DO NOTHING
    `);
    return true;
  } catch (err) {
    logger.warn({ err, args }, 'wb_events insert failed (probably missing table or FK)');
    return false;
  }
}

function deriveSuggestion(changes: ChangeType[]): string {
  if (changes.includes('photo_change')) return 'Проверить CTR через 7 дней в Лаборатории';
  if (changes.includes('title_change')) return 'Проверить показы и SEO-позиции';
  if (changes.includes('characteristics_change')) return 'Проверить категорийные показы';
  if (changes.includes('subject_change') || changes.includes('brand_change'))
    return 'Проверить всю воронку — смена категории / бренда критична';
  return 'Отследите эффект через Лабораторию';
}

// ---------------------------------------------------------------------------
// Active shops listing
// ---------------------------------------------------------------------------

interface ActiveShop { workspaceId: number; shopId: number }

async function listActiveShops(wsFilter: number[] | null, shopFilter: number | null): Promise<ActiveShop[]> {
  const wsLiteral = wsFilter && wsFilter.length > 0 ? sql`(${sql.join(wsFilter.map(n => sql`${n}`), sql`, `)})` : null;
  const wsClause = wsLiteral ? sql`AND workspace_id IN ${wsLiteral}` : sql``;
  const shopClause = shopFilter != null ? sql`AND shop_id = ${shopFilter}` : sql``;
  const rows = await db.execute(sql`
    SELECT workspace_id, shop_id
    FROM marketplace_shops
    WHERE COALESCE(is_active, true) = true
      ${wsClause}
      ${shopClause}
    ORDER BY shop_id
  `);
  return (rows.rows as Array<{ workspace_id: number; shop_id: number }>).map(r => ({
    workspaceId: Number(r.workspace_id),
    shopId: Number(r.shop_id),
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Scheduler registration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Backfill: пройти по всем уже накопленным wb_card_snapshots и для тех, у кого
// changes_from_prev не пустой, создать события в wb_events. Полезно при первом
// включении функции и после исправления багов в INSERT (idempotent через
// fingerprint).
// ---------------------------------------------------------------------------

export async function backfillCardEvents(opts: { workspaceId?: number | null; shopId?: number | null } = {}): Promise<{
  processed: number;
  inserted: number;
}> {
  const wsFilter = opts.workspaceId ?? null;
  const shopFilter = opts.shopId ?? null;
  const rows = await db.execute(sql`
    SELECT workspace_id, shop_id, nm_id, snapshot_date::text AS d,
           changes_from_prev, changes_summary
    FROM wb_card_snapshots
    WHERE changes_from_prev IS NOT NULL
      AND jsonb_typeof(changes_from_prev) = 'array'
      AND jsonb_array_length(changes_from_prev) > 0
      AND (${wsFilter}::int IS NULL OR workspace_id = ${wsFilter})
      AND (${shopFilter}::int IS NULL OR shop_id    = ${shopFilter})
    ORDER BY snapshot_date ASC
  `);
  let inserted = 0;
  for (const r of rows.rows as Array<{
    workspace_id: number; shop_id: number; nm_id: number; d: string;
    changes_from_prev: unknown; changes_summary: string | null;
  }>) {
    const changes = Array.isArray(r.changes_from_prev) ? r.changes_from_prev as ChangeType[] : [];
    if (changes.length === 0) continue;
    const ok = await maybeEmitKanbanEvent({
      workspaceId: Number(r.workspace_id),
      shopId: Number(r.shop_id),
      nmId: Number(r.nm_id),
      date: r.d,
      changes,
      summary: r.changes_summary ?? changes.join(', '),
    });
    if (ok) inserted++;
  }
  logger.info({ processed: rows.rows.length, inserted, opts }, 'card events backfill done');
  return { processed: rows.rows.length, inserted };
}

export const WB_CARD_SNAPSHOT_DAILY_JOB = 'wb-card-snapshot-daily' as const;

export function registerWbCardSnapshotDaily(): void {
  registerJob({
    name: WB_CARD_SNAPSHOT_DAILY_JOB,
    cron: '30 0,8,16 * * *', // 03:30 / 11:30 / 19:30 MSK — 3 раза в сутки.
    // С сервисными лимитами карточные изменения (title/фото/характеристики)
    // ловим за 8 часов, а не за 24. До этого был 1 раз в сутки.
    enabled: process.env.ENABLE_WB_CARD_SNAPSHOT !== '0',
    handler: async () => {
      const res = await runWbCardSnapshot();
      logger.info(res, 'wb-card-snapshot-daily finished');
    },
  });
}

// Avoid bundler complaints about unused JOBS import
void JOBS;
