/**
 * Tool: query_competitor_card — публичный аудит карточки WB по nmId.
 *
 * Не требует ключа продавца. Дёргает card.wb.ru/cards/v4/detail и возвращает
 * данные «глазами покупателя»: витринная цена (включает СПП), бренд,
 * поставщик, рейтинг, отзывы, остатки по размерам, доставка, промо WB.
 *
 * Используется для:
 *  • аудита карточек конкурентов («сравни мою с этой»);
 *  • парсинга чужих цен/остатков для anti-dumping мониторинга;
 *  • разведки нового товара перед запуском (что у соседей по нише).
 *
 * Цена тут — «всё включено» от WB (база vs витрина). Разделить «скидка
 * продавца vs СПП» нельзя без авторизации того продавца — отдаём только
 * `totalDiscountPct` (объединённую скидку от базы до витрины).
 */

import { fetchPublicCard } from '../../integrations/wb/publicCard.js';

interface Args {
  nmId: number;
  _workspaceId?: number;
  _shopId?: number;
}

export async function queryCompetitorCard(args: Args): Promise<string> {
  const nmId = Number(args?.nmId);
  if (!Number.isFinite(nmId) || nmId <= 0) {
    return JSON.stringify({ error: 'некорректный nmId' });
  }

  let card;
  try {
    card = await fetchPublicCard(nmId);
  } catch (err) {
    return JSON.stringify({
      error: 'Не удалось получить данные WB',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  if (!card) {
    return JSON.stringify({
      nmId,
      status: 'not_found',
      message: 'Карточка не найдена на витрине WB. Возможно, она снята с продажи или nmId некорректен.',
    });
  }

  const toRub = (kop: number | null) => (kop == null ? null : Math.round(kop / 100));
  const basePriceRub = toRub(card.basePriceKop);
  const showcasePriceRub = toRub(card.showcasePriceKop);

  return JSON.stringify({
    nmId: card.nmId,
    url: card.url,
    product: {
      name: card.name,
      vendorCode: card.vendorCode ?? null,
      brand: card.brand,
      subject: card.subject,
      description: card.description ?? null,
      descriptionLength: card.description ? card.description.length : 0,
      characteristics: card.characteristics ?? [],
      characteristicsCount: card.characteristics?.length ?? 0,
    },
    seller: {
      supplier: card.supplier,
      supplierId: card.supplierId,
      supplierRating: card.supplierRating,
    },
    price: {
      basePriceRub,
      showcasePriceRub,
      totalDiscountPct: card.totalDiscountPct,
      labels: {
        basePriceRub: 'зачёркнутая цена «до скидок»',
        showcasePriceRub: 'витринная цена — то что видит покупатель (включает скидку продавца + СПП + промо WB)',
        totalDiscountPct: 'суммарная скидка от базы до витрины (нельзя разделить на seller/SPP/promo без авторизации этого продавца)',
      },
    },
    stock: {
      totalQuantity: card.totalQuantity,
      bySize: card.sizes.map((s) => ({
        size: s.origName,
        qty: s.totalQty,
        showcasePriceRub: Math.round(s.productKop / 100),
      })),
    },
    rating: {
      score: card.rating,
      reviewsCount: card.feedbacks,
    },
    promotions: {
      activeIds: card.promotionIds,
      count: card.promotionIds.length,
      note: card.promotionIds.length > 0 ? 'Товар участвует в WB-акциях.' : 'В WB-акциях не участвует.',
    },
    delivery: {
      hoursToBuyer: card.deliveryHours,
    },
    photos: {
      count: card.picsCount,
      urls: card.photoUrls ?? [],
      visionHint: (card.photoUrls?.length ?? 0) > 0
        ? 'Фото — прямые URL на WB CDN. Можно отдать их Claude vision как image-блоки для разбора композиции, инфографики, читаемости, ракурса.'
        : 'URLs не получены (свежая карточка, basket не найден). AI пользуется только текстовыми данными.',
    },
    source: 'wb_public_card_api',
    note: 'Публичные данные с витрины WB. Не учитывает приватные настройки кабинета продавца. Цена включает все скидки WB. Описание и характеристики — из basket CDN (как у нас в собственных карточках).',
  });
}
