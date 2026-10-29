/**
 * Hypothesis registry — the 24 business questions the Лаборатория answers.
 *
 * Each entry is a declarative contract:
 *   - which metrics to pair
 *   - which sign/magnitude means what
 *   - what a trader should DO about it
 *   - which risks to flag ("your Black-Friday week skews this")
 *
 * insightEngine.ts walks the registry, picks applicable hypotheses by the
 * metrics the user selected, and fills the templates with the numbers.
 */

import type { MetricKey } from './metrics.js';

export type HypothesisId =
  | 'price_volume_elasticity'
  | 'price_margin_optimum'
  | 'spp_volume'
  | 'seller_discount_volume'
  | 'competitor_pressure'           // v1.1 — requires competitor price series
  | 'ctr_volume'
  | 'views_volume'
  | 'cr_volume'
  | 'ads_volume_lag'
  | 'ads_drr_saturation'
  | 'ads_roi_payout'                 // Этап 5: нетавтологическая замена ads_drr_saturation
  | 'ads_targeting_quality'
  | 'traffic_to_cart'                // Этап 5: нетавтологическая замена ctr_volume
  | 'stock_volume_oos'
  | 'stock_days_margin'
  | 'logistics_share_volume'
  | 'seo_position_views'
  | 'seo_position_orders'
  | 'seo_coverage_views'
  | 'seo_competitor_pressure'       // v1.1 — requires competitor series
  | 'photo_change_ctr'               // v1.1 — event study
  | 'title_change_views'             // v1.1 — event study
  | 'price_change_orders'            // v1.1 — event study
  | 'storage_days_consistency'
  | 'penalty_volume'
  | 'matrix_scan';

export type HypothesisCategory = 'Основная' | 'Важная' | 'Контент' | 'Конкуренты' | 'Логистика' | 'Мета';

export interface HypothesisSpec {
  id: HypothesisId;
  category: HypothesisCategory;
  /** Sort priority inside category — lower numbers show first in UI. */
  priority: number;
  metricsPair: [MetricKey, MetricKey];
  resolution: 'daily' | 'weekly';
  /**
   * Expected sign of correlation under the "healthy" hypothesis. Used by
   * insightEngine to flag inversions as `critical`.
   *   '+' → positive expected (e.g. CTR↑ → orders↑)
   *   '-' → negative expected (e.g. price↑ → orders↓)
   *   '0' → ambiguous — interpret by magnitude only
   */
  expectedSign: '+' | '-' | '0';
  /** Question answered by this hypothesis. */
  hypothesis: string;
  /** Templates keyed by rough r bucket. Use {r}, {p}, {n}, {E}, {lag} placeholders. */
  interpretation: Partial<Record<RBucket, string>>;
  decision: Partial<Record<RBucket, string>>;
  noiseRisk: string;
  /** When true this hypothesis is off by default until event-store/SEO data is wired. */
  mvpEnabled: boolean;
}

/**
 * Bucket labels — the sign is the last char for ordering.
 * 'strong-'   = r ≤ -0.7
 * 'moderate-' = -0.7 < r ≤ -0.3
 * 'weak'      = -0.3 < r < 0.3
 * 'moderate+' = 0.3 ≤ r < 0.7
 * 'strong+'   = 0.7 ≤ r
 */
export type RBucket = 'strong-' | 'moderate-' | 'weak' | 'moderate+' | 'strong+';

export function bucketOf(r: number): RBucket {
  if (!Number.isFinite(r)) return 'weak';
  if (r <= -0.7) return 'strong-';
  if (r <= -0.3) return 'moderate-';
  if (r < 0.3)   return 'weak';
  if (r < 0.7)   return 'moderate+';
  return 'strong+';
}

// ---------------------------------------------------------------------------
// Registry data
// ---------------------------------------------------------------------------

export const HYPOTHESES: HypothesisSpec[] = [
  {
    id: 'price_volume_elasticity',
    category: 'Основная', priority: 10,
    metricsPair: ['finishedPriceRub', 'ordersCount'],
    resolution: 'daily', expectedSign: '-',
    hypothesis: 'Ценовая эластичность спроса: как клиент голосует рублём?',
    interpretation: {
      'strong-':   'Сильная обратная связь: товар высокоэластичен, снижение цены кратно растит спрос.',
      'moderate-': 'Умеренная обратная: снижение цены тянет спрос, но не линейно.',
      'weak':      'Цена почти не драйвер — ищите рычаги в контенте/позициях.',
      'moderate+': 'Положительная связь — возможен эффект Веблена / совпадение с промо.',
      'strong+':   'Сильная положительная — редкий кейс, проверьте совпадение с распродажами.',
    },
    decision: {
      'strong-':   '{bestDate}: цена {bestX}₽ → {bestY} заказов. {worstDate}: цена {worstX}₽ → {worstY} заказов. Тестируйте цену ближе к {bestX}₽ на 7 дней.',
      'moderate-': 'В удачные дни цена держалась ≈{topAvgX}₽ (заказы ≈{topAvgY}/день), в слабые ≈{bottomAvgX}₽. Снизьте цену до {topAvgX}₽ и зафиксируйте 7 дней.',
      'weak':      'Связь цены и заказов слабая (медиана цены {medianX}₽ при {medianY} заказов/день). Не двигайте цену ради объёма — вкладывайтесь в CTR/рекламу/SEO.',
      'moderate+': 'Цена выше — заказов больше: вероятно совпадение с акциями WB. Проверьте даты {bestDate} и {worstDate} в Календаре Событий.',
      'strong+':   'Эффект Веблена не подтверждается без проверки. {bestDate}: цена {bestX}₽ → {bestY} заказов; {worstDate}: цена {worstX}₽ → {worstY}. Проверьте, не было ли промо в дорогие дни.',
    },
    noiseRisk: 'Глобальные распродажи (Чёрная пятница, 11.11) сбивают паттерн. Рекомендуется режим «исключить праздники».',
    mvpEnabled: true,
  },
  {
    id: 'price_margin_optimum',
    category: 'Основная', priority: 20,
    metricsPair: ['finishedPriceRub', 'marginRub'],
    resolution: 'daily', expectedSign: '0',
    hypothesis: 'Оптимум прибыли по цене — ловушка объёма vs маржи.',
    interpretation: {
      'strong-':   'Высокая цена = падение прибыли — товар перешёл в зону эластичности.',
      'moderate-': 'Рост цены съедает прибыль — вы левее точки оптимума.',
      'weak':      'Линейной связи нет — возможна U-форма (ищите в нелинейном режиме).',
      'moderate+': 'Рост цены пока увеличивает прибыль — вы правее точки оптимума.',
      'strong+':   'Прибыль сильно растёт с ценой — проверьте, нет ли шока объёма.',
    },
    decision: {
      'weak':      'Линейной зависимости цена-маржа нет. Возможна U-форма: лучшая маржа на цене ≈{topAvgX}₽ ({bestDate}: {bestX}₽ → {bestY} маржи).',
      'moderate+': '{bestDate}: цена {bestX}₽ → маржа {bestY}₽. Можно тестировать +3% (≈{bestX}₽×1.03) при контроле конверсии.',
      'moderate-': 'Цена выше — маржа ниже. {bestDate}: цена {bestX}₽ → {bestY}₽ маржи. Удерживайте цену в районе {topAvgX}₽.',
    },
    noiseRisk: 'Маржа волатильна по комиссии/логистике — на коротких периодах возможны артефакты.',
    mvpEnabled: true,
  },
  {
    id: 'spp_volume',
    category: 'Основная', priority: 30,
    metricsPair: ['sppPct', 'ordersCount'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Как участие в промо-механиках WB двигает спрос.',
    interpretation: {
      'moderate+': 'СПП работает — включение в акции даёт рост заказов.',
      'strong+':   'Ваш товар завязан на СПП — без акций спрос падает резко.',
      'weak':      'Покупатель не реагирует на СПП — цена с СПП не драйвер.',
    },
    decision: {
      'strong+':   'СПП — рычаг: {bestDate}: СПП {bestX}% → {bestY} заказов; {worstDate}: СПП {worstX}% → {worstY}. Заходите в WB-акции с СПП ≥ {topAvgX}%.',
      'weak':      'СПП не двигает заказы (медиана СПП {medianX}% при {medianY} заказов/день). Рассмотрите отказ от невыгодных акций.',
    },
    noiseRisk: 'Данные СПП приходят с задержкой; LOCF может переоценивать стабильность СПП.',
    mvpEnabled: true,
  },
  {
    id: 'seller_discount_volume',
    category: 'Основная', priority: 40,
    metricsPair: ['sellerDiscountPct', 'ordersCount'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Работа собственных скидок продавца.',
    interpretation: {
      'moderate+': 'Собственная скидка работает, особенно в нишах с ценовой чувствительностью.',
      'weak':      'Скидка не двигает объём — покупатель смотрит на итоговую цену с СПП.',
    },
    decision: {
      'weak':      'Скидка продавца не двигает заказы (медиана скидки {medianX}% при {medianY} заказов/день). Уберите скидку, направьте бюджет в рекламу.',
    },
    noiseRisk: 'Скидки часто совпадают с СПП-акциями — рекомендуется partial correlation.',
    mvpEnabled: true,
  },
  {
    id: 'competitor_pressure',
    category: 'Конкуренты', priority: 50,
    metricsPair: ['finishedPriceRub', 'ordersCount'],
    resolution: 'daily', expectedSign: '-',
    hypothesis: 'Ценовое давление конкурентов (через трекинг цен).',
    interpretation: {
      'strong-':   'Если конкурент опустил цену — ваш спрос падает быстрее, чем можно объяснить сезоном.',
    },
    decision: {},
    noiseRisk: 'Требуются регулярные snapshot-и цен конкурентов — включите парсинг в seo_competitor_positions.',
    mvpEnabled: false,
  },
  {
    id: 'ctr_volume',
    category: 'Важная', priority: 60,
    metricsPair: ['ctrPercent', 'ordersCount'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Качество трафика контента (обложка × позиция).',
    interpretation: {
      'strong+':   'Карточка конвертит — показы окупаются в заказы.',
      'moderate+': 'Контент работает, но есть куда расти.',
      'weak':      'Показы не становятся заказами — проверьте цену/отзывы.',
      'moderate-': 'Обратная связь — подозрительно, проверьте аномалии.',
    },
    decision: {
      'strong+':   'CTR работает: {bestDate} CTR {bestX}% → {bestY} заказов; {worstDate} CTR {worstX}% → {worstY}. Наращивайте показы (реклама/SEO) — каждый показ окупается.',
      'weak':      'CTR не доводит трафик до заказов (медиана CTR {medianX}% при {medianY} заказов/день). Ревизия обложки и отзывов.',
    },
    noiseRisk: 'CTR колеблется при малом числе показов — sparsity guard должен сработать.',
    // Тавтология воронки: CTR = клики/показы, а заказы коррелируют с кликами по
    // определению. Будет переоформлено в `traffic_to_orders` (узкое место воронки).
    mvpEnabled: false,
  },
  {
    id: 'views_volume',
    category: 'Важная', priority: 70,
    metricsPair: ['viewCount', 'ordersCount'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Охват = прямая функция поисковых позиций.',
    interpretation: {
      'strong+':   'Каждый новый показ превращается в заказ с устойчивой конверсией.',
      'moderate+': 'Трафик работает, но с заметным провалом CR.',
      'weak':      'Трафик не монетизируется — проверьте релевантность запросов.',
    },
    decision: {
      'strong+':   '{bestDate}: {bestX} показов → {bestY} заказов; {worstDate}: {worstX} показов → {worstY}. Наращивайте охват через SEO/рекламу.',
      'weak':      'Показы не идут в заказы (медиана показов {medianX} при {medianY} заказов/день). Проверьте релевантность запросов.',
    },
    noiseRisk: 'В периоды распродаж показы взлетают неравномерно по товарам.',
    mvpEnabled: true,
  },
  {
    id: 'traffic_to_cart',
    category: 'Важная', priority: 75,
    metricsPair: ['viewCount', 'addToCartCount'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Привлекательность карточки: сколько корзин даёт показ.',
    interpretation: {
      'strong+':   'Карточка цепляет — рост показов почти линейно даёт рост корзин.',
      'moderate+': 'Карточка работает, но часть трафика теряется до корзины.',
      'weak':      'Показы не превращаются в корзины — обложка/цена/первый экран не убеждают.',
      'moderate-': 'Подозрительный знак: больше показов — меньше корзин. Возможно прилетел нерелевантный трафик.',
    },
    decision: {
      'strong+':   '{bestDate}: {bestX} показов → {bestY} в корзину. {worstDate}: {worstX} показов → {worstY}. Показы окупаются — наращивайте охват через SEO/рекламу.',
      'moderate+': 'В удачные дни на ≈{topAvgX} показов было ≈{topAvgY} корзин, в слабые ≈{bottomAvgX} → ≈{bottomAvgY}. Контент работает, но есть потолок — проверьте первый экран карточки.',
      'weak':      'Из ≈{medianX} показов в день в корзину уходит ≈{medianY}. Проблема не в трафике, а в карточке: проверьте обложку, цену, рейтинг, первый отзыв.',
      'moderate-': '{worstDate}: {worstX} показов дали всего {worstY} корзин — низкая релевантность. Если был запуск кампании в этот день, скорее всего таргетинг шире нужного.',
    },
    noiseRisk: 'В дни распродаж WB на товар прилетает «случайный» трафик, который завышает показы без эффекта на корзины.',
    mvpEnabled: true,
  },
  {
    id: 'cr_volume',
    category: 'Важная', priority: 80,
    metricsPair: ['crPercent', 'ordersCount'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Чистая конверсия корзина→заказ — драйвер прибыли без вложений.',
    interpretation: {
      'strong+':   'Высокая CR + рост заказов — органичный рост без трат.',
      'weak':      'CR стабильна, но заказы не растут — проблема в трафике.',
    },
    decision: {
      'weak':      'CR в заказ стабильна (медиана {medianX}%, заказы {medianY}/день). Не трогайте контент — нагоняйте трафик.',
    },
    noiseRisk: 'На малом числе добавлений в корзину CR волатильна — sparsity guard.',
    // Тавтология: CR = заказы/(добавления в корзину). Связь с заказами
    // гарантирована формулой. Будет переоформлено в `cart_loss` (потери в воронке
    // в ₽: ушло из корзины × средняя цена).
    mvpEnabled: false,
  },
  {
    id: 'ads_volume_lag',
    category: 'Важная', priority: 90,
    metricsPair: ['advSpendRub', 'ordersCount'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Эффективность рекламы с учётом отложенного эффекта.',
    interpretation: {
      'strong+':   'Реклама работает, эффект на {lag}-й день.',
      'moderate+': 'Реклама даёт умеренный эффект, lag={lag}.',
      'weak':      'Реклама не тянет заказы — пересмотрите таргетинг.',
    },
    decision: {
      'strong+':   '{bestDate}: реклама {bestX}₽ → {bestY} заказов через {lag} дн. Эффект на {lag}-й день — масштабируйте бюджет.',
      'weak':      'Реклама {medianX}₽/день не двигает заказы ({medianY}/день). Урежьте спенд на 30%, замерьте падение.',
    },
    noiseRisk: 'ДРР-атрибуция WB неполная; реальный ROAS может отличаться на 10–30%.',
    mvpEnabled: true,
  },
  {
    id: 'ads_drr_saturation',
    category: 'Важная', priority: 100,
    metricsPair: ['advSpendRub', 'drrPercent'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Насыщение рекламного окна — лаг «больше бюджета = выше ДРР».',
    interpretation: {
      'strong+':   'Окно рекламное насыщено — каждый новый рубль хуже предыдущего.',
      'weak':      'Окно не насыщено — можно наращивать бюджет.',
    },
    decision: {
      'strong+':   '{bestDate}: спенд {bestX}₽ → ДРР {bestY}%; {worstDate}: спенд {worstX}₽ → ДРР {worstY}%. Окно насыщено — снижайте ставки на дорогих ключах или открывайте новые кампании.',
    },
    noiseRisk: 'В пиковые дни WB возможны аукционные перекосы.',
    // Тавтология: ДРР = расход на рекламу / выручка × 100. Расход стоит в
    // числителе ДРР, корреляция гарантирована. Будет переоформлено в
    // `ads_roi_per_rub` (₽ выручки на ₽ затрат — нетавтологичная метрика).
    mvpEnabled: false,
  },
  {
    id: 'ads_roi_payout',
    category: 'Важная', priority: 95,
    metricsPair: ['advSpendRub', 'forPayRub'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Окупаемость рекламы: рубль рекламы и рубль в карман.',
    interpretation: {
      'strong+':   'Реклама окупается — растёт расход, растёт и сумма к перечислению.',
      'moderate+': 'Реклама работает, но отдача неравномерная по дням.',
      'weak':      'Связи между расходом на рекламу и выручкой к перечислению нет — деньги уходят, эффекта не видно.',
      'moderate-': 'Подозрительный знак: больше тратите — меньше получаете. Проверьте таргетинг.',
    },
    decision: {
      'strong+':   '{bestDate}: реклама {bestX}₽ → к перечислению {bestY}₽. {worstDate}: реклама {worstX}₽ → {worstY}₽. Текущая стратегия даёт отдачу — можно масштабировать на лучшие кампании.',
      'moderate+': 'В удачные дни реклама ≈{topAvgX}₽ давала ≈{topAvgY}₽ к перечислению, в слабые ≈{bottomAvgX}₽ → ≈{bottomAvgY}₽. Сравните что было разное (ставки, ключи) и удержите параметры удачных дней.',
      'weak':      'Реклама ≈{medianX}₽/день не двигает выплаты ({medianY}₽/день медиана). Срежьте бюджет на 30% и замерьте, не упадут ли заказы — возможно реклама идёт «в воздух».',
      'moderate-': '{worstDate}: реклама {worstX}₽ → выплаты {worstY}₽. Похоже, бюджет уходит на нерелевантные показы — пересоберите кампанию.',
    },
    noiseRisk: 'Лаг между показом и выкупом 1-3 дня может маскировать эффект. Проверьте отдельно с лагом если данных хватает.',
    mvpEnabled: true,
  },
  {
    id: 'ads_targeting_quality',
    category: 'Важная', priority: 110,
    metricsPair: ['viewCount', 'advSpendRub'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Качество таргетинга: платные показы должны совпадать с ростом общих показов.',
    interpretation: {
      'strong+':   'Платные показы органично подкрепляют общий трафик.',
      'weak':      'Платные показы не отражаются в общем охвате — либо низкая доля, либо невидимая аудитория.',
    },
    decision: {},
    noiseRisk: 'В разрезе nmId эффект разнородный.',
    mvpEnabled: true,
  },
  {
    id: 'stock_volume_oos',
    category: 'Логистика', priority: 120,
    metricsPair: ['stockQty', 'ordersCount'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Out-of-stock риск: мало остатков = потерянные заказы.',
    interpretation: {
      'strong+':   'Заказы коррелируют с остатком — в дни низких остатков теряете выручку.',
      'weak':      'Остаток достаточен, OOS не лимитирует.',
      'strong-':   'Обратная связь подозрительна — проверьте синхронизацию данных.',
    },
    decision: {
      'strong+':   '{bestDate}: остаток {bestX}шт → {bestY} заказов; {worstDate}: остаток {worstX}шт → {worstY}. OOS-потери есть — страховой запас на 14 дней, алерт на 7.',
    },
    noiseRisk: 'Снапшоты остатков на момент синка — в течение дня могут расходиться.',
    mvpEnabled: true,
  },
  {
    id: 'stock_days_margin',
    category: 'Логистика', priority: 130,
    metricsPair: ['daysOfStock', 'marginPct'],
    resolution: 'daily', expectedSign: '-',
    hypothesis: 'Избыточный сток на складе WB (FBO) = хранение съедает маржу.',
    interpretation: {
      'strong-':   'Хранение на FBO выжигает маржу. Распродажа FBO-остатков оправдана.',
      'moderate-': 'FBO-сток избыточен, маржа страдает, но не критично.',
      'weak':      'Баланс FBO-стока приемлем.',
    },
    decision: {
      'strong-':   '{bestDate}: покрытие {bestX} дн → маржа {bestY}%; {worstDate}: {worstX} дн → {worstY}%. Распродайте FBO-неликвид (>60 дн покрытия) с глубокой скидкой — дешевле хранения. FBS-остатки (склад продавца) не учитываются — там оборачиваемость регулируется поставками.',
    },
    noiseRisk: 'daysOfStock считается ТОЛЬКО по FBO (склады WB) и 7-дневному среднему — FBS-буфер не входит.',
    mvpEnabled: true,
  },
  {
    id: 'logistics_share_volume',
    category: 'Логистика', priority: 140,
    metricsPair: ['logisticsRub', 'ordersCount'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Линейность логистики: расходы растут строго пропорционально заказам.',
    interpretation: {
      'strong+':   'Логистика масштабируется линейно — здоровый операционный paттерн.',
      'weak':      'Логистика оторвана от заказов — возможны штрафы/возвраты.',
      'moderate-': 'Обратная связь — сигнал об ошибке данных или смене тарифа.',
    },
    decision: {
      'weak':      'Проверьте штрафы/платную приёмку/возвраты.',
    },
    noiseRisk: 'Смена тарифов WB в течение периода ломает линейность.',
    // Тавтология: логистика = тариф × количество заказов. Линейная связь по
    // определению. Будет переоформлено в `logistics_per_unit` (стоимость
    // логистики за единицу с трендом — vs тариф WB).
    mvpEnabled: false,
  },
  {
    id: 'seo_position_views',
    category: 'Важная', priority: 150,
    metricsPair: ['positionBest', 'viewCount'],
    resolution: 'daily', expectedSign: '-',
    hypothesis: 'Поисковая позиция → показы (чем меньше номер позиции, тем больше показов).',
    interpretation: {
      'strong-':   'Позиция — главный драйвер показов.',
      'moderate-': 'Позиция работает, но не единственный рычаг.',
      'weak':      'Показы не объясняются позицией — возможно, трафик из рекомендаций/рекламы.',
    },
    decision: {
      'strong-':   'Инвестируйте в SEO-ключи для удержания ТОП-10.',
    },
    noiseRisk: 'При Jam-блокировке позиции собраны фрагментарно — проверьте полноту данных.',
    mvpEnabled: true,
  },
  {
    id: 'seo_position_orders',
    category: 'Важная', priority: 160,
    metricsPair: ['positionBest', 'ordersCount'],
    resolution: 'daily', expectedSign: '-',
    hypothesis: 'Поисковая позиция → заказы (с возможным лагом 1–3 дня).',
    interpretation: {
      'strong-':   'Позиция напрямую конвертится в заказы, lag={lag}.',
      'weak':      'Позиция есть, заказов нет — сигнал об аудитории/контенте.',
    },
    decision: {
      'strong-':   'Продвижение — приоритет. Lag показывает, когда ждать эффект.',
    },
    noiseRisk: 'Заказы реагируют с задержкой на новые позиции — включите lag-analysis.',
    mvpEnabled: true,
  },
  {
    id: 'seo_coverage_views',
    category: 'Важная', priority: 170,
    metricsPair: ['keywordsInTop10', 'viewCount'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Ширина охвата ключей → показы.',
    interpretation: {
      'strong+':   'Каждый новый ключ в ТОП-10 даёт измеримый прирост показов.',
      'weak':      'Новые ключи не приносят трафика — низкочастотка или сезон.',
    },
    decision: {
      'strong+':   'Расширяйте семантическое ядро — прямой эффект на охват.',
    },
    noiseRisk: 'keywordsInTop10 чувствителен к расписанию snapshot-ов.',
    mvpEnabled: true,
  },
  {
    id: 'seo_competitor_pressure',
    category: 'Конкуренты', priority: 180,
    metricsPair: ['positionBest', 'ordersCount'],
    resolution: 'daily', expectedSign: '-',
    hypothesis: 'Давление конкурентов на SEO — снижение нашей позиции = рост их активности.',
    interpretation: {},
    decision: {},
    noiseRisk: 'Требуется регулярный сбор позиций конкурентов.',
    mvpEnabled: false,
  },
  {
    id: 'photo_change_ctr',
    category: 'Контент', priority: 190,
    metricsPair: ['ctrPercent', 'ordersCount'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Эффект смены фото/обложки на CTR (event study).',
    interpretation: {},
    decision: {},
    noiseRisk: 'Требуется event-store из studio_assets.',
    mvpEnabled: false,
  },
  {
    id: 'title_change_views',
    category: 'Контент', priority: 200,
    metricsPair: ['viewCount', 'viewCount'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Эффект смены заголовка на показы (event study).',
    interpretation: {}, decision: {},
    noiseRisk: 'Требуется audit_log.resource_type = wb_card.',
    mvpEnabled: false,
  },
  {
    id: 'price_change_orders',
    category: 'Контент', priority: 210,
    metricsPair: ['finishedPriceRub', 'ordersCount'],
    resolution: 'daily', expectedSign: '-',
    hypothesis: 'Реакция рынка на смену цены агентом (event study ±7).',
    interpretation: {}, decision: {},
    noiseRisk: 'Требуется join с agent_actions.',
    mvpEnabled: false,
  },
  {
    id: 'storage_days_consistency',
    category: 'Логистика', priority: 220,
    metricsPair: ['storageRub', 'daysOfStock'],
    resolution: 'daily', expectedSign: '+',
    hypothesis: 'Санити-проверка: хранение должно расти с покрытием дней на складе.',
    interpretation: {
      'strong+':   'Логика консистентна.',
      'weak':      'Подозрение на ошибку ETL — хранение не следует за стоком.',
    },
    decision: {
      'weak':      'Срочно проверьте синхронизацию wb_finance_daily_products.',
    },
    noiseRisk: 'Разные тарифы хранения по объёму/типу склада могут искажать линейность.',
    // Тавтология: и хранение и dosof_stock растут со стоком. Это санити-проверка
    // ETL, а не бизнес-инсайт — место для неё в диагностике, не в карточках.
    mvpEnabled: false,
  },
  {
    id: 'penalty_volume',
    category: 'Логистика', priority: 230,
    metricsPair: ['penaltyRub', 'ordersCount'],
    resolution: 'daily', expectedSign: '-',
    hypothesis: 'Штрафы WB давят продажи в моменте.',
    interpretation: {
      'strong-':   'Штрафы коррелируют со спадом — проверьте причины.',
      'weak':      'Штрафы редкие / не связаны с заказами.',
    },
    decision: {
      'strong-':   'Разберите тип штрафов (упаковка/маркировка/срок) — устраните причину.',
    },
    noiseRisk: 'Разовые штрафы — не паттерн. Сверьте даты с агентскими действиями.',
    mvpEnabled: true,
  },
  {
    id: 'matrix_scan',
    category: 'Мета', priority: 1000,
    metricsPair: ['ordersCount', 'finishedPriceRub'],
    resolution: 'daily', expectedSign: '0',
    hypothesis: 'Полный N×N скан метрик с BH-FDR коррекцией.',
    interpretation: {}, decision: {},
    noiseRisk: 'Без FDR коррекции даже при нулевой истинной корреляции 1–2 пары из 28 выпадают значимыми.',
    mvpEnabled: true,
  },
];

export function hypothesisById(id: HypothesisId): HypothesisSpec | undefined {
  return HYPOTHESES.find(h => h.id === id);
}

/** Retrieve all MVP-enabled hypotheses that match a pair of metrics (order-insensitive). */
export function findHypothesesByPair(
  a: MetricKey,
  b: MetricKey,
  includeNonMvp = false,
): HypothesisSpec[] {
  return HYPOTHESES.filter(h => {
    if (!includeNonMvp && !h.mvpEnabled) return false;
    const [x, y] = h.metricsPair;
    return (x === a && y === b) || (x === b && y === a);
  });
}
