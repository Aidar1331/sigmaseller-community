/**
 * Tool: query_current_price — текущая цена + скидка продавца + цена со скидкой.
 *
 * Использует общий helper `priceInfo`. Возвращает оба числа (базу и финальную)
 * чтобы агент мог корректно говорить пользователю «2151 ₽ × −4% = 2064 ₽»
 * вместо одной размытой цифры.
 *
 * Источники:
 *  - wb_prices_history (если sync настроен) → точные база + скидка
 *  - wb_orders_sales_daily_products (фоллбек, последние 14д) → средняя цена
 *    заказов; разделение база/скидка вычислено эвристикой
 */

import { getCurrentPriceInfo } from './priceInfo.js';

interface Args {
  nmId: number;
  _workspaceId?: number;
  _shopId?: number;
}

export async function queryCurrentPrice(args: Args): Promise<string> {
  const wsId = args._workspaceId;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });
  if (!args.nmId || args.nmId <= 0) {
    return JSON.stringify({ error: 'некорректный nmId' });
  }

  const info = await getCurrentPriceInfo(wsId, args._shopId ?? null, args.nmId);
  if (!info) {
    return JSON.stringify({
      nmId: args.nmId,
      status: 'no_data',
      message: 'Текущая цена WB неизвестна: история цен не синхронизирована и нет заказов за 14д.',
    });
  }

  const toRub = (kop: number | null | undefined) =>
    kop == null ? null : Math.round(kop / 100);

  const basePriceRub = toRub(info.basePriceKop);
  const finalPriceRub = toRub(info.finalPriceKop);
  const showcasePriceRub = toRub(info.finishedPriceKop);

  return JSON.stringify({
    nmId: args.nmId,
    source: info.source,
    asOf: info.asOf,
    samples: info.samples,
    // 3 уровня цены — отдавай юзеру ОБА «цена кабинета» и «цена на витрине»,
    // если показываешь только одно — он подумает что наша цена неверная.
    basePriceRub,            // «Цена до скидки продавца» — то что в карточке зачёркнуто
    discountPct: info.discountPct,
    finalPriceRub,           // «Цена кабинета» = base × (1 − скидка продавца). Это то что продавец сам ставит в WB-кабинете.
    showcasePriceRub,        // «Цена на витрине» = final × (1 − СПП). То что видит покупатель на сайте WB.
    // Совместимость со старым контрактом — некоторые тулы читают finishedPriceRub.
    finishedPriceRub: showcasePriceRub,
    priceLabels: {
      basePriceRub: 'до скидки продавца (зачёркнутая)',
      finalPriceRub: 'цена кабинета (после скидки продавца, до СПП)',
      showcasePriceRub: 'цена на витрине (после СПП — то что видит покупатель)',
    },
    note: showcasePriceRub != null
      ? `Юзеру отвечай: «На витрине ${showcasePriceRub} ₽ (в кабинете ${finalPriceRub} ₽, СПП учтена)». Если СПП неизвестна — finishedPriceRub=null, тогда показывай только finalPriceRub.`
      : `СПП неизвестна → показывай finalPriceRub (${finalPriceRub} ₽) как «цену кабинета». Витринная цена ниже за счёт СПП, но точное значение мы пока не знаем.`,
  });
}
