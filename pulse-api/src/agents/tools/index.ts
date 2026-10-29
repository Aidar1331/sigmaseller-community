/**
 * Tool Registry for the Pulse AI Agent.
 *
 * Tools are grouped into 4 categories:
 * - query* : Read-only data retrieval (safe, no confirmation needed)
 * - calc*  : Calculations & projections (safe)
 * - show*  : Widget generation (safe)
 * - action*: Write operations (DANGEROUS, need confirmation)
 *
 * All tools receive _workspaceId injected by the graph — never from user input.
 *
 * 49 tools total (28 safe + 6 widget + 15 dangerous):
 * Phase 0: 24 original tools
 * Phase 1: +4 communication (query_questions, query_chats, action_reply_question, action_send_chat_message)
 * Phase 2: +5 card management (query_card_health, query_categories, query_card_limits, action_create_card, action_update_characteristics)
 * Phase 3: +7 logistics (query_warehouses, query_supplies, query_fbs_orders, query_acceptance_coefficients, action_create_supply, action_confirm_fbs_order, show_supply_calendar)
 * Phase 4: +5 promotions/docs (query_promotions, action_manage_promotion, query_documents, query_wb_news, query_tariffs)
 * Phase 5: +4 strategy (query_competitors, query_assortment_health, calc_ab_test, show_seller_report)
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { queryFinanceOverview } from './queryFinance.js';
import { querySalesOverview } from './querySales.js';
import { queryStocksOverview } from './queryStocks.js';
import { queryFunnelOverview } from './queryFunnel.js';
import { queryAlerts } from './queryAlerts.js';
import { queryAbTests } from './queryAbTests.js';
import { queryProductDetails } from './queryProduct.js';
import { queryReturnsOverview } from './queryReturns.js';
import { queryAdvertisingOverview } from './queryAdvertising.js';
import { querySeoOverview } from './querySeo.js';
import { queryRegionalOverview } from './queryRegional.js';
import { queryStorageOverview } from './queryStorage.js';
import { calcUnitEconomics } from './calcUnitEconomics.js';
import { showFunnelDiagram } from './showFunnel.js';
import { showPriceSlider } from './showPriceSlider.js';
import { showAbcChart } from './showAbcChart.js';
import { showSupplyPlan } from './showSupplyPlan.js';
import { actionSetPrice } from './actionSetPrice.js';
import { actionReplyFeedback } from './actionReplyFeedback.js';
import { actionEditFeedbackReply } from './actionEditFeedbackReply.js';
import { actionRejectQuestion } from './actionRejectQuestion.js';
import { actionReturnByReview } from './actionReturnByReview.js';
import { queryFunnelGrouped } from './queryFunnelGrouped.js';
import { queryProductsBySemantics } from './queryProductsBySemantics.js';
import { queryProductsByCharacteristics } from './queryProductsByCharacteristics.js';
import { listAvailableCharacteristics } from './listAvailableCharacteristics.js';
import { actionApproveReturn } from './actionApproveReturn.js';
import { actionRejectReturn } from './actionRejectReturn.js';
import { actionBookSupplySlot } from './actionBookSupplySlot.js';
import { actionQueueAutoBook } from './actionQueueAutoBook.js';
import { actionStartCampaign, actionPauseCampaign, actionUpdateBid } from './actionCampaign.js';
import { actionManageDiscount } from './actionManageDiscount.js';
import { actionUpdateCard } from './actionUpdateCard.js';
import { actionManageClusters } from './actionManageClusters.js';

// Phase 1: Communication tools
import { queryQuestions } from './queryQuestions.js';
import { queryFeedbackSummary } from './queryFeedbackSummary.js';
import { queryChats } from './queryChats.js';
import { actionReplyQuestion } from './actionReplyQuestion.js';
import { actionSendChatMessage } from './actionSendChatMessage.js';

// Phase 2: Card management tools
import { queryCardHealth } from './queryCardHealth.js';
import { queryCategories } from './queryCategories.js';
import { queryCardLimits } from './queryCardLimits.js';
import { actionCreateCard } from './actionCreateCard.js';
import { actionUpdateCharacteristics } from './actionUpdateCharacteristics.js';

// Phase 3: Logistics FBO/FBS tools
import { queryWarehouses } from './queryWarehouses.js';
import { querySupplies } from './querySupplies.js';
import { queryFbsOrders } from './queryFbsOrders.js';
import { queryAcceptanceCoefficients } from './queryAcceptanceCoefficients.js';
import { actionCreateSupply } from './actionCreateSupply.js';
import { actionConfirmFbsOrder } from './actionConfirmFbsOrder.js';
import { actionGenerateSupplySlip } from './actionGenerateSupplySlip.js';
import { showSupplyWizard } from './showSupplyWizard.js';
import { showSupplyCreated } from './showSupplyCreated.js';
import { showSupplyCalendar } from './showSupplyCalendar.js';
import { showDataTable } from './showDataTable.js';

// Phase 4: Promotions, documents, news
import { queryPromotions } from './queryPromotions.js';
import { actionManagePromotion } from './actionManagePromotion.js';
import { queryDocuments } from './queryDocuments.js';
import { queryWbNews } from './queryWbNews.js';
import { queryTariffs } from './queryTariffs.js';

// Phase 5: Assortment, reports, analytics
import { queryCompetitors } from './queryCompetitors.js';
import { queryCompetitorCard } from './queryCompetitorCard.js';
import { queryAssortmentHealth } from './queryAssortmentHealth.js';
import { queryCurrentPrice } from './queryCurrentPrice.js';
import { suggestPhotoPrompts } from './suggestPhotoPrompts.js';
import { calcAbTest } from './calcAbTest.js';
import { showSellerReport } from './showSellerReport.js';

// FBO: Stickers + Passes
import { actionGetBoxStickers } from './actionGetBoxStickers.js';
import { queryPasses } from './queryPasses.js';
import { actionCreatePass } from './actionCreatePass.js';

// FBS E2E (0131): создание поставки + добавление заказов + штрихкод + отгрузка
import { actionCreateFbsSupply } from './actionCreateFbsSupply.js';
import { actionDeliverFbsSupply } from './actionDeliverFbsSupply.js';
import { actionGetFbsSupplyBarcode } from './actionGetFbsSupplyBarcode.js';
// FBW prepare (deep-link mode, since WB blocked POST /supplies create)
import { actionPrepareFbwSupply } from './actionPrepareFbwSupply.js';

// Multi-Agent v2: domain subagent wrappers (registered only when ENABLE_MULTI_AGENT=1)
import { subagentPricing } from './subagent_pricing.js';
import { subagentAds } from './subagent_ads.js';
import { subagentReviews } from './subagent_reviews.js';
import { subagentSupply } from './subagent_supply.js';
import { subagentSeo } from './subagent_seo.js';
import { subagentSeoKeywordSuggestion } from './subagent_seo_keyword_suggestion.js';
import { actionAddSeoKeywords } from './actionAddSeoKeywords.js';
import { subagentChat } from './subagent_chat.js';
import { subagentFbs } from './subagent_fbs.js';

// Лаборатория корреляций — safe analytics subagent
import { subagentLab } from './subagentLab.js';
import { env } from '../../env.js';

// ── Query Tools (safe, read-only) ────────────────────────────

export const queryFinanceTool = tool(queryFinanceOverview, {
  name: 'query_finance',
  description:
    'Финансовый обзор: выручка, расходы, маржа, ДРР, прибыль за период. '
    + 'Возвращает: revenueRub (выручка = sales_rub из orders_sales, ЕДИНЫЙ источник со всеми тулами), '
    + 'adjustmentsRub (разница «финотчёт − orders_sales» — корректировки WB), '
    + 'financeReportRevenueRub (что показывает финансовый отчёт WB), '
    + 'profitRub, marginPct (БЕЗ COGS), drrPct, '
    + 'logisticsKop/penaltiesKop/acceptanceKop/commissionKop/advSpendKop, '
    + 'ordersCount, ordersRevenueRub (сумма заказов — главная пара), '
    + 'salesCount (справочно). '
    + ''
    + 'Правила подачи: '
    + '(1) Главная пара — Заказы (ordersCount + ordersRevenueRub). Выкупы (salesCount) показывай как дополнительную метрику или в drill-down — НЕ рядом с заказами в основной таблице. '
    + '(2) Если adjustmentsRub != 0 — упомяни «±N ₽ корректировок WB» отдельной строкой. '
    + '(3) marginPct > 50% = маржа без себестоимости. ЯВНО предупреди: «Реальная маржа будет ниже когда заведёшь COGS на /cogs». '
    + '(4) НЕ делай salesCount/ordersCount = «процент выкупа» — это разные товары/даты. Реальный когортный buyoutPercent — через query_funnel или query_assortment_health(showBuyoutPct=true).',
  schema: z.object({
    from: z.string().describe('Дата начала (YYYY-MM-DD)'),
    to: z.string().describe('Дата конца (YYYY-MM-DD)'),
    nmIds: z.array(z.union([z.number(), z.string()])).optional().describe('Фильтр по артикулам — принимай как WB-артикул (nmId, число), так и артикул продавца (vendorCode, строка). НЕ требуй у пользователя именно nmId — мы автоматически найдём по vendorCode.'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const querySalesTool = tool(querySalesOverview, {
  name: 'query_sales',
  description: 'Получить обзор продаж: заказы, продажи, возвраты, выкуп за период.',
  schema: z.object({
    from: z.string().describe('Дата начала (YYYY-MM-DD)'),
    to: z.string().describe('Дата конца (YYYY-MM-DD)'),
    nmIds: z.array(z.union([z.number(), z.string()])).optional().describe('Фильтр по артикулам — принимай как WB-артикул (nmId, число), так и артикул продавца (vendorCode, строка). НЕ требуй у пользователя именно nmId — мы автоматически найдём по vendorCode.'),
    groupBy: z.enum(['day', 'week', 'total']).optional().default('total'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryStocksTool = tool(queryStocksOverview, {
  name: 'query_stocks',
  description: 'Получить текущие остатки: по складам, дни запаса, товары с нулевыми остатками.',
  schema: z.object({
    nmIds: z.array(z.union([z.number(), z.string()])).optional().describe('Фильтр по артикулам — принимай как WB-артикул (nmId, число), так и артикул продавца (vendorCode, строка). НЕ требуй у пользователя именно nmId — мы автоматически найдём по vendorCode.'),
    lowDaysThreshold: z.number().optional().default(14).describe('Порог "мало дней остатка"'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryFunnelTool = tool(queryFunnelOverview, {
  name: 'query_funnel',
  description: 'Получить воронку конверсии: показы → клики → корзина → заказы → выкуп.',
  schema: z.object({
    from: z.string().describe('Дата начала (YYYY-MM-DD)'),
    to: z.string().describe('Дата конца (YYYY-MM-DD)'),
    nmIds: z.array(z.union([z.number(), z.string()])).optional().describe('Фильтр по артикулам — принимай как WB-артикул (nmId, число), так и артикул продавца (vendorCode, строка). НЕ требуй у пользователя именно nmId — мы автоматически найдём по vendorCode.'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryAlertsTool = tool(queryAlerts, {
  name: 'query_alerts',
  description: 'Получить последние алерты и события workspace: проблемы со стоком, ДРР, продажи.',
  schema: z.object({
    status: z.enum(['active', 'resolved', 'all']).optional().default('active'),
    severity: z.enum(['warn', 'critical', 'all']).optional().default('all'),
    limit: z.number().optional().default(20),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryAbTestsTool = tool(queryAbTests, {
  name: 'query_ab_tests',
  description: 'Получить статус и результаты A/B-тестов фото/контента по списку артикулов (active, completed, winner).',
  schema: z.object({
    nmIds: z.array(z.number()).describe('Список nmId, по которым нужен статус A/B-тестов'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryProductTool = tool(queryProductDetails, {
  name: 'query_product',
  description: 'Получить детальную информацию по товару: карточка, продажи, остатки, реклама.',
  schema: z.object({
    nmId: z.number().describe('Артикул WB (nmId)'),
    from: z.string().optional().describe('Дата начала для метрик'),
    to: z.string().optional().describe('Дата конца для метрик'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryReturnsTool = tool(queryReturnsOverview, {
  name: 'query_returns',
  description: 'Анализ возвратов: паттерны, причины, проблемные товары. Выявляет системные проблемы с качеством.',
  schema: z.object({
    nmIds: z.array(z.union([z.number(), z.string()])).optional().describe('Фильтр по артикулам — принимай как WB-артикул (nmId, число), так и артикул продавца (vendorCode, строка). НЕ требуй у пользователя именно nmId — мы автоматически найдём по vendorCode.'),
    daysBack: z.number().optional().default(30).describe('За сколько дней анализировать'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryAdvertisingTool = tool(queryAdvertisingOverview, {
  name: 'query_advertising',
  description: 'Детальная аналитика рекламы: ROI/ROAS, DRR, CTR, CPC по товарам. Выявляет убыточные кампании.',
  schema: z.object({
    from: z.string().describe('Дата начала (YYYY-MM-DD)'),
    to: z.string().describe('Дата конца (YYYY-MM-DD)'),
    nmIds: z.array(z.union([z.number(), z.string()])).optional().describe('Фильтр по артикулам — принимай как WB-артикул (nmId, число), так и артикул продавца (vendorCode, строка). НЕ требуй у пользователя именно nmId — мы автоматически найдём по vendorCode.'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const querySeoTool = tool(querySeoOverview, {
  name: 'query_seo',
  description: 'SEO-аналитика: позиции по ключевым словам, тренды, алерты (падение/восстановление позиций).',
  schema: z.object({
    nmIds: z.array(z.union([z.number(), z.string()])).optional().describe('Фильтр по артикулам — принимай как WB-артикул (nmId, число), так и артикул продавца (vendorCode, строка). НЕ требуй у пользователя именно nmId — мы автоматически найдём по vendorCode.'),
    daysBack: z.number().optional().default(14).describe('За сколько дней'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryRegionalTool = tool(queryRegionalOverview, {
  name: 'query_regional',
  description: 'Региональная аналитика: продажи по регионам, распределение остатков по складам. Рекомендации по логистике.',
  schema: z.object({
    from: z.string().describe('Дата начала (YYYY-MM-DD)'),
    to: z.string().describe('Дата конца (YYYY-MM-DD)'),
    nmIds: z.array(z.union([z.number(), z.string()])).optional().describe('Фильтр по артикулам — принимай как WB-артикул (nmId, число), так и артикул продавца (vendorCode, строка). НЕ требуй у пользователя именно nmId — мы автоматически найдём по vendorCode.'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryStorageTool = tool(queryStorageOverview, {
  name: 'query_storage',
  description: 'Анализ расходов на хранение: стоимость по складам, "мёртвый" сток, рекомендации по оптимизации.',
  schema: z.object({
    from: z.string().describe('Дата начала (YYYY-MM-DD)'),
    to: z.string().describe('Дата конца (YYYY-MM-DD)'),
    nmIds: z.array(z.union([z.number(), z.string()])).optional().describe('Фильтр по артикулам — принимай как WB-артикул (nmId, число), так и артикул продавца (vendorCode, строка). НЕ требуй у пользователя именно nmId — мы автоматически найдём по vendorCode.'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

// ── Calculation Tools (safe) ─────────────────────────────────

export const calcUnitEconTool = tool(calcUnitEconomics, {
  name: 'calc_unit_economics',
  description: 'Рассчитать юнит-экономику товара: маржа, ДРР, ROI, прогноз при изменении цены.',
  schema: z.object({
    nmId: z.number().describe('Артикул WB'),
    currentPriceKop: z.number().optional().describe('Текущая цена в копейках'),
    newPriceKop: z.number().optional().describe('Новая цена для прогноза (в копейках)'),
    cogsKop: z.number().optional().describe('Себестоимость в копейках'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

// ── Widget Tools (safe, visual) ──────────────────────────────

export const showFunnelTool = tool(showFunnelDiagram, {
  name: 'show_funnel',
  description: 'Показать интерактивную диаграмму воронки конверсии как виджет.',
  schema: z.object({
    nmId: z.number().optional().describe('Артикул WB'),
    from: z.string().describe('Дата начала'),
    to: z.string().describe('Дата конца'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const showPriceSliderTool = tool(showPriceSlider, {
  name: 'show_price_slider',
  description: 'Показать интерактивный слайдер оптимизации цены с прогнозом метрик.',
  schema: z.object({
    nmId: z.number().describe('Артикул WB'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const showAbcChartTool = tool(showAbcChart, {
  name: 'show_abc_chart',
  description: 'ABC-анализ товаров: категоризация по вкладу в выручку (A=80%, B=15%, C=5%). Визуальный виджет.',
  schema: z.object({
    from: z.string().describe('Дата начала (YYYY-MM-DD)'),
    to: z.string().describe('Дата конца (YYYY-MM-DD)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const showSupplyPlanTool = tool(showSupplyPlan, {
  name: 'show_supply_plan',
  description: 'Показать план поставок: расчёт необходимого количества по товарам и складам на основе скорости продаж.',
  schema: z.object({
    nmIds: z.array(z.number()).optional().describe('Фильтр по артикулам'),
    targetDays: z.number().optional().default(45).describe('Целевой запас в днях'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const showSupplyWizardTool = tool(showSupplyWizard, {
  name: 'show_supply_wizard',
  description:
    'Показать интерактивный мастер создания FBO-поставки (3 шага: выбор товаров из рекомендаций → склад → тип доставки → [Создать]). Используй когда пользователь хочет быстро оформить поставку. Пред-условие: был запуск subagent_supply/supply-agent (иначе виджет предложит запустить анализ).',
  schema: z.object({
    minUrgency: z.enum(['critical', 'high', 'medium', 'low']).optional()
      .describe('Показать только товары с такой и выше срочностью'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
  }),
});

export const showSupplyCreatedTool = tool(showSupplyCreated, {
  name: 'show_supply_created',
  description:
    'Показать финальный экран успешной поставки: preorderID, состав, кнопки [Скачать лист приёмки] и [Открыть в ЛК WB]. Вызывай сразу после успешного action_create_supply.',
  schema: z.object({
    supplyRowId: z.number().describe('Внутренний id поставки из wb_supplies'),
    _workspaceId: z.number().optional(),
  }),
});

// ── Dangerous Tools (require confirmation) ─────────────────

export const actionSetPriceTool = tool(actionSetPrice, {
  name: 'action_set_price',
  description:
    'Изменить базовую цену товара на WB (опционально вместе со скидкой продавца). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Перед вызовом узнай текущую цену через query_current_price и в rationale укажи и базу, и финальную цену со скидкой — пользователь должен видеть оба числа. ' +
    'Если tool вернёт status="queued" или "already_queued" — это нормальный успех: команда поставлена в очередь и применится через несколько секунд. ' +
    'В этом случае ОБЯЗАТЕЛЬНО включи в свой финальный ответ маркер вида [actionId:N] (целиком, в квадратных скобках) — UI по этому маркеру покажет пользователю прогресс исполнения. ' +
    'Не выдумывай результаты WB и не утверждай "цена изменена" до подтверждения статусом executed.',
  schema: z.object({
    nmId: z.number().describe('Артикул WB'),
    newPriceKop: z.number().describe('Новая БАЗОВАЯ цена (до скидки продавца), в копейках'),
    newDiscountPct: z.number().min(0).max(99).optional().describe('Новая скидка продавца в процентах (0–99). Если не указана — сохраняется текущая скидка WB.'),
    rationale: z.string().describe('Обоснование изменения цены. Включи и базу, и финальную цену с учётом скидки.'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionReplyFeedbackTool = tool(actionReplyFeedback, {
  name: 'action_reply_feedback',
  description:
    'Ответить на отзыв покупателя на WB. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Если tool вернёт status="queued" — это нормальный успех: ответ поставлен в очередь и отправится через секунды. ' +
    'В этом случае ОБЯЗАТЕЛЬНО включи в финальный ответ маркер вида [actionId:N] (в квадратных скобках) — UI по нему покажет прогресс. ' +
    'Не утверждай "ответ отправлен" до подтверждения статусом executed.',
  schema: z.object({
    feedbackId: z.string().describe('ID отзыва'),
    replyText: z.string().describe('Текст ответа'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionEditFeedbackReplyTool = tool(actionEditFeedbackReply, {
  name: 'action_edit_feedback_reply',
  description:
    'Отредактировать ранее отправленный ответ на отзыв. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ. ' +
    'WB разрешает 1 правку в течение 60 дней с момента исходного ответа — позже вернёт ошибку. ' +
    'Используй когда нужно исправить опечатку, уточнить формулировку, или после обратной связи от пользователя.',
  schema: z.object({
    feedbackId: z.string().describe('ID отзыва'),
    replyText: z.string().describe('Новый текст ответа'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionRejectQuestionTool = tool(actionRejectQuestion, {
  name: 'action_reject_question',
  description:
    'Отклонить вопрос покупателя. Покупатель получит ответ, но вопрос+ответ НЕ опубликуются на WB. ' +
    'Используй для спама, повторов, не-вопросов («спасибо», эмоджи). ' +
    'Для публичного ответа на нормальный вопрос — action_reply_question. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
  schema: z.object({
    questionId: z.string().describe('ID вопроса'),
    replyText: z.string().describe('Текст ответа покупателю (не публикуется)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionReturnByReviewTool = tool(actionReturnByReview, {
  name: 'action_return_by_review',
  description:
    'Оформить возврат товара покупателю по отзыву (инициирует продавец). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ. ' +
    'Доступно только для отзывов с isAbleReturnProductOrders=true. ' +
    'Use case: серия 1-2★ с критичной проблемой → автоматический возврат для снятия партии. ' +
    'Возврат произойдёт когда товар вернётся в ПВЗ.',
  schema: z.object({
    feedbackId: z.string().describe('ID отзыва с признаком isAbleReturnProductOrders=true'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const queryFunnelGroupedTool = tool(queryFunnelGrouped, {
  name: 'query_funnel_grouped',
  description:
    'Категорийная аналитика воронки продаж по бренду / предмету / ярлыку за период. ' +
    'Возвращает агрегаты (просмотры, открытия карточки, добавления в корзину, заказы, выкупы) + конверсию и выкуп %. ' +
    'Use cases: «бренд X растёт, бренд Y проседает», сравнение категорий, эффективность ярлыков (например Архив). ' +
    'Укажи РОВНО ОДНУ группировку (brandNames ИЛИ subjectIds ИЛИ tagIds), иначе WB пересечёт и группа окажется пустой.',
  schema: z.object({
    from: z.string().describe('Начало периода YYYY-MM-DD'),
    to: z.string().describe('Конец периода YYYY-MM-DD'),
    brandNames: z.array(z.string()).optional().describe('Группировка по брендам товаров'),
    subjectIds: z.array(z.number()).optional().describe('Группировка по subjectId (предметам WB)'),
    tagIds: z.array(z.number()).optional().describe('Группировка по ярлыкам продавца'),
    aggregationLevel: z.enum(['day', 'week']).optional().describe('Шаг агрегации: день (дефолт) или неделя'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
  }),
});

// ─────────────────────────────────────────────────────────────────────
// RAG / semantic + characteristics поиск товаров (2026-05-31, фаза «команды
// в чате AI»). Карта решения:
//   - семантические/абстрактные запросы («подарок маме», «как 731640698»)
//     → query_products_by_semantics (pgvector cosine + Jina embeddings)
//   - точные фильтры по характеристикам («Цвет=Чёрный, Размер=38»)
//     → query_products_by_characteristics (GIN по raw->'characteristics')
//   - AI не знает какие характеристики есть в магазине
//     → list_available_characteristics (топ-N по частоте)
// ─────────────────────────────────────────────────────────────────────

export const queryProductsBySemanticsTool = tool(queryProductsBySemantics, {
  name: 'query_products_by_semantics',
  description:
    'Семантический поиск товаров через RAG (pgvector + Jina embeddings). '
    + 'Используй для СВОБОДНЫХ запросов: «подарок маме», «летнее лёгкое», '
    + '«товары как 731640698». Для точных фильтров по характеристикам '
    + '(«Цвет=Чёрный») используй query_products_by_characteristics. '
    + 'Возвращает топ-N товаров с similarity 0..1 (порог релевантности ~0.6).',
  schema: z.object({
    query: z.string().optional().describe('Свободный текстовый запрос'),
    similarToNmId: z.number().optional().describe('Артикул-«пример». Возвращает товары похожие на него (вместо query)'),
    limit: z.number().min(1).max(50).optional().describe('Сколько вернуть (по умолчанию 10)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
  }),
});

export const queryProductsByCharacteristicsTool = tool(queryProductsByCharacteristics, {
  name: 'query_products_by_characteristics',
  description:
    'Точный поиск товаров по характеристикам и/или бренду/категории. '
    + 'Используй когда юзер УКАЗАЛ конкретные свойства: цвет, размер, состав, '
    + 'сезон, материал, бренд. Если не знаешь какие характеристики есть в '
    + 'магазине — сначала вызови list_available_characteristics. '
    + 'Несколько значений в массиве = OR внутри одной характеристики.',
  schema: z.object({
    filters: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional()
      .describe('map характеристика → значение(я). Пример: {"Цвет":["Чёрный","Серый"],"Сезон":"Демисезон"}'),
    brand: z.string().optional().describe('Фильтр по бренду (ILIKE)'),
    category: z.string().optional().describe('Фильтр по категории/subject_name (ILIKE)'),
    limit: z.number().min(1).max(200).optional(),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
  }),
});

export const listAvailableCharacteristicsTool = tool(listAvailableCharacteristics, {
  name: 'list_available_characteristics',
  description:
    'Список характеристик которые встречаются у товаров магазина + топ-10 '
    + 'значений каждой. Зови ПЕРЕД query_products_by_characteristics если не '
    + 'знаешь какие свойства есть. Опц. category — посмотреть характеристики '
    + 'конкретной категории.',
  schema: z.object({
    category: z.string().optional().describe('Опц. категория (subject_name) для уточнения'),
    limit: z.number().min(1).max(100).optional().describe('Сколько ключей отдать (по умолчанию 30)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
  }),
});

export const actionApproveReturnTool = tool(actionApproveReturn, {
  name: 'action_approve_return',
  description:
    'Одобрить возврат товара покупателем на WB. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Используй когда селлер согласен с возвратом (бракованный товар / не подошёл размер / иная обоснованная причина). ' +
    'Если tool вернёт status="queued" — это нормальный успех; включи маркер [actionId:N] в финальный ответ.',
  schema: z.object({
    returnId: z.number().int().positive().describe('Числовой ID возврата на WB'),
    comment: z.string().optional().describe('Необязательный комментарий продавца к одобрению'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionRejectReturnTool = tool(actionRejectReturn, {
  name: 'action_reject_return',
  description:
    'Отклонить возврат товара покупателем на WB. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Используй когда возврат необоснован (повреждение из-за неправильной эксплуатации / отсутствие брака / истёкший срок возврата). ' +
    'Обязателен параметр reason. Если tool вернёт status="queued" — нормальный успех; маркер [actionId:N] в финальный ответ.',
  schema: z.object({
    returnId: z.number().int().positive().describe('Числовой ID возврата на WB'),
    reason: z.string().describe('Краткая формальная причина отказа (для протокола)'),
    comment: z.string().optional().describe('Развёрнутый комментарий продавца'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionStartCampaignTool = tool(actionStartCampaign, {
  name: 'action_start_campaign',
  description:
    'Запустить рекламную кампанию на WB. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Если tool вернёт status="queued" — это нормальный успех. ' +
    'Включи в финальный ответ маркер [actionId:N] — UI покажет прогресс.',
  schema: z.object({
    campaignId: z.number().describe('ID рекламной кампании'),
    rationale: z.string().describe('Обоснование запуска'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionPauseCampaignTool = tool(actionPauseCampaign, {
  name: 'action_pause_campaign',
  description:
    'Остановить (поставить на паузу) рекламную кампанию на WB. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Если tool вернёт status="queued" — нормальный успех. Включи в ответ маркер [actionId:N] для UI-прогресса.',
  schema: z.object({
    campaignId: z.number().describe('ID рекламной кампании'),
    rationale: z.string().describe('Обоснование остановки'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionUpdateBidTool = tool(actionUpdateBid, {
  name: 'action_update_bid',
  description:
    'Изменить ставку для товара в рекламной кампании. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Если tool вернёт status="queued" — это нормальный успех: команда в очереди и применится через секунды. ' +
    'Включи в финальный ответ маркер [actionId:N] (в квадратных скобках) — UI покажет прогресс.',
  schema: z.object({
    campaignId: z.number().describe('ID рекламной кампании'),
    nmId: z.number().describe('Артикул WB'),
    bidKopecks: z.number().describe('Новая ставка в копейках'),
    rationale: z.string().describe('Обоснование изменения ставки'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionManageDiscountTool = tool(actionManageDiscount, {
  name: 'action_manage_discount',
  description:
    'Установить или убрать скидку на товар. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Если tool вернёт status="queued" — нормальный успех. Включи в ответ маркер [actionId:N] для UI-прогресса.',
  schema: z.object({
    nmId: z.number().describe('Артикул WB'),
    discountPct: z.number().describe('Размер скидки в процентах (0-100)'),
    action: z.enum(['set', 'remove']).describe('Действие: set — установить, remove — убрать'),
    rationale: z.string().describe('Обоснование'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionUpdateCardTool = tool(actionUpdateCard, {
  name: 'action_update_card',
  description:
    'SEO-оптимизация карточки: обновить заголовок и/или описание товара на WB. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Если tool вернёт status="queued" — нормальный успех. Включи в ответ маркер [actionId:N] для UI-прогресса.',
  schema: z.object({
    nmId: z.number().describe('Артикул WB'),
    title: z.string().optional().describe('Новый заголовок товара'),
    description: z.string().optional().describe('Новое описание товара'),
    rationale: z.string().describe('Обоснование изменений'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionManageClustersTool = tool(actionManageClusters, {
  name: 'action_manage_clusters',
  description:
    'Управление поисковыми кластерами рекламы: установить минус-фразы или ставки по кластерам. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Если tool вернёт status="queued" — нормальный успех. Включи в ответ маркер [actionId:N] для UI-прогресса.',
  schema: z.object({
    campaignId: z.number().describe('ID рекламной кампании'),
    action: z.enum(['set_minus', 'set_bid']).describe('Действие: set_minus — минус-фразы, set_bid — ставки по кластерам'),
    minusPhrases: z.array(z.string()).optional().describe('Список минус-фраз (для set_minus)'),
    clusterBids: z.array(z.object({
      cluster: z.string().describe('Текст поискового кластера'),
      bidKop: z.number().describe('Ставка в копейках'),
    })).optional().describe('Ставки по кластерам (для set_bid)'),
    rationale: z.string().describe('Обоснование'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

// ── Phase 1: Communication Tools ────────────────────────────

export const queryQuestionsTool = tool(queryQuestions, {
  name: 'query_questions',
  description: 'Получить вопросы покупателей по товарам. Показывает неотвеченные и отвеченные вопросы.',
  schema: z.object({
    isAnswered: z.boolean().optional().describe('Фильтр: true — отвеченные, false — неотвеченные, не указано — все'),
    nmId: z.number().optional().describe('Фильтр по артикулу WB'),
    limit: z.number().optional().describe('Максимум вопросов (по умолчанию 50)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryFeedbackSummaryTool = tool(queryFeedbackSummary, {
  name: 'query_feedback_summary',
  description:
    'AI-сводка отзывов и вопросов за период: выявляет повторяющиеся темы жалоб (качество/упаковка/доставка/несоответствие), считает статистику (средняя оценка, распределение звёзд, % ответов), даёт actionable insights. ' +
    'Используй когда селлер спрашивает "о чём чаще всего пишут", "что за квартал жаловались", "какие 3 самые больные темы". ' +
    'Default 30 дней, максимум 120. Можно фильтровать по конкретному nmId или типу (review/question). ' +
    'Результат кэшируется на 30 минут.',
  schema: z.object({
    days: z.number().int().min(1).max(120).optional().describe('Количество дней назад (1-120, по умолчанию 30)'),
    nmId: z.number().int().positive().optional().describe('Фильтр по конкретному товару'),
    itemType: z.enum(['review', 'question', 'all']).optional().describe('Тип (по умолчанию all)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryChatsTool = tool(queryChats, {
  name: 'query_chats',
  description: 'Получить список чатов с покупателями. Показывает непрочитанные сообщения и активные диалоги.',
  schema: z.object({
    status: z.enum(['active', 'closed']).optional().describe('Статус чатов'),
    unreadOnly: z.boolean().optional().describe('Только непрочитанные'),
    limit: z.number().optional().describe('Максимум чатов (по умолчанию 30)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const actionReplyQuestionTool = tool(actionReplyQuestion, {
  name: 'action_reply_question',
  description:
    'Ответить на вопрос покупателя по товару. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Если tool вернёт status="queued" — нормальный успех. Включи в ответ маркер [actionId:N] для UI-прогресса.',
  schema: z.object({
    questionId: z.string().describe('ID вопроса'),
    replyText: z.string().describe('Текст ответа на вопрос'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionSendChatMessageTool = tool(actionSendChatMessage, {
  name: 'action_send_chat_message',
  description:
    'Отправить сообщение покупателю в чат. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Если tool вернёт status="queued" — нормальный успех. Включи в ответ маркер [actionId:N] для UI-прогресса.',
  schema: z.object({
    chatId: z.string().describe('ID чата'),
    text: z.string().describe('Текст сообщения'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

// ── Phase 2: Card Management Tools ───────���──────────────────

export const queryCardHealthTool = tool(queryCardHealth, {
  name: 'query_card_health',
  description: 'Проверить качество карточек товаров (заполненность, фото, описание, характеристики). Возвращает score 0-100 и список проблем.',
  schema: z.object({
    nmIds: z.array(z.number()).optional().describe('Артикулы WB (если не указаны — все)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryCategoriesTool = tool(queryCategories, {
  name: 'query_categories',
  description: 'Найти категории/предметы WB по названию. Показывает обязательные характеристики для категории.',
  schema: z.object({
    search: z.string().describe('Поиск по названию категории'),
    includeCharacteristics: z.boolean().optional().describe('Включить характеристики первой категории'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryCardLimitsTool = tool(queryCardLimits, {
  name: 'query_card_limits',
  description: 'Получить лимиты на создание карточек товаров (бесплатные и платные).',
  schema: z.object({
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const actionCreateCardTool = tool(actionCreateCard, {
  name: 'action_create_card',
  description:
    'Создать новую карточку товара на WB. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Если tool вернёт status="queued" — нормальный успех. Включи в ответ маркер [actionId:N] для UI-прогресса.',
  schema: z.object({
    subjectID: z.number().describe('ID категории (предмета) WB'),
    vendorCode: z.string().describe('Артикул поставщика'),
    title: z.string().describe('Название товара'),
    description: z.string().describe('Описание товара'),
    brand: z.string().describe('Бренд'),
    dimensions: z.object({ length: z.number(), width: z.number(), height: z.number() }).describe('Размеры (см)'),
    characteristics: z.array(z.object({ id: z.number(), value: z.union([z.string(), z.array(z.string())]) })).describe('Характеристики'),
    sizes: z.array(z.object({ techSize: z.string(), wbSize: z.string().optional(), skus: z.array(z.string()) })).describe('Размеры со штрихкодами'),
    rationale: z.string().describe('Обоснование'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionUpdateCharacteristicsTool = tool(actionUpdateCharacteristics, {
  name: 'action_update_characteristics',
  description:
    'Обновить характеристики карточки товара (название, описание, параметры). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Если tool вернёт status="queued" — нормальный успех. Включи в ответ маркер [actionId:N] для UI-прогресса.',
  schema: z.object({
    nmId: z.number().describe('Артикул WB'),
    characteristics: z.array(z.object({ id: z.number(), value: z.union([z.string(), z.array(z.string())]) })).describe('Характеристики для обновления'),
    title: z.string().optional().describe('Новый заголовок'),
    description: z.string().optional().describe('Новое описание'),
    rationale: z.string().describe('Обоснование'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

// ── Phase 3: Logistics FBO/FBS Tools ────────────────────────

export const queryWarehousesTool = tool(queryWarehouses, {
  name: 'query_warehouses',
  description: 'Получить список складов WB и транзитные тарифы.',
  schema: z.object({ _workspaceId: z.number().optional(), _userId: z.number().optional() }),
});

export const querySuppliesTool = tool(querySupplies, {
  name: 'query_supplies',
  description: 'Получить список поставок FBO (активные или все).',
  schema: z.object({
    activeOnly: z.boolean().optional().describe('Только активные поставки'),
    limit: z.number().optional().describe('Максимум поставок'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryFbsOrdersTool = tool(queryFbsOrders, {
  name: 'query_fbs_orders',
  description: 'Получить FBS заказы для сборки. Сортирует по дедлайну, показывает срочность.',
  schema: z.object({
    newOnly: z.boolean().optional().describe('Только новые заказы (по умолчанию true)'),
    limit: z.number().optional().describe('Максимум заказов'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryAcceptanceCoefficientsTool = tool(queryAcceptanceCoefficients, {
  name: 'query_acceptance_coefficients',
  description: 'Получить коэффициенты приёмки и доступные даты для склада WB.',
  schema: z.object({
    warehouseId: z.number().optional().default(0).describe('ID склада WB (0 — все склады)'),
    deliveryType: z.enum(['box', 'mono_pallet', 'super_safe']).optional().default('box').describe('Тип поставки'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const actionCreateSupplyTool = tool(actionCreateSupply, {
  name: 'action_create_supply',
  description:
    '⚠️ DEPRECATED для FBW (с 2026-05-27, подтверждено live-probe): WB убрал POST /api/v1/supplies на создание. ' +
    'Tool ВСЕГДА вернёт error «Создайте preorder в ЛК WB». ' +
    '\n\n' +
    '**Что использовать вместо**: ' +
    '\n  • Для FBW (на склад WB) → action_prepare_fbw_supply — даёт рекомендацию склада + deep-link для ручного создания. ' +
    '\n  • Для FBS (со склада продавца) → action_create_fbs_supply — полностью автоматизировано через marketplace API. ' +
    '\n\n' +
    'Эта функция оставлена только для совместимости со старыми чатами. НЕ ВЫЗЫВАЙ ЕЁ ДЛЯ НОВЫХ ЗАПРОСОВ.',
  schema: z.object({
    warehouseID: z.number().describe('ID склада назначения'),
    deliveryType: z.enum(['box', 'mono_pallet', 'super_safe']).describe('Тип поставки'),
    goods: z.array(z.object({ barcode: z.string(), quantity: z.number() })).describe('Товары: штрихкод + количество'),
    rationale: z.string().describe('Обоснование'),
    desiredDate: z.string().optional().describe('Дата приёмки (YYYY-MM-DD). Если указана — попытается забронировать слот или поставить в очередь.'),
    maxCoefficient: z.number().optional().describe('Макс приемлемый коэффициент приёмки (default 1.0). Если фактический выше — записывается в очередь авто-брони.'),
    packageType: z.enum(['box', 'mono_pallet']).optional().describe('Тип упаковки (default derives from deliveryType)'),
    preferredDate: z.string().optional().describe('LEGACY (использовать desiredDate)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionBookSupplySlotTool = tool(actionBookSupplySlot, {
  name: 'action_book_supply_slot',
  description:
    'Забронировать конкретный слот приёмки для уже созданной поставки (preorder). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Используй после action_create_supply (без desiredDate) когда юзер выбрал дату через show_supply_calendar. ' +
    'Если tool вернёт status="queued" — нормальный успех. Включи в ответ [actionId:N].',
  schema: z.object({
    preorderID: z.number().describe('ID preorder из action_create_supply'),
    warehouseID: z.number().describe('ID склада'),
    date: z.string().describe('Дата приёмки (YYYY-MM-DD)'),
    rationale: z.string().optional().describe('Обоснование'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionQueueAutoBookTool = tool(actionQueueAutoBook, {
  name: 'action_queue_supply_autoBook',
  description:
    'Поставить уже созданную поставку (preorder) в очередь авто-бронирования. ' +
    'Cron каждые 10 минут будет пытаться забронировать слот когда коэф приёмки ≤ maxCoefficient. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Используй когда юзер говорит «забронируй когда станет дешевле» / «жди слот со скидкой».',
  schema: z.object({
    preorderID: z.number().describe('ID preorder'),
    warehouseID: z.number().describe('ID склада'),
    desiredDate: z.string().describe('Дата приёмки (YYYY-MM-DD)'),
    maxCoefficient: z.number().optional().describe('Макс коэф для бронирования (default 1.0)'),
    rationale: z.string().optional().describe('Обоснование'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionGenerateSupplySlipTool = tool(actionGenerateSupplySlip, {
  name: 'action_generate_supply_slip',
  description:
    'Сгенерировать лист приёмки FBO-поставки (A4 PDF с Code-128 штрих-кодами) и прислать его в чат. Используй после создания поставки (supplyRowId = внутренний id из wb_supplies), либо по просьбе пользователя «пришли лист приёмки/штрих-коды для поставки X». Подтверждение НЕ нужно.',
  schema: z.object({
    supplyRowId: z.number().describe('Внутренний id поставки из таблицы wb_supplies'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
  }),
});

export const actionConfirmFbsOrderTool = tool(actionConfirmFbsOrder, {
  name: 'action_confirm_fbs_order',
  description:
    'Подтвердить сборку FBS заказа. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Если tool вернёт status="queued" — нормальный успех. Включи в ответ маркер [actionId:N] для UI-прогресса.',
  schema: z.object({
    orderId: z.number().describe('ID заказа'),
    rationale: z.string().describe('Обоснование'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const showSupplyCalendarTool = tool(showSupplyCalendar, {
  name: 'show_supply_calendar',
  description: 'Показать виджет с календарём поставок: доступные даты и коэффициенты приёмки по складам.',
  schema: z.object({
    warehouseIds: z.array(z.number()).optional().describe('ID складов (по умолчанию — топ-5)'),
    deliveryType: z.enum(['box', 'mono_pallet', 'super_safe']).optional().describe('Тип поставки'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const showDataTableTool = tool(showDataTable, {
  name: 'show_data_table',
  description:
    'Показать длинную таблицу в чате как интерактивный виджет (сортировка, поиск, пагинация, экспорт CSV). ' +
    'Использовать ВСЕГДА, если строк больше 10 — вместо markdown-таблицы. Экономит output-токены и даёт пользователю полные данные без обрезки "и ещё N".',
  schema: z.object({
    title: z.string().optional().describe('Заголовок таблицы'),
    subtitle: z.string().optional().describe('Подзаголовок / 1-2 предложения контекста'),
    columns: z.array(z.object({
      key: z.string().describe('Ключ поля в объекте строки'),
      label: z.string().describe('Заголовок колонки для пользователя. ВСЕГДА на русском (Заказы, Выручка, Оценка, Остаток и т.п.), НЕ на английском (Score, Orders, Revenue).'),
      type: z.enum(['text', 'number', 'nmId', 'rub', 'pct', 'date']).optional()
        .describe('Тип данных для форматирования. nmId → ссылка на WB, rub → руб, pct → проценты'),
      width: z.string().optional(),
    })).describe('Описание колонок'),
    rows: z.array(z.record(z.string(), z.unknown())).describe('Все строки данных. Не обрезай — весь список.'),
    pageSize: z.number().optional().describe('Размер страницы, по умолчанию 10'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
  }),
});

// ── FBO: Stickers + Passes ──────────────────────────────────

export const queryBoxStickersTool = tool(actionGetBoxStickers, {
  name: 'query_box_stickers',
  description:
    'Скачать QR-стикеры коробов FBO-поставки с WB и прислать в чат одним PDF (580×400 px на короб). ' +
    'Используй после создания поставки или когда пользователь просит стикеры/этикетки для коробов. ' +
    'Подтверждение НЕ нужно — только чтение из WB.',
  schema: z.object({
    supplyId: z.string().describe('WB supply ID вида "WB-GI-XXXXXXX"'),
    type: z.enum(['png', 'svg']).optional().describe('Формат (по умолчанию png)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
  }),
});

export const queryPassesTool = tool(queryPasses, {
  name: 'query_passes',
  description:
    'Получить список пропусков на склад WB: активные (с таймером 48ч) + история за 30 дней. ' +
    'Используй перед action_create_pass, чтобы проверить нет ли уже активного пропуска.',
  schema: z.object({
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
  }),
});

export const actionCreatePassTool = tool(actionCreatePass, {
  name: 'action_create_pass',
  description:
    'Создать пропуск продавца на склад WB (действует 48 ч). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    '⚠️ Строгий лимит WB: 1 пропуск в 10 минут на аккаунт. ' +
    'Перед созданием вызови query_passes — если есть активный, не создавай новый. ' +
    'Если tool вернёт status="queued" — нормальный успех. Включи в ответ маркер [actionId:N] для UI-прогресса.',
  schema: z.object({
    firstName: z.string().describe('Имя водителя'),
    lastName: z.string().describe('Фамилия водителя'),
    carModel: z.string().describe('Марка автомобиля'),
    carNumber: z.string().min(6).max(9).describe('Номер авто (буквы и цифры, 6-9 символов)'),
    warehouseId: z.number().int().describe('ID склада WB (officeId)'),
    supplyId: z.number().optional().describe('Внутренний id поставки (опционально, для привязки)'),
    rationale: z.string().describe('Обоснование'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

// ── FBS E2E (0131): создание FBS-поставки через AI-агента ──────────────
//
// Контракт чейна:
//   query_fbs_orders → action_create_fbs_supply(orderIds[])
//     → action_get_fbs_supply_barcode (опционально, для печати)
//     → action_deliver_fbs_supply (закрыть на отправку)
//     → action_create_pass (выписать пропуск водителю)

export const actionCreateFbsSupplyTool = tool(actionCreateFbsSupply, {
  name: 'action_create_fbs_supply',
  description:
    'Создать FBS-поставку и добавить в неё указанные заказы (POST /api/v3/supplies + PUT orders). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ. ' +
    'Используй когда пользователь хочет отгрузить несколько FBS-заказов одной поставкой. ' +
    'Сначала вызови query_fbs_orders, найди подходящие orderId, потом эту функцию. ' +
    'Если tool вернёт status="queued" — нормальный успех. Включи [actionId:N] в финальный ответ. ' +
    'НЕ ИСПОЛЬЗОВАТЬ для FBW (на склад WB) — там нет API создания, используй action_prepare_fbw_supply.',
  schema: z.object({
    name: z.string().optional().describe('Имя поставки (по умолчанию — сегодняшняя дата YYYY-MM-DD)'),
    orderIds: z.array(z.number().int()).min(1).max(1000).describe('FBS orderId из query_fbs_orders'),
    rationale: z.string().describe('Обоснование (что отгружаем, куда, зачем именно сейчас)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionDeliverFbsSupplyTool = tool(actionDeliverFbsSupply, {
  name: 'action_deliver_fbs_supply',
  description:
    'Закрыть FBS-поставку на отправку (PATCH /api/v3/supplies/{id}/deliver). После этого поставку нельзя редактировать. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ. ' +
    'Вызывай только когда пользователь физически готов отвезти заказы на ПВЗ/склад. ' +
    'Передай ЛИБО fbsSupplyPk (внутренний id из wb_fbs_supplies), ЛИБО wbSupplyId (WB-GI-...).',
  schema: z.object({
    fbsSupplyPk: z.number().optional().describe('Внутренний id из wb_fbs_supplies'),
    wbSupplyId: z.string().optional().describe('WB supplyId формата WB-GI-XXXXXXXXX'),
    rationale: z.string().describe('Обоснование'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const actionGetFbsSupplyBarcodeTool = tool(actionGetFbsSupplyBarcode, {
  name: 'action_get_fbs_supply_barcode',
  description:
    'Получить штрихкод (QR) FBS-поставки для печати и наклейки на короб. Безопасно — read-only. ' +
    'Возвращает fileBase64 — UI/чат покажет его пользователю. Формат pdf (default) | png | svg.',
  schema: z.object({
    fbsSupplyPk: z.number().optional(),
    wbSupplyId: z.string().optional(),
    format: z.enum(['pdf', 'png', 'svg']).optional(),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
  }),
});

// ── FBW prepare (0131): рекомендация склада + deep-link ─────────────────
// WB убрал API создания FBW preorders, поэтому AI больше НЕ может вызвать
// `action_create_supply` для создания FBW с нуля. Вместо этого AI вызывает
// `action_prepare_fbw_supply` — функция возвращает рекомендованный склад,
// коэф приёмки, расчёт стоимости и ссылку для ручного создания в ЛК WB.
// После того как пользователь создаст preorder, suppliesSync подхватит,
// и можно использовать action_book_supply_slot / action_queue_auto_book.

export const actionPrepareFbwSupplyTool = tool(actionPrepareFbwSupply, {
  name: 'action_prepare_fbw_supply',
  description:
    'Подготовить FBW-поставку (на склад WB): подобрать оптимальный склад, найти ближайший слот с приемлемым коэф приёмки, выдать deep-link в ЛК WB для ручного создания preorder. ' +
    'БЕЗОПАСНО, не требует подтверждения. ' +
    'Используй ЭТУ функцию когда пользователь хочет отправить товары на склад WB (FBW). ' +
    'НЕ используй action_create_supply — WB убрал API создания FBW preorder, она вернёт ошибку.',
  schema: z.object({
    nmIds: z.array(z.number().int()).min(1).max(50).describe('Артикулы WB для отгрузки'),
    quantities: z.record(z.string(), z.number().int()).optional()
      .describe('Map nmId(string) → quantity. Если не задано, используется default 10 шт'),
    preferredWarehouseId: z.number().int().optional().describe('Если пользователь указал склад'),
    packageType: z.enum(['box', 'mono_pallet', 'super_safe']).optional(),
    targetDays: z.number().int().optional().describe('Целевой запас в днях (default 30)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
  }),
});

// ── Phase 4: Promotions, Documents, News Tools ──────────────

export const queryPromotionsTool = tool(queryPromotions, {
  name: 'query_promotions',
  description: 'Получить список акций WB (активные, предстоящие или все).',
  schema: z.object({
    status: z.enum(['active', 'upcoming', 'all']).optional().describe('Фильтр по статусу'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const actionManagePromotionTool = tool(actionManagePromotion, {
  name: 'action_manage_promotion',
  description:
    'Добавить или убрать товары из акции WB. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ПОЛЬЗОВАТЕЛЯ. ' +
    'Если tool вернёт status="queued" — нормальный успех. Включи в ответ маркер [actionId:N] для UI-прогресса.',
  schema: z.object({
    promotionId: z.number().describe('ID акции'),
    action: z.enum(['add', 'remove']).describe('Действие: добавить или убрать'),
    nmIds: z.array(z.number()).describe('Артикулы WB'),
    rationale: z.string().describe('Обоснование'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _confirmed: z.boolean().optional(),
  }),
});

export const queryDocumentsTool = tool(queryDocuments, {
  name: 'query_documents',
  description: 'Получить финансовые документы WB за период (акты, счета, УПД).',
  schema: z.object({
    from: z.string().optional().default(() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString().slice(0, 10);
    }).describe('Дата начала (YYYY-MM-DD, по умолчанию 30 дней назад)'),
    to: z.string().optional().default(() => new Date().toISOString().slice(0, 10)).describe('Дата конца (YYYY-MM-DD, по умолчанию сегодня)'),
    category: z.string().optional().describe('Категория документа (необязательно)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryWbNewsTool = tool(queryWbNews, {
  name: 'query_wb_news',
  description: 'Получить последние новости портала продавцов WB (изменения оферты, новые правила).',
  schema: z.object({
    limit: z.number().optional().describe('Количество новостей (по умолчанию 20)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryTariffsTool = tool(queryTariffs, {
  name: 'query_tariffs',
  description: 'Получить комиссии WB по категориям и тарифы на логистику/хранение.',
  schema: z.object({
    subjectNames: z.array(z.string()).optional().describe('Фильтр по названиям категорий'),
    date: z.string().optional().describe('Дата для тарифов (YYYY-MM-DD)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

// ── Phase 5: Assortment, Reports, Analytics Tools ───────────

export const queryCompetitorsTool = tool(queryCompetitors, {
  name: 'query_competitors',
  description: 'Конкурентный анализ: сравнить свои товары с конкурентами по ключевым запросам.',
  schema: z.object({
    keywords: z.array(z.string()).min(1, 'Нужен хотя бы один ключевой запрос').describe('Ключевые запросы для поиска конкурентов (минимум 1)'),
    nmIds: z.array(z.number()).optional().describe('Свои артикулы для сравнения'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryCompetitorCardTool = tool(queryCompetitorCard, {
  name: 'query_competitor_card',
  description: 'Публичный аудит карточки WB по nmId (без авторизации того продавца). Дёргает card.wb.ru — возвращает витринную цену (с СПП), бренд, поставщика и его рейтинг, остатки по размерам, рейтинг товара, кол-во отзывов, активные акции WB, время доставки, базу и суммарную скидку. Используй для сравнения «моя карточка vs конкурент», anti-dumping мониторинга, разведки ниши. ВАЖНО: цена тут уже включает СПП — это «то что видит покупатель», не путай с finalPriceRub из нашего query_current_price (там без СПП).',
  schema: z.object({
    nmId: z.number().int().positive().describe('Артикул WB карточки конкурента'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
  }),
});

export const suggestPhotoPromptsTool = tool(suggestPhotoPrompts, {
  name: 'suggest_photo_prompts',
  description: 'Сгенерировать готовые промпты для AI-генерации фото/видео контента товара в Студии. ВАЖНО: это НЕ генерирует сами картинки — только текстовые промпты, которые пользователь потом запустит в Студии. Используй когда юзер спрашивает «какие промпты использовать», «дай идеи для фото», «как улучшить карточку визуально». Можно передать auditId если уже был аудит — тогда промпты будут таргетированы под выявленные проблемы. Результат сохраняется в историю Студии, пользователь увидит их в /studio → вкладка История промптов.',
  schema: z.object({
    nmId: z.number().describe('Артикул WB'),
    auditId: z.number().optional().describe('Опциональный ID аудита карточки — обогатит контекст промпта'),
    count: z.number().min(3).max(15).optional().describe('Кол-во промптов (3-15, по умолчанию 8)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryCurrentPriceTool = tool(queryCurrentPrice, {
  name: 'query_current_price',
  description: 'Текущая цена товара на WB: базовая цена продавца, скидка продавца %, цена со скидкой (то что видит покупатель до СПП), цена покупателя после СПП. Используй ВСЕГДА перед action_set_price и когда пользователь спрашивает «сколько стоит», «какая сейчас цена», «какая скидка». Источник: история цен WB либо средняя по заказам за 14д.',
  schema: z.object({
    nmId: z.number().describe('Артикул WB'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const queryAssortmentHealthTool = tool(queryAssortmentHealth, {
  name: 'query_assortment_health',
  description:
    'ABC-анализ ассортимента по СУММЕ ЗАКАЗОВ (orders_rub) за период. '
    + 'Возвращает: abcSummary, totalProducts, topProducts, deadStock. '
    + 'Поля в каждом товаре: nmId, orderRevenue (сумма заказов в копейках), orders (шт заказов), abc (A/B/C). '
    + 'limit (дефолт 100, max 500): если просят «все товары» и их < 500, ставь 500. '
    + ''
    + 'Опционально (только когда явно нужен drill-down или пользователь спрашивает): '
    + '— showSales=true добавит sales (шт выкупов) и salesRevenue (₽ выкупов). '
    + '  НЕ показывай orders и sales рядом в основной таблице — это разные товары/даты, '
    + '  отношение sales/orders НЕ есть процент выкупа. '
    + '— showBuyoutPct=true добавит buyoutPctCohort — когортный % выкупа из funnel. '
    + '  При daysBack<21: если buyoutPctCohort=null — товар ЕЩЁ В ПУТИ (заказы недавние, '
    + '  выкупы будут позже). Не показывай «0%» в этом случае — пиши «в пути» или «—». '
    + '  Для надёжного % выкупа используй daysBack≥21.',
  schema: z.object({
    daysBack: z.number().optional().describe('Период анализа в днях (по умолчанию 30)'),
    limit: z.number().int().min(1).max(500).optional().describe('Сколько товаров вернуть в topProducts и deadStock. Дефолт 100, максимум 500. Для полного списка указывай 500.'),
    showSales: z.boolean().optional().describe('Добавить sales/salesRevenue (выкупы). По умолчанию false — заказы важнее.'),
    showBuyoutPct: z.boolean().optional().describe('Добавить когортный % выкупа из funnel-данных (поле buyoutPctCohort).'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const calcAbTestTool = tool(calcAbTest, {
  name: 'calc_ab_test',
  description: 'Оценить результат A/B-теста: сравнить метрики товара ДО и ПОСЛЕ изменения.',
  schema: z.object({
    nmId: z.number().describe('Артикул WB'),
    changeDate: z.string().describe('Дата изменения (YYYY-MM-DD)'),
    periodDaysBefore: z.number().optional().describe('Дней до изменения (по умолчанию 7)'),
    periodDaysAfter: z.number().optional().describe('Дней после изменения (по умолчанию 7)'),
    changeDescription: z.string().describe('Что было изменено'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const subagentLabTool = tool(subagentLab, {
  name: 'subagent_lab',
  description:
    'Лаборатория корреляций — объясняет ПОЧЕМУ метрики двигаются вместе. Вызывай когда юзер спрашивает «влияет ли X на Y», «почему упали заказы», «работает ли реклама», «какой эффект цены», «эластичность». Возвращает: корреляции с p-value и BH-FDR, топ-3 critical инсайта, точки роста, эластичность цены, lag-анализ. Строго привязана к одному магазину (shopId). Safe query — ничего не меняет.',
  schema: z.object({
    userIntent: z.string().describe('Краткое описание вопроса пользователя'),
    nmId: z.number().optional().describe('Артикул WB — если интерес к конкретному товару'),
    from: z.string().describe('Начало периода YYYY-MM-DD (рекомендуется 60 дней назад)'),
    to: z.string().describe('Конец периода YYYY-MM-DD'),
    focus: z.enum(['price', 'ads', 'seo', 'stock', 'all']).optional().describe('Фокус анализа. all — стандартный набор метрик'),
    excludeHolidays: z.boolean().optional().describe('Исключить праздники/WB-распродажи (по умолчанию true)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

export const showSellerReportTool = tool(showSellerReport, {
  name: 'show_seller_report',
  description: 'Сформировать виджет-отчёт продавца: продажи, финансы, остатки за период (день/неделя/месяц).',
  schema: z.object({
    period: z.enum(['daily', 'weekly', 'monthly']).describe('Период отчёта'),
    from: z.string().optional().describe('Дата начала'),
    to: z.string().optional().describe('Дата конца'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
  }),
});

// ── Registry ───────────────────────────────────────────────

export const allTools = [
  // Query (safe) — original
  queryFinanceTool,
  querySalesTool,
  queryStocksTool,
  queryFunnelTool,
  queryAlertsTool,
  queryAbTestsTool,
  queryProductTool,
  queryReturnsTool,
  queryAdvertisingTool,
  querySeoTool,
  queryRegionalTool,
  queryStorageTool,
  // Query (safe) — Phase 1: Communication
  queryQuestionsTool,
  queryChatsTool,
  queryFeedbackSummaryTool,
  // Query (safe) — Phase 2: Cards
  queryCardHealthTool,
  queryCategoriesTool,
  queryCardLimitsTool,
  // Query (safe) — Phase 3: Logistics
  queryWarehousesTool,
  querySuppliesTool,
  queryFbsOrdersTool,
  queryAcceptanceCoefficientsTool,
  // Query (safe) — Phase 4: Promotions & docs
  queryPromotionsTool,
  queryDocumentsTool,
  queryWbNewsTool,
  queryTariffsTool,
  // Query (safe) — Phase 5: Strategy
  queryCompetitorsTool,
  queryCompetitorCardTool,
  queryAssortmentHealthTool,
  queryCurrentPriceTool,
  suggestPhotoPromptsTool,
  // Calc (safe)
  calcUnitEconTool,
  calcAbTestTool,
  // subagent_lab — pushed below after declaration (const is not hoisted)
  // Widget (safe)
  showFunnelTool,
  showPriceSliderTool,
  showAbcChartTool,
  showSupplyPlanTool,
  showSupplyWizardTool,
  showSupplyCreatedTool,
  showSupplyCalendarTool,
  showDataTableTool,
  showSellerReportTool,
  // Action (dangerous) — original
  actionSetPriceTool,
  actionReplyFeedbackTool,
  actionStartCampaignTool,
  actionPauseCampaignTool,
  actionUpdateBidTool,
  actionManageDiscountTool,
  actionUpdateCardTool,
  actionManageClustersTool,
  // Action (dangerous) — Phase 1
  actionReplyQuestionTool,
  actionSendChatMessageTool,
  // Action (dangerous) — Phase 2
  actionCreateCardTool,
  actionUpdateCharacteristicsTool,
  // Action (dangerous) — Phase 3
  actionCreateSupplyTool,
  actionGenerateSupplySlipTool,
  actionConfirmFbsOrderTool,
  // Action (dangerous) — Phase 4
  actionManagePromotionTool,
  // FBO: Stickers + Passes
  queryBoxStickersTool,
  queryPassesTool,
  actionCreatePassTool,
  // FBS E2E (0131)
  actionCreateFbsSupplyTool,
  actionDeliverFbsSupplyTool,
  actionGetFbsSupplyBarcodeTool,
  // FBW prepare (deep-link, since POST /api/v1/supplies = listing-only)
  actionPrepareFbwSupplyTool,
  // Action (dangerous) — Returns (Phase 5, 2026-05-24)
  actionApproveReturnTool,
  actionRejectReturnTool,
  // Action (dangerous) — Supplies E2E (rev 25z.4, 2026-05-24)
  actionBookSupplySlotTool,
  actionQueueAutoBookTool,
  // Phase 6 (2026-05-26) — расширенные feedback + grouped funnel
  actionEditFeedbackReplyTool,
  actionRejectQuestionTool,
  actionReturnByReviewTool,
  queryFunnelGroupedTool,
  // Phase 7 (2026-06-01) — RAG + characteristics search для товаров
  queryProductsBySemanticsTool,
  queryProductsByCharacteristicsTool,
  listAvailableCharacteristicsTool,
];

// ── Multi-Agent v2 subagent tools (behind ENABLE_MULTI_AGENT flag) ───

export const subagentPricingTool = tool(subagentPricing, {
  name: 'subagent_pricing',
  description:
    'Делегировать pricing-специалисту: анализ цен/маржи/конкурентов и рекомендации по переоценке. Используй когда юзер спрашивает про цены, маржу, скидки, конкурентов. Subagent возвращает ТОЛЬКО рекомендации — реальное изменение цены идёт через action_set_price с подтверждением пользователя.',
  schema: z.object({
    userIntent: z.string().describe('Краткое описание запроса пользователя'),
    targetNmIds: z.array(z.number()).optional().describe('Если юзер указал конкретные артикулы'),
    detailLevel: z.enum(['quick', 'thorough']).optional().describe('quick — быстрый ответ, thorough — полный анализ'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _correlationId: z.string().optional(),
  }),
});

export const subagentAdsTool = tool(subagentAds, {
  name: 'subagent_ads',
  description:
    'Делегировать ads/bidder-специалисту: анализ эффективности рекламных кампаний, оптимизация ставок по ДРР/ROAS. Используй когда юзер спрашивает про рекламу, ставки, ДРР, кампании. Subagent возвращает рекомендации — применение через action_update_bid / action_pause_campaign с подтверждением.',
  schema: z.object({
    userIntent: z.string(),
    strategy: z.enum(['maximize_position', 'optimize_drr', 'budget_saver', 'aggressive_growth']).optional(),
    detailLevel: z.enum(['quick', 'thorough']).optional(),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _correlationId: z.string().optional(),
  }),
});

export const subagentReviewsTool = tool(subagentReviews, {
  name: 'subagent_reviews',
  description:
    'Делегировать reviews-специалисту: агрегация отзывов/вопросов покупателей, sentiment, без ответа, критичные 1-2★. Используй когда юзер спрашивает про отзывы/отрицательные оценки/репутацию. Ответ на конкретный отзыв — через action_reply_feedback.',
  schema: z.object({
    userIntent: z.string(),
    daysBack: z.number().optional(),
    detailLevel: z.enum(['quick', 'thorough']).optional(),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _correlationId: z.string().optional(),
  }),
});

export const subagentSupplyTool = tool(subagentSupply, {
  name: 'subagent_supply',
  description:
    'Делегировать supply-специалисту: планирование поставок FBO, анализ остатков/OOS-risk, распределение по складам. Используй когда юзер спрашивает про поставки/остатки/склад.',
  schema: z.object({
    userIntent: z.string(),
    targetDays: z.number().optional().describe('Целевое количество дней остатка (default 45)'),
    detailLevel: z.enum(['quick', 'thorough']).optional(),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _correlationId: z.string().optional(),
  }),
});

export const subagentSeoTool = tool(subagentSeo, {
  name: 'subagent_seo',
  description:
    'Делегировать SEO-специалисту: анализ позиций товаров, рекомендации по title/description/keywords. Используй когда юзер спрашивает про SEO/позиции/поисковую выдачу WB.',
  schema: z.object({
    userIntent: z.string(),
    detailLevel: z.enum(['quick', 'thorough']).optional(),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _correlationId: z.string().optional(),
  }),
});

export const subagentSeoKeywordSuggestionTool = tool(subagentSeoKeywordSuggestion, {
  name: 'subagent_seo_keyword_suggestion',
  description:
    'Подбирает поисковые запросы (агрегаты ПО МАГАЗИНУ) для добавления в SEO-мониторинг. ' +
    'Источник: wb_search_queries (Jam-отчёт) за 14 дней. Возвращает виджет с чекбоксами.\n\n' +
    'ВАЖНО ДЛЯ LLM (DECISIONS #103): возвращаемые `avgPositionShopWide`, `views`, ' +
    '`clicks`, `orders` — это АГРЕГАТЫ ПО ВСЕМУ МАГАЗИНУ для конкретного запроса, ' +
    'а НЕ позиция/трафик одного артикула. Поле `relatedNmIds` показывает, какие ' +
    'товары попадают в выдачу по запросу, но НЕ означает что у каждого из них ' +
    'именно эта позиция. Поле `attribution` явно: `shop_wide_aggregate` (несколько ' +
    'товаров) или `single_product` (один). Если пользователь спрашивает про ' +
    'КОНКРЕТНЫЙ nmId — НЕ зови этот tool для ответа о его позициях; используй ' +
    'query_seo_overview / query_card_health / query_funnel.',
  schema: z.object({
    userIntent: z.string(),
    limit: z.number().optional().describe('Сколько кандидатов вернуть (default 30)'),
    includeTracked: z.boolean().optional().describe('Показать и уже отслеживаемые (default false)'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _correlationId: z.string().optional(),
  }),
});

export const actionAddSeoKeywordsTool = tool(actionAddSeoKeywords, {
  name: 'action_add_seo_keywords',
  description:
    'Добавить пачку слов на отслеживание позиций в seo_keywords (batch, до 50 за раз). Подтверждение НЕ нужно — локальная операция. Используй после того как пользователь выбрал слова из subagent_seo_keyword_suggestion.',
  schema: z.object({
    keywords: z.array(z.object({
      keyword: z.string(),
      nmIds: z.array(z.number()).optional().describe('Товары, по которым отслеживать это слово'),
    })).describe('Список слов для добавления'),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
  }),
});

export const subagentChatTool = tool(subagentChat, {
  name: 'subagent_chat',
  description:
    'Делегировать chat-специалисту: статистика по чатам покупателей, непрочитанные сообщения, активность. Используй когда юзер спрашивает про чаты/переписку с покупателями.',
  schema: z.object({
    userIntent: z.string(),
    detailLevel: z.enum(['quick', 'thorough']).optional(),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _correlationId: z.string().optional(),
  }),
});

export const subagentFbsTool = tool(subagentFbs, {
  name: 'subagent_fbs',
  description:
    'Делегировать FBS-специалисту: статистика по FBS-отгрузкам, заказам, маркировке. Используй когда юзер спрашивает про FBS/отгрузки/маркировку.',
  schema: z.object({
    userIntent: z.string(),
    daysBack: z.number().optional(),
    detailLevel: z.enum(['quick', 'thorough']).optional(),
    _workspaceId: z.number().optional(),
    _shopId: z.number().optional(),
    _userId: z.number().optional(),
    _correlationId: z.string().optional(),
  }),
});

// subagent_lab — always registered (safe, no multi-agent flag required).
// Push after declaration because `allTools` is evaluated at module-init time.
(allTools as unknown as Array<typeof calcUnitEconTool>).push(
  subagentLabTool as unknown as typeof calcUnitEconTool,
);

// When flag=1 — add subagent tools to main registry BEFORE toolMap build.
// Keeps tool list static per-process (set at import time); restart after
// flipping env. Cast bypasses allTools' inferred tuple-union type — the graph
// treats tools via their .name/.invoke interface, not the specific zod schema.
if (env.ENABLE_MULTI_AGENT === '1') {
  const list = allTools as unknown as Array<typeof subagentPricingTool>;
  list.push(subagentPricingTool);
  list.push(subagentAdsTool as unknown as typeof subagentPricingTool);
  list.push(subagentReviewsTool as unknown as typeof subagentPricingTool);
  list.push(subagentSupplyTool as unknown as typeof subagentPricingTool);
  list.push(subagentSeoTool as unknown as typeof subagentPricingTool);
  list.push(subagentSeoKeywordSuggestionTool as unknown as typeof subagentPricingTool);
  list.push(actionAddSeoKeywordsTool as unknown as typeof subagentPricingTool);
  list.push(subagentChatTool as unknown as typeof subagentPricingTool);
  list.push(subagentFbsTool as unknown as typeof subagentPricingTool);
}

const toolMap = new Map<string, (typeof allTools)[number]>(allTools.map((t) => [t.name, t]));

export function getToolByName(name: string): (typeof allTools)[number] | null {
  return toolMap.get(name) ?? null;
}

/** Tools that modify data and require human-in-the-loop confirmation */
export const DANGEROUS_TOOLS = new Set([
  'action_set_price',
  'action_reply_feedback',
  'action_start_campaign',
  'action_pause_campaign',
  'action_update_bid',
  'action_manage_discount',
  'action_update_card',
  'action_manage_clusters',
  'action_reply_question',
  'action_send_chat_message',
  'action_create_card',
  'action_update_characteristics',
  'action_create_supply',
  'action_confirm_fbs_order',
  'action_manage_promotion',
  'action_create_pass',
  'action_approve_return',
  'action_reject_return',
  'action_book_supply_slot',
  'action_queue_supply_autoBook',
  // Phase 6 (2026-05-26)
  'action_edit_feedback_reply',
  'action_reject_question',
  'action_return_by_review',
]);
