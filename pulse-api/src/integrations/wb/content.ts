/**
 * WB Content API integration
 * 
 * Manage product cards: titles, descriptions, characteristics
 * Host: https://content-api.wildberries.ru
 */

import { wbGetJson, wbPostJson, wbPatchJson } from './wbClient.js';

const BASE_URL = 'https://content-api.wildberries.ru';

// Types
export interface CardCharacteristic {
  id: number;
  name: string;
  value: string | string[];
}

export interface CardPhoto {
  big: string;
  c246x328: string;
  c516x688: string;
  square: string;
  tm: string;
}

export interface CardSize {
  chrtID: number;
  techSize: string;
  skus: string[];
  wbSize?: string;
}

export interface WbCard {
  nmID: number;
  imtID: number;
  nmUUID: string;
  subjectID: number;
  subjectName: string;
  vendorCode: string;
  brand: string;
  title: string;
  description: string;
  photos: CardPhoto[];
  video?: string;
  dimensions: {
    length: number;
    width: number;
    height: number;
  };
  characteristics: CardCharacteristic[];
  sizes: CardSize[];
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CardUpdatePayload {
  nmID: number;
  vendorCode: string;
  title?: string;
  description?: string;
  characteristics?: Array<{
    id: number;
    value: string | string[];
  }>;
  dimensions?: {
    length: number;
    width: number;
    height: number;
  };
}

export interface CardListParams {
  cursor?: {
    nmID?: number;
    updatedAt?: string;
    limit: number;
  };
  filter?: {
    textSearch?: string;
    withPhoto?: number; // 0 = any, 1 = with photo, -1 = without photo, 2 = without photo
    tagIDs?: number[];
    objectIDs?: number[];
    brands?: string[];
    imtID?: number;
    nmID?: number;
  };
}

export interface CardsListResponse {
  cards: WbCard[];
  cursor: {
    nmID: number;
    updatedAt: string;
    total: number;
  };
}

/**
 * Get list of cards with cursor pagination
 * POST /content/v2/get/cards/list
 */
export async function getCardsList(
  apiKey: string,
  params: CardListParams = {}
): Promise<CardsListResponse> {
  const body = {
    settings: {
      cursor: params.cursor || { limit: 100 },
      filter: params.filter || {},
    },
  };

  return wbPostJson<CardsListResponse>(
    `${BASE_URL}/content/v2/get/cards/list`,
    apiKey,
    body
  );
}

/**
 * Get single card by nmID
 * POST /content/v2/get/cards/list with nmID filter
 *
 * NB: WB's nmID filter on cards-list is not always respected — the API may
 * return the first card from the account ignoring the filter. Verify the
 * returned card actually matches the requested nmID before handing it back,
 * otherwise GET /content/.../cards/:nmId silently returns the wrong card.
 */
export async function getCard(
  apiKey: string,
  nmID: number
): Promise<WbCard | null> {
  const result = await getCardsList(apiKey, {
    cursor: { limit: 1 },
    filter: { nmID },
  });
  const candidate = result.cards[0];
  if (!candidate || candidate.nmID !== nmID) return null;
  return candidate;
}

/**
 * Update card(s)
 * POST /content/v2/cards/update
 * Rate limit: 100 req/min
 *
 * WB rotated this endpoint from PATCH to POST (verified 2026-05-14 — PATCH
 * returns 405 with `Allow: POST`). Keep this on POST.
 */
export async function updateCards(
  apiKey: string,
  cards: CardUpdatePayload[]
): Promise<{ error: boolean; errorText?: string; additionalErrors?: any[] }> {
  const res = await fetch(`${BASE_URL}/content/v2/cards/update`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cards),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WB Content API error: ${res.status} ${text}`);
  }

  return res.json() as Promise<{ error: boolean; errorText?: string; additionalErrors?: any[] }>;
}

/**
 * Update single card (convenience wrapper)
 */
export async function updateCard(
  apiKey: string,
  card: CardUpdatePayload
): Promise<{ error: boolean; errorText?: string }> {
  return updateCards(apiKey, [card]);
}

/**
 * Безопасный partial update карточки WB.
 *
 * Проблема: WB `cards/update` принимает «полный» payload — поля, которых нет
 * в запросе, могут быть очищены. Особенно опасно с `characteristics` — массив
 * заменяет весь список характеристик (если передать 3 из 47, остальные 44
 * уйдут в `null`). Найдено в проде 2026-06-05.
 *
 * Это поведение похоже на инцидент с `media/save`: если передать 1 URL, WB
 * стирает остальные 4 фото с карточки. Решение симметричное — читаем текущее
 * состояние через `getCard`, мержим с patch, отправляем полное состояние.
 *
 * Использовать ВЕЗДЕ вместо прямого `updateCard`, когда patch неполный
 * (не содержит всех полей карточки).
 *
 * @param patch только те поля что нужно изменить. Остальное берётся
 *              из текущей карточки. Для `characteristics`: id, перечисленные в
 *              patch, перезаписываются; остальные id остаются как были.
 */
export async function safeUpdateCard(
  apiKey: string,
  nmID: number,
  patch: Partial<Omit<CardUpdatePayload, 'nmID' | 'vendorCode'>>,
  vendorCode?: string,
): Promise<{ error: boolean; errorText?: string }> {
  let current = await getCard(apiKey, nmID);

  // Fallback: WB nmID filter is unreliable — try textSearch by vendorCode
  if (!current && vendorCode) {
    try {
      const list = await getCardsList(apiKey, {
        cursor: { limit: 100 },
        filter: { textSearch: vendorCode },
      });
      current = (list.cards ?? []).find((c) => c.nmID === nmID) ?? null;
    } catch { /* ignore fallback errors */ }
  }

  if (!current) {
    return { error: true, errorText: `Card ${nmID} not found — cannot safe-update` };
  }

  // Мержим characteristics по id: WB ждёт полный список.
  let nextCharcs: Array<{ id: number; value: string | string[] }> | undefined;
  if (patch.characteristics && patch.characteristics.length > 0) {
    const byId = new Map<number, { id: number; value: string | string[] }>();
    for (const c of current.characteristics ?? []) {
      // current.characteristics приходит с дополнительным полем name — игнорируем.
      byId.set((c as any).id, { id: (c as any).id, value: (c as any).value });
    }
    for (const c of patch.characteristics) {
      byId.set(c.id, { id: c.id, value: c.value });
    }
    nextCharcs = Array.from(byId.values());
  } else {
    // Patch не трогает characteristics — отдаём текущие как есть, чтобы WB не
    // занулил их.
    nextCharcs = (current.characteristics ?? []).map((c: any) => ({ id: c.id, value: c.value }));
  }

  const payload: CardUpdatePayload = {
    nmID,
    vendorCode: current.vendorCode,
    title: patch.title ?? current.title,
    description: patch.description ?? current.description,
    characteristics: nextCharcs,
    dimensions: patch.dimensions ?? current.dimensions,
  };

  return updateCards(apiKey, [payload]);
}

/**
 * Get characteristics for a subject (category)
 * GET /content/v2/object/charcs/{subjectId}
 */
export async function getSubjectCharacteristics(
  apiKey: string,
  subjectId: number
): Promise<{ data: Array<{ charcID: number; name: string; required: boolean; unitName?: string; maxCount?: number; popular?: boolean; charcType: number }> }> {
  return wbGetJson(
    `${BASE_URL}/content/v2/object/charcs/${subjectId}`,
    apiKey
  );
}

/**
 * Get all subjects (categories)
 * GET /content/v2/object/all
 */
export async function getAllSubjects(
  apiKey: string,
  params?: { name?: string; limit?: number; offset?: number }
): Promise<{ data: Array<{ subjectID: number; parentID: number; subjectName: string; parentName: string }> }> {
  const searchParams = new URLSearchParams();
  if (params?.name) searchParams.set('name', params.name);
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.offset) searchParams.set('offset', String(params.offset));

  const query = searchParams.toString();
  return wbGetJson(
    `${BASE_URL}/content/v2/object/all${query ? `?${query}` : ''}`,
    apiKey
  );
}

/**
 * Add media to card
 * POST /content/v3/media/save
 */
export async function addCardMedia(
  apiKey: string,
  nmID: number,
  data: string, // base64
  photoNumber: number
): Promise<{ error: boolean; errorText?: string }> {
  const res = await fetch(`${BASE_URL}/content/v3/media/save`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
      'X-Nm-Id': String(nmID),
      'X-Photo-Number': String(photoNumber),
    },
    body: data,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WB Media API error: ${res.status} ${text}`);
  }

  return res.json() as Promise<{ error: boolean; errorText?: string }>;
}

/**
 * Create new card
 * POST /content/v2/cards/upload
 */
export async function createCard(
  apiKey: string,
  card: {
    subjectID: number;
    variants: Array<{
      vendorCode: string;
      title: string;
      description: string;
      brand: string;
      dimensions: { length: number; width: number; height: number };
      characteristics: Array<{ id: number; value: string | string[] }>;
      sizes: Array<{ techSize: string; wbSize?: string; skus: string[] }>;
    }>;
  }
): Promise<{ error: boolean; errorText?: string }> {
  const res = await fetch(`${BASE_URL}/content/v2/cards/upload`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([card]),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WB Content API error: ${res.status} ${text}`);
  }

  return res.json() as Promise<{ error: boolean; errorText?: string }>;
}

/**
 * Get card limits (how many cards can be created)
 * GET /content/v2/cards/limits
 */
export async function getCardLimits(
  apiKey: string
): Promise<{ freeLimits: number; paidLimits: number }> {
  return wbGetJson(`${BASE_URL}/content/v2/cards/limits`, apiKey);
}

// ============================================================================
// Справочники WB (родительские категории + 6 directory/* справочников).
// Нужны для создания/редактирования карточек, обогащения UI и LLM-промптов.
// Все эти endpoints — на content-api.wildberries.ru.
// ============================================================================

export interface WbParentCategory {
  id: number;
  name: string;
}

/**
 * GET /content/v2/object/parent/all — список родительских категорий товаров.
 * Используется как первый шаг для получения subjectID при создании карточки.
 */
export async function getAllParentCategories(
  apiKey: string,
  params?: { locale?: string },
): Promise<{ data: WbParentCategory[] }> {
  const qs = params?.locale ? `?locale=${encodeURIComponent(params.locale)}` : '';
  return wbGetJson(`${BASE_URL}/content/v2/object/parent/all${qs}`, apiKey);
}

/**
 * Универсальная обёртка для 6 справочников WB Content:
 *   colors / kinds / countries / seasons / vat / tnved
 *
 * `tnved` принимает фильтр по subjectID и поисковую подстроку (см. доку WB).
 * Остальные — простые GET без параметров.
 */
export type WbDirectoryKind = 'colors' | 'kinds' | 'countries' | 'seasons' | 'vat' | 'tnved';

export async function getDirectory<T = unknown>(
  apiKey: string,
  kind: WbDirectoryKind,
  params?: { subjectID?: number; search?: string; locale?: string },
): Promise<{ data: T[] }> {
  const qs = new URLSearchParams();
  if (params?.subjectID) qs.set('subjectID', String(params.subjectID));
  if (params?.search) qs.set('search', params.search);
  if (params?.locale) qs.set('locale', params.locale);
  const suffix = qs.toString() ? `?${qs}` : '';
  return wbGetJson(`${BASE_URL}/content/v2/directory/${kind}${suffix}`, apiKey);
}

// ============================================================================
// Ярлыки (теги) для группировки и фильтрации карточек товаров.
// Максимум 15 ярлыков на продавца. Максимум 15 ярлыков на карточку.
// ============================================================================

export interface WbTag {
  id: number;
  name: string;
  color?: string;
}

/** GET /content/v2/tags — список всех ярлыков продавца. */
export async function getAllTags(apiKey: string): Promise<{ data: WbTag[] }> {
  return wbGetJson(`${BASE_URL}/content/v2/tags`, apiKey);
}

/** POST /content/v2/tag — создать новый ярлык. */
export async function createTag(
  apiKey: string,
  params: { name: string; color?: string },
): Promise<{ data: { id: number } }> {
  return wbPostJson(`${BASE_URL}/content/v2/tag`, apiKey, params);
}

/** PATCH /content/v2/tag/{id} — переименовать/перекрасить ярлык. */
export async function updateTag(
  apiKey: string,
  tagId: number,
  patch: { name?: string; color?: string },
): Promise<void> {
  const res = await fetch(`${BASE_URL}/content/v2/tag/${tagId}`, {
    method: 'PATCH',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WB updateTag failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

/** DELETE /content/v2/tag/{id} — удалить ярлык (со всех карточек тоже снимется). */
export async function deleteTag(apiKey: string, tagId: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/content/v2/tag/${tagId}`, {
    method: 'DELETE',
    headers: { Authorization: apiKey },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WB deleteTag failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

/**
 * POST /content/v2/tag/nomenclature/link — управление ярлыками карточки.
 *
 * tagIds: полный новый список ярлыков для карточки. Пустой массив = снять все.
 * Максимум 15 ярлыков на карточку.
 */
export async function linkTagsToCard(
  apiKey: string,
  params: { nmId: number; tagIds: number[] },
): Promise<void> {
  const res = await fetch(`${BASE_URL}/content/v2/tag/nomenclature/link`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nmID: params.nmId, tagsIDs: params.tagIds }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WB linkTagsToCard failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

// ============================================================================
// Карточки: корзина + объединение + баркоды + ошибки создания.
// ============================================================================

/**
 * POST /content/v2/get/cards/trash — список карточек в корзине.
 * Карточки хранятся 30 дней в корзине после удаления, потом удаляются полностью.
 */
export async function getCardsInTrash(
  apiKey: string,
  params?: { cursor?: { trashedAt?: string; nmID?: number; limit: number } },
): Promise<{ cards: WbCard[]; cursor: any }> {
  return wbPostJson(`${BASE_URL}/content/v2/get/cards/trash`, apiKey, {
    settings: { cursor: params?.cursor ?? { limit: 100 } },
  });
}

/**
 * POST /content/v2/cards/delete/trash — переместить карточки в корзину.
 * Не удаляет полностью — на 30 дней доступно восстановление через `recoverCards`.
 */
export async function trashCards(apiKey: string, nmIds: number[]): Promise<void> {
  const res = await fetch(`${BASE_URL}/content/v2/cards/delete/trash`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(nmIds),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WB trashCards failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

/** POST /content/v2/cards/recover — восстановить карточки из корзины. */
export async function recoverCards(apiKey: string, nmIds: number[]): Promise<void> {
  const res = await fetch(`${BASE_URL}/content/v2/cards/recover`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(nmIds),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WB recoverCards failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

/**
 * POST /content/v2/cards/moveNm — объединить или разъединить карточки.
 *
 *  - Объединение: указать targetIMT (imtID одной из объединяемых карточек) +
 *    список nmIDs.
 *  - Разъединение: указать только nmIDs без targetIMT — будут разъединены,
 *    каждая получит свой новый imtID.
 *
 * Объединять можно только карточки одного subjectID.
 */
export async function moveNm(
  apiKey: string,
  params: { targetIMT?: number; nmIds: number[] },
): Promise<{ data?: unknown }> {
  return wbPostJson(`${BASE_URL}/content/v2/cards/moveNm`, apiKey, {
    targetIMT: params.targetIMT,
    nmIDs: params.nmIds,
  });
}

/** POST /content/v2/barcodes — сгенерировать новые баркоды (до 5000 за запрос). */
export async function generateBarcodes(
  apiKey: string,
  count: number,
): Promise<{ data: string[] }> {
  return wbPostJson(`${BASE_URL}/content/v2/barcodes`, apiKey, { count });
}

/**
 * POST /content/v2/cards/error/list — список карточек с ошибками создания/обновления.
 * WB возвращает 200 даже когда создание упало; проверять надо отдельно.
 */
export async function getCardsErrorList(
  apiKey: string,
): Promise<{ data: Array<{ vendorCode: string; errors: string[] }> }> {
  return wbPostJson(`${BASE_URL}/content/v2/cards/error/list`, apiKey, {});
}

/**
 * POST /content/v3/media/file — прямая загрузка медиафайла (бинарь).
 *
 * Используется когда у нас есть Buffer (например, после `sharp` ресайза),
 * а не URL картинки. Поле фото в карточке заменяется по `photoNumber`
 * (1-based индекс позиции). `nmId` идёт в `X-Nm-Id`, не в body.
 */
export async function uploadMediaFile(
  apiKey: string,
  params: { nmId: number; photoNumber: number; buffer: Buffer; mimeType?: string; filename?: string },
): Promise<{ data?: unknown }> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(params.buffer)], { type: params.mimeType ?? 'image/jpeg' });
  form.append('uploadfile', blob, params.filename ?? 'photo.jpg');
  const res = await fetch(`${BASE_URL}/content/v3/media/file`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'X-Nm-Id': String(params.nmId),
      'X-Photo-Number': String(params.photoNumber),
    },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WB uploadMediaFile failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<{ data?: unknown }>;
}
