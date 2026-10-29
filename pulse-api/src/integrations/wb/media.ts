import { getWbApiKey, wbPostJson } from './wbClient.js';

export function isWbMediaSyncEnabled(): boolean {
  return (process.env.ENABLE_AB_PHOTO_WB_MEDIA_SYNC ?? '') === '1';
}

/**
 * УСТАРЕЛО — не использовать напрямую. WB content/v3/media/save заменяет ВЕСЬ
 * массив фото карточки на переданный список. Если вызывать с 1 URL — остальные
 * фото удаляются с витрины. Используй updateWbCardSlot() ниже, она подмешивает
 * новое фото в нужный слот и сохраняет остальные.
 *
 * Оставлено для совместимости (вызывается с уже-полным списком), но любой
 * новый код должен идти через updateWbCardSlot().
 */
export async function updateWbCardMediaByUrls(workspaceId: number, nmId: number, urls: string[], shopId?: number): Promise<void> {
  if (!urls.length) return;
  const apiKey = await getWbApiKey(workspaceId, shopId);
  const url = 'https://content-api.wildberries.ru/content/v3/media/save';
  await wbPostJson(url, apiKey, { nmId, data: urls });
}

/**
 * Безопасная замена ОДНОГО слота фото на карточке WB. Сохраняет остальные
 * фото (передаём их URL обратно в media/save, иначе WB удаляет всё кроме
 * переданного). Не вызывается если testUrl пуст ИЛИ если originalPhotos
 * пуст (нет snapshot — рисковать не имеем права).
 *
 * @param slot — индекс слота для замены (0 = главное фото).
 * @param originalPhotos — полный snapshot URL всех фото на момент старта теста.
 */
export async function updateWbCardSlot(
  workspaceId: number,
  nmId: number,
  slot: number,
  testUrl: string,
  originalPhotos: string[],
  shopId?: number,
): Promise<void> {
  if (!testUrl) return;
  if (!Array.isArray(originalPhotos) || originalPhotos.length === 0) {
    // Без snapshot не делаем ничего — иначе WB сотрёт все фото.
    throw new Error('updateWbCardSlot: originalPhotos snapshot is empty, refusing to update to avoid data loss');
  }
  const safeSlot = Math.max(0, Math.min(slot, originalPhotos.length - 1));
  const next = [...originalPhotos];
  next[safeSlot] = testUrl;
  const apiKey = await getWbApiKey(workspaceId, shopId);
  const url = 'https://content-api.wildberries.ru/content/v3/media/save';
  await wbPostJson(url, apiKey, { nmId, data: next });
}
