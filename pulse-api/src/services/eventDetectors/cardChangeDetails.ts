/**
 * Deep diff for wb_card_snapshots → builds rich `evidence.details` payload
 * that the UI can render as thumbnails and per-characteristic table, and
 * that AI Vision can consume via the photo URLs.
 *
 * Output shape is documented as `CardChangeDetails` below. All fields are
 * optional — only filled when the corresponding ChangeType was detected.
 */

export type ChangeType =
  | 'title_change'
  | 'description_change'
  | 'brand_change'
  | 'subject_change'
  | 'photo_change'
  | 'video_change'
  | 'characteristics_change'
  | 'sizes_change'
  | 'dimensions_change';

export interface PrevCardRow {
  title?: string | null;
  description?: string | null;
  brand?: string | null;
  subject_id?: number | null;
  photos?: unknown;
  video?: string | null;
  characteristics?: unknown;
  sizes?: unknown;
  dimensions?: unknown;
}

export interface NextCard {
  title?: string;
  description?: string;
  brand?: string;
  subjectID?: number;
  photos?: Array<Record<string, unknown>>;
  video?: string;
  characteristics?: Array<{ id: number; name?: string; value: unknown }>;
  sizes?: unknown;
  dimensions?: unknown;
}

export interface PhotoUrls {
  thumb: string;  // c246x328 — for UI grid
  big: string;    // c516x688 / big — for AI Vision
}

export interface CharacteristicDiff {
  name: string;
  from: unknown;
  to: unknown;
}

export interface CardChangeDetails {
  title?: { from: string; to: string };
  description?: { fromLen: number; toLen: number; fromPreview: string; toPreview: string };
  brand?: { from: string; to: string };
  subject?: { from: number | null; to: number | null };
  photos?: {
    from: PhotoUrls[];
    to: PhotoUrls[];
    addedCount: number;
    removedCount: number;
  };
  characteristics?: {
    changed: CharacteristicDiff[];
    added: CharacteristicDiff[];
    removed: CharacteristicDiff[];
  };
  sizes?: { fromCount: number; toCount: number };
  dimensions?: { from: unknown; to: unknown };
  video?: { from: string; to: string };
}

function extractPhotoUrls(photo: unknown): PhotoUrls | null {
  if (!photo || typeof photo !== 'object') return null;
  const p = photo as Record<string, unknown>;
  const thumb = (p.c246x328 as string) ?? (p.square as string) ?? (p.tm as string);
  const big = (p.c516x688 as string) ?? (p.big as string) ?? (p.hq as string) ?? thumb;
  if (!thumb) return null;
  return { thumb, big };
}

function photosToUrls(photos: unknown): PhotoUrls[] {
  if (!Array.isArray(photos)) return [];
  const out: PhotoUrls[] = [];
  for (const p of photos) {
    const urls = extractPhotoUrls(p);
    if (urls) out.push(urls);
  }
  return out;
}

function safeStringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return safeStringify(a) === safeStringify(b);
}

/**
 * Compare characteristic arrays element-by-element. Match by `id` (numeric
 * WB characteristic ID) when present, otherwise by `name`. Returns three
 * buckets: changed (same id/name, different value), added (only in next),
 * removed (only in prev).
 */
function diffCharacteristics(
  prev: unknown,
  next: unknown,
): { changed: CharacteristicDiff[]; added: CharacteristicDiff[]; removed: CharacteristicDiff[] } {
  const prevArr = Array.isArray(prev) ? prev : [];
  const nextArr = Array.isArray(next) ? next : [];

  const keyOf = (c: any): string => {
    if (c == null || typeof c !== 'object') return '';
    if (c.id != null) return `id:${c.id}`;
    if (c.name) return `name:${c.name}`;
    return '';
  };

  const prevMap = new Map<string, any>();
  for (const c of prevArr) {
    const k = keyOf(c);
    if (k) prevMap.set(k, c);
  }
  const nextMap = new Map<string, any>();
  for (const c of nextArr) {
    const k = keyOf(c);
    if (k) nextMap.set(k, c);
  }

  const changed: CharacteristicDiff[] = [];
  const added: CharacteristicDiff[] = [];
  const removed: CharacteristicDiff[] = [];

  for (const [k, nextC] of nextMap.entries()) {
    const prevC = prevMap.get(k);
    const name = (nextC as any).name ?? (prevC as any)?.name ?? k;
    if (!prevC) {
      added.push({ name, from: null, to: (nextC as any).value });
    } else if (!valuesEqual((prevC as any).value, (nextC as any).value)) {
      changed.push({ name, from: (prevC as any).value, to: (nextC as any).value });
    }
  }
  for (const [k, prevC] of prevMap.entries()) {
    if (!nextMap.has(k)) {
      const name = (prevC as any).name ?? k;
      removed.push({ name, from: (prevC as any).value, to: null });
    }
  }

  return { changed, added, removed };
}

function sizesCount(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

const DESCRIPTION_PREVIEW_CHARS = 240;

export function buildCardChangeDetails(
  prev: PrevCardRow,
  next: NextCard,
  changes: ChangeType[],
): CardChangeDetails {
  const out: CardChangeDetails = {};

  if (changes.includes('title_change')) {
    out.title = { from: prev.title ?? '', to: next.title ?? '' };
  }
  if (changes.includes('description_change')) {
    const fromText = prev.description ?? '';
    const toText = next.description ?? '';
    out.description = {
      fromLen: fromText.length,
      toLen: toText.length,
      fromPreview: fromText.slice(0, DESCRIPTION_PREVIEW_CHARS),
      toPreview: toText.slice(0, DESCRIPTION_PREVIEW_CHARS),
    };
  }
  if (changes.includes('brand_change')) {
    out.brand = { from: prev.brand ?? '', to: next.brand ?? '' };
  }
  if (changes.includes('subject_change')) {
    out.subject = { from: prev.subject_id ?? null, to: next.subjectID ?? null };
  }
  if (changes.includes('photo_change')) {
    const fromUrls = photosToUrls(prev.photos);
    const toUrls = photosToUrls(next.photos);
    out.photos = {
      from: fromUrls,
      to: toUrls,
      addedCount: Math.max(0, toUrls.length - fromUrls.length),
      removedCount: Math.max(0, fromUrls.length - toUrls.length),
    };
  }
  if (changes.includes('video_change')) {
    out.video = { from: prev.video ?? '', to: next.video ?? '' };
  }
  if (changes.includes('characteristics_change')) {
    out.characteristics = diffCharacteristics(prev.characteristics, next.characteristics);
  }
  if (changes.includes('sizes_change')) {
    out.sizes = { fromCount: sizesCount(prev.sizes), toCount: sizesCount(next.sizes) };
  }
  if (changes.includes('dimensions_change')) {
    out.dimensions = { from: prev.dimensions ?? null, to: next.dimensions ?? null };
  }

  return out;
}
